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
- **Uploads are rejected** for: >5 MB, unparseable, <5 valid fixes, bad date, or
  out-of-range coords. `ingestIgc`/`extractMetadata` never throw on bad input — they
  return `{ ok: false, error }`.

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
- `src/routes/flights/+server.ts` — public JSON API: `GET` lists all flights,
  `POST` ingests one `.igc` from the request body (`?anonymous=1`), no auth.
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
