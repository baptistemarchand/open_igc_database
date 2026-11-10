# CLAUDE.md

Open IGC Database — public paragliding flight (`.igc`) database. SvelteKit on
Cloudflare (D1 + R2). See `README.md` for the product/architecture overview; this
file records the non-obvious things.

## Commands

```sh
npm run dev                                          # vite dev, bindings via Miniflare
npm run check                                         # svelte-check (typecheck) — run before done
npm run format                                        # prettier --write
npx wrangler d1 migrations apply open-igc-db --local  # create/refresh local D1
npm run stats:local                                   # refresh the /stats snapshot (stats:remote for prod)
npm run processor:dev                                 # queue consumer on :8788, same local state
npm run check:processor                               # typecheck workers/processor — run before done
npm run processor:deploy                              # deploy the consumer (the app deploys separately)
```

There is no test suite and no lint step beyond `svelte-check` + prettier.

## Stack

- **Svelte 5, runes forced on** (`vite.config.ts`) for all non-`node_modules` files.
  Use `$state`/`$props`/`$derived`, not the Svelte 4 store/`export let` syntax.
- **TS is strict + `checkJs`.** `moduleResolution: bundler`, `$lib` alias for `src/lib`.
- **Cloudflare bindings live on `event.platform.env`** and are undefined outside the
  Cloudflare runtime — every server route guards with `if (!platform?.env)`. In `vite
dev` the adapter's platformProxy supplies them from local Miniflare (real SQLite +
  local R2 under `.wrangler/state`); no cloud calls, no keys.
- **Bindings**: D1 is `env.DB` (binding `DB`, database_name `open-igc-db`), R2 is
  `env.BUCKET` (bucket_name `open-igc`), the queue producer is `env.FLIGHT_QUEUE`
  (queue `flight-processing`). The binding name is the code identifier, not the
  resource name.
- **Two deployables**: the SvelteKit app (Pages, `wrangler.toml`) and the processor
  Worker (`workers/processor/`, its own `wrangler.toml` and `tsconfig.json`, checked by
  `npm run check:processor`, not by svelte-check). The account is on **Workers Paid**,
  which the processor needs for its raised CPU limit.

## Data model / invariants (don't break these)

- **`id` = SHA-256 hex of the _identifier-stripped_ bytes**, not the raw file bytes.
  (The migration/README comments saying "hash of the file bytes" are imprecise.) This
  makes dedup name-independent: the same track uploaded named vs. anonymous → one id.
  `id` is also the R2 object key (`{id}.igc`) and the D1 primary key.
- **Re-uploads are refused** (`ingestIgc` returns `existingId`, the API answers 409).
  Since the id ignores the pilot name, that includes an anonymous re-upload of a named
  flight and vice versa: there is no way to relabel or anonymize a flight after the
  fact. The duplicate check runs **before** the R2 put (the key is the id, so storing
  first would let a named file overwrite an anonymous one), and `insertFlight` is
  `ON CONFLICT DO NOTHING` so two racing uploads can't both win. Its success test is
  `meta.changes > 0`, not `=== 1`: D1 also counts the row the 0004 counter trigger
  writes, so a real insert reports 2.
- **`processed_at` is NULL until workers/processor has handled the flight** (migration
  0009). Uploads insert it NULL, with `suspicious` and the scores NULL too, and send
  `{ id }` on the `flight-processing` queue. The processor reads the file from R2,
  computes the whole `suspicious` mask and, for clean flights, the XC scores, then sets
  `processed_at`. Until then the flight is hidden from `/browse`, left out of `/stats`
  and its page shows a banner; the API lists it with `processed_at: null`.
  - **The column is the source of truth, the queue only a trigger.** The send is best
    effort (a failure is logged, the upload still succeeds), messages that exhaust
    `max_retries` go to a dead-letter queue nothing reads, and bulk imports enqueue
    nothing. A 30-minute cron in the processor re-enqueues rows still NULL after 10
    minutes, off the `idx_flights_unprocessed` partial index.
  - **Failures**: D1/R2 errors retry the message. A file that is missing or doesn't
    parse, or a solver crash, is not retried: it gets the `UNPROCESSABLE` bit and a
    `processed_at`, otherwise the cron would loop on it forever.
  - **One flight per invocation** (`max_batch_size = 1`), processed synchronously: the
    solver's module state (below) must not interleave, and a CPU-limit kill then only
    retries that flight.
- **Anonymity**: `stripIdentifyingHeaders` blanks the _values_ of H-records
  PLT/CM2/GID/CID (keeps them structurally valid); glider _type_ GTY is kept on purpose
  (searchable, not identifying). When `anonymous`, the stripped bytes are stored and
  `pilot_name` is set to `"Anonymous"`.
- **Metadata is parsed once, at upload** (`extractMetadata` in `src/lib/igc.ts`, via
  `igc-parser`) — in the **browser** for the upload page, on the Worker for API and
  no-JS uploads (see the trusted-metadata invariant below). Track points are never stored — D1 holds only the metadata columns
  in `migrations/0001_init.sql`. The one exception is the **detail-page map**: the
  browser fetches the raw `.igc` from R2 and parses just the B-record lat/lons itself
  (tiny inline parser in `flight/[id]/+page.svelte`), so the worker never re-parses on a
  read. Cross-origin fetches of `R2_PUBLIC_URL` therefore need a **CORS rule** on the
  bucket allowing the site origin (a plain `<a download>` doesn't, but `fetch()` does).
- **`takeoff_hour` is _local_ civil time, not UTC** (0–23, hour of the first valid fix;
  minutes are deliberately not stored). IGC B-records are UTC-only, so the zone is looked
  up from `takeoff_lat/takeoff_lon` via **`tz-lookup`** and `Intl` supplies the
  DST-correct offset for that date; the resolved zone is stored in `takeoff_tz` so the
  hour stays auditable. Two things not to redo:
  - **Don't switch to the file's own `HFTZN`/`HFTZO` header.** Measured over the 186k-file
    corpus: ~89% of files have no TZ header, and of the ~10% that do, `igc-parser` only
    reads `TZN` (never `TZO`), rejects the space-padded `HFTZNUTCOFFSET:  2` spelling,
    and _silently parses `HPTZNUTCOFFSET:2:00` as `0`_. ~5% usable, ~1% actively wrong.
  - **`tz-lookup` is a deliberate exception to the zero-dependency bias** (cf. the native
    `CompressionStream`, the hand-rolled map parser): lat/lon → IANA zone is a data
    problem, not a code problem. It's one self-contained 73 KB / 28 KB-gzipped CJS file,
    no transitive deps, no filesystem, CC0. Its boundary data is from 2019, which is fine
    — boundaries barely move, and the DST _rules_ come from the runtime's full-ICU `Intl`,
    so offsets stay current without bumping the package. `geo-tz` is a non-starter (73 MB
    of shapefiles read from a filesystem the Worker doesn't have). It ships no types;
    `src/tz-lookup.d.ts` is the ambient declaration.
  - Ordering in `extractMetadata` is load-bearing: the lookup sits **after** the
    `Number.isFinite(timestamp)` and `inRange` coord guards, because `tzlookup` throws
    `RangeError` on bad coords and a NaN timestamp would yield a bogus hour. Use
    `hourCycle: 'h23'` rather than `hour12: false`: h23 pins the range to 0–23, while
    `hour12: false` leaves the midnight rendering to the locale and ICU build.
  - **Known wrinkle, don't "fix" it:** `flight_date` stays UTC while `takeoff_hour` is
    local, so a late-evening flight east of UTC has a date and hour that disagree by a
    day. Fixing that means a local-date column and re-deciding what `flight_date` means
    for search and the `(flight_date, id)` pagination index — don't shift `flight_date`.
  - **`takeoff_hour`/`takeoff_tz` are nullable _because of history_** (migration 0003 —
    the only `ALTER TABLE` so far), unlike `pilot_name`/`glider_type`/`max_altitude`,
    which are nullable because the source file may lack them. Backfill is asymmetric:
    `takeoff_tz` can be filled from D1 alone (the coords are already stored), but
    `takeoff_hour` needs a re-read and re-parse of the file, since track points aren't
    stored. **Both columns are backfilled as of 2026-08-20** — 186,626/186,626 rows,
    zero NULLs — by `scripts/backfill-takeoff-time.ts`, which is the pattern to copy for
    any future column that needs file contents. Two things it establishes:
    - **Read the corpus from disk, not R2.** The account API is paced at ~3.8 req/s
      (`scripts/lib/cf-api.ts`), so a GET per flight is ~13.6 h; hashing the local
      `igc_gz/` copy instead is ~4 min across a `worker_threads` pool, and only the 266
      rows with no local match fall back to R2. Local filenames carry no id, so the
      id is recomputed per file — do that from the _same_ gunzip that feeds
      `extractMetadata`, rather than reusing `mapLocalIdsToPaths` (paths only, forces a
      second read of all 15 GB).
    - **Fold many rows into one statement.** `d1Exec` + `WITH v(id,…) AS (VALUES …)
UPDATE … FROM v`, 500 rows per request: ~370 requests and ~100 s instead of 186k
      requests. D1 caps bound params far below that, so values are inlined as literals
      and therefore _validated_ against strict patterns (never escaped) — same argument
      as `SORT_COLUMNS`/`FLIGHT_COLUMNS`. Resume is free: the target set is
      `WHERE takeoff_tz IS NULL`, so an interrupted run just gets re-run.
- **Never run an unfiltered `COUNT(*)` on `flights`.** SQLite stores no row count, so it
  scans a covering index end to end and D1 bills every entry: measured at **186,626
  rows_read for one `SELECT COUNT(*)`**, on every `/browse` and `/flights` request. That
  alone is ~27 requests against the 5M/day free-tier read limit, which is how the limit
  got exceeded on a site nobody had the URL for. Migration 0004 replaces it with a
  `meta(key, value)` counter read via `getFlightCount` (one row).
  - Confirmed against prod on 2026-09-10, before/after: the counter reads **1 row** where
    the `COUNT(*)` read 186,626, and a `/browse` view went from 373,252 rows to 51.
  - **`wrangler d1 insights` is the tool for this**, and it needs `Account Analytics:
Read` on the token (`scripts/import.env`) — without that scope it silently returns
    `[]` rather than erroring, and the GraphQL `d1AnalyticsAdaptiveGroups` endpoint 403s
    with "not authorized for that account". The scope is on the token as of 2026-09-10.
    What it showed over 7 days: 30.1M rows read, 15.1M of it the unfiltered `COUNT(*)`
    (87 runs) and 14.9M the two unindexed sorts (40 runs), against **zero writes** and a
    steady overnight request rate — automated crawling, not users.
  - **Maintained by SQL triggers, not by `upsertFlight`.** The bulk scripts write to D1
    through the REST API and never execute app code, so an app-level counter would drift
    on the next re-import. `AFTER INSERT` is safe under `INSERT … ON CONFLICT DO UPDATE`:
    SQLite fires INSERT triggers only on a genuine insert and UPDATE triggers on the
    DO UPDATE path, so a re-upload doesn't double-count (verified, not assumed). The
    `AFTER DELETE` counterpart also disables SQLite's truncate optimisation, which is
    what keeps a bare `DELETE FROM flights` (`empty-db.sh`) from leaving the count stale.
  - `getFlightCount` **throws** if the row is missing rather than falling back to a real
    `COUNT(*)` — the only cause is an unapplied migration, and a silent fallback would
    restore the exact cost it exists to remove. `searchFlights` still pays a real COUNT
    when a filter is set; that one is unavoidable and is not the common case.
- **`/stats` reads a precomputed snapshot, never live aggregates.** The `stats` table
  (migration 0005) holds one row: flight count, the ids of the longest/highest flights,
  per-year counts as JSON, and (0011) the 15 gliders with the best median XContest score
  among those with at least 50 scored flights. SQLite has no `MEDIAN`: it's `ROW_NUMBER()` over each glider's
  scores, averaging the middle one or two. It is refreshed **by hand** with `scripts/compute-stats.sql`
  (`npm run stats:remote`), and counts processed, non-suspicious flights only — the
  per-year `GROUP BY` is a full date-index scan (~187k
  reads), so it must not run per request. Record flights are stored as ids and joined at
  read time (`getStats`), so a relabel shows up without a recompute. `getStats` throws if
  the row is missing, same policy as `getFlightCount`. Values are raw maxima: no outlier
  filtering, so a GPS glitch would own "highest"/"longest" until fixed in the data.
- **`suspicious` is a bitmask of glitch reasons, NULL for normal flights** (bits in
  `src/lib/suspicious.ts`, never renumbered). Only workers/processor writes it, never the
  upload, so neither the browser nor a client can set a bit. `/stats` and `/browse`
  exclude flagged flights (browse subtracts counts over the 0006 and 0009 partial
  indexes from the cached total, so it stays cheap), the flight page shows a banner, and
  the API still lists them. For existing rows, the two kinds of bit are backfilled
  differently:
  - **Threshold bits** (`ALT_TOO_HIGH`, `TOO_LONG`) only need metadata. Changing a
    threshold needs a new SQL migration for existing rows (0006 and 0007 hardcode the
    numbers); thresholds only went down so far, so the migrations only OR bits in.
  - **Track bits** (`ALT_SPIKE`, `BAD_TIMESTAMPS`, `TIME_GAP`, `GROUND_TIME`,
    `POSITION_JUMP`) need the fixes (`trackFlags(trackFixes(parsed))`), so existing rows
    are backfilled from the local corpus by `scripts/backfill-suspicious.ts`. It
    _replaces_ the track bits (a rule change can clear a flag, not only add one) and
    writes only rows that change, so re-run it after any change to `trackFlags`.
    Thresholds were picked from full-corpus scans; see the comments in `suspicious.ts`.
  - Fixed limits alone missed real glitches by a hair (8,915 m, 14 h 45 m), which is
    why the track rules exist. A new rule should be checked against the whole corpus
    before shipping, not just the examples that motivated it.
- **XC scores (`score_xcontest`, `score_ffvl`) come from workers/processor** for new
  uploads, and from the offline backfill (`scripts/backfill-xc-score.ts`,
  `npm run backfill:xcscore`) for corpus-wide rescoring. `igc-xc-score` is a
  branch-and-bound solver: ~0.6 s per flight on average over a corpus sample, 20 s for
  some, minutes in the worst case. That rules out the app's Worker and the upload page:
  - NULL means "not processed yet" (`processed_at IS NULL`) or "suspicious".
  - `insertFlight` takes a `NewFlight`, which omits the processed columns. Don't add
    them to it or to `FlightMetadata`/`checkClaimedMetadata`: a client must not be able
    to claim a score or a flag.
  - The dependency is a **devDependency** used only by `scripts/lib/xcscore.ts`, which
    the processor and the backfill import. Nothing under `src/` may import it (it's LGPL
    and heavy; check with `npm run build` and a grep for `flatbush` in `.svelte-kit/`).
  - The solver keeps module-level state (`geom.init`, a swapped `Point.prototype`
    distance), so scorings must not interleave in one thread; parallelism is
    `worker_threads` in the backfill, separate invocations in the processor.
  - **Budget in loops on the Worker, not milliseconds.** workerd's `Date.now()` doesn't
    move during synchronous code, so a time budget (the backfill's `{ ms }`, igc-xc-score's
    `maxcycle`) would never fire there and only the CPU limit would stop the solver. The
    processor passes `{ loops }` (igc-xc-score's `maxloop`, a count of evaluated
    solutions). Measured on 299 corpus files (2026-11-08): 18 solutions/ms on average
    but 6.4/ms on the slowest tracks, so `LOOP_BUDGET` (150k per rule) is sized on the
    slow rate against `cpu_ms`; 4 of the 299 needed more. Re-measure before raising it.
  - Options are `trim: true` (auto launch/landing, ignores ground time); when the budget
    runs out the best score found is stored, with no "optimal" flag. A track with no
    detected flight stores 0.
  - The target set is `WHERE suspicious IS NULL AND score_xcontest IS NULL` with keyset
    paging on `id`: a range seek on `idx_flights_score_xcontest_id`, so a periodic run
    reads only unscored rows. **Suspicious flights are never scored** (a glitchy track
    gives a meaningless score): each run starts by NULLing the scores of flagged flights
    (via the 0006 partial index), because a flag can land after the score. So after a
    new track rule, run `backfill:suspicious`, then `backfill:xcscore`, then
    `stats:remote`. Clearing a flag makes the flight a target again. Neither backfill
    touches `processed_at`.
    Without `<dir>` the script fetches targets from R2, which is the right mode once the
    corpus has had its first full pass. Results are written as they come (hours for a
    full pass), so resume is re-running.
- **Gliders are curated, flights link through an alias** (migration 0010).
  `gliderKey` (`src/lib/glider.ts`) turns the free-text `glider_type` into
  `(brand_key, model_key)`: lowercase letters and digits, a known brand set apart
  (`BRANDS`), a trailing letter size dropped (a size is the same glider), placeholders
  (`NKN`, `not set`… ~49% of prod) → null. Each distinct key is a `glider_aliases` row;
  `flights.glider_alias_id` points at it, and the alias's `glider_id` is resolved from
  `glider_keys`, rebuilt from `data/gliders.csv`. Things to keep:
  - **`glider_type` is never rewritten**: it's what the file says; the link is derived.
  - **Curation changes rewrite aliases, never flights.** `npm run gliders:remote` syncs
    the CSV (gliders upserted by slug, so ids stay stable) and re-resolves every alias.
    `-- --link` also links unlinked flights: needed once for the pre-0010 corpus and after
    adding a brand to `BRANDS` (that changes keys), not for new uploads.
  - **Only the processor links new uploads**, like the other processed columns:
    `glider_alias_id` is in `ProcessedColumns`, so a client can't claim one.
  - Resolution (`resolveGliderSql`): exact `(brand, model)` key, else a brandless alias
    matches on model alone **only if a single glider lists that key**. Pass it `?` params
    or _qualified_ columns: a bare `brand_key` binds to `glider_keys` inside its subqueries
    and matched every alias to the first glider.
  - `data/gliders.csv` was seeded from the 318 most common prod model keys (~80% of the
    flights that name a glider). The unmapped aliases ordered by flight count are the
    to-do list. Numeric sizes (`Sigma 10 25`) can't be told from generations, so they're
    merged by listing several keys on one glider.
- **Sort tiebreakers follow the sort direction** (`ORDER BY <col> ${dir}, id ${dir}`), and
  migration 0004 adds `(duration_s, id)` / `(max_altitude, id)` to go with 0002's
  `(flight_date, id)`. The indexes are the real fix — those two columns had none, so
  sorting by them was a genuine full scan plus a full sort to return 50 rows. The
  direction match is cheaper insurance and the reasoning is counter-intuitive enough to
  write down: `ORDER BY col DESC, id ASC` over a `(col, id)` index does **not** read the
  whole table — SQLite sorts only each run of equal `col` values ("TEMP B-TREE FOR LAST
  TERM") and exits at the LIMIT, ~1 ms at 200k rows. It degenerates only when one value
  covers a huge run, which `max_altitude ASC` does (every NULL row, one run): 88 ms and a
  full read, versus 0 ms matched. Cost: same-date flights come back in a different order
  than before, including from the public API — still newest-first and still total/stable.

- **Uploads are rejected** for: >5 MB, unparseable, <5 valid fixes, bad date,
  out-of-range coords, or an id already in D1. `ingestIgc`/`extractMetadata` never throw on bad input — they
  return `{ ok: false, error }`.
- **R2 holds gzip only, never raw IGC bytes.** `ingestIgc` gzips (`CompressionStream`,
  native to `workerd`/Node, no dependency) after validation/hashing and sets
  `httpMetadata.contentEncoding: 'gzip'` on the `BUCKET.put`. `size_bytes` is still the
  _uncompressed_ logical file size, captured before gzip. Reads rely on that metadata:
  the R2-public-URL path serves it automatically, and `src/routes/f/[id]/+server.ts`
  hardcodes the same `Content-Encoding: gzip` header since every object is gzip. Fetch
  and browsers decode this transparently; `curl`/`wget` need `--compressed` or the
  downloaded `.igc` is raw gzip bytes. `scripts/import-igc.ts` mirrors this: its local
  `.igc` files are themselves pre-gzipped, so it gunzips only in-memory to parse/hash,
  and re-gzips only for anonymous imports (where stripping headers changes the bytes);
  named imports upload the source gzip bytes unmodified.
- **Uploads may arrive gzipped, and the upload page always sends gzip.** Gzip was the
  costliest step of an ingest (measured 2026-11-07 on the local corpus: ~6 ms of a ~11 ms
  median file, against the free plan's ~10 ms CPU per request, which 1102'd uploads in
  prod), and inflating costs about a sixth of that. So `upload/+page.svelte` compresses
  in the browser, and `ingestIgc` detects gzip by **magic bytes** (not a header, so any
  client and the no-JS form get it for free), inflates with `gunzipCapped`, and stores
  the **client's gzip untouched**. That is safe only because the stored bytes are the
  ones whose inflation was validated and hashed — don't store a client gzip anywhere
  that skips the inflate. Two things to keep:
  - `gunzipCapped` stops at `MAX_FILE_BYTES` of _output_: the 5 MB check on the body
    alone would let a 20 KB gzip bomb expand to gigabytes on the Worker.
  - **Anonymous uploads**: the page strips headers before gzipping, and the Worker
    re-strips as the check. If that changes nothing, the client gzip is kept; otherwise
    (curl, a stale page) the Worker stores its own stripped bytes and gzips them itself.
    Never skip the re-strip on the strength of the page having done it.
- **The upload page's metadata is trusted, not verified** (glitch checks are no longer
  part of it: they run in the processor). Browser gzip alone changed
  nothing measurable in prod: Cloudflare analytics showed successful uploads at a
  median 20–27 ms CPU both before and after (prod is ~4× slower than local Node, so the
  local numbers above get proportions right, not absolutes), and once the free plan's
  overrun allowance runs out, requests are killed at exactly 10 ms — in bursts during
  a big batch, not per file. So the page also runs `extractMetadata` and sends the
  result in the `X-Flight-Metadata` header (`encodeURIComponent(JSON)`, since header
  values must be Latin-1); with it, `ingestIgc` skips parsing and only runs
  `checkClaimedMetadata` (types, ranges, real date, bounded strings, rebuilt field by
  field so extra keys never reach the INSERT) plus a sniff that the text starts with
  an A record and has a B record. This was a deliberate trade made on the free plan;
  the account is on Workers Paid now, so the app's CPU limit no longer forces it, but it
  was kept. What it does and doesn't allow:
  - A hand-crafted `POST` can store **wrong metadata or a non-flight file** shaped like
    IGC. It **cannot overwrite another flight**: the id is still hashed on the Worker
    from the bytes it stores. Don't ever accept a client-supplied id.
  - R2 holds the real files, so bad rows are recoverable: re-run `extractMetadata`
    over the corpus offline, `backfill-takeoff-time.ts`-style, and diff against D1.

## Where things are

- `src/lib/upload.ts` — `ingestIgc`, the single ingest pipeline (validate → duplicate
  check → D1 → R2 → queue), shared by the form action and the JSON API so both behave
  identically.
- `workers/processor/src/index.ts` — the queue consumer (glitch checks, XC scores,
  `processed_at`) and the cron sweep. `npm run processor:dev` runs it locally against
  the same `.wrangler/state` as `vite dev`; the local queue does reach it across the two
  processes, and `/__scheduled` on port 8788 fires the cron.
- **Browser upload fans out per-file**: with JS on, `upload/+page.svelte` POSTs each
  file separately to `/flights` (one file = one worker invocation = its own CPU budget),
  streaming results in. The multi-file server action in `upload/+page.server.ts` is the
  no-JS fallback (whole batch in one invocation — the CPU-heavy path we avoid via JS).
- `src/lib/igc.ts` — parse/validate/extract; re-exports `stripIdentifyingHeaders`.
- `src/lib/anonymize.ts` — `stripIdentifyingHeaders`, kept dependency-free so the
  browser can import it without bundling `igc-parser`/`tz-lookup`.
- `src/lib/gzip.ts` — `gzip`, `isGzip`, `gunzipCapped`, shared by Worker and browser.
- `src/lib/db.ts` — all D1 queries. `searchFlights` sort is whitelisted via
  `SORT_COLUMNS` (never interpolate a raw sort param); filters use bound `?` params.
  `getFlightsPage` expects `limit`/`offset` already bounded by the caller.
  `getFlightCount` is the cached row count — read the invariant above before touching it.
- `src/lib/params.ts` — `intParam` and `fieldsParam`, the one place query params get
  validated. `intParam`: absent → the supplied default; anything else must match
  `/^\d+$/` and sit within `[min, max]` or it throws `error(400, …)`. `fieldsParam`
  parses a comma-separated list against a whitelist, same reject-don't-coerce policy:
  an unknown name 400s (with the offender echoed, capped by `MAX_ECHO`) rather than
  being dropped, so a typo can't silently yield a wrong-shaped response. It returns
  results in _whitelist_ order, deduped — that's what makes response key order stable
  and independent of the request. Note this is the opposite policy from
  `searchFlights`/`browse`, which coerce-and-clamp: the public API rejects so callers
  learn the cap exists, while the UI never 400s on its own links. Use `intParam`
  rather than hand-rolling — `searchParams.get()` returns `null` for a missing param
  and `Number(null)`/`Number('')` are both `0`, so a bare coercion turns "not
  specified" into zero. That shipped as a bug once (`/flights` served one flight
  instead of 1000).
- `src/routes/flights/+server.ts` — public JSON API: `GET` returns one page of
  flights (default & max 1000 via `limit`, `offset` to skip ahead), with a `next`
  URL in the response for iterating the full dataset; `POST` ingests one `.igc`
  from the request body (`?anonymous=1`), no auth.
  **`GET` is sparse by default**: each item carries only `url` unless `?fields=`
  asks for more (`fields=all` for the whole row, else a comma-separated subset of
  `FLIGHT_COLUMNS` + `url`). This is a deliberate cost decision — the free-tier
  worker was reading and serialising 15 columns × 1000 rows for callers who only
  wanted the download link (~4× the bytes). `getFlightsPage` projects the column
  list into its SELECT instead of `SELECT *`; interpolating those names is safe
  only because they come from `FLIGHT_COLUMNS`, same argument as `SORT_COLUMNS`.
  Two things to keep straight: `url` is derived from `id`, so `id` is _fetched_
  whenever `url` is wanted but _emitted_ only if actually requested (hence the
  explicit key-picking loop — spreading the row would leak it); and `next` is a copy
  of the request URL, so `fields` propagates across pages for free. `POST` is
  exempt on purpose — one row, and `upload/+page.svelte` consumes the whole object.
  `FLIGHT_COLUMNS` is guarded by a `satisfies` + an `Assert<…>` conditional-type
  check against `keyof Flight`; the assert has to be _consumed_ to fire, since a
  type alias that merely resolves to `never` is not an error.
  **Gotcha**: `POST` must send a non-form `Content-Type` (e.g.
  `application/octet-stream`). curl's `--data-binary` default is
  `application/x-www-form-urlencoded`, which SvelteKit's CSRF guard rejects with
  "Cross-site POST form submissions are forbidden".
- `src/routes/f/[id]/+server.ts` — dev/fallback file streamer; in prod downloads go
  straight to `R2_PUBLIC_URL` (set in `wrangler.toml [vars]`) so traffic skips the Worker.
- Download URL logic (R2 public domain vs. `/f/[id]` fallback) is duplicated in
  `flights/+server.ts` and `flight/[id]/+page.server.ts` — keep them in sync.

## Known gaps

No rate limiting / WAF on upload yet (noted in README as production TODO).

Crawler cost control is only half done. `static/robots.txt` disallows `/browse?` (the
faceted URLs — every sort/dir/page/filter combination is a distinct URL running its own
query), `/flights` and `/f/`, leaving bare `/browse` crawlable so the detail pages stay
discoverable; there is no sitemap, so blocking `/browse` outright would de-index the
site. `/browse` sets `Cache-Control: public, max-age=60`, which only gets browsers and
intermediaries — **Cloudflare does not edge-cache HTML from a Worker by default**, so
absorbing crawler traffic before it reaches D1 still needs a Cache Rule on the zone.
That rule is not configured. Also unfixed: `pilot`/`glider` filters use
`LIKE '%x%'`, whose leading wildcard can never use an index, so a filtered search is
still a full scan — prefix matching or FTS5 would be the fix.

**`OFFSET` still walks the rows it skips**, which is now the largest remaining read
vector. Measured on prod: `LIMIT 50 OFFSET 10000` reads 10,050 rows, and walking the
whole `/flights` API via its `next` chain (187 pages × 1000) would read ~17M — more than
a day's budget in one crawl. `robots.txt` keeps well-behaved crawlers out of both paged
paths, but that is a request, not an enforcement. The real fix is keyset pagination
(`WHERE (flight_date, id) < (?, ?)` instead of `OFFSET`), which the `(col, id)` indexes
from 0004 already support; it would change the public API's paging contract, so it was
left out of that migration.
