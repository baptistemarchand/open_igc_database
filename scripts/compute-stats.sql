-- Refresh the single `stats` row read by /stats. Run by hand after imports:
--   npx wrangler d1 execute open-igc-db --local  --file scripts/compute-stats.sql
--   npx wrangler d1 execute open-igc-db --remote --file scripts/compute-stats.sql
--
-- Only processed, non-suspicious flights count: flagged ones (`suspicious IS NOT NULL`,
-- migration 0006) and the ones workers/processor hasn't handled yet (`processed_at IS
-- NULL`, migration 0009) are excluded from everything. The two sets don't overlap: an
-- unprocessed flight has no flags yet.
--
-- Costs about one full read of idx_flights_date_id (the per-year GROUP BY); the four
-- records are index seeks on the (col, id) indexes from migrations 0004 and 0008,
-- skipping the few excluded rows at the top (unscored flights are NULL, which sorts
-- last in DESC). The ORDER BY directions match the index on purpose, so no sorter is
-- needed. Per-year counts are all flights minus the excluded ones (grouped off the two
-- small partial indexes), which keeps the big scan covering instead of a table lookup
-- per row.
INSERT OR REPLACE INTO stats
  (id, computed_at, flight_count, longest_id, highest_id, best_xcontest_id, best_ffvl_id, per_year, per_glider)
SELECT
  1,
  CAST(strftime('%s', 'now') AS INTEGER),
  (SELECT value FROM meta WHERE key = 'flight_count')
    - (SELECT COUNT(*) FROM flights WHERE suspicious IS NOT NULL)
    - (SELECT COUNT(*) FROM flights WHERE processed_at IS NULL),
  (SELECT id FROM flights WHERE suspicious IS NULL AND processed_at IS NOT NULL
     ORDER BY duration_s DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE suspicious IS NULL AND processed_at IS NOT NULL AND max_altitude IS NOT NULL
     ORDER BY max_altitude DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE suspicious IS NULL AND processed_at IS NOT NULL AND score_xcontest IS NOT NULL
     ORDER BY score_xcontest DESC, id DESC LIMIT 1),
  (SELECT id FROM flights WHERE suspicious IS NULL AND processed_at IS NOT NULL AND score_ffvl IS NOT NULL
     ORDER BY score_ffvl DESC, id DESC LIMIT 1),
  (SELECT COALESCE(json_group_array(json_object('year', y, 'count', n - COALESCE(bad, 0) - COALESCE(pending, 0))), '[]')
     FROM (SELECT a.y, a.n, b.bad, c.pending
             FROM (SELECT substr(flight_date, 1, 4) AS y, COUNT(*) AS n
                     FROM flights GROUP BY y) a
             LEFT JOIN (SELECT substr(flight_date, 1, 4) AS y, COUNT(*) AS bad
                          FROM flights WHERE suspicious IS NOT NULL GROUP BY y) b USING (y)
             LEFT JOIN (SELECT substr(flight_date, 1, 4) AS y, COUNT(*) AS pending
                          FROM flights WHERE processed_at IS NULL GROUP BY y) c USING (y)
            ORDER BY a.y)),
  -- The 15 gliders with the best median XContest score, among those with at least 50
  -- scored flights (below that, a few big days decide the median). SQLite has no
  -- MEDIAN: number each glider's scores in order and average the middle one or two.
  -- Walks the flights that have a glider alias (idx_flights_glider_alias, then a row
  -- lookup for the filters): about half the table.
  (SELECT COALESCE(json_group_array(json_object(
            'slug', g.slug, 'brand', g.brand, 'model', g.model,
            'flights', m.n, 'median', ROUND(m.median, 1))), '[]')
     FROM (SELECT gid, n, AVG(score) AS median
             FROM (SELECT ga.glider_id AS gid, f.score_xcontest AS score,
                          ROW_NUMBER() OVER (PARTITION BY ga.glider_id ORDER BY f.score_xcontest) AS rn,
                          COUNT(*) OVER (PARTITION BY ga.glider_id) AS n
                     FROM flights f JOIN glider_aliases ga ON ga.id = f.glider_alias_id
                    WHERE ga.glider_id IS NOT NULL AND f.suspicious IS NULL
                      AND f.processed_at IS NOT NULL AND f.score_xcontest IS NOT NULL)
            WHERE rn IN ((n + 1) / 2, (n + 2) / 2) AND n >= 50
            GROUP BY gid, n
            ORDER BY median DESC, gid
            LIMIT 15) m
     JOIN gliders g ON g.id = m.gid);
