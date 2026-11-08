-- Bitmask of reasons a flight's data looks glitchy; NULL for a normal flight (the vast
-- majority), so the column costs nothing for them. Bits are defined in
-- src/lib/suspicious.ts: 1 = max altitude > 10000 m, 2 = duration > 20 h.
ALTER TABLE flights ADD COLUMN suspicious INTEGER;

-- Backfill with one indexed range scan per rule. A single `WHERE a OR b` would defeat
-- both (col, id) indexes from 0004 and read the whole table.
UPDATE flights SET suspicious = COALESCE(suspicious, 0) | 1 WHERE max_altitude > 10000;
UPDATE flights SET suspicious = COALESCE(suspicious, 0) | 2 WHERE duration_s > 72000;

-- Partial index: holds only the few hundred flagged rows, so stats can count and
-- group them without touching the other ~186k.
CREATE INDEX idx_flights_suspicious ON flights(suspicious, flight_date) WHERE suspicious IS NOT NULL;
