/**
 * Backfill the track-derived `suspicious` bits (TRACK_BITS in src/lib/suspicious.ts:
 * ALT_SPIKE, BAD_TIMESTAMPS). The threshold bits come from stored metadata and are
 * backfilled by SQL migrations; these need the track points, which only the .igc has.
 *
 * Same shape as backfill-takeoff-time.ts, which explains the choices in detail:
 *  - read the local corpus copy, not R2 (the account API is paced at ~3.8 req/s);
 *  - recompute each id from the same gunzip that feeds `extractMetadata`;
 *  - fall back to R2 only for D1 rows with no local file;
 *  - fold 500 rows into one `WITH v(...) AS (VALUES ...) UPDATE ... FROM v`, with
 *    every inlined literal validated first (see `d1Exec`).
 *
 * Only flagged flights are written, and the bits are OR-ed in, so a re-run is harmless
 * and resuming after an interruption is just running it again. Finding the rows with no
 * local file needs every id in D1: one paged read of ~187k rows, paid once per run.
 *
 * Run `npm run stats:remote` afterwards: /stats only changes when the snapshot does.
 *
 * Usage:
 *   npx tsx scripts/backfill-suspicious.ts <dir> [--recursive] [--concurrency=8]
 *       [--workers=N] [--max-files=N] [--dry-run]
 *
 * Auth (env or a gitignored scripts/import.env):
 *   CLOUDFLARE_API_TOKEN   token with D1:Edit + Workers R2 Storage:Read
 *   CLOUDFLARE_ACCOUNT_ID  your account id
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { extractMetadata, stripIdentifyingHeaders } from '../src/lib/igc.ts';
import { SUSPICIOUS, TRACK_BITS } from '../src/lib/suspicious.ts';
import { D1_DATABASE_ID, R2_BUCKET, loadEnvFile, d1Query, d1Exec, r2Get, runPool, type Creds } from './lib/cf-api.ts';
import { findIgcFiles, sha256Hex } from './lib/local-igc.ts';

const D1_PAGE_SIZE = 10_000;
/** ~70 bytes of SQL per row, so 500 rows stay far under D1's 100 KB statement limit. */
const CHUNK_ROWS = 500;
const MAX_CONSECUTIVE_FAILURES = 3;
const WORKER_FLUSH = 2000;

/** One local file: its id, and its track bits (0 when clean). */
interface Scanned {
  id: string;
  bits: number;
}

// --- Worker: hash + parse a shard of the local corpus -----------------------------
interface WorkerReport {
  rows: Scanned[];
  scanned: number;
  unusable: number;
}

function runWorker(): void {
  const { paths } = workerData as { paths: string[] };
  const port = parentPort!;
  let report: WorkerReport = { rows: [], scanned: 0, unusable: 0 };
  const flush = () => {
    port.postMessage(report);
    report = { rows: [], scanned: 0, unusable: 0 };
  };

  for (const path of paths) {
    try {
      const text = new TextDecoder().decode(gunzipSync(readFileSync(path)));
      const res = extractMetadata(text);
      if (!res.ok) report.unusable++;
      else
        report.rows.push({
          id: sha256Hex(stripIdentifyingHeaders(text)),
          bits: (res.meta.suspicious ?? 0) & TRACK_BITS,
        });
    } catch {
      report.unusable++;
    }
    report.scanned++;
    if (report.scanned >= WORKER_FLUSH) flush();
  }
  flush();
}

// --- CLI --------------------------------------------------------------------------
interface Args {
  dir: string;
  recursive: boolean;
  concurrency: number;
  workers: number;
  maxFiles: number | null;
  dryRun: boolean;
}

const usage = () =>
  'Usage: npx tsx scripts/backfill-suspicious.ts <dir> [--recursive] [--concurrency=8]\n' +
  '       [--workers=N] [--max-files=N] [--dry-run]';

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Omit<Args, 'dir'> = {
    recursive: false,
    concurrency: 8,
    workers: Math.max(1, availableParallelism() - 1),
    maxFiles: null,
    dryRun: false,
  };
  for (const a of argv) {
    if (a === '--recursive') args.recursive = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--concurrency=')) args.concurrency = Math.max(1, Number(a.slice(14)) || 8);
    else if (a.startsWith('--workers=')) args.workers = Math.max(1, Number(a.slice(10)) || 1);
    else if (a.startsWith('--max-files=')) args.maxFiles = Math.max(0, Number(a.slice(12)) || 0);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}\n${usage()}`);
    else positional.push(a);
  }
  if (positional.length !== 1) fail('Expected exactly one <dir> argument.\n' + usage());
  return { dir: positional[0], ...args };
}

// --- Phase A: scan the local corpus -----------------------------------------------
/** Stride sharding, as in backfill-takeoff-time.ts: file sizes drift by era. */
async function scanCorpus(args: Args): Promise<Map<string, number>> {
  const files = await findIgcFiles(args.dir, args.recursive);
  const paths = args.maxFiles == null ? files : files.slice(0, args.maxFiles);
  const n = Math.min(args.workers, paths.length);
  console.log(`Scanning ${paths.length} local file(s) across ${n} worker(s)…`);

  const map = new Map<string, number>();
  let scanned = 0;
  let unusable = 0;
  let nextLog = 10_000;
  await Promise.all(
    Array.from({ length: n }, (_, k) => {
      const shard = paths.filter((_, i) => i % n === k);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { paths: shard } });
        worker.on('message', (m: WorkerReport) => {
          for (const r of m.rows) map.set(r.id, r.bits);
          scanned += m.scanned;
          unusable += m.unusable;
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
  console.log(`  ${map.size} local file(s) mapped to a flight id (${unusable} unusable, skipped).`);
  return map;
}

// --- Phase B: D1 ids with no local file -------------------------------------------
async function fetchAllIds(creds: Creds): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += D1_PAGE_SIZE) {
    const page = await d1Query<{ id: string }>(
      creds,
      D1_DATABASE_ID,
      'SELECT id FROM flights ORDER BY id LIMIT ? OFFSET ?',
      [D1_PAGE_SIZE, offset],
    );
    ids.push(...page.map((r) => r.id));
    if (page.length < D1_PAGE_SIZE) return ids;
  }
}

// --- Phase C: validate + write ----------------------------------------------------
const ID_RE = /^[0-9a-f]{64}$/;

function chunkSql(rows: Scanned[]): string {
  // Both values validated before inlining: the id against a strict hex pattern, the
  // bits as a non-zero integer inside TRACK_BITS (see the filter in main).
  const tuples = rows.map((r) => `('${r.id}',${r.bits})`).join(',');
  return (
    `WITH v(id, bits) AS (VALUES ${tuples})\n` +
    'UPDATE flights SET suspicious = COALESCE(flights.suspicious, 0) | v.bits FROM v WHERE flights.id = v.id'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadEnvFile();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId)
    fail('Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID (env or scripts/import.env).');
  const creds: Creds = { token, accountId };

  const local = await scanCorpus(args);

  console.log('Fetching every flight id from prod D1…');
  const ids = await fetchAllIds(creds);
  const misses = ids.filter((id) => !local.has(id));
  console.log(`${ids.length} flight(s) in D1, ${misses.length} with no local file.`);

  const flagged = new Map<string, number>();
  for (const id of ids) {
    const bits = local.get(id);
    if (bits) flagged.set(id, bits);
  }

  let unresolved = 0;
  if (misses.length > 0) {
    console.log(`Fetching ${misses.length} flight(s) from R2…`);
    await runPool(misses, args.concurrency, async (id) => {
      try {
        const obj = await r2Get(creds, R2_BUCKET, `${id}.igc`);
        const res = obj && extractMetadata(new TextDecoder().decode(obj.body));
        if (res && res.ok) {
          const bits = (res.meta.suspicious ?? 0) & TRACK_BITS;
          if (bits) flagged.set(id, bits);
          return;
        }
      } catch (e) {
        console.error(`  ✗ ${id}: R2 read failed: ${(e as Error).message}`);
      }
      unresolved++;
    });
  }

  const rows = [...flagged]
    .map(([id, bits]) => ({ id, bits }))
    .filter((r) => ID_RE.test(r.id) && Number.isInteger(r.bits));
  const count = (bit: number) => rows.filter((r) => r.bits & bit).length;
  console.log(
    `\n${rows.length} flight(s) to flag: ALT_SPIKE ${count(SUSPICIOUS.ALT_SPIKE)}, ` +
      `BAD_TIMESTAMPS ${count(SUSPICIOUS.BAD_TIMESTAMPS)}; ${unresolved} unresolved.`,
  );

  const chunks: Scanned[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) chunks.push(rows.slice(i, i + CHUNK_ROWS));

  if (args.dryRun) {
    console.log(
      `Would send ${chunks.length} chunk(s). Shape:\n\n${chunks[0] ? chunkSql(chunks[0].slice(0, 3)) : '(none)'}`,
    );
    console.log('\n=== DRY RUN — no writes performed ===');
    return;
  }

  let written = 0;
  let consecutiveFailures = 0;
  for (const [i, chunk] of chunks.entries()) {
    try {
      const meta = await d1Exec(creds, D1_DATABASE_ID, chunkSql(chunk));
      written += meta.changes ?? chunk.length;
      consecutiveFailures = 0;
    } catch (e) {
      console.error(`  ✗ chunk ${i + 1}/${chunks.length}: ${(e as Error).message}`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`Aborting after ${MAX_CONSECUTIVE_FAILURES} consecutive failures; re-run to resume.`);
        process.exitCode = 1;
        break;
      }
    }
  }
  console.log(`=== Done: ${written} row(s) updated. Now run \`npm run stats:remote\`. ===`);
  if (unresolved > 0) process.exitCode = 1;
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runWorker();
}
