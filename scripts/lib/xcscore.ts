/**
 * XContest / FFVL scoring with igc-xc-score, for workers/processor and the offline
 * backfill.
 *
 * The solver is a branch-and-bound search: milliseconds for most flights, minutes for
 * near-straight long ones. That is too heavy for the app's Worker and the upload page,
 * so nothing under src/ imports this (see CLAUDE.md).
 *
 * The solver keeps module-level state (`geom.init`, a swapped `Point.prototype`
 * distance function), so two scorings must never interleave in one thread. Scoring is
 * synchronous here, which guarantees it; parallelism comes from worker_threads.
 */
import IGCParser from 'igc-parser';
import { scoringRules, solver } from 'igc-xc-score';

export interface XcScores {
  score_xcontest: number;
  score_ffvl: number;
}

export interface XcScoreResult {
  scores: XcScores;
  /** True when a rule ran out of budget and the stored score is the best found, not a proven optimum. */
  truncated: boolean;
  elapsedMs: number;
  /** Solutions the solver evaluated, summed over both rules: what a `loops` budget counts. */
  loops: number;
}

/**
 * Per-rule solver budget. `ms` is wall time and needs a clock that moves during
 * synchronous code, which workerd's doesn't: `Date.now()` is frozen until the next I/O,
 * so a time budget never fires there and only the CPU limit stops the solver. The
 * Worker therefore counts evaluated solutions instead (`loops`, igc-xc-score's
 * `maxloop`), calibrated against `ms` on the local corpus.
 */
export type XcBudget = { ms: number } | { loops: number };

/** Slices short enough that the budget overshoots by at most one slice. */
const CYCLE_MS = 250;

type Rules = Parameters<typeof solver>[1];
type Flight = Parameters<typeof solver>[0];

interface Solved {
  score: number;
  optimal: boolean;
  loops: number;
}

function solve(flight: IGCParser.IGCFile, rules: Rules, budget: XcBudget): Solved {
  const common = { trim: true, invalid: false, hp: false };
  // igc-xc-score is typed against igc-parser 1.x; the fix shape it reads (latitude,
  // longitude, timestamp, valid, altitudes) is unchanged in 2.x.
  const asFlight = flight as unknown as Flight;
  type Step = { score?: number; optimal?: boolean; processed?: number };
  const done = (v: Step): Solved => ({ score: v.score ?? 0, optimal: v.optimal === true, loops: v.processed ?? 0 });

  if ('loops' in budget) {
    // `processed` is cumulative and `maxcycle` unset, so the first next() runs until
    // the solution is optimal or the loop budget is spent: one call is the whole run.
    const it = solver(asFlight, rules, { ...common, maxloop: budget.loops } as never);
    return done(it.next().value as Step);
  }

  const it = solver(asFlight, rules, { ...common, maxcycle: CYCLE_MS });
  const start = Date.now();
  // Driven with next() rather than for..of: the optimal solution is the generator's
  // *return* value, which for..of drops.
  for (;;) {
    const { value } = it.next();
    if (value.optimal || Date.now() - start >= budget.ms) return done(value as Step);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Score one IGC text under both rule sets. Returns null when the file doesn't parse.
 */
export function scoreIgc(text: string, budget: XcBudget): XcScoreResult | null {
  let flight: IGCParser.IGCFile;
  try {
    flight = IGCParser.parse(text, { lenient: true });
  } catch {
    return null;
  }
  return scoreFlight(flight, budget);
}

/**
 * Score an already parsed flight under both rule sets. A track with no detected flight
 * (no launch/landing found by `trim`) scores 0 rather than failing, so it counts as
 * done instead of being retried on every run.
 */
export function scoreFlight(flight: IGCParser.IGCFile, budget: XcBudget): XcScoreResult {
  const start = Date.now();
  let truncated = false;
  let loops = 0;
  const run = (rules: Rules): number => {
    let res: Solved;
    try {
      res = solve(flight, rules, budget);
    } catch (e) {
      // No launch/landing pair leaves the solver with no root solution to start from.
      if ((flight as { ll?: unknown[] }).ll?.length === 0) return 0;
      throw e;
    }
    if (!res.optimal) truncated = true;
    loops += res.loops;
    return round2(Math.max(0, res.score));
  };

  const score_xcontest = run(scoringRules.XContest);
  const score_ffvl = run(scoringRules.FFVL);
  return { scores: { score_xcontest, score_ffvl }, truncated, elapsedMs: Date.now() - start, loops };
}
