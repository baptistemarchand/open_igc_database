-- Flight metadata. One row per uploaded IGC file. id = SHA-256 hex of the file bytes,
-- which is also the R2 object key ({id}.igc) and gives free dedup on re-upload.
CREATE TABLE flights (
  id            TEXT PRIMARY KEY,      -- SHA-256 hex of file bytes; also R2 key
  flight_date   TEXT NOT NULL,         -- ISO 'YYYY-MM-DD' from HFDTE (SQLite has no date type)
  pilot_name    TEXT,                  -- from HFPLT; NULL if absent
  takeoff_lat   REAL NOT NULL,
  takeoff_lon   REAL NOT NULL,
  landing_lat   REAL NOT NULL,
  landing_lon   REAL NOT NULL,
  duration_s    INTEGER NOT NULL,
  max_altitude  INTEGER,              -- metres
  point_count   INTEGER NOT NULL,
  glider_type   TEXT,                 -- HFGTY (glider model)
  size_bytes    INTEGER NOT NULL,
  uploaded_at   INTEGER NOT NULL      -- epoch seconds
);

CREATE INDEX idx_flights_date   ON flights(flight_date);
CREATE INDEX idx_flights_pilot  ON flights(pilot_name);
CREATE INDEX idx_flights_glider ON flights(glider_type);
