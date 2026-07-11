import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types';
import { getFlight } from '$lib/db';

export const load: PageServerLoad = async ({ params, platform }) => {
  if (!platform?.env) throw error(503, 'Database unavailable');
  if (!/^[0-9a-f]{64}$/.test(params.id)) throw error(404, 'Not found');

  const flight = await getFlight(platform.env.DB, params.id);
  if (!flight) throw error(404, 'Flight not found');

  // In production, link straight to the R2 public domain (no Worker cost). In dev the
  // file lives only in local Miniflare R2 (not the cloud bucket the public URL points
  // at), so always use the /f/[id] route that streams from the binding — otherwise both
  // the download link and the client-side map fetch 404. `dev` is the reliable signal:
  // R2_PUBLIC_URL is set unconditionally in wrangler.toml [vars], including under vite dev.
  const base = platform.env.R2_PUBLIC_URL?.replace(/\/$/, '');
  const downloadUrl = base && !dev ? `${base}/${flight.id}.igc` : `/f/${flight.id}`;

  // The map track is fetched from `downloadUrl` and parsed in the browser (see
  // +page.svelte). The worker deliberately does NOT read/parse the .igc here — that
  // re-parse ran on every detail view and was the app's heaviest CPU cost.
  return { flight, downloadUrl };
};
