-- Lower the suspicious thresholds to 9000 m and 15 h (src/lib/suspicious.ts), just above
-- the all-time paragliding records. Thresholds only went down, so bits are only added:
-- every row flagged by 0006 still qualifies, and nothing needs clearing.
--
-- One indexed range scan per rule, same as 0006: an OR would read the whole table.
UPDATE flights SET suspicious = COALESCE(suspicious, 0) | 1 WHERE max_altitude > 9000;
UPDATE flights SET suspicious = COALESCE(suspicious, 0) | 2 WHERE duration_s > 54000;
