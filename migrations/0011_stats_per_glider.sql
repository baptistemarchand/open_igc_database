-- The 15 gliders with the best median XContest score, among those with at least 50
-- scored flights, for /stats.
-- JSON: [{"slug":"ozone-zeno-2","brand":"Ozone","model":"Zeno 2","flights":1234,"median":56.7}, ...]
-- Filled by scripts/compute-stats.sql like the rest of the row; '[]' until the next run.
ALTER TABLE stats ADD COLUMN per_glider TEXT NOT NULL DEFAULT '[]';
