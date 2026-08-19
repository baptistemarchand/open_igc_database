/**
 * Shared Cloudflare REST API helpers for one-off scripts that operate on prod D1 + R2
 * directly, bypassing the deployed Worker (whose free-plan per-request CPU budget
 * 503s under sustained bulk load — see scripts/import-igc.ts). Used by
 * scripts/import-igc.ts and scripts/backfill-gzip.ts.
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Prod resource ids (from wrangler.toml) --------------------------------------
export const D1_DATABASE_ID = '0b6f991e-6fb8-4fbc-90fb-600aa020f175';
export const R2_BUCKET = 'open-igc';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface Creds {
  token: string;
  accountId: string;
}

// --- Credentials ------------------------------------------------------------------
const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // lib/ -> scripts/

/** Load KEY=VALUE lines from scripts/import.env into process.env (without overriding). */
export async function loadEnvFile(): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(SCRIPTS_DIR, 'import.env'), 'utf8');
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

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Client-side rate limiting ---------------------------------------------------
// The account API caps at 1200 req/5min (seen via the `ratelimit-policy` response
// header while building this). Firing at whatever --concurrency allows and reacting
// to 429s isn't enough: once that budget is blown, the window doesn't free up again
// for potentially minutes, far longer than a short backoff waits — this is exactly
// what happened in testing (clean for ~1000 requests, then a compounding 429 storm
// for the rest of the run). So every request — across all concurrent callers, via
// this module-level gate — is proactively paced to stay under the limit, rather
// than hoping retries catch up after the fact.
const TARGET_REQUESTS_PER_SEC = 3.8; // just under 1200/300s = 4/s, leaves a little headroom
const MIN_INTERVAL_MS = 1000 / TARGET_REQUESTS_PER_SEC;
let nextSlot = 0;

async function rateLimitGate(): Promise<void> {
  const now = Date.now();
  const scheduled = Math.max(now, nextSlot);
  nextSlot = scheduled + MIN_INTERVAL_MS;
  if (scheduled > now) await sleep(scheduled - now);
}

/** Exponential backoff with jitter (avoids concurrent callers retrying in lockstep),
 * honoring Retry-After when the server sends one. Capped at 60s, well past what the
 * proactive gate above should ever require in practice — this is a safety net. */
function backoffMs(res: Response | null, attempt: number): number {
  const retryAfter = Number(res?.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000 + Math.random() * 250;
  return Math.min(1000 * 2 ** attempt, 60_000) * (0.5 + Math.random());
}

/** fetch with rate-limiting + retry/backoff on network errors, 429 and 5xx. */
export async function fetchRetry(url: string, init: RequestInit, retries = 8): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimitGate();
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      if (attempt < retries) await sleep(backoffMs(res, attempt));
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(backoffMs(null, attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Run a D1 SQL statement via the REST query API. Returns the first statement's rows. */
export async function d1Query<T = unknown>(
  creds: Creds,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = `${API_BASE}/accounts/${creds.accountId}/d1/database/${databaseId}/query`;
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

export interface R2GetResult {
  /** Always plaintext — see the two gotchas below. Never the raw stored bytes. */
  body: ArrayBuffer;
  /** The Content-Encoding response header, as-received. Informational only — see below. */
  contentEncoding: string | null;
}

/**
 * GET a raw object from R2 via the REST object API. Returns null on 404.
 *
 * Two gotchas discovered empirically while writing scripts/compress-igc-r2.ts, both
 * meaning `body` is always decoded plaintext and `contentEncoding` can't tell you
 * whether the object is *actually* stored gzip in R2:
 *
 *  1. If the object's stored `httpMetadata.contentEncoding` is `gzip`, `fetch` decodes
 *     `body` transparently per the Fetch spec — there is no way to get the raw
 *     compressed bytes back through this call. Sniffing `body` for gzip magic bytes
 *     to detect "already compressed" will never find them.
 *  2. Cloudflare's edge also gzips large plain-text API responses on the fly,
 *     independent of the object's actual stored encoding — so `contentEncoding: gzip`
 *     on the response does NOT reliably mean the object is stored as gzip either. (A
 *     real stored-gzip object comes back with a `content-length` matching its exact
 *     compressed size; edge-injected transport compression comes back chunked, with
 *     no `content-length` — that distinction held in testing but isn't a documented
 *     contract, so don't build correctness-critical logic on it.)
 *
 * Net effect: there's no reliable way to ask "is this object already gzip?" through
 * this API. Treat `body` as plaintext unconditionally and re-gzip it — redundant if
 * it was already stored compressed, but harmless (see compress-igc-r2.ts).
 */
export async function r2Get(creds: Creds, bucket: string, key: string): Promise<R2GetResult | null> {
  const url = `${API_BASE}/accounts/${creds.accountId}/r2/buckets/${bucket}/objects/${key}`;
  const res = await fetchRetry(url, { method: 'GET', headers: { authorization: `Bearer ${creds.token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get ${key} failed: HTTP ${res.status}`);
  return { body: await res.arrayBuffer(), contentEncoding: res.headers.get('content-encoding') };
}

/** PUT a gzip-compressed object into R2 via the REST object API. R2 holds gzip only. */
export async function r2PutGzip(creds: Creds, bucket: string, key: string, body: Uint8Array): Promise<void> {
  const url = `${API_BASE}/accounts/${creds.accountId}/r2/buckets/${bucket}/objects/${key}`;
  const res = await fetchRetry(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${creds.token}`,
      'content-type': 'text/plain; charset=utf-8',
      'content-encoding': 'gzip',
    },
    // .slice() copies into a fresh, concrete ArrayBuffer — callers may pass a Buffer
    // (Node's pooled-allocator-backed Uint8Array), which BodyInit doesn't accept directly.
    body: body.slice(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 put ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

/** Bounded-concurrency worker pool. */
export async function runPool<T>(
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
