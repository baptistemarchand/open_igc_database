import type IGCParser from 'igc-parser';

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
  GROUND_TIME: 32,
  POSITION_JUMP: 64,
  /** The processor could not read or parse the stored file, so nothing could be checked. */
  UNPROCESSABLE: 128,
} as const;

export type SuspiciousReason = keyof typeof SUSPICIOUS;

/**
 * Bits that need the track points, as opposed to the threshold bits, which only need
 * the stored metadata. All of them are computed by workers/processor; the offline
 * backfill rewrites only these, since a rule change can clear one.
 */
export const TRACK_BITS =
  SUSPICIOUS.ALT_SPIKE |
  SUSPICIOUS.BAD_TIMESTAMPS |
  SUSPICIOUS.TIME_GAP |
  SUSPICIOUS.GROUND_TIME |
  SUSPICIOUS.POSITION_JUMP;

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
/**
 * GROUND_TIME: the logger kept recording on the ground, parked or in a car, which
 * inflates the duration. Fixes are reduced to per-minute medians; a minute is "level"
 * when its altitude moved less than LEVEL_M from the previous minute's. A level minute
 * is parked if it also moved less than PARKED_M, and driving if it covered more than
 * DRIVING_M (60 km/h) but less than a position glitch would.
 *
 * Each signal alone failed on the corpus: level altitude also fits dune and ridge
 * soaring, and a 10-min fast stretch also fits competition wings gliding in lift. Level
 * *and* parked, or level *and* fast for many minutes, did separate. Measured: 182k files
 * have no driving minute, and real 8-11 h cross-country flights reach 6-20 (fast level
 * glides), hence the 20 floor; the car ride that motivated this had 107. Parked over an
 * hour is 385 files, flights with an hour or more of ground time before or after.
 */
const LEVEL_M = 15;
const PARKED_M = 50;
const DRIVING_M = 1000;
const GLITCH_M = 3000;
const MIN_DRIVING_MIN = 20;
const MIN_PARKED_MIN = 60;
/**
 * POSITION_JUMP: two consecutive fixes further apart than JUMP_M, at a speed no glider
 * reaches (JUMP_SPEED_MS is 360 km/h, about three times the fastest paraglider ground
 * speed). The case that motivated it: a logger writing 0°N 0°E before its first GPS
 * lock, which put takeoff in the Gulf of Guinea and scored 5,145 XC points.
 *
 * Measured over the 186k-file corpus: the count of files barely moves between 70 m/s
 * and 150 m/s (674 to 631 in a raw B-record scan), so real flights and glitches are well
 * apart. At 100 m/s, 591 files are flagged, 439 of them by this rule alone. Most jumps
 * are short (half are 2-5 km), 29 are over 1,000 km. The 2 km floor keeps a few metres
 * of noise between fixes logged in the same second from counting as infinite speed.
 */
const JUMP_M = 2000;
const JUMP_SPEED_MS = 100;

/** Human-readable text for the flight page banner. */
export const SUSPICIOUS_LABELS: Record<SuspiciousReason, string> = {
  ALT_TOO_HIGH: `Max altitude is above ${MAX_PLAUSIBLE_ALTITUDE_M.toLocaleString('en')} m`,
  TOO_LONG: `Duration is longer than ${MAX_PLAUSIBLE_DURATION_S / 3600} hours`,
  ALT_SPIKE: 'Max altitude comes from a GPS glitch no glider could climb to',
  BAD_TIMESTAMPS: 'Most fixes share the same timestamp, so the duration is unreliable',
  TIME_GAP: `The track has a gap of more than ${MAX_GAP_S / 60} minutes without fixes, so the duration is unreliable`,
  GROUND_TIME: 'The logger kept recording on the ground (parked or in a car), so the duration is unreliable',
  POSITION_JUMP: `The track jumps more than ${JUMP_M / 1000} km faster than any glider can fly (a GPS glitch), so positions and the XC score are unreliable`,
  UNPROCESSABLE: 'The stored file could not be read or parsed, so it could not be checked or scored',
};

/** One fix, as `trackFlags` needs it. `timestamp` is in ms. */
export interface TrackFix {
  timestamp: number;
  altitude: number | null;
  latitude: number;
  longitude: number;
}

/** The valid fixes of a parsed file, in the shape `trackFlags` reads. */
export function trackFixes(parsed: IGCParser.IGCFile): TrackFix[] {
  return parsed.fixes
    .filter((f) => f.valid)
    .map((f) => ({
      timestamp: f.timestamp,
      altitude: f.gpsAltitude ?? f.pressureAltitude,
      latitude: f.latitude,
      longitude: f.longitude,
    }));
}

/**
 * The track-derived bits (TRACK_BITS only), 0 when none apply. `timestamp` is in ms, as
 * igc-parser gives it: already monotonic across midnight, which is what makes a 12-hour
 * clock show up as a gap.
 */
export function trackFlags(fixes: readonly TrackFix[]): number {
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

  // All need elapsed time; with a stuck clock they would misread everything.
  if (!(flags & SUSPICIOUS.BAD_TIMESTAMPS)) {
    if (altitudeSpike(fixes)) flags |= SUSPICIOUS.ALT_SPIKE;
    if (groundTime(fixes)) flags |= SUSPICIOUS.GROUND_TIME;
    if (positionJump(fixes)) flags |= SUSPICIOUS.POSITION_JUMP;
  }

  return flags;
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];

/** Great-circle distance in metres. */
function distanceM(la1: number, lo1: number, la2: number, lo2: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

function positionJump(fixes: readonly TrackFix[]): boolean {
  for (let i = 1; i < fixes.length; i++) {
    const [a, b] = [fixes[i - 1], fixes[i]];
    const d = distanceM(a.latitude, a.longitude, b.latitude, b.longitude);
    if (d <= JUMP_M) continue;
    // A jump within the same timestamp is infinitely fast.
    const dt = (b.timestamp - a.timestamp) / 1000;
    if (dt <= 0 || d / dt > JUMP_SPEED_MS) return true;
  }
  return false;
}

function groundTime(fixes: readonly TrackFix[]): boolean {
  const pts = fixes.filter((f) => f.altitude != null);
  if (pts.length < 5) return false;

  // Medians per minute make one noisy fix irrelevant, which the raw fixes are not.
  const t0 = pts[0].timestamp;
  const buckets = new Map<number, { z: number[]; la: number[]; lo: number[] }>();
  for (const p of pts) {
    const m = Math.floor((p.timestamp - t0) / 60_000);
    let b = buckets.get(m);
    if (!b) buckets.set(m, (b = { z: [], la: [], lo: [] }));
    b.z.push(p.altitude!);
    b.la.push(p.latitude);
    b.lo.push(p.longitude);
  }
  const minutes = [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([m, b]) => ({ m, z: median(b.z), la: median(b.la), lo: median(b.lo) }));

  let parked = 0;
  let driving = 0;
  for (let i = 1; i < minutes.length; i++) {
    const [a, b] = [minutes[i - 1], minutes[i]];
    if (b.m !== a.m + 1 || Math.abs(b.z - a.z) >= LEVEL_M) continue;
    const d = distanceM(a.la, a.lo, b.la, b.lo);
    if (d < PARKED_M) parked++;
    else if (d > DRIVING_M && d < GLITCH_M) driving++;
  }
  return driving >= MIN_DRIVING_MIN || parked >= MIN_PARKED_MIN;
}

function altitudeSpike(fixes: readonly TrackFix[]): boolean {
  const pts = fixes.filter((f): f is TrackFix & { altitude: number } => f.altitude != null);
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
 * The full bitmask, or null when nothing applies: the threshold bits from the metadata,
 * plus the TRACK_BITS of `m.suspicious` (what `trackFlags` returned).
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
