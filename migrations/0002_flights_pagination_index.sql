-- Composite index matching GET /flights' pagination query
-- (ORDER BY flight_date DESC, id ASC LIMIT ? OFFSET ?), so paging can use an
-- index instead of a full-table sort as the table grows.
CREATE INDEX idx_flights_date_id ON flights(flight_date, id);
