import IGCParser from 'igc-parser';

/** Metadata extracted from an IGC file, ready to insert into D1 (minus id/size/uploaded_at). */
export interface FlightMetadata {
  flight_date: string; // ISO 'YYYY-MM-DD'
  pilot_name: string | null;
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

/**
 * Parse an IGC file and return its track as [lat, lon] pairs (valid fixes only).
 * Server-side only, same parse call as `extractMetadata`. Returns [] for anything
 * unparseable so the caller can just skip drawing a map.
 */
export function extractTrack(text: string): [number, number][] {
  try {
    const parsed = IGCParser.parse(text, { lenient: true });
    return parsed.fixes.filter((f) => f.valid).map((f) => [f.latitude, f.longitude]);
  } catch {
    return [];
  }
}

/**
 * IGC H-record types that carry personally identifying info. Matched on the
 * 3-char header code at `line.slice(2, 5)` — the same slice `igc-parser` uses to
 * dispatch headers. Covers pilot-in-charge, second crew/copilot, glider
 * registration, and competition callsign. Glider *type* (GTY) is intentionally
 * left alone: it isn't personally identifying and is useful for search.
 */
const IDENTIFYING_HEADERS = new Set(['PLT', 'CM2', 'GID', 'CID']);

/**
 * Remove identifying header values from raw IGC text while keeping the file
 * structurally valid: the record key is preserved and only its value is blanked
 * (`HFPLTPILOTINCHARGE:John Doe` → `HFPLTPILOTINCHARGE:`). Line endings are
 * preserved byte-for-byte, so only the targeted lines change. Used both to build
 * the anonymized file that gets stored and to compute a name-independent id.
 */
export function stripIdentifyingHeaders(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // Preserve a trailing CR (IGC files are CRLF) so rejoining is byte-exact.
      const cr = line.endsWith('\r') ? '\r' : '';
      const body = cr ? line.slice(0, -1) : line;
      if (body[0] !== 'H' || !IDENTIFYING_HEADERS.has(body.slice(2, 5))) return line;
      const colon = body.indexOf(':');
      const stripped = colon === -1 ? body.slice(0, 5) : body.slice(0, colon + 1);
      return stripped + cr;
    })
    .join('\n');
}

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
 * Parse an IGC file (server-side only) and extract the searchable/displayable metadata.
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

  return {
    ok: true,
    meta: {
      flight_date,
      pilot_name: parsed.pilot?.trim() || null,
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
