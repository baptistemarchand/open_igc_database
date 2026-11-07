import IGCParser from 'igc-parser';
import tzlookup from 'tz-lookup';

// Lives in its own module so the browser can strip headers without bundling the parser.
export { stripIdentifyingHeaders } from './anonymize';

/** Metadata extracted from an IGC file, ready to insert into D1 (minus id/size/uploaded_at). */
export interface FlightMetadata {
  flight_date: string; // ISO 'YYYY-MM-DD'
  pilot_name: string | null;
  takeoff_hour: number | null; // local hour of day at takeoff, 0-23
  takeoff_tz: string | null; // IANA zone from the takeoff coords, e.g. 'Europe/Paris'
  takeoff_lat: number;
  takeoff_lon: number;
  landing_lat: number;
  landing_lon: number;
  duration_s: number;
  max_altitude: number | null;
  point_count: number;
  glider_type: string | null;
}

export type ExtractResult = { ok: true; meta: FlightMetadata } | { ok: false; error: string };

/** Minimum number of valid GPS fixes for a file to count as a real flight. */
const MIN_VALID_FIXES = 5;

/**
 * True only for a real calendar date in strict 'YYYY-MM-DD' form. Guards against
 * strings that match the shape but aren't real dates, e.g. '2000-00-00' — which
 * igc-parser passes through verbatim from an HFDTE000000 header.
 */
function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [, y, mo, d] = m;
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() + 1 === Number(mo) && dt.getUTCDate() === Number(d);
}

/**
 * Request header carrying browser-computed metadata, as `encodeURIComponent(JSON)`:
 * header values must be Latin-1, and pilot names often aren't.
 */
export const METADATA_HEADER = 'X-Flight-Metadata';

const MAX_TEXT_FIELD = 200;
const IANA_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/**
 * Shape-check metadata a client computed with `extractMetadata`, without the file.
 * This can't prove the values match the track (that would mean parsing it, the cost
 * we're avoiding); it only keeps impossible values out of D1: types, ranges, a real
 * date, bounded strings. Returns null when anything is off.
 */
export function checkClaimedMetadata(raw: unknown): FlightMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && num(v, min, max);
  const text = (v: unknown) => v === null || (typeof v === 'string' && v.length <= MAX_TEXT_FIELD);

  if (typeof m.flight_date !== 'string' || !isRealDate(m.flight_date)) return null;
  if (!num(m.takeoff_lat, -90, 90) || !num(m.landing_lat, -90, 90)) return null;
  if (!num(m.takeoff_lon, -180, 180) || !num(m.landing_lon, -180, 180)) return null;
  if (!int(m.duration_s, 0, 7 * 86400)) return null;
  if (!int(m.point_count, MIN_VALID_FIXES, 10_000_000)) return null;
  if (m.max_altitude !== null && !int(m.max_altitude, -1000, 20_000)) return null;
  if (m.takeoff_hour !== null && !int(m.takeoff_hour, 0, 23)) return null;
  if (m.takeoff_tz !== null && !(typeof m.takeoff_tz === 'string' && IANA_ZONE.test(m.takeoff_tz))) return null;
  if (!text(m.pilot_name) || !text(m.glider_type)) return null;

  // Rebuilt field by field so unknown keys never reach the INSERT.
  return {
    flight_date: m.flight_date,
    pilot_name: m.pilot_name as string | null,
    takeoff_hour: m.takeoff_hour as number | null,
    takeoff_tz: m.takeoff_tz as string | null,
    takeoff_lat: m.takeoff_lat as number,
    takeoff_lon: m.takeoff_lon as number,
    landing_lat: m.landing_lat as number,
    landing_lon: m.landing_lon as number,
    duration_s: m.duration_s as number,
    max_altitude: m.max_altitude as number | null,
    point_count: m.point_count as number,
    glider_type: m.glider_type as string | null,
  };
}

/**
 * Parse an IGC file and extract the searchable/displayable metadata. Runs on the
 * server for API and no-JS uploads, and in the browser for the upload page.
 * Returns { ok: false, error } for anything that isn't a usable flight track so the
 * upload handler can reject junk without throwing.
 */
export function extractMetadata(text: string): ExtractResult {
  let parsed: IGCParser.IGCFile;
  try {
    parsed = IGCParser.parse(text, { lenient: true });
  } catch (e) {
    return { ok: false, error: `Not a valid IGC file: ${(e as Error).message}` };
  }

  const valid = parsed.fixes.filter((f) => f.valid);
  if (valid.length < MIN_VALID_FIXES) {
    return { ok: false, error: 'Too few valid GPS fixes to be a flight track.' };
  }

  const first = valid[0];
  const last = valid[valid.length - 1];

  // flight_date: prefer HFDTE (parsed.date, ISO). Fall back to the first fix's UTC day.
  // A regex isn't enough: igc-parser passes through junk like "2000-00-00" (from
  // HFDTE000000 on devices whose date was never set), which also makes every fix
  // timestamp NaN — hence the finite-timestamp guard below. Such files have no
  // recoverable date, so they're rejected rather than stored with a bogus one.
  const flight_date = (parsed.date ?? first.time).slice(0, 10);
  if (!isRealDate(flight_date)) {
    return { ok: false, error: 'Missing or invalid flight date.' };
  }

  if (!Number.isFinite(first.timestamp) || !Number.isFinite(last.timestamp)) {
    return { ok: false, error: 'Invalid or missing timestamps in track fixes.' };
  }
  const duration_s = Math.max(0, Math.round((last.timestamp - first.timestamp) / 1000));

  let max_altitude: number | null = null;
  for (const f of valid) {
    const alt = f.gpsAltitude ?? f.pressureAltitude;
    if (alt != null && (max_altitude == null || alt > max_altitude)) max_altitude = alt;
  }

  const inRange = (lat: number, lon: number) => lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  if (!inRange(first.latitude, first.longitude) || !inRange(last.latitude, last.longitude)) {
    return { ok: false, error: 'Implausible coordinates.' };
  }

  // Local time of day at takeoff. IGC B-records are UTC only, so the zone has to come
  // from the takeoff coordinates — the file's own HFTZN/HFTZO header covers ~10% of
  // real-world files and half of those are malformed (see CLAUDE.md). ICU (full in
  // workerd) then supplies the DST-correct offset for that specific date.
  //
  // Both guards above are load-bearing: tzlookup throws RangeError on out-of-range
  // coords, and a NaN timestamp would silently yield a bogus hour. Don't hoist this.
  const takeoff_tz = tzlookup(first.latitude, first.longitude);
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: takeoff_tz,
    hour: '2-digit',
    hourCycle: 'h23', // explicit 0-23; hour12:false leaves midnight up to the locale/ICU build
  })
    .formatToParts(new Date(first.timestamp))
    .find((p) => p.type === 'hour')?.value;
  // formatToParts (not format) so no surrounding literal text can reach Number(), and an
  // explicit 0-23 check so a surprising ICU result stores null instead of a wrong hour.
  const h = Number(hourPart);
  const takeoff_hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;

  return {
    ok: true,
    meta: {
      flight_date,
      pilot_name: parsed.pilot?.trim() || null,
      takeoff_hour,
      takeoff_tz,
      takeoff_lat: first.latitude,
      takeoff_lon: first.longitude,
      landing_lat: last.latitude,
      landing_lon: last.longitude,
      duration_s,
      max_altitude: max_altitude == null ? null : Math.round(max_altitude),
      point_count: parsed.fixes.length,
      glider_type: parsed.gliderType?.trim() || null,
    },
  };
}
