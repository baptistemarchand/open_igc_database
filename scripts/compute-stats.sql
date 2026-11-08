-- Refresh the single `stats` row read by /stats. Run by hand after imports:
--   npx wrangler d1 execute open-igc-db --local  --file scripts/compute-stats.sql
--   npx wrangler d1 execute open-igc-db --remote --file scripts/compute-stats.sql
--
-- Costs about one full read of idx_flights_date_id (the per-year GROUP BY); the two
-- records are index seeks on the (col, id) indexes from migration 0004. The ORDER BY
-- directions match the index on purpose, so no sorter is needed.
INSERT OR REPLACE INTO stats (id, computed_at, flight_count, longest_id, highest_id, per_year)
SELECT
  1,
  CAST(strftime('%s', 'now') AS INTEGER),
  (SELECT value FROM meta WHERE key = 'flight_count'),
  (SELECT id FROM flights ORDER BY duration_s DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE max_altitude IS NOT NULL ORDER BY max_altitude DESC, id DESC LIMIT 1),
  (SELECT COALESCE(json_group_array(json_object('year', y, 'count', n)), '[]')
     FROM (SELECT substr(flight_date, 1, 4) AS y, COUNT(*) AS n
             FROM flights GROUP BY y ORDER BY y));
