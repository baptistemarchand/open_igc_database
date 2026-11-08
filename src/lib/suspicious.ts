/**
 * Reasons a flight's data looks glitchy, as bit flags. `flights.suspicious` is NULL for a
 * normal flight and the OR of these bits otherwise. Append new reasons with the next
 * power of two and never renumber: the values are persisted.
 */
export const SUSPICIOUS = {
  ALT_TOO_HIGH: 1,
  TOO_LONG: 2,
  ALT_SPIKE: 4,
  BAD_TIMESTAMPS: 8,
} as const;

export type SuspiciousReason = keyof typeof SUSPICIOUS;

/**
 * Bits that need the track points. The others are recomputed from stored metadata
 * anywhere, but these exist only where the file was parsed, so they travel inside
 * `FlightMetadata.suspicious` and get backfilled from the corpus, not by SQL.
 */
export const TRACK_BITS = SUSPICIOUS.ALT_SPIKE | SUSPICIOUS.BAD_TIMESTAMPS;

/**
 * Thresholds, set just above the all-time paragliding records (about 8,400 m altitude
 * and 12 h airtime). The latest migration that backfills `suspicious` hardcodes the
 * same two numbers: changing them here needs a new backfill migration too.
 */
export const MAX_PLAUSIBLE_ALTITUDE_M = 9_000;
export const MAX_PLAUSIBLE_DURATION_S = 15 * 3600;

/**
 * ALT_SPIKE: how far the raw max may sit above the max of a 5-fix median filter. A
 * one- or two-fix spike vanishes under the filter. Measured over the 186k-file corpus:
 * 99.6% of files differ by 50 m or less, and the 240 above 500 m are sentinel values
 * (-500, 8915 between two fixes at 1490) rather than real climbs.
 */
const SPIKE_TOLERANCE_M = 500;
/**
 * BAD_TIMESTAMPS: the largest share of fixes that may carry one identical timestamp.
 * Loggers recording several fixes per second stay under 5%; a stuck clock (every fix
 * at 00:00:00) is above 90%. Only 3 corpus files fall in between. The absolute floor
 * keeps a tiny file from a 5 Hz logger from tripping it.
 */
const MAX_SAME_TIMESTAMP_SHARE = 0.2;
const MIN_SAME_TIMESTAMP_FIXES = 10;

/** Human-readable text for the flight page banner. */
export const SUSPICIOUS_LABELS: Record<SuspiciousReason, string> = {
  ALT_TOO_HIGH: `Max altitude is above ${MAX_PLAUSIBLE_ALTITUDE_M.toLocaleString('en')} m`,
  TOO_LONG: `Duration is longer than ${MAX_PLAUSIBLE_DURATION_S / 3600} hours`,
  ALT_SPIKE: 'Max altitude comes from an isolated GPS spike',
  BAD_TIMESTAMPS: 'Most fixes share the same timestamp, so the duration is unreliable',
};

/** The track-derived bits (TRACK_BITS only), 0 when none apply. */
export function trackFlags(fixes: readonly { timestamp: number; altitude: number | null }[]): number {
  let flags = 0;

  const alts = fixes.map((f) => f.altitude).filter((a): a is number => a != null);
  let rawMax = -Infinity;
  let filteredMax = -Infinity;
  const window: number[] = [];
  for (let i = 0; i < alts.length; i++) {
    if (alts[i] > rawMax) rawMax = alts[i];
    window.length = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(alts.length - 1, i + 2); j++) window.push(alts[j]);
    window.sort((a, b) => a - b);
    const median = window[window.length >> 1];
    if (median > filteredMax) filteredMax = median;
  }
  if (rawMax - filteredMax > SPIKE_TOLERANCE_M) flags |= SUSPICIOUS.ALT_SPIKE;

  const counts = new Map<number, number>();
  let top = 0;
  for (const f of fixes) {
    const n = (counts.get(f.timestamp) ?? 0) + 1;
    counts.set(f.timestamp, n);
    if (n > top) top = n;
  }
  if (top >= MIN_SAME_TIMESTAMP_FIXES && top / fixes.length >= MAX_SAME_TIMESTAMP_SHARE)
    flags |= SUSPICIOUS.BAD_TIMESTAMPS;

  return flags;
}

/**
 * The full bitmask, or null when nothing applies. The threshold bits are always
 * recomputed from the metadata; only TRACK_BITS are taken from `m.suspicious`, which
 * is how a value claimed by the upload page can't set the other bits by itself.
 */
export function suspiciousFlags(m: {
  duration_s: number;
  max_altitude: number | null;
  suspicious: number | null;
}): number | null {
  let flags = (m.suspicious ?? 0) & TRACK_BITS;
  if (m.max_altitude != null && m.max_altitude > MAX_PLAUSIBLE_ALTITUDE_M) flags |= SUSPICIOUS.ALT_TOO_HIGH;
  if (m.duration_s > MAX_PLAUSIBLE_DURATION_S) flags |= SUSPICIOUS.TOO_LONG;
  return flags === 0 ? null : flags;
}

/** Decode a stored bitmask into the labels to show. Unknown bits are ignored. */
export function suspiciousReasons(flags: number | null): string[] {
  if (!flags) return [];
  return (Object.keys(SUSPICIOUS) as SuspiciousReason[])
    .filter((k) => flags & SUSPICIOUS[k])
    .map((k) => SUSPICIOUS_LABELS[k]);
}
