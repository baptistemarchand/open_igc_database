/** Format a duration in seconds as e.g. "2h 14m" or "47m". */
export function formatDuration(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

/** Format a lat/lon pair as e.g. "46.5210, 6.6320". */
export function formatCoord(lat: number, lon: number): string {
	return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** Format epoch seconds as a UTC date, e.g. "2026-07-09". */
export function formatEpochDate(epoch: number): string {
	return new Date(epoch * 1000).toISOString().slice(0, 10);
}

/** Human-readable file size, e.g. "412 KB". */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
