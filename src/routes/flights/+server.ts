import { error, json } from '@sveltejs/kit';
import { DEFAULT_FLIGHTS_PAGE_SIZE, MAX_FLIGHTS_PAGE_SIZE, getFlightsPage, type Flight } from '$lib/db';
import { intParam } from '$lib/params';
import { ingestIgc } from '$lib/upload';
import type { RequestHandler } from './$types';

/** Build the public download URL for a flight, matching GET and POST responses. */
function fileUrl(f: Flight, env: App.Platform['env'], origin: string): string {
  const base = env.R2_PUBLIC_URL?.replace(/\/$/, '');
  return base ? `${base}/${f.id}.igc` : `${origin}/f/${f.id}`;
}

/**
 * Public JSON API: returns one page of flights, newest first.
 *
 * `limit` (default & max 1000) and `offset` (default 0) come from the query string
 * via `intParam`, which 400s on malformed or out-of-range values instead of
 * clamping them. Each item is the full D1 row plus a `url` field pointing at the
 * raw .igc file. In production that is the R2 public domain (R2_PUBLIC_URL); in
 * dev/fallback it is an absolute link to this app's own /f/<id> streaming route.
 *
 * The response also carries `total` and a `next` field: a ready-to-fetch absolute
 * URL for the following page, or `null` once there's nothing left. `next` is set
 * based on whether this page came back full (`flights.length === limit`), not by
 * comparing against `total` — the COUNT(*) and the page SELECT are separate D1
 * statements with no cross-statement snapshot isolation, so they can disagree by a
 * row or two under concurrent uploads. A client should follow `next` until `null`
 * to iterate the whole dataset.
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
  const page = await getFlightsPage(env.DB, limit, offset);

  const flights = page.flights.map((f) => ({
    ...f,
    url: fileUrl(f, env, url.origin),
  }));

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
