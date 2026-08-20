import { error, json } from '@sveltejs/kit';
import {
  DEFAULT_FLIGHTS_PAGE_SIZE,
  FLIGHT_COLUMNS,
  MAX_FLIGHTS_PAGE_SIZE,
  getFlightsPage,
  type Flight,
  type FlightColumn,
} from '$lib/db';
import { fieldsParam, intParam } from '$lib/params';
import { ingestIgc } from '$lib/upload';
import type { RequestHandler } from './$types';

/** Build the public download URL for a flight, matching GET and POST responses. */
function fileUrl(f: Pick<Flight, 'id'>, env: App.Platform['env'], origin: string): string {
  const base = env.R2_PUBLIC_URL?.replace(/\/$/, '');
  return base ? `${base}/${f.id}.igc` : `${origin}/f/${f.id}`;
}

/**
 * Field names `?fields=` accepts: every D1 column, plus `url`, which is derived rather
 * than stored. `fields=all` selects all of them.
 */
const SELECTABLE_FIELDS = [...FLIGHT_COLUMNS, 'url'] as const;
const ALL_FIELDS = 'all';

/**
 * Public JSON API: returns one page of flights, newest first.
 *
 * `limit` (default & max 1000) and `offset` (default 0) come from the query string
 * via `intParam`, which 400s on malformed or out-of-range values instead of
 * clamping them.
 *
 * Each item carries only the fields named by `?fields=`, defaulting to `url` alone —
 * a link to the raw .igc file, which is all most consumers want and keeps the worker
 * off the hook for reading and serialising fifteen columns per row. Pass
 * `fields=all` for the whole D1 row, or a comma-separated subset; unknown names 400
 * (see `fieldsParam`). `url` is the R2 public domain (R2_PUBLIC_URL) in production and
 * an absolute link to this app's own /f/<id> streaming route in dev/fallback.
 *
 * The response also carries `total` and a `next` field: a ready-to-fetch absolute
 * URL for the following page, or `null` once there's nothing left. `next` is set
 * based on whether this page came back full (`flights.length === limit`), not by
 * comparing against `total` — the COUNT(*) and the page SELECT are separate D1
 * statements with no cross-statement snapshot isolation, so they can disagree by a
 * row or two under concurrent uploads. A client should follow `next` until `null`
 * to iterate the whole dataset. It is built by copying this request's URL, so
 * `fields` (and anything else the caller sent) rides along to the next page for free.
 */
export const GET: RequestHandler = async ({ platform, url }) => {
  if (!platform?.env) throw error(503, 'Storage unavailable');

  const env = platform.env;
  const limit = intParam(url.searchParams, 'limit', {
    default: DEFAULT_FLIGHTS_PAGE_SIZE,
    min: 1,
    max: MAX_FLIGHTS_PAGE_SIZE,
  });
  const offset = intParam(url.searchParams, 'offset', { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  const fields = fieldsParam(url.searchParams, 'fields', {
    allowed: SELECTABLE_FIELDS,
    default: ['url'],
    all: ALL_FIELDS,
  });

  // `url` is built from the id, so fetch `id` whenever it's wanted — but emit it only
  // if the caller actually asked for it, hence picking keys explicitly below rather
  // than spreading the row.
  const emitUrl = fields.includes('url');
  const emitColumns = fields.filter((f): f is FlightColumn => f !== 'url');
  const fetchColumns = emitUrl && !emitColumns.includes('id') ? (['id', ...emitColumns] as const) : emitColumns;

  const page = await getFlightsPage(env.DB, limit, offset, fetchColumns);

  const flights = page.flights.map((f) => {
    const item: Partial<Flight> & { url?: string } = {};
    // `as never`: TS can't correlate item[col] with f[col] when col is a union of keys.
    for (const col of emitColumns) item[col] = f[col] as never;
    if (emitUrl) item.url = fileUrl(f as Pick<Flight, 'id'>, env, url.origin);
    return item;
  });

  let next: string | null = null;
  if (flights.length === page.limit) {
    const nextUrl = new URL(url);
    nextUrl.searchParams.set('limit', String(page.limit));
    nextUrl.searchParams.set('offset', String(page.offset + page.limit));
    next = nextUrl.toString();
  }

  return json(
    { flights, total: page.total, limit: page.limit, offset: page.offset, next },
    { headers: { 'Cache-Control': 'public, max-age=60' } },
  );
};

/**
 * Public upload API: ingest a single raw .igc file sent as the request body
 * (e.g. `curl --data-binary @flight.igc -H "Content-Type: application/octet-stream"`).
 * The explicit content-type matters: curl's default (application/x-www-form-urlencoded)
 * trips SvelteKit's CSRF form-submission guard. Pass `?anonymous=1` to strip identifying
 * headers and list the pilot as "Anonymous". No auth — this endpoint is for scripts.
 *
 * Responds with the flight row plus `url` and `status`: HTTP 201 when the flight is new,
 * 200 when the same track was already stored (dedup by content hash), 400 for junk.
 */
export const POST: RequestHandler = async ({ request, platform, url }) => {
  if (!platform?.env) throw error(503, 'Storage unavailable');

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw error(400, 'Empty request body — send the .igc file as the body.');

  const anonymous = url.searchParams.get('anonymous') != null;
  const result = await ingestIgc(platform.env, buf, {
    anonymous,
    uploadedAt: Math.floor(Date.now() / 1000),
  });

  if (!result.ok) return json({ error: result.error }, { status: 400 });

  return json(
    { status: result.status, ...result.flight, url: fileUrl(result.flight, platform.env, url.origin) },
    { status: result.status === 'added' ? 201 : 200 },
  );
};
