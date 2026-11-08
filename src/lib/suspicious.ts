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
  TIME_GAP: 16,
} as const;

export type SuspiciousReason = keyof typeof SUSPICIOUS;

/**
 * Bits that need the track points. The others are recomputed from stored metadata
 * anywhere, but these exist only where the file was parsed, so they travel inside
 * `FlightMetadata.suspicious` and get backfilled from the corpus, not by SQL.
 */
export const TRACK_BITS = SUSPICIOUS.ALT_SPIKE | SUSPICIOUS.BAD_TIMESTAMPS | SUSPICIOUS.TIME_GAP;

/**
 * Thresholds, set just above the all-time paragliding records (about 8,400 m altitude
 * and 12 h airtime). The latest migration that backfills `suspicious` hardcodes the
 * same two numbers: changing them here needs a new backfill migration too.
 */
export const MAX_PLAUSIBLE_ALTITUDE_M = 9_000;
export const MAX_PLAUSIBLE_DURATION_S = 15 * 3600;

/**
 * ALT_SPIKE: a speed gate. Starting from the median altitude of the first minutes, a fix
 * is kept only if a glider could have reached it from the last kept fix: within
 * MAX_VERTICAL_SPEED × elapsed time, plus GPS noise. The flag is set when the raw max
 * sits more than SPIKE_TOLERANCE_M above the kept max.
 *
 * It replaced a 5-fix median filter, which missed glitches that weren't isolated:
 * altitudes flipping back and forth every fix, a doubled altitude, a jump on the last
 * fixes (the window is cut short at the ends), and a GPS cold start that begins at
 * 7,674 m. Measured over the 186k-file corpus: 99.6% of files keep their max within
 * 50 m, and 414 are flagged. The seed is the early median, not the first fix, precisely
 * because of the cold-start case.
 */
const MAX_VERTICAL_SPEED_MS = 30;
const ALTITUDE_NOISE_M = 100;
const SEED_WINDOW_S = 300;
const SPIKE_TOLERANCE_M = 500;
/**
 * TIME_GAP: the longest allowed stretch with no fixes. A gap inflates the duration: a
 * logger left on between two flights, garbage fixes hours before takeoff, or a 12-hour
 * clock writing 13:00 as 01:00 (the parser reads that as 12 h later). Measured: 0.5% of
 * the corpus has a gap over 30 minutes.
 */
const MAX_GAP_S = 30 * 60;
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
  ALT_SPIKE: 'Max altitude comes from a GPS glitch no glider could climb to',
  BAD_TIMESTAMPS: 'Most fixes share the same timestamp, so the duration is unreliable',
  TIME_GAP: `The track has a gap of more than ${MAX_GAP_S / 60} minutes without fixes, so the duration is unreliable`,
};

/**
 * The track-derived bits (TRACK_BITS only), 0 when none apply. `timestamp` is in ms, as
 * igc-parser gives it: already monotonic across midnight, which is what makes a 12-hour
 * clock show up as a gap.
 */
export function trackFlags(fixes: readonly { timestamp: number; altitude: number | null }[]): number {
  let flags = 0;

  const counts = new Map<number, number>();
  let top = 0;
  for (const f of fixes) {
    const n = (counts.get(f.timestamp) ?? 0) + 1;
    counts.set(f.timestamp, n);
    if (n > top) top = n;
  }
  if (top >= MIN_SAME_TIMESTAMP_FIXES && top / fixes.length >= MAX_SAME_TIMESTAMP_SHARE)
    flags |= SUSPICIOUS.BAD_TIMESTAMPS;

  for (let i = 1; i < fixes.length; i++) {
    if (fixes[i].timestamp - fixes[i - 1].timestamp > MAX_GAP_S * 1000) {
      flags |= SUSPICIOUS.TIME_GAP;
      break;
    }
  }

  // The gate needs elapsed time; with a stuck clock it would reject everything.
  if (!(flags & SUSPICIOUS.BAD_TIMESTAMPS) && altitudeSpike(fixes)) flags |= SUSPICIOUS.ALT_SPIKE;

  return flags;
}

function altitudeSpike(fixes: readonly { timestamp: number; altitude: number | null }[]): boolean {
  const pts = fixes.filter((f): f is { timestamp: number; altitude: number } => f.altitude != null);
  if (pts.length < 5) return false;

  const t0 = pts[0].timestamp;
  let early = pts.filter((p) => p.timestamp - t0 <= SEED_WINDOW_S * 1000);
  if (early.length < 5) early = pts.slice(0, 5);
  const sorted = early.map((p) => p.altitude).sort((a, b) => a - b);

  let lastAlt = sorted[sorted.length >> 1];
  let lastT = t0;
  let rawMax = -Infinity;
  let keptMax = -Infinity;
  for (const p of pts) {
    if (p.altitude > rawMax) rawMax = p.altitude;
    const dt = Math.max(0, p.timestamp - lastT) / 1000;
    if (Math.abs(p.altitude - lastAlt) <= MAX_VERTICAL_SPEED_MS * dt + ALTITUDE_NOISE_M) {
      lastAlt = p.altitude;
      lastT = p.timestamp;
      if (p.altitude > keptMax) keptMax = p.altitude;
    }
  }
  return rawMax - keptMax > SPIKE_TOLERANCE_M;
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
