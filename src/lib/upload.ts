import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types';
import { deleteFlight, getFlight, insertFlight, type NewFlight } from '$lib/db';
import { checkClaimedMetadata, extractMetadata, stripIdentifyingHeaders, type ExtractResult } from '$lib/igc';
import { gunzipCapped, gzip, isGzip } from '$lib/gzip';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — IGC files are small

/** Hex SHA-256 of the given bytes. Used both as the flight id and the R2 object key. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Message body on the flight-processing queue, consumed by workers/processor. */
export interface ProcessMessage {
  id: string;
}

/** The bindings a single ingest needs. */
export interface IngestEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  FLIGHT_QUEUE: Queue<ProcessMessage>;
}

export interface IngestOptions {
  /** Strip identifying headers before storing and list the pilot as "Anonymous". */
  anonymous: boolean;
  /** Upload time, epoch seconds — passed in so a batch shares one timestamp. */
  uploadedAt: number;
  /**
   * Metadata the client already extracted (the upload page does). When present the
   * Worker skips parsing and only shape-checks it. Absent for API and no-JS uploads,
   * which are parsed here.
   */
  claimedMetadata?: unknown;
}

export const DUPLICATE_ERROR = 'This flight is already in the database.';

export type IngestResult =
  | { ok: true; flight: NewFlight }
  /** `existingId` is set only when the file was refused as a duplicate. */
  | { ok: false; error: string; existingId?: string };

/**
 * Ingest a single raw IGC file: validate it, insert the metadata row in D1, store the
 * bytes in R2 and queue the flight for processing (glitch checks and XC scores, in
 * workers/processor). Shared by the browser upload form action and the POST /flights
 * API route so both behave identically. No glitch check runs here: the row starts with
 * `processed_at` and `suspicious` NULL, which keeps it out of /browse and /stats.
 *
 * The id is the SHA-256 of the identifier-stripped bytes, so the same track dedups to
 * one flight whether or not it was uploaded anonymously. A file whose id already exists
 * is refused with `existingId`. Never throws for bad input — junk is returned as
 * { ok: false }.
 *
 * `body` may be the IGC bytes or a gzip of them (detected by magic bytes, so any client
 * can send either). Gzip is the single most expensive step of an ingest, so the upload
 * page compresses in the browser and the Worker only inflates — several times cheaper —
 * then stores the client's gzip untouched. That is safe because inflating it is what
 * produced the text we validated and hashed: the stored bytes can't differ from it.
 */
export async function ingestIgc(env: IngestEnv, body: ArrayBuffer, opts: IngestOptions): Promise<IngestResult> {
  const tooLarge = { ok: false, error: 'File too large (max 5 MB).' } as const;
  if (body.byteLength > MAX_FILE_BYTES) return tooLarge;

  let buf = body;
  let clientGzip: ArrayBuffer | null = null;
  if (isGzip(body)) {
    let inflated: ArrayBuffer | null;
    try {
      inflated = await gunzipCapped(body, MAX_FILE_BYTES);
    } catch {
      return { ok: false, error: 'Corrupt gzip data.' };
    }
    if (!inflated) return tooLarge;
    buf = inflated;
    clientGzip = body;
  }

  const text = new TextDecoder().decode(buf);
  const parsed = opts.claimedMetadata === undefined ? extractMetadata(text) : checkClaimed(text, opts.claimedMetadata);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // The id ignores identifying header fields, so the same track dedups to one flight
  // whether or not it was uploaded anonymously.
  const scrubbedText = stripIdentifyingHeaders(text);
  const scrubbed = new TextEncoder().encode(scrubbedText).buffer;
  const id = await sha256Hex(scrubbed);
  // An anonymous file the page already stripped needs no rewrite, which is what lets
  // anonymous uploads keep the client's gzip too. Re-stripping is the check: never trust
  // the client to have done it.
  const storeBuf = opts.anonymous && scrubbedText !== text ? scrubbed : buf;
  const gz = clientGzip && storeBuf === buf ? clientGzip : await gzip(storeBuf);

  // Checked before the R2 put: the object key is the id, so storing first would let a
  // named upload overwrite the stripped file of a flight uploaded anonymously.
  const duplicate = { ok: false, error: DUPLICATE_ERROR, existingId: id } as const;
  if ((await getFlight(env.DB, id)) != null) return duplicate;

  // size_bytes reflects the logical (uncompressed) IGC file, so it's captured from
  // storeBuf before gzip — R2 itself holds only the compressed bytes.
  const flight: NewFlight = {
    id,
    ...parsed.meta,
    pilot_name: opts.anonymous ? 'Anonymous' : parsed.meta.pilot_name,
    size_bytes: storeBuf.byteLength,
    uploaded_at: opts.uploadedAt,
  };
  // Row first, so a concurrent upload of the same file loses here, before it can touch R2.
  if (!(await insertFlight(env.DB, flight))) return duplicate;

  try {
    await env.BUCKET.put(`${id}.igc`, gz, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8', contentEncoding: 'gzip' },
    });
  } catch (e) {
    await deleteFlight(env.DB, id);
    throw e;
  }

  // Best effort: the processor's cron re-enqueues every row still unprocessed, so a
  // failed send only delays the flight instead of failing an upload that did succeed.
  try {
    await env.FLIGHT_QUEUE.send({ id });
  } catch (e) {
    console.error(`Could not queue ${id} for processing`, e);
  }

  return { ok: true, flight };
}

/**
 * Trusted-metadata path. The values are the client's word: a hand-crafted request can
 * store wrong metadata for its own file. What it can't do is overwrite another flight
 * (the id is still hashed here) or store something that isn't even shaped like an IGC
 * file — hence the O(1)-ish sniff below, in place of a parse.
 */
function checkClaimed(text: string, claimed: unknown): ExtractResult {
  if (!/^\uFEFF?\s*A/.test(text) || !text.includes('\nB')) {
    return { ok: false, error: 'Not a valid IGC file: no A record or no fixes.' };
  }
  const meta = checkClaimedMetadata(claimed);
  return meta ? { ok: true, meta } : { ok: false, error: 'Invalid flight metadata.' };
}
