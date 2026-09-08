-- Cost control. Measured against prod (186,626 rows): a single unfiltered
-- `SELECT COUNT(*) FROM flights` costs 186,626 rows_read, and every /browse and
-- /flights request ran one. Against D1's 5M/day free-tier read limit that is ~27
-- requests a day — ~13 when also sorting by duration or altitude, which had no index
-- and so scanned the table a second time. Both are fixed here.

-- 1. Cached row count ------------------------------------------------------------
-- `SELECT COUNT(*) FROM flights` has no cheap plan in SQLite: it scans a covering
-- index end to end, so it costs one row read per row in the table on every request,
-- forever, just to render "N flights". The count only changes when a row is added or
-- removed, so it's maintained incrementally here and read as a single row.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Maintained by triggers rather than by upsertFlight, deliberately: the bulk scripts
-- (scripts/import-igc.ts, scripts/backfill-*.ts, scripts/empty-db.sh) write to D1
-- through the REST API and never execute application code, so an app-level counter
-- would silently drift the moment the corpus is re-imported.
--
-- The AFTER INSERT trigger is correct under `INSERT ... ON CONFLICT DO UPDATE`
-- (upsertFlight): SQLite fires INSERT triggers only when a row is genuinely inserted,
-- and UPDATE triggers when the DO UPDATE path is taken — so a re-upload of an
-- existing id (latest-upload-wins) does not double-count. Verified empirically.
CREATE TRIGGER IF NOT EXISTS flights_count_insert AFTER INSERT ON flights BEGIN
  UPDATE meta SET value = value + 1 WHERE key = 'flight_count';
END;

-- Counterpart for deletes. A bare `DELETE FROM flights` would normally take SQLite's
-- truncate optimisation and skip per-row triggers, but the optimisation is disabled
-- whenever a DELETE trigger exists — so empty-db.sh leaves the counter at 0, not stale.
CREATE TRIGGER IF NOT EXISTS flights_count_delete AFTER DELETE ON flights BEGIN
  UPDATE meta SET value = value - 1 WHERE key = 'flight_count';
END;

-- 2. Sort indexes ----------------------------------------------------------------
-- The browse UI sorts by date / duration / altitude, each in either direction, and
-- appends `id` as a tiebreaker so pagination is stable. duration_s and max_altitude
-- had no index at all, so those sorts were a real `SCAN flights` plus a full sort of
-- every row to return 50 — the second full read that halved the request budget.
-- flight_date was already covered by idx_flights_date_id (migration 0002).
--
-- These pair with the `id ${dir}` tiebreaker change in searchFlights/getFlightsPage,
-- which matters less than it looks and is worth stating precisely, because the
-- measurement is counter-intuitive: `ORDER BY col DESC, id ASC` over a (col, id)
-- index does NOT read the whole table. SQLite reads the index in order and sorts only
-- each run of equal `col` values ("USE TEMP B-TREE FOR LAST TERM OF ORDER BY"), then
-- exits at the LIMIT — ~1 ms at 200k rows with realistic date cardinality.
--
-- It degenerates only when a single value covers a huge run, and this table has
-- exactly that shape available: max_altitude is nullable, so `ORDER BY max_altitude
-- ASC` leads with every NULL row as one equal-run. Measured at 200k rows in one run,
-- the partial sort costs 88 ms and reads everything, versus 0 ms matched. So the
-- direction match is cheap insurance against the clustered case, not the headline
-- fix — the COUNT and these two indexes are.
CREATE INDEX IF NOT EXISTS idx_flights_duration_id ON flights(duration_s, id);
CREATE INDEX IF NOT EXISTS idx_flights_altitude_id ON flights(max_altitude, id);

-- 3. Seed the counter ------------------------------------------------------------
-- Last, and deliberately so. This is the one statement here that costs a full-table
-- read (the last one this codebase should ever pay), which means it is also the one
-- that can fail when the account is already at its daily row-read limit — exactly the
-- situation this migration exists to end. D1 applies these statements individually
-- with no enclosing transaction, so a failure here would otherwise leave the schema
-- half-built and unrecorded in d1_migrations. Everything above is IF NOT EXISTS and
-- this is INSERT OR IGNORE, so re-running `wrangler d1 migrations apply` after the
-- quota resets picks up exactly where it stopped.
--
-- The triggers above are already live at this point. That is harmless: with no seed
-- row yet their UPDATE matches nothing, and the COUNT(*) below is evaluated when it
-- runs, so whatever the table holds at that moment is what gets stored.
INSERT OR IGNORE INTO meta (key, value) VALUES ('flight_count', (SELECT COUNT(*) FROM flights));
