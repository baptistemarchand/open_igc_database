-- Refresh the single `stats` row read by /stats. Run by hand after imports:
--   npx wrangler d1 execute open-igc-db --local  --file scripts/compute-stats.sql
--   npx wrangler d1 execute open-igc-db --remote --file scripts/compute-stats.sql
--
-- Flights with `suspicious IS NOT NULL` (migration 0006) are excluded from everything.
--
-- Costs about one full read of idx_flights_date_id (the per-year GROUP BY); the four
-- records are index seeks on the (col, id) indexes from migrations 0004 and 0008,
-- skipping the few flagged rows at the top (unscored flights are NULL, which sorts last
-- in DESC). The ORDER BY directions match the index on purpose, so no sorter is needed. Per-year counts are all flights minus the flagged ones (grouped off
-- the small partial index), which keeps the big scan covering instead of a table lookup
-- per row.
INSERT OR REPLACE INTO stats
  (id, computed_at, flight_count, longest_id, highest_id, best_xcontest_id, best_ffvl_id, per_year)
SELECT
  1,
  CAST(strftime('%s', 'now') AS INTEGER),
  (SELECT value FROM meta WHERE key = 'flight_count')
    - (SELECT COUNT(*) FROM flights WHERE suspicious IS NOT NULL),
  (SELECT id FROM flights WHERE suspicious IS NULL ORDER BY duration_s DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE suspicious IS NULL AND max_altitude IS NOT NULL
     ORDER BY max_altitude DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE suspicious IS NULL AND score_xcontest IS NOT NULL
     ORDER BY score_xcontest DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE suspicious IS NULL AND score_ffvl IS NOT NULL
     ORDER BY score_ffvl DESC, id DESC LIMIT 1),
  (SELECT COALESCE(json_group_array(json_object('year', y, 'count', n - COALESCE(bad, 0))), '[]')
     FROM (SELECT a.y, a.n, b.bad
             FROM (SELECT substr(flight_date, 1, 4) AS y, COUNT(*) AS n
                     FROM flights GROUP BY y) a
             LEFT JOIN (SELECT substr(flight_date, 1, 4) AS y, COUNT(*) AS bad
                          FROM flights WHERE suspicious IS NOT NULL GROUP BY y) b USING (y)
            ORDER BY a.y));
