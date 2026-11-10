-- Best XContest score of each year and the flight that holds it, for /stats.
-- JSON: [{"year":"2019","score":312.4,"id":"<flight id>"}, ...], ascending by year.
-- Filled by scripts/compute-stats.sql like the rest of the row; '[]' until the next run.
ALTER TABLE stats ADD COLUMN best_per_year TEXT NOT NULL DEFAULT '[]';
