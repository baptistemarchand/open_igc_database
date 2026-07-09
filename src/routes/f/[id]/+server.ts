import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Streams a raw .igc file from the R2 bucket binding.
 *
 * In production, download links point straight at the R2 public domain (R2_PUBLIC_URL)
 * so file traffic never hits the Worker. This route is the local-dev / fallback path
 * used when R2_PUBLIC_URL is not configured.
 */
export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform?.env) throw error(503, 'Storage unavailable');
	if (!/^[0-9a-f]{64}$/.test(params.id)) throw error(400, 'Bad id');

	const obj = await platform.env.BUCKET.get(`${params.id}.igc`);
	if (!obj) throw error(404, 'File not found');

	return new Response(obj.body as unknown as BodyInit, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Content-Disposition': `attachment; filename="${params.id}.igc"`,
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
};
