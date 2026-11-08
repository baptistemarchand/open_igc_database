-- XC scores (points) under XContest and FFVL rules, from igc-xc-score. NULL means "not
-- scored yet": the solver is far too heavy for the Worker or the upload page, so scores
-- only ever come from scripts/backfill-xc-score.ts, run by hand (see CLAUDE.md).
ALTER TABLE flights ADD COLUMN score_xcontest REAL;
ALTER TABLE flights ADD COLUMN score_ffvl REAL;

-- Same (col, id) shape as 0004, so /browse sorts by score are index walks that stop at
-- the LIMIT, and /stats finds the best flight with one seek.
CREATE INDEX idx_flights_score_xcontest_id ON flights(score_xcontest, id);
CREATE INDEX idx_flights_score_ffvl_id ON flights(score_ffvl, id);

-- Best-scoring flights for /stats, as ids joined at read time like longest_id/highest_id.
ALTER TABLE stats ADD COLUMN best_xcontest_id TEXT;
ALTER TABLE stats ADD COLUMN best_ffvl_id TEXT;
