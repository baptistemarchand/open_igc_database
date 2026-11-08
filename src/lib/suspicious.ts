/**
 * Reasons a flight's data looks glitchy, as bit flags. `flights.suspicious` is NULL for a
 * normal flight and the OR of these bits otherwise. Append new reasons with the next
 * power of two and never renumber: the values are persisted.
 */
export const SUSPICIOUS = {
  ALT_TOO_HIGH: 1,
  TOO_LONG: 2,
} as const;

export type SuspiciousReason = keyof typeof SUSPICIOUS;

/** Thresholds. migrations/0006 hardcodes the same two numbers for the backfill. */
export const MAX_PLAUSIBLE_ALTITUDE_M = 10_000;
export const MAX_PLAUSIBLE_DURATION_S = 20 * 3600;

/** Human-readable text for the flight page banner. */
export const SUSPICIOUS_LABELS: Record<SuspiciousReason, string> = {
  ALT_TOO_HIGH: `Max altitude is above ${MAX_PLAUSIBLE_ALTITUDE_M.toLocaleString('en')} m`,
  TOO_LONG: `Duration is longer than ${MAX_PLAUSIBLE_DURATION_S / 3600} hours`,
};

/** The OR of every reason that applies, or null when none does. */
export function suspiciousFlags(m: { duration_s: number; max_altitude: number | null }): number | null {
  let flags = 0;
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
