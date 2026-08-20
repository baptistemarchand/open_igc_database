-- Local time of day at takeoff, derived at ingest from the first valid fix's UTC
-- timestamp plus the IANA zone looked up from takeoff_lat/takeoff_lon.
--
-- Both nullable, and deliberately so: rows predating these columns have no recoverable
-- takeoff hour (track points are never stored), and every plausible default -- 0 being
-- midnight -- would read as a real time. See CLAUDE.md for the backfill asymmetry:
-- takeoff_tz can be filled from D1 alone, takeoff_hour needs a re-read of R2.
ALTER TABLE flights ADD COLUMN takeoff_hour INTEGER; -- local hour of day, 0-23
ALTER TABLE flights ADD COLUMN takeoff_tz TEXT;      -- IANA zone, e.g. 'Europe/Paris'
