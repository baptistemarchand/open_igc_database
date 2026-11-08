import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { searchFlights, type SortKey } from '$lib/db';

const PAGE_SIZE = 50;
const SORT_KEYS: SortKey[] = ['date', 'duration', 'altitude', 'xcontest', 'ffvl'];

export const load: PageServerLoad = async ({ url, platform, setHeaders }) => {
  if (!platform?.env) throw error(503, 'Database unavailable');

  // Every distinct query string here is a separate crawlable URL backed by a real D1
  // query, and the content only changes on upload — so let repeat hits be served from
  // a cache rather than the database. Matches the max-age on GET /flights.
  //
  // This gets browsers and any intermediary for free; to also have Cloudflare's edge
  // absorb crawler traffic, the zone needs a Cache Rule that makes this path eligible
  // (HTML from a Worker is not edge-cached by default, header or no header).
  setHeaders({ 'Cache-Control': 'public, max-age=60' });

  const q = url.searchParams;
  const sortParam = q.get('sort') as SortKey | null;
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : 'date';
  const dir = q.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(parseInt(q.get('page') ?? '1', 10) || 1, 1);

  const filters = {
    pilot: q.get('pilot') ?? undefined,
    glider: q.get('glider') ?? undefined,
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
  };

  const { flights, total } = await searchFlights(platform.env.DB, {
    ...filters,
    sort,
    dir,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return {
    flights,
    total,
    page,
    pageSize: PAGE_SIZE,
    sort,
    dir,
    filters,
  };
};
