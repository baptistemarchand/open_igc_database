/**
 * One-off backfill for migration 0003's `takeoff_hour` / `takeoff_tz` columns, which
 * are NULL for every flight uploaded before that migration landed.
 *
 * The two columns are NOT symmetrically recoverable (see migrations/0003 + CLAUDE.md):
 *  - `takeoff_tz` is a pure function of takeoff_lat/takeoff_lon, both already in D1.
 *  - `takeoff_hour` needs the first valid B-record's UTC timestamp, and track points
 *    are never stored — so it only exists inside the .igc file itself.
 *
 * Hence <dir>: a local copy of the R2 corpus. Reading the hour from disk instead of
 * re-downloading 186k R2 objects is the whole point — the account API is paced at
 * ~3.8 req/s (see cf-api.ts), so a GET per flight would take over half a day. Only
 * the handful of D1 rows with no local match fall back to R2.
 *
 * Local filenames carry no flight id, so the id has to be recomputed per file as
 * sha256(stripIdentifyingHeaders(gunzip(bytes))). That hash pass is unavoidable and
 * dominates the local cost (~7 ms/file single-threaded, i.e. ~20 min for 186k), so it
 * runs across a worker_threads pool and its output is cached to JSONL — a second
 * invocation (the free-plan resume, a --limit smoke test) skips it entirely.
 *
 * Writes fold 500 rows into one `WITH v(...) AS (VALUES ...) UPDATE ... FROM v`
 * statement: ~370 requests instead of ~186k, ~100 s instead of ~13.6 h. Values are
 * inlined as literals (D1 caps bound params well below that batch size), so every one
 * is validated against a strict pattern first and dropped if it fails — see
 * `d1Exec`'s doc comment.
 *
 * Safe to interrupt and re-run: the target set is `WHERE takeoff_tz IS NULL`, so a
 * resumed run naturally picks up exactly the rows that haven't landed yet. That also
 * covers the free plan's 100k-rows-written-per-day cap, which a full 186k run will
 * hit: the script aborts after 3 consecutive failed chunks rather than grinding
 * through doomed ones, and finishing is just running it again the next day.
 *
 * Usage:
 *   npx tsx scripts/backfill-takeoff-time.ts <dir> [--recursive] [--concurrency=8]
 *       [--workers=N] [--limit=N] [--max-files=N] [--cache=<path>] [--refresh-cache]
 *       [--dry-run]
 *
 * Auth (env or a gitignored scripts/import.env):
 *   CLOUDFLARE_API_TOKEN   token with D1:Edit + Workers R2 Storage:Read
 *   CLOUDFLARE_ACCOUNT_ID  your account id
 */
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import tzlookup from 'tz-lookup';
import { extractMetadata, stripIdentifyingHeaders } from '../src/lib/igc.ts';
import { D1_DATABASE_ID, R2_BUCKET, loadEnvFile, d1Query, d1Exec, r2Get, runPool, type Creds } from './lib/cf-api.ts';
import { findIgcFiles, sha256Hex } from './lib/local-igc.ts';

const D1_PAGE_SIZE = 10_000;
/** Rows folded into one UPDATE. ~105 bytes of SQL each, so 500 ≈ 55 KB — comfortably
 *  under D1's 100 KB statement limit, with room for the longest IANA zone names. */
const CHUNK_ROWS = 500;
/** A D1 error that repeats is structural (bad SQL, daily write cap), not transient —
 *  fetchRetry has already exhausted its backoff by the time one surfaces here. */
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_CACHE = '.backfill-takeoff-cache.jsonl';

/** One resolved flight: what the two columns should be set to. */
interface Resolved {
  id: string;
  h: number | null;
  tz: string | null;
}

// --- Worker: hash + parse a shard of the local corpus -----------------------------
/** How many scanned files a worker batches before reporting back to the main thread. */
const WORKER_FLUSH = 2000;

interface WorkerInput {
  paths: string[];
}
interface WorkerReport {
  rows: Resolved[];
  scanned: number;
  unusable: number;
}

function runWorker(): void {
  const { paths } = workerData as WorkerInput;
  const port = parentPort!;
  let rows: Resolved[] = [];
  let scanned = 0;
  let unusable = 0;

  const flush = () => {
    port.postMessage({ rows, scanned, unusable } satisfies WorkerReport);
    rows = [];
    scanned = 0;
    unusable = 0;
  };

  for (const path of paths) {
    try {
      // One gunzip serves both the id and the metadata. Don't reuse mapLocalIdsToPaths
      // from ./lib/local-igc.ts here: it returns paths only, forcing a second read and
      // gunzip of all 15 GB downstream.
      const text = new TextDecoder().decode(gunzipSync(readFileSync(path)));
      const res = extractMetadata(text);
      // A file extractMetadata rejects (junk HFDTE000000 dates, too few fixes) was never
      // a valid import, so it has no D1 row to backfill — skip rather than hash it.
      if (!res.ok) unusable++;
      else
        rows.push({ id: sha256Hex(stripIdentifyingHeaders(text)), h: res.meta.takeoff_hour, tz: res.meta.takeoff_tz });
    } catch {
      unusable++; // unreadable or not gzip — same reasoning as mapLocalIdsToPaths
    }
    scanned++;
    if (scanned >= WORKER_FLUSH) flush();
  }
  flush();
}

// --- CLI --------------------------------------------------------------------------
interface Args {
  dir: string;
  recursive: boolean;
  concurrency: number;
  workers: number;
  limit: number | null;
  maxFiles: number | null;
  cache: string;
  refreshCache: boolean;
  dryRun: boolean;
}

const usage = () =>
  'Usage: npx tsx scripts/backfill-takeoff-time.ts <dir> [--recursive] [--concurrency=8]\n' +
  '       [--workers=N] [--limit=N] [--max-files=N] [--cache=<path>] [--refresh-cache] [--dry-run]';

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let recursive = false;
  let dryRun = false;
  let refreshCache = false;
  let concurrency = 8;
  let workers = Math.max(1, availableParallelism() - 1);
  let limit: number | null = null;
  let maxFiles: number | null = null;
  let cache = DEFAULT_CACHE;

  for (const a of argv) {
    if (a === '--recursive') recursive = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--refresh-cache') refreshCache = true;
    else if (a.startsWith('--concurrency=')) concurrency = Math.max(1, Number(a.slice(14)) || 8);
    else if (a.startsWith('--workers=')) workers = Math.max(1, Number(a.slice(10)) || 1);
    else if (a.startsWith('--limit=')) limit = Math.max(0, Number(a.slice(8)) || 0);
    else if (a.startsWith('--max-files=')) maxFiles = Math.max(0, Number(a.slice(12)) || 0);
    else if (a.startsWith('--cache=')) cache = a.slice(8);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}\n${usage()}`);
    else positional.push(a);
  }

  if (positional.length !== 1) fail('Expected exactly one <dir> argument.\n' + usage());
  return { dir: positional[0], recursive, concurrency, workers, limit, maxFiles, cache, refreshCache, dryRun };
}

// --- Phase A: scan the local corpus -----------------------------------------------
/**
 * Hash + parse every local file across a worker pool, returning id → {h, tz}.
 *
 * Sharding is by stride (worker k takes indices k, k+N, …) rather than by contiguous
 * block: the corpus is sorted by filename, which starts with the flight date, and file
 * sizes drift a lot across eras — contiguous blocks would leave workers unbalanced.
 */
async function scanCorpus(args: Args): Promise<Map<string, Resolved>> {
  const files = await findIgcFiles(args.dir, args.recursive);
  const paths = args.maxFiles == null ? files : files.slice(0, args.maxFiles);
  const n = Math.min(args.workers, paths.length);
  console.log(`Scanning ${paths.length} local file(s) across ${n} worker(s)…`);

  const map = new Map<string, Resolved>();
  let scanned = 0;
  let unusable = 0;
  let nextLog = WORKER_FLUSH;

  await Promise.all(
    Array.from({ length: n }, (_, k) => {
      const shard = paths.filter((_, i) => i % n === k);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { paths: shard } satisfies WorkerInput });
        worker.on('message', (m: WorkerReport) => {
          // Last write wins on a duplicate id, matching upsertFlight — but the values
          // are a pure function of the content the id hashes, so duplicates agree.
          for (const r of m.rows) map.set(r.id, r);
          scanned += m.scanned;
          unusable += m.unusable;
          if (scanned >= nextLog) {
            console.log(`  …${scanned}/${paths.length} scanned (${map.size} ids, ${unusable} unusable)`);
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

/** Reuse the JSONL cache if present; otherwise scan and write it. A partial scan is
 *  never cached — the file is only renamed into place once the pool finishes. */
async function loadOrScan(args: Args): Promise<Map<string, Resolved>> {
  if (!args.refreshCache) {
    try {
      const text = await readFile(args.cache, 'utf8');
      const map = new Map<string, Resolved>();
      for (const line of text.split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line) as Resolved;
        map.set(r.id, r);
      }
      console.log(`Using cached corpus scan: ${map.size} id(s) from ${args.cache} (--refresh-cache to rebuild).`);
      return map;
    } catch {
      // no cache yet (or it's unreadable) — fall through and scan
    }
  }

  const map = await scanCorpus(args);
  // --max-files produces a deliberately partial scan; caching it would poison later runs.
  if (args.maxFiles == null) {
    const tmp = `${args.cache}.part`;
    await writeFile(tmp, [...map.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await rename(tmp, args.cache);
    console.log(`  cached to ${args.cache}`);
  }
  return map;
}

// --- Phase B: the rows that still need backfilling --------------------------------
interface TargetRow {
  id: string;
  takeoff_lat: number;
  takeoff_lon: number;
}

/**
 * Page through every row still missing the columns. `takeoff_tz IS NULL` is the
 * resume marker — it's non-null for every row this script has already written, and
 * for every row uploaded since migration 0003.
 *
 * All pages are read before any write: LIMIT/OFFSET over a predicate the writes
 * themselves flip would skip rows if the two were interleaved.
 */
async function fetchTargets(creds: Creds, limit: number | null): Promise<TargetRow[]> {
  const rows: TargetRow[] = [];
  for (let offset = 0; ; offset += D1_PAGE_SIZE) {
    const page = await d1Query<TargetRow>(
      creds,
      D1_DATABASE_ID,
      'SELECT id, takeoff_lat, takeoff_lon FROM flights WHERE takeoff_tz IS NULL ORDER BY id LIMIT ? OFFSET ?',
      [D1_PAGE_SIZE, offset],
    );
    rows.push(...page);
    if (limit != null && rows.length >= limit) return rows.slice(0, limit);
    if (page.length < D1_PAGE_SIZE) return rows;
  }
}

/** Zone from the coordinates D1 already stores. tzlookup throws RangeError on
 *  out-of-range coords, which upload validation should have excluded — but a stored
 *  row is not worth trusting blindly for something that throws. */
function tzFromCoords(lat: number, lon: number): string | null {
  try {
    return tzlookup(lat, lon);
  } catch {
    return null;
  }
}

// --- Phase C: validate + write ----------------------------------------------------
const ID_RE = /^[0-9a-f]{64}$/;
/** Every tz-lookup output, including the Etc/GMT±n zones it returns over water. */
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** SQL literal for one row, or null if any value fails its pattern (see d1Exec). */
function valuesTuple(r: Resolved): string | null {
  if (!ID_RE.test(r.id)) return null;
  if (r.h != null && !(Number.isInteger(r.h) && r.h >= 0 && r.h <= 23)) return null;
  if (r.tz != null && !TZ_RE.test(r.tz)) return null;
  if (r.h == null && r.tz == null) return null; // nothing to write
  return `('${r.id}',${r.h ?? 'NULL'},${r.tz == null ? 'NULL' : `'${r.tz}'`})`;
}

function chunkSql(tuples: string[]): string {
  return (
    `WITH v(id, h, tz) AS (VALUES ${tuples.join(',')})\n` +
    'UPDATE flights SET takeoff_hour = v.h, takeoff_tz = v.tz FROM v WHERE flights.id = v.id'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadEnvFile();

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    fail(
      'Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID.\n' +
        'Set them in the environment or in a gitignored scripts/import.env file.',
    );
  }
  const creds: Creds = { token, accountId };

  const local = await loadOrScan(args);

  console.log('Fetching rows still missing takeoff_tz from prod D1…');
  const targets = await fetchTargets(creds, args.limit);
  console.log(`${targets.length} row(s) to backfill${args.dryRun ? ' (dry run — no writes)' : ''}.`);
  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const tally = { local: 0, fromR2: 0, coordsOnly: 0, unresolved: 0, invalid: 0 };
  const resolved: Resolved[] = [];
  const misses: TargetRow[] = [];

  for (const t of targets) {
    const hit = local.get(t.id);
    if (hit) {
      resolved.push(hit);
      tally.local++;
    } else {
      misses.push(t);
    }
  }

  // Flights with no local copy (uploaded straight through the website). Expect a few
  // hundred — small enough to afford one rate-gated R2 GET each.
  if (misses.length > 0) {
    console.log(`Fetching ${misses.length} flight(s) with no local copy from R2…`);
    await runPool(misses, args.concurrency, async (t) => {
      try {
        const obj = await r2Get(creds, R2_BUCKET, `${t.id}.igc`);
        // obj.body is always decoded plaintext — see r2Get's doc comment.
        const res = obj && extractMetadata(new TextDecoder().decode(obj.body));
        if (res && res.ok) {
          resolved.push({ id: t.id, h: res.meta.takeoff_hour, tz: res.meta.takeoff_tz });
          tally.fromR2++;
          return;
        }
      } catch (e) {
        console.error(`  ✗ ${t.id}: R2 read failed: ${(e as Error).message}`);
      }
      // No file, or a file the parser rejects: the zone is still recoverable from the
      // coords D1 stores, so write that and leave the hour NULL rather than nothing.
      const tz = tzFromCoords(t.takeoff_lat, t.takeoff_lon);
      if (tz == null) tally.unresolved++;
      else {
        resolved.push({ id: t.id, h: null, tz });
        tally.coordsOnly++;
      }
    });
  }

  const tuples: string[] = [];
  for (const r of resolved) {
    const tuple = valuesTuple(r);
    if (tuple == null) tally.invalid++;
    else tuples.push(tuple);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < tuples.length; i += CHUNK_ROWS) chunks.push(tuples.slice(i, i + CHUNK_ROWS));

  if (args.dryRun) {
    const [first] = chunks;
    console.log(`\nWould send ${chunks.length} chunk(s) of up to ${CHUNK_ROWS} row(s).`);
    if (first) {
      console.log(`First chunk holds ${first.length} row(s), ${chunkSql(first).length} bytes of SQL. Shape:\n`);
      console.log(chunkSql(first.slice(0, 3)));
    }
  } else {
    console.log(`Writing ${tuples.length} row(s) in ${chunks.length} chunk(s)…`);
    let consecutiveFailures = 0;
    let written = 0;
    for (const [i, chunk] of chunks.entries()) {
      try {
        const meta = await d1Exec(creds, D1_DATABASE_ID, chunkSql(chunk));
        written += meta.changes ?? chunk.length;
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        console.error(`  ✗ chunk ${i + 1}/${chunks.length}: ${(e as Error).message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `\nAborting after ${MAX_CONSECUTIVE_FAILURES} consecutive failures — this is a\n` +
              "structural error, not a blip. If it's the free plan's 100k rows/day write cap,\n" +
              `${written} row(s) landed; re-run tomorrow and it resumes from here.`,
          );
          process.exitCode = 1;
          break;
        }
      }
      if ((i + 1) % 25 === 0 || i === chunks.length - 1) {
        console.log(`  …chunk ${i + 1}/${chunks.length} (${written} row(s) written)`);
      }
    }
    console.log(`rows written                   : ${written}`);
  }

  console.log('\n' + (args.dryRun ? '=== DRY RUN — no writes performed ===' : '=== Done ==='));
  console.log(`resolved from local corpus     : ${tally.local}`);
  console.log(`resolved from R2               : ${tally.fromR2}`);
  console.log(`zone only, hour NULL           : ${tally.coordsOnly}`);
  console.log(`unresolved (skipped)           : ${tally.unresolved}`);
  console.log(`failed validation (skipped)    : ${tally.invalid}`);
  if (tally.unresolved > 0 || tally.invalid > 0) process.exitCode = 1;
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runWorker();
}
