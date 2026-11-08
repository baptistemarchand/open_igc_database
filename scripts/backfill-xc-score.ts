/**
 * Fill `score_xcontest` / `score_ffvl` (migration 0008) with igc-xc-score. This is the
 * only writer of those columns: the solver is far too heavy for the Worker or the upload
 * page, so new flights stay NULL ("not scored yet") until this is run again by hand.
 *
 * Same shape as backfill-suspicious.ts / backfill-takeoff-time.ts, which explain the
 * choices in detail (local corpus over R2, id recomputed from the same gunzip, many rows
 * folded into one validated `WITH v(...) AS (VALUES ...) UPDATE ... FROM v`). What differs:
 *
 *  - The target set is read first, and only target files are solved. Hashing the whole
 *    corpus is minutes; solving it is hours (~0.5 s per flight on average, some take
 *    seconds), so a periodic run must not re-solve flights that already have a score.
 *    `WHERE score_xcontest IS NULL` with keyset paging on `id` is a range seek on
 *    `idx_flights_score_xcontest_id`: it reads only the unscored rows. Both columns are
 *    always written together, so one of them is enough to find the gap.
 *  - Suspicious flights (`suspicious IS NOT NULL`) are never scored: their glitches
 *    (teleporting fixes, clock jumps) make the score meaningless, and they are excluded
 *    from /stats anyway. They stay NULL; if `backfill-suspicious.ts` later clears the
 *    flag, the next run picks them up on its own.
 *  - Results are written as they come, not at the end: a first full pass runs for hours,
 *    and a crash must not lose what was already solved. Resume is just re-running.
 *  - `<dir>` is optional. Without it every target is fetched from R2, which is what a
 *    periodic run wants (the new flights are not in the local corpus anyway).
 *
 * Run `npm run stats:remote` afterwards: /stats only changes when the snapshot does.
 *
 * Usage:
 *   npx tsx scripts/backfill-xc-score.ts [<dir>] [--recursive] [--workers=N]
 *       [--concurrency=8] [--budget-ms=20000] [--max-files=N] [--rescore] [--dry-run]
 *
 * Auth (env or a gitignored scripts/import.env):
 *   CLOUDFLARE_API_TOKEN   token with D1:Edit + Workers R2 Storage:Read
 *   CLOUDFLARE_ACCOUNT_ID  your account id
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { stripIdentifyingHeaders } from '../src/lib/anonymize.ts';
import { D1_DATABASE_ID, R2_BUCKET, loadEnvFile, d1Query, d1Exec, r2Get, runPool, type Creds } from './lib/cf-api.ts';
import { findIgcFiles, sha256Hex } from './lib/local-igc.ts';
import { scoreIgc } from './lib/xcscore.ts';

const D1_PAGE_SIZE = 10_000;
/** ~100 bytes of SQL per row, so 500 rows stay far under D1's 100 KB statement limit. */
const CHUNK_ROWS = 500;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Solving is slow, so workers report often enough for progress and incremental writes. */
const WORKER_FLUSH_MS = 5_000;

interface Scored {
  id: string;
  x: number;
  f: number;
  ms: number;
  truncated: boolean;
  source: string;
}

// --- Worker: hash a shard of the local corpus, solve the target files ---------------
interface WorkerInput {
  paths: string[];
  targets: string[];
  budgetMs: number;
}
interface WorkerReport {
  rows: Scored[];
  scanned: number;
  failed: string[];
}

function runWorker(): void {
  const { paths, targets, budgetMs } = workerData as WorkerInput;
  const want = new Set(targets);
  const port = parentPort!;
  let report: WorkerReport = { rows: [], scanned: 0, failed: [] };
  let lastFlush = Date.now();
  const flush = () => {
    port.postMessage(report);
    report = { rows: [], scanned: 0, failed: [] };
    lastFlush = Date.now();
  };

  for (const path of paths) {
    try {
      const text = new TextDecoder().decode(gunzipSync(readFileSync(path)));
      const id = sha256Hex(stripIdentifyingHeaders(text));
      // A duplicate file of the same track would be solved twice; dropping the id here
      // keeps that to one per worker.
      if (want.delete(id)) {
        const res = scoreIgc(text, budgetMs);
        if (res) {
          const { score_xcontest: x, score_ffvl: f } = res.scores;
          report.rows.push({ id, x, f, ms: res.elapsedMs, truncated: res.truncated, source: path });
        } else report.failed.push(path);
      }
    } catch (e) {
      report.failed.push(`${path}: ${(e as Error).message}`);
    }
    report.scanned++;
    if (Date.now() - lastFlush >= WORKER_FLUSH_MS) flush();
  }
  flush();
}

// --- CLI --------------------------------------------------------------------------
interface Args {
  dir: string | null;
  recursive: boolean;
  workers: number;
  concurrency: number;
  budgetMs: number;
  maxFiles: number | null;
  rescore: boolean;
  dryRun: boolean;
}

const usage = () =>
  'Usage: npx tsx scripts/backfill-xc-score.ts [<dir>] [--recursive] [--workers=N]\n' +
  '       [--concurrency=8] [--budget-ms=20000] [--max-files=N] [--rescore] [--dry-run]';

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Omit<Args, 'dir'> = {
    recursive: false,
    workers: Math.max(1, availableParallelism() - 1),
    concurrency: 8,
    budgetMs: 20_000,
    maxFiles: null,
    rescore: false,
    dryRun: false,
  };
  for (const a of argv) {
    if (a === '--recursive') args.recursive = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--rescore') args.rescore = true;
    else if (a.startsWith('--workers=')) args.workers = Math.max(1, Number(a.slice(10)) || 1);
    else if (a.startsWith('--concurrency=')) args.concurrency = Math.max(1, Number(a.slice(14)) || 8);
    else if (a.startsWith('--budget-ms=')) args.budgetMs = Math.max(100, Number(a.slice(12)) || 20_000);
    else if (a.startsWith('--max-files=')) args.maxFiles = Math.max(0, Number(a.slice(12)) || 0);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}\n${usage()}`);
    else positional.push(a);
  }
  if (positional.length > 1) fail('Expected at most one <dir> argument.\n' + usage());
  return { dir: positional[0] ?? null, ...args };
}

// --- Target set ---------------------------------------------------------------------
/** Keyset paging, not OFFSET: OFFSET re-walks every skipped row on each page. */
async function fetchTargets(creds: Creds, rescore: boolean): Promise<string[]> {
  const ids: string[] = [];
  const where = `suspicious IS NULL AND ${rescore ? '' : 'score_xcontest IS NULL AND '}id > ?`;
  for (let after = ''; ;) {
    const page = await d1Query<{ id: string }>(
      creds,
      D1_DATABASE_ID,
      `SELECT id FROM flights WHERE ${where} ORDER BY id LIMIT ?`,
      [after, D1_PAGE_SIZE],
    );
    for (const r of page) ids.push(r.id);
    if (page.length < D1_PAGE_SIZE) return ids;
    after = page[page.length - 1].id;
  }
}

// --- Writes -------------------------------------------------------------------------
const ID_RE = /^[0-9a-f]{64}$/;
/** No league scores in the thousands; anything outside this is a bug, not a flight. */
const validScore = (n: number) => Number.isFinite(n) && n >= 0 && n < 100_000;

function chunkSql(rows: Scored[]): string {
  // Every inlined value is validated before it gets here (see `Writer.add`): the id
  // against a strict hex pattern, the scores as finite numbers printed by toFixed.
  const tuples = rows.map((r) => `('${r.id}',${r.x.toFixed(2)},${r.f.toFixed(2)})`).join(',');
  return (
    `WITH v(id, x, f) AS (VALUES ${tuples})\n` +
    'UPDATE flights SET score_xcontest = v.x, score_ffvl = v.f FROM v WHERE flights.id = v.id'
  );
}

/** Buffers rows and writes them in chunks, one request at a time, as they arrive. */
class Writer {
  private pending: Scored[] = [];
  private chain: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;
  written = 0;
  rejected = 0;
  aborted = false;

  constructor(
    private creds: Creds,
    private dryRun: boolean,
  ) {}

  add(r: Scored): void {
    if (!ID_RE.test(r.id) || !validScore(r.x) || !validScore(r.f)) {
      console.error(`  ✗ ${r.id}: invalid score ${r.x} / ${r.f}, skipped`);
      this.rejected++;
      return;
    }
    this.pending.push(r);
    if (this.pending.length >= CHUNK_ROWS) this.send(this.pending.splice(0, CHUNK_ROWS));
  }

  private send(chunk: Scored[]): void {
    if (this.dryRun) {
      if (this.written === 0) console.log(`Chunk shape:\n\n${chunkSql(chunk.slice(0, 3))}\n`);
      this.written += chunk.length;
      return;
    }
    this.chain = this.chain.then(async () => {
      if (this.aborted) return;
      try {
        const meta = await d1Exec(this.creds, D1_DATABASE_ID, chunkSql(chunk));
        this.written += meta.changes ?? chunk.length;
        this.consecutiveFailures = 0;
      } catch (e) {
        console.error(`  ✗ write of ${chunk.length} row(s) failed: ${(e as Error).message}`);
        if (++this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`Aborting after ${MAX_CONSECUTIVE_FAILURES} consecutive failures; re-run to resume.`);
          this.aborted = true;
        }
      }
    });
  }

  async flush(): Promise<void> {
    if (this.pending.length > 0) this.send(this.pending.splice(0));
    await this.chain;
  }
}

// --- Report -------------------------------------------------------------------------
class Tally {
  solved = 0;
  truncated = 0;
  totalMs = 0;
  slowest: Scored[] = [];

  add(r: Scored): void {
    this.solved++;
    this.totalMs += r.ms;
    if (r.truncated) this.truncated++;
    this.slowest.push(r);
    this.slowest.sort((a, b) => b.ms - a.ms);
    this.slowest.length = Math.min(this.slowest.length, 5);
  }

  print(): void {
    const avg = this.solved ? Math.round(this.totalMs / this.solved) : 0;
    console.log(`  ${this.solved} solved, avg ${avg} ms, ${this.truncated} hit the budget (best found stored).`);
    for (const r of this.slowest) console.log(`    ${r.ms} ms  ${r.source}`);
  }
}

// --- Main ---------------------------------------------------------------------------
async function scanCorpus(args: Args, targets: Set<string>, onRow: (r: Scored) => void): Promise<void> {
  const files = await findIgcFiles(args.dir!, args.recursive);
  const paths = args.maxFiles == null ? files : files.slice(0, args.maxFiles);
  const n = Math.min(args.workers, paths.length);
  console.log(`Scanning ${paths.length} local file(s) across ${n} worker(s)…`);

  let scanned = 0;
  let failed = 0;
  let nextLog = 10_000;
  const shardTargets = [...targets];
  await Promise.all(
    Array.from({ length: n }, (_, k) => {
      // Stride sharding, as in backfill-takeoff-time.ts: file sizes drift by era.
      const shard = paths.filter((_, i) => i % n === k);
      return new Promise<void>((resolve, reject) => {
        const input: WorkerInput = { paths: shard, targets: shardTargets, budgetMs: args.budgetMs };
        const worker = new Worker(new URL(import.meta.url), { workerData: input });
        worker.on('message', (m: WorkerReport) => {
          for (const r of m.rows) onRow(r);
          for (const f of m.failed) console.error(`  ✗ ${f}`);
          failed += m.failed.length;
          scanned += m.scanned;
          if (scanned >= nextLog) {
            console.log(`  …${scanned}/${paths.length} scanned`);
            nextLog = scanned + 10_000;
          }
        });
        worker.on('error', reject);
        worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
      });
    }),
  );
  console.log(`  local scan done (${failed} file(s) failed).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadEnvFile();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId)
    fail('Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID (env or scripts/import.env).');
  const creds: Creds = { token, accountId };

  console.log(
    args.rescore ? 'Fetching every non-suspicious flight id…' : 'Fetching unscored, non-suspicious flight ids…',
  );
  const targets = new Set(await fetchTargets(creds, args.rescore));
  console.log(`${targets.size} flight(s) to score.`);
  if (targets.size === 0) return;

  const writer = new Writer(creds, args.dryRun);
  const tally = new Tally();
  const done = new Set<string>();
  const onRow = (r: Scored) => {
    if (done.has(r.id)) return; // the same track in several local files
    done.add(r.id);
    tally.add(r);
    writer.add(r);
    if (tally.solved % 1000 === 0) console.log(`  …${tally.solved}/${targets.size} solved`);
  };

  if (args.dir) await scanCorpus(args, targets, onRow);

  // R2 for the rest. `--max-files` is a local-only trial, so it skips R2.
  const misses = args.maxFiles == null ? [...targets].filter((id) => !done.has(id)) : [];
  let unresolved = 0;
  if (misses.length > 0 && !writer.aborted) {
    console.log(`Fetching ${misses.length} flight(s) from R2…`);
    // Downloads overlap; solving is synchronous, so it still runs one flight at a time.
    await runPool(misses, args.concurrency, async (id) => {
      if (writer.aborted) return;
      try {
        const obj = await r2Get(creds, R2_BUCKET, `${id}.igc`);
        const res = obj && scoreIgc(new TextDecoder().decode(obj.body), args.budgetMs);
        if (res) {
          const { score_xcontest: x, score_ffvl: f } = res.scores;
          onRow({ id, x, f, ms: res.elapsedMs, truncated: res.truncated, source: `r2:${id}` });
          return;
        }
        console.error(`  ✗ ${id}: ${obj ? 'unparseable' : 'missing from R2'}`);
      } catch (e) {
        console.error(`  ✗ ${id}: ${(e as Error).message}`);
      }
      unresolved++;
    });
  }

  await writer.flush();
  tally.print();
  const verb = args.dryRun ? 'would be written' : 'written';
  console.log(`\n${writer.written} row(s) ${verb}; ${unresolved} unresolved, ${writer.rejected} rejected.`);
  if (args.dryRun) console.log('=== DRY RUN — no writes performed ===');
  else console.log('=== Done. Now run `npm run stats:remote`. ===');
  if (unresolved > 0 || writer.rejected > 0 || writer.aborted) process.exitCode = 1;
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runWorker();
}
