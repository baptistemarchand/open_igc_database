-- Canonical gliders, linked from flights through the normalized form of their free-text
-- glider_type (HFGTY). See src/lib/glider.ts for the normalization and data/gliders.csv
-- for the curated list, synced by scripts/gliders.ts.
--
--   flights.glider_type --gliderKey()--> glider_aliases --resolve--> gliders
--
-- Flights point at an alias, not at a glider: merging two gliders or fixing a bad match
-- rewrites a few alias rows, never the flights.

-- One row per curated glider. Sizes are not separate gliders.
CREATE TABLE gliders (
  id     INTEGER PRIMARY KEY,
  slug   TEXT NOT NULL UNIQUE,  -- stable across syncs: ids are reused by slug
  brand  TEXT NOT NULL,         -- display name, from BRANDS in src/lib/glider.ts
  model  TEXT NOT NULL          -- display name, e.g. 'Zeno 2'
);

-- The normalized keys each curated glider answers to ("Mantra M6" and "Mantra 6" are
-- one glider). Rebuilt from data/gliders.csv on every sync.
CREATE TABLE glider_keys (
  brand_key  TEXT NOT NULL,
  model_key  TEXT NOT NULL,
  glider_id  INTEGER NOT NULL REFERENCES gliders(id) ON DELETE CASCADE,
  PRIMARY KEY (brand_key, model_key)
);
-- The brandless fallback of the resolution looks up by model alone.
CREATE INDEX idx_glider_keys_model ON glider_keys(model_key);

-- One row per distinct normalized string seen in flights, curated or not. glider_id is
-- NULL until data/gliders.csv lists a matching key: unmapped aliases are the to-do list.
CREATE TABLE glider_aliases (
  id         INTEGER PRIMARY KEY,
  brand_key  TEXT NOT NULL,     -- '' when the string starts with no known brand
  model_key  TEXT NOT NULL,
  glider_id  INTEGER REFERENCES gliders(id) ON DELETE SET NULL,
  UNIQUE (brand_key, model_key)
);
CREATE INDEX idx_glider_aliases_glider ON glider_aliases(glider_id);

-- Set by workers/processor for new uploads, by scripts/gliders.ts --link for the rest.
-- NULL when glider_type names no glider (~49% of prod: NKN, not set, empty…).
ALTER TABLE flights ADD COLUMN glider_alias_id INTEGER REFERENCES glider_aliases(id);
CREATE INDEX idx_flights_glider_alias ON flights(glider_alias_id);
