/**
 * Bulk-import local `.igc` files straight into production D1 + R2 via the
 * Cloudflare REST API — bypassing the deployed Worker (whose free-plan per-request
 * limits 503 under load, see scripts/upload-igc.sh).
 *
 * Parsing/validation/hashing run locally and MUST match the Worker exactly, so we
 * reuse the repo's own `extractMetadata` + `stripIdentifyingHeaders` verbatim and
 * reproduce the ingest orchestration from src/lib/upload.ts (`ingestIgc`) and the
 * upsert SQL from src/lib/db.ts (`upsertFlight`). The id is the SHA-256 of the
 * identifier-stripped bytes, so dedup is name-independent.
 *
 * The local `.igc` files this script reads are themselves already gzip-compressed
 * (matching what the Worker now stores in R2 — see src/lib/upload.ts). They're
 * gunzipped in memory just to parse/hash/strip headers; for a `--named` import the
 * original gzip bytes are uploaded unchanged (no recompression). Anonymous imports
 * (the default, i.e. without `--named`) recompress instead, because blanking the
 * identifying headers changes the bytes that need to end up in R2.
 *
 * Usage:
 *   npx tsx scripts/import-igc.ts <dir> [--named] [--recursive] \
 *       [--concurrency=8] [--limit=N] [--dry-run]
 *
 * Auth (env or a gitignored scripts/import.env):
 *   CLOUDFLARE_API_TOKEN   token with D1:Edit + Workers R2 Storage:Edit
 *   CLOUDFLARE_ACCOUNT_ID  your account id
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extractMetadata, stripIdentifyingHeaders, type FlightMetadata } from '../src/lib/igc.ts';

// --- Prod resource ids (from wrangler.toml) ------------------------------------
const D1_DATABASE_ID = '0b6f991e-6fb8-4fbc-90fb-600aa020f175';
const R2_BUCKET = 'open-igc';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // keep in sync with src/lib/upload.ts

// --- Types ---------------------------------------------------------------------
type Flight = FlightMetadata & { id: string; size_bytes: number; uploaded_at: number };

interface Args {
  dir: string;
  named: boolean;
  recursive: boolean;
  concurrency: number;
  limit: number | null;
  dryRun: boolean;
}

// --- Arg parsing ---------------------------------------------------------------
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let named = false;
  let recursive = false;
  let dryRun = false;
  let concurrency = 8;
  let limit: number | null = null;

  for (const a of argv) {
    if (a === '--named') named = true;
    else if (a === '--recursive') recursive = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--concurrency=')) concurrency = Math.max(1, Number(a.slice(14)) || 8);
    else if (a.startsWith('--limit=')) limit = Math.max(0, Number(a.slice(8)) || 0);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}`);
    else positional.push(a);
  }

  if (positional.length !== 1) fail('Expected exactly one <dir> argument.\n' + usage());
  return { dir: positional[0], named, recursive, concurrency, limit, dryRun };
}

const usage = () =>
  'Usage: npx tsx scripts/import-igc.ts <dir> [--named] [--recursive] [--concurrency=8] [--limit=N] [--dry-run]';

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// --- Credentials ---------------------------------------------------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Load KEY=VALUE lines from scripts/import.env into process.env (without overriding). */
async function loadEnvFile(): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(SCRIPT_DIR, 'import.env'), 'utf8');
  } catch {
    return; // optional file
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// --- Cloudflare REST helpers ---------------------------------------------------
interface Creds {
  token: string;
  accountId: string;
}

/** fetch with retry/backoff on network errors, 429 and 5xx. */
async function fetchRetry(url: string, init: RequestInit, retries = 5): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await sleep(Math.min(500 * 2 ** attempt, 8000));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a D1 SQL statement via the REST query API. Returns the first statement's rows. */
async function d1Query<T = unknown>(creds: Creds, sql: string, params: unknown[] = []): Promise<T[]> {
  const url = `${API_BASE}/accounts/${creds.accountId}/d1/database/${D1_DATABASE_ID}/query`;
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    const detail = json?.errors?.map((e: any) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`D1 query failed: ${detail}`);
  }
  return (json.result?.[0]?.results ?? []) as T[];
}

/** PUT a gzip-compressed object into R2 via the REST object API. R2 holds gzip only. */
async function r2Put(creds: Creds, key: string, body: ArrayBuffer): Promise<void> {
  const url = `${API_BASE}/accounts/${creds.accountId}/r2/buckets/${R2_BUCKET}/objects/${key}`;
  const res = await fetchRetry(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${creds.token}`,
      'content-type': 'text/plain; charset=utf-8',
      'content-encoding': 'gzip',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 put ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

// --- Ingest (mirror of src/lib/upload.ts, minus the bindings) ------------------
/**
 * Hex SHA-256 of the given bytes — the flight id and R2 key. The Worker uses
 * `crypto.subtle`; node:crypto over the same UTF-8 bytes yields the identical hex.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Copy a (possibly view-backed) Uint8Array into a standalone ArrayBuffer for a fetch body. */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

const UPSERT_SQL = `INSERT INTO flights
    (id, flight_date, pilot_name, takeoff_lat, takeoff_lon, landing_lat, landing_lon,
     duration_s, max_altitude, point_count, glider_type, size_bytes, uploaded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    flight_date = excluded.flight_date,
    pilot_name = excluded.pilot_name,
    takeoff_lat = excluded.takeoff_lat,
    takeoff_lon = excluded.takeoff_lon,
    landing_lat = excluded.landing_lat,
    landing_lon = excluded.landing_lon,
    duration_s = excluded.duration_s,
    max_altitude = excluded.max_altitude,
    point_count = excluded.point_count,
    glider_type = excluded.glider_type,
    size_bytes = excluded.size_bytes,
    uploaded_at = excluded.uploaded_at`;

const upsertParams = (f: Flight): unknown[] => [
  f.id,
  f.flight_date,
  f.pilot_name,
  f.takeoff_lat,
  f.takeoff_lon,
  f.landing_lat,
  f.landing_lon,
  f.duration_s,
  f.max_altitude,
  f.point_count,
  f.glider_type,
  f.size_bytes,
  f.uploaded_at,
];

// --- File discovery ------------------------------------------------------------
async function findIgcFiles(dir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(p);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.igc')) {
        out.push(p);
      }
    }
  };
  await walk(dir);
  out.sort();
  return out;
}

// --- Concurrency pool ----------------------------------------------------------
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const n = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}

// --- Main ----------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadEnvFile();

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!args.dryRun && (!token || !accountId)) {
    fail(
      'Missing CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ACCOUNT_ID.\n' +
        'Set them in the environment or in a gitignored scripts/import.env file.\n' +
        '(A --dry-run needs no credentials.)',
    );
  }
  const creds: Creds = { token: token ?? '', accountId: accountId ?? '' };
  const anonymous = !args.named;
  const uploadedAt = Math.floor(Date.now() / 1000);

  // 1. Enumerate files.
  let files = await findIgcFiles(args.dir, args.recursive);
  if (args.limit != null) files = files.slice(0, args.limit);
  if (files.length === 0) fail(`No .igc files found in ${args.dir}${args.recursive ? ' (recursive)' : ''}.`);
  console.log(`Found ${files.length} .igc file(s)${anonymous ? ' — storing anonymously' : ' — storing named'}.`);

  // 2. Prefetch existing ids in one D1 call (skip in dry-run without creds).
  const known = new Set<string>();
  if (token && accountId) {
    console.log('Fetching existing flight ids from prod D1…');
    const rows = await d1Query<{ id: string }>(creds, 'SELECT id FROM flights');
    for (const r of rows) known.add(r.id);
    console.log(`  ${known.size} flight(s) already in the database.`);
  } else {
    console.log('Dry run without credentials: skipping the existing-id fetch (all files shown as "would add").');
  }

  // 3. Process files.
  const tally = { added: 0, duplicate: 0, rejected: new Map<string, number>(), errored: 0 };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let processed = 0;
  const total = files.length;

  await runPool(files, args.concurrency, async (path) => {
    try {
      const gzBytes = await readFile(path); // Buffer — the file on disk is already gzip
      const bytes = gunzipSync(gzBytes); // decompressed only for parsing/hashing below
      if (bytes.byteLength > MAX_FILE_BYTES) {
        bump(tally.rejected, 'too large (>5 MB)');
        return;
      }
      const text = new TextDecoder().decode(bytes);
      const parsed = extractMetadata(text);
      if (!parsed.ok) {
        bump(tally.rejected, parsed.error);
        return;
      }

      const scrubbed = new TextEncoder().encode(stripIdentifyingHeaders(text));
      const id = sha256Hex(scrubbed);
      // Named: upload the original gzip bytes as-is, no recompression. Anonymous:
      // the stored bytes must differ from the source file (headers blanked), so
      // there's no "as is" option — gzip the scrubbed text instead.
      const storeBuf = anonymous ? gzipSync(scrubbed) : gzBytes;
      const size_bytes = anonymous ? scrubbed.byteLength : bytes.byteLength;

      // check-and-claim must be synchronous (no await between) to avoid a race.
      if (known.has(id)) {
        tally.duplicate++;
        return;
      }
      known.add(id);

      const flight: Flight = {
        id,
        ...parsed.meta,
        pilot_name: anonymous ? 'Anonymous' : parsed.meta.pilot_name,
        size_bytes,
        uploaded_at: uploadedAt,
      };

      if (!args.dryRun) {
        await r2Put(creds, `${id}.igc`, toArrayBuffer(storeBuf));
        await d1Query(creds, UPSERT_SQL, upsertParams(flight));
      }
      tally.added++;
    } catch (e) {
      tally.errored++;
      console.error(`  ✗ ${path}: ${(e as Error).message}`);
    } finally {
      processed++;
      if (processed % 20 === 0 || processed === total) {
        console.log(
          `  …${processed}/${total} (added ${tally.added}, dup ${tally.duplicate}, rejected ${sum(tally.rejected)}, errors ${tally.errored})`,
        );
      }
    }
  });

  // 4. Report.
  console.log('\n' + (args.dryRun ? '=== DRY RUN — no writes performed ===' : '=== Done ==='));
  console.log(`${args.dryRun ? 'would add' : 'added'}   : ${tally.added}`);
  console.log(`duplicate : ${tally.duplicate}`);
  console.log(`errored   : ${tally.errored}`);
  const rejectedTotal = sum(tally.rejected);
  console.log(`rejected  : ${rejectedTotal}`);
  for (const [reason, count] of [...tally.rejected.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count}× ${reason}`);
  }
  if (tally.errored > 0) process.exitCode = 1;
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
