-- Precomputed site statistics, one row. Computing them needs a full scan of the date
-- index (flights per year), which is ~187k rows_read: far too much to pay per request
-- against D1's free-tier read budget (see migration 0004). The row is refreshed by hand
-- with scripts/compute-stats.sql, and the /stats page reads this single row.
--
-- The record flights are stored as ids and joined at read time, so a re-upload that
-- relabels a flight (latest-upload-wins) shows the new pilot name without a recompute.
CREATE TABLE IF NOT EXISTS stats (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at         INTEGER NOT NULL,  -- epoch seconds
  flight_count        INTEGER NOT NULL,
  longest_id          TEXT,              -- flight with the greatest duration_s
  highest_id          TEXT,              -- flight with the greatest max_altitude
  per_year            TEXT NOT NULL      -- JSON: [{"year":"2019","count":123}, ...]
);
