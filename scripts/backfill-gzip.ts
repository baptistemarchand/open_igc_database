/**
 * One-off migration: gzip-compress every existing R2 `.igc` object, for flights
 * stored before src/lib/upload.ts started writing gzip.
 *
 * Two paths per D1 row, chosen automatically per id:
 *  - Fast (PUT only): <dir> has a local gzip copy matching this id — upload it
 *    directly, no R2 read. Named vs anonymous is decided from D1's CURRENT
 *    pilot_name (see below), not a CLI flag.
 *  - Fallback (GET+PUT): no local match (e.g. flights uploaded directly through
 *    the website) — fetch the current bytes from R2, gzip, write back. This path
 *    costs 2 requests against the Cloudflare account API's rate limit (1200/5min
 *    account-wide at last check), so a run is only as slow as however many rows
 *    fall through to it — if the local corpus covers everything, a full run is
 *    dominated by local disk I/O, not the network.
 *
 * ids + pilot_name come from D1 (`SELECT id, pilot_name FROM flights`), not an R2
 * list call — every flight row has exactly one R2 object at `{id}.igc`, so D1 is a
 * complete index of what needs compressing. No D1 writes happen here: size_bytes
 * already stores the *uncompressed* logical size (see CLAUDE.md), unaffected by
 * compression — this script touches R2 only.
 *
 * Named vs anonymous (fast path only; the fallback path has no local original to
 * choose between, so it just re-gzips whatever's already stored, headers and all):
 * `pilot_name === 'Anonymous'` means the row is stored with identifying headers
 * stripped (see src/lib/upload.ts / CLAUDE.md). `upsertFlight` always writes the D1
 * row and the R2 object together, so pilot_name is always in sync with what's
 * actually in R2 right now, regardless of this flight's upload history.
 *
 * No reliable "already gzip?" check exists through the account API (see
 * cf-api.ts's r2Get doc comment: fetch auto-decodes, and Cloudflare's edge also
 * gzips large plain responses on the fly independent of R2's stored metadata). So
 * every matched row is unconditionally (re)compressed — harmless if it was already
 * correct, just makes this safe (if not cheap) to re-run or interrupt.
 *
 * Usage:
 *   npx tsx scripts/backfill-gzip.ts <dir> [--recursive] [--concurrency=8] \
 *       [--limit=N] [--dry-run]
 *
 * Auth (env or a gitignored scripts/import.env):
 *   CLOUDFLARE_API_TOKEN   token with D1:Read + Workers R2 Storage:Edit
 *   CLOUDFLARE_ACCOUNT_ID  your account id
 */
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { stripIdentifyingHeaders } from '../src/lib/igc.ts';
import {
  D1_DATABASE_ID,
  R2_BUCKET,
  loadEnvFile,
  d1Query,
  r2Get,
  r2PutGzip,
  runPool,
  type Creds,
} from './lib/cf-api.ts';
import { mapLocalIdsToPaths } from './lib/local-igc.ts';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // keep in sync with src/lib/upload.ts
const D1_PAGE_SIZE = 10_000;

interface Args {
  dir: string;
  recursive: boolean;
  concurrency: number;
  limit: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let recursive = false;
  let dryRun = false;
  let concurrency = 8;
  let limit: number | null = null;

  for (const a of argv) {
    if (a === '--recursive') recursive = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--concurrency=')) concurrency = Math.max(1, Number(a.slice(14)) || 8);
    else if (a.startsWith('--limit=')) limit = Math.max(0, Number(a.slice(8)) || 0);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}\n${usage()}`);
    else positional.push(a);
  }

  if (positional.length !== 1) fail('Expected exactly one <dir> argument.\n' + usage());
  return { dir: positional[0], recursive, concurrency, limit, dryRun };
}

const usage = () =>
  'Usage: npx tsx scripts/backfill-gzip.ts <dir> [--recursive] [--concurrency=8] [--limit=N] [--dry-run]';

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

interface Row {
  id: string;
  pilot_name: string | null;
}

/** Page through every (id, pilot_name) in D1, ordered so LIMIT/OFFSET pagination is stable. */
async function fetchAllRows(creds: Creds, limit: number | null): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += D1_PAGE_SIZE) {
    const page = await d1Query<Row>(
      creds,
      D1_DATABASE_ID,
      'SELECT id, pilot_name FROM flights ORDER BY id LIMIT ? OFFSET ?',
      [D1_PAGE_SIZE, offset],
    );
    rows.push(...page);
    if (limit != null && rows.length >= limit) return rows.slice(0, limit);
    if (page.length < D1_PAGE_SIZE) return rows;
  }
}

/** Fast-path bytes to store: the local gzip file as-is, unless anonymizing requires
 * blanking header values first (which the source file's own bytes don't have). */
function fastPathBytes(gzBytes: Buffer, anonymous: boolean): Buffer {
  if (!anonymous) return gzBytes;
  const text = new TextDecoder().decode(gunzipSync(gzBytes));
  return gzipSync(new TextEncoder().encode(stripIdentifyingHeaders(text)));
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

  console.log(`Hashing local corpus at ${args.dir}…`);
  const localPaths = await mapLocalIdsToPaths(args.dir, args.recursive);
  console.log(`  ${localPaths.size} local file(s) matched to a flight id.`);

  console.log('Fetching (id, pilot_name) from prod D1…');
  const rows = await fetchAllRows(creds, args.limit);
  console.log(`${rows.length} flight(s) to process${args.dryRun ? ' (dry run — no writes)' : ''}.`);

  const tally = { fast: 0, fallback: 0, missing: 0, errored: 0 };
  let processed = 0;

  await runPool(rows, args.concurrency, async ({ id, pilot_name }) => {
    try {
      const localPath = localPaths.get(id);
      if (localPath != null) {
        const gzBytes = await readFile(localPath);
        if (!args.dryRun) {
          const storeBuf = fastPathBytes(gzBytes, pilot_name === 'Anonymous');
          await r2PutGzip(creds, R2_BUCKET, `${id}.igc`, storeBuf);
        }
        tally.fast++;
        return;
      }

      const obj = await r2Get(creds, R2_BUCKET, `${id}.igc`);
      if (obj == null) {
        tally.missing++;
        console.error(`  ✗ ${id}: no matching R2 object (D1 row with no file, and no local copy)`);
        return;
      }
      if (obj.body.byteLength > MAX_FILE_BYTES) {
        tally.errored++;
        console.error(`  ✗ ${id}: decoded body too large (>5 MB) — skipping`);
        return;
      }
      // obj.body is always plaintext (see r2Get's doc comment) — gzip it and store it
      // back unconditionally. Redundant if this object was already gzip; harmless.
      if (!args.dryRun) {
        await r2PutGzip(creds, R2_BUCKET, `${id}.igc`, gzipSync(Buffer.from(obj.body)));
      }
      tally.fallback++;
    } catch (e) {
      tally.errored++;
      console.error(`  ✗ ${id}: ${(e as Error).message}`);
    } finally {
      processed++;
      if (processed % 500 === 0 || processed === rows.length) {
        console.log(
          `  …${processed}/${rows.length} (fast ${tally.fast}, fallback ${tally.fallback}, ` +
            `missing ${tally.missing}, errors ${tally.errored})`,
        );
      }
    }
  });

  console.log('\n' + (args.dryRun ? '=== DRY RUN — no writes performed ===' : '=== Done ==='));
  console.log(`${args.dryRun ? 'would upload' : 'uploaded'} (fast, local)    : ${tally.fast}`);
  console.log(`${args.dryRun ? 'would upload' : 'uploaded'} (fallback, R2)   : ${tally.fallback}`);
  console.log(`missing R2 object              : ${tally.missing}`);
  console.log(`errored                        : ${tally.errored}`);
  if (tally.errored > 0 || tally.missing > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
