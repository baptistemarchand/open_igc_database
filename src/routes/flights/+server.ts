import { error, json } from '@sveltejs/kit';
import { getAllFlights, type Flight } from '$lib/db';
import { ingestIgc } from '$lib/upload';
import type { RequestHandler } from './$types';

/** Build the public download URL for a flight, matching GET and POST responses. */
function fileUrl(f: Flight, env: App.Platform['env'], origin: string): string {
  const base = env.R2_PUBLIC_URL?.replace(/\/$/, '');
  return base ? `${base}/${f.id}.igc` : `${origin}/f/${f.id}`;
}

/**
 * Public JSON API: returns every flight as an array.
 *
 * Each item is the full D1 row plus a `url` field pointing at the raw .igc file.
 * In production that is the R2 public domain (R2_PUBLIC_URL); in dev/fallback it is
 * an absolute link to this app's own /f/<id> streaming route.
 */
export const GET: RequestHandler = async ({ platform, url }) => {
  if (!platform?.env) throw error(503, 'Storage unavailable');

  const flights = await getAllFlights(platform.env.DB_NAME);
  const env = platform.env;

  const items = flights.map((f) => ({
    ...f,
    url: fileUrl(f, env, url.origin),
  }));

  return json(items, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
};

/**
 * Public upload API: ingest a single raw .igc file sent as the request body
 * (e.g. `curl --data-binary @flight.igc`). Pass `?anonymous=1` to strip identifying
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
