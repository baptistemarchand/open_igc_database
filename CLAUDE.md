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
  `env.BUCKET` (bucket_name `open-igc`). The binding name is the code identifier, not
  the resource name.

## Data model / invariants (don't break these)

- **`id` = SHA-256 hex of the _identifier-stripped_ bytes**, not the raw file bytes.
  (The migration/README comments saying "hash of the file bytes" are imprecise.) This
  makes dedup name-independent: the same track uploaded named vs. anonymous → one id.
  `id` is also the R2 object key (`{id}.igc`) and the D1 primary key.
- **Upsert is latest-upload-wins** (`upsertFlight`): re-uploading overwrites the row,
  so an anonymous re-upload can relabel a named flight and vice versa.
- **Anonymity**: `stripIdentifyingHeaders` blanks the _values_ of H-records
  PLT/CM2/GID/CID (keeps them structurally valid); glider _type_ GTY is kept on purpose
  (searchable, not identifying). When `anonymous`, the stripped bytes are stored and
  `pilot_name` is set to `"Anonymous"`.
- **Metadata parsing/validation is server-side at upload only** (`src/lib/igc.ts`,
  via `igc-parser`). Track points are never stored — D1 holds only the metadata columns
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
    `takeoff_hour` needs a re-read and re-parse of every R2 object, since track points
    aren't stored — `scripts/backfill-gzip.ts` is the pattern.
- **Uploads are rejected** for: >5 MB, unparseable, <5 valid fixes, bad date, or
  out-of-range coords. `ingestIgc`/`extractMetadata` never throw on bad input — they
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

## Where things are

- `src/lib/upload.ts` — `ingestIgc`, the single ingest pipeline (validate → R2 → D1),
  shared by the form action and the JSON API so both behave identically.
- **Browser upload fans out per-file**: with JS on, `upload/+page.svelte` POSTs each
  file separately to `/flights` (one file = one worker invocation = its own CPU budget),
  streaming results in. The multi-file server action in `upload/+page.server.ts` is the
  no-JS fallback (whole batch in one invocation — the CPU-heavy path we avoid via JS).
- `src/lib/igc.ts` — parse/validate/extract + `stripIdentifyingHeaders`.
- `src/lib/db.ts` — all D1 queries. `searchFlights` sort is whitelisted via
  `SORT_COLUMNS` (never interpolate a raw sort param); filters use bound `?` params.
  `getFlightsPage` expects `limit`/`offset` already bounded by the caller.
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
