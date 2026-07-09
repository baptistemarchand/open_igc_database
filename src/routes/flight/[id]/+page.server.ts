import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getFlight } from '$lib/db';

export const load: PageServerLoad = async ({ params, platform }) => {
	if (!platform?.env) throw error(503, 'Database unavailable');
	if (!/^[0-9a-f]{64}$/.test(params.id)) throw error(404, 'Not found');

	const flight = await getFlight(platform.env.DB_NAME, params.id);
	if (!flight) throw error(404, 'Flight not found');

	// In production, link straight to the R2 public domain (no Worker cost). In dev
	// (R2_PUBLIC_URL empty) fall back to the /f/[id] route that streams from the binding.
	const base = platform.env.R2_PUBLIC_URL?.replace(/\/$/, '');
	const downloadUrl = base ? `${base}/${flight.id}.igc` : `/f/${flight.id}`;

	return { flight, downloadUrl };
};
