import { error, json } from '@sveltejs/kit';
import { getAllFlights } from '$lib/db';
import type { RequestHandler } from './$types';

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
  const base = platform.env.R2_PUBLIC_URL?.replace(/\/$/, '');

  const items = flights.map((f) => ({
    ...f,
    url: base ? `${base}/${f.id}.igc` : `${url.origin}/f/${f.id}`,
  }));

  return json(items, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
};
