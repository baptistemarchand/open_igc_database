import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getStats } from '$lib/db';

export const load: PageServerLoad = async ({ platform, setHeaders }) => {
  if (!platform?.env) throw error(503, 'Database unavailable');

  // The snapshot only changes when scripts/compute-stats.sql is run by hand.
  setHeaders({ 'Cache-Control': 'public, max-age=300' });

  return { stats: await getStats(platform.env.DB) };
};
