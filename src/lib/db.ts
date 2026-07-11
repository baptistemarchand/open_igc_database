import type { D1Database } from '@cloudflare/workers-types';
import type { FlightMetadata } from './igc';

/** A full flight row as stored in D1. */
export interface Flight extends FlightMetadata {
  id: string;
  size_bytes: number;
  uploaded_at: number;
}

/**
 * Insert or refresh a flight. The id is a name-independent content hash, so a
 * conflicting id means "same flight, newer upload" — the row is overwritten
 * (latest-upload-wins), which lets an anonymous re-upload relabel a named flight
 * and vice versa. Whether the row is new is determined by the caller.
 */
export async function upsertFlight(db: D1Database, f: Flight): Promise<void> {
  await db
    .prepare(
      `INSERT INTO flights
         (id, flight_date, pilot_name, takeoff_lat, takeoff_lon, landing_lat, landing_lon,
          duration_s, max_altitude, point_count, glider_type, size_bytes, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         flight_date = excluded.flight_date,
         pilot_name = excluded.pilot_name,
         takeoff_lat = excluded.takeoff_lat,
         takeoff_lon = excluded.takeoff_lon,
         landing_lat = excluded.landing_lat,
         landing_lon = excluded.landing_lon,
         duration_s = excluded.duration_s,
         max_altitude = excluded.max_altitude,
         point_count = excluded.point_count,
         glider_type = excluded.glider_type,
         size_bytes = excluded.size_bytes,
         uploaded_at = excluded.uploaded_at`,
    )
    .bind(
      f.id,
      f.flight_date,
      f.pilot_name,
      f.takeoff_lat,
      f.takeoff_lon,
      f.landing_lat,
      f.landing_lon,
      f.duration_s,
      f.max_altitude,
      f.point_count,
      f.glider_type,
      f.size_bytes,
      f.uploaded_at,
    )
    .run();
}

export async function getFlight(db: D1Database, id: string): Promise<Flight | null> {
  return db.prepare('SELECT * FROM flights WHERE id = ?').bind(id).first<Flight>();
}

/** Return every flight, newest first. Used by the public JSON API. */
export async function getAllFlights(db: D1Database): Promise<Flight[]> {
  const { results } = await db.prepare('SELECT * FROM flights ORDER BY flight_date DESC, id ASC').all<Flight>();
  return results ?? [];
}

/** Whitelisted sort keys → column, guarding against injection via the sort param. */
const SORT_COLUMNS = {
  date: 'flight_date',
  duration: 'duration_s',
  altitude: 'max_altitude',
} as const;
export type SortKey = keyof typeof SORT_COLUMNS;

export interface SearchParams {
  pilot?: string;
  glider?: string;
  from?: string; // ISO date
  to?: string; // ISO date
  sort?: SortKey;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  flights: Flight[];
  total: number;
}

/** Search + sort + paginate flights. All filters optional and combinable. */
export async function searchFlights(db: D1Database, p: SearchParams): Promise<SearchResult> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (p.pilot?.trim()) {
    where.push('pilot_name LIKE ?');
    args.push(`%${p.pilot.trim()}%`);
  }
  if (p.glider?.trim()) {
    where.push('glider_type LIKE ?');
    args.push(`%${p.glider.trim()}%`);
  }
  if (p.from) {
    where.push('flight_date >= ?');
    args.push(p.from);
  }
  if (p.to) {
    where.push('flight_date <= ?');
    args.push(p.to);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = SORT_COLUMNS[p.sort ?? 'date'];
  const dir = p.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 100);
  const offset = Math.max(p.offset ?? 0, 0);

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM flights ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT * FROM flights ${whereSql}
       ORDER BY ${sortCol} ${dir}, id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...args, limit, offset)
    .all<Flight>();

  return { flights: results ?? [], total: totalRow?.n ?? 0 };
}
