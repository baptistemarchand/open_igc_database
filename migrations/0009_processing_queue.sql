-- When the processor Worker (workers/processor) last checked the flight for glitches
-- and scored it, epoch seconds. NULL means "not processed yet": uploads insert NULL and
-- push the id onto the flight-processing queue. The column, not the queue, is the
-- source of truth: the processor's cron re-enqueues whatever is still NULL.
ALTER TABLE flights ADD COLUMN processed_at INTEGER;

-- Rows the offline backfills already handled: flagged ones (never scored on purpose)
-- and scored ones. The rest were never scored, so they wait for the processor.
UPDATE flights SET processed_at = uploaded_at
  WHERE suspicious IS NOT NULL OR score_xcontest IS NOT NULL;

-- Partial index: holds only the unprocessed rows, so the cron sweep and the
-- /browse and /stats counts read a handful of entries instead of the table.
CREATE INDEX idx_flights_unprocessed ON flights(uploaded_at) WHERE processed_at IS NULL;
