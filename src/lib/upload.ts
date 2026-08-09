import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { getFlight, upsertFlight, type Flight } from '$lib/db';
import { extractMetadata, stripIdentifyingHeaders } from '$lib/igc';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — IGC files are small

/** Hex SHA-256 of the given bytes. Used both as the flight id and the R2 object key. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Gzip-compress bytes via the runtime's native CompressionStream (supported by both
 * `workerd` — Miniflare local dev and production — and Node, no dependency needed).
 * R2 stores gzip only, never raw IGC bytes; see the `contentEncoding` set in the
 * `BUCKET.put` below.
 */
async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** The storage bindings a single ingest needs. */
export interface IngestEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export interface IngestOptions {
  /** Strip identifying headers before storing and list the pilot as "Anonymous". */
  anonymous: boolean;
  /** Upload time, epoch seconds — passed in so a batch shares one timestamp. */
  uploadedAt: number;
}

export type IngestResult = { ok: true; status: 'added' | 'duplicate'; flight: Flight } | { ok: false; error: string };

/**
 * Ingest a single raw IGC file: validate it, store the bytes in R2 and upsert the
 * metadata row in D1. Shared by the browser upload form action and the POST /flights
 * API route so both behave identically.
 *
 * The id is the SHA-256 of the identifier-stripped bytes, so the same track dedups to
 * one flight whether or not it was uploaded anonymously. On an id conflict the row is
 * overwritten (latest-upload-wins, via upsertFlight); `status` reports whether the row
 * already existed. Never throws for bad input — junk is returned as { ok: false }.
 */
export async function ingestIgc(env: IngestEnv, buf: ArrayBuffer, opts: IngestOptions): Promise<IngestResult> {
  if (buf.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: 'File too large (max 5 MB).' };
  }

  const text = new TextDecoder().decode(buf);
  const parsed = extractMetadata(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // The id ignores identifying header fields, so the same track dedups to one flight
  // whether or not it was uploaded anonymously.
  const scrubbed = new TextEncoder().encode(stripIdentifyingHeaders(text)).buffer;
  const id = await sha256Hex(scrubbed);
  const storeBuf = opts.anonymous ? scrubbed : buf;

  // size_bytes reflects the logical (uncompressed) IGC file, so it's captured from
  // storeBuf before gzip — R2 itself holds only the compressed bytes.
  await env.BUCKET.put(`${id}.igc`, await gzip(storeBuf), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8', contentEncoding: 'gzip' },
  });

  const existed = (await getFlight(env.DB, id)) != null;
  const flight: Flight = {
    id,
    ...parsed.meta,
    pilot_name: opts.anonymous ? 'Anonymous' : parsed.meta.pilot_name,
    size_bytes: storeBuf.byteLength,
    uploaded_at: opts.uploadedAt,
  };
  await upsertFlight(env.DB, flight);

  return { ok: true, status: existed ? 'duplicate' : 'added', flight };
}
