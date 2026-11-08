/**
 * XContest / FFVL scoring with igc-xc-score, for the offline backfill only.
 *
 * The solver is a branch-and-bound search: milliseconds for most flights, minutes for
 * near-straight long ones. That is far beyond the Worker's CPU budget and too heavy for
 * the upload page, so nothing under src/ imports this (see CLAUDE.md).
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
}

/** Slices short enough that the budget overshoots by at most one slice. */
const CYCLE_MS = 250;

type Rules = Parameters<typeof solver>[1];
type Flight = Parameters<typeof solver>[0];

function solve(flight: IGCParser.IGCFile, rules: Rules, budgetMs: number): { score: number; optimal: boolean } {
  // igc-xc-score is typed against igc-parser 1.x; the fix shape it reads (latitude,
  // longitude, timestamp, valid, altitudes) is unchanged in 2.x.
  const it = solver(flight as unknown as Flight, rules, { maxcycle: CYCLE_MS, trim: true, invalid: false, hp: false });
  const start = Date.now();
  // Driven with next() rather than for..of: the optimal solution is the generator's
  // *return* value, which for..of drops.
  for (;;) {
    const { value } = it.next();
    if (value.optimal || Date.now() - start >= budgetMs) {
      return { score: value.score ?? 0, optimal: value.optimal === true };
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Score one IGC text under both rule sets. Returns null when the file doesn't parse.
 * A track with no detected flight (no launch/landing found by `trim`) scores 0 rather
 * than null, so the backfill marks it done instead of retrying it on every run.
 */
export function scoreIgc(text: string, budgetMs: number): XcScoreResult | null {
  let flight: IGCParser.IGCFile;
  try {
    flight = IGCParser.parse(text, { lenient: true });
  } catch {
    return null;
  }

  const start = Date.now();
  let truncated = false;
  const run = (rules: Rules): number => {
    let res: { score: number; optimal: boolean };
    try {
      res = solve(flight, rules, budgetMs);
    } catch (e) {
      // No launch/landing pair leaves the solver with no root solution to start from.
      if ((flight as { ll?: unknown[] }).ll?.length === 0) return 0;
      throw e;
    }
    if (!res.optimal) truncated = true;
    return round2(Math.max(0, res.score));
  };

  const score_xcontest = run(scoringRules.XContest);
  const score_ffvl = run(scoringRules.FFVL);
  return { scores: { score_xcontest, score_ffvl }, truncated, elapsedMs: Date.now() - start };
}
