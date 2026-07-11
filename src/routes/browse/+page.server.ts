import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { searchFlights, type SortKey } from '$lib/db';

const PAGE_SIZE = 50;
const SORT_KEYS: SortKey[] = ['date', 'duration', 'altitude'];

export const load: PageServerLoad = async ({ url, platform }) => {
  if (!platform?.env) throw error(503, 'Database unavailable');

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
