# Open IGC Database

A free, open, public database of paragliding flights (IGC tracklogs), built for research.
Anyone can upload their `.igc` files and browse everyone else's.

Three pages:

- **Upload** — add one or many IGC files (public domain / CC0).
- **Browse** — search by pilot, date, and glider; sort by duration, altitude, or date.
- **Flight** — textual metadata for a flight + a `.igc` download link.

## Architecture

Serverless on Cloudflare, one SvelteKit app:

- **SvelteKit** (`@sveltejs/adapter-cloudflare`) serves the pages and handles upload.
- **R2** stores the raw `.igc` files (object key = SHA-256 of the bytes → free dedup).
  Downloads are served straight from R2's public domain in production (zero egress, no
  Worker cost); in dev they fall back to the `/f/[id]` route which streams from the binding.
- **D1** (SQLite) stores only lightweight flight metadata for search — never track points.
- IGC files are parsed once, **server-side at upload** (`igc-parser`), to extract metadata.
  There is no client-side parsing, no maps, and no charts.

Key files: `src/lib/igc.ts` (parse + validate + extract), `src/lib/db.ts` (D1 queries),
`src/routes/upload/+page.server.ts` (upload pipeline), `migrations/0001_init.sql` (schema).

## Local development

```sh
npm install
# Create/refresh the local D1 database (Miniflare-backed, real SQLite):
npx wrangler d1 migrations apply open-igc-db --local
npm run dev
```

`vite dev` exposes the R2/D1 bindings on `event.platform.env` via the adapter's
platformProxy (local Miniflare state under `.wrangler/state`) — no cloud calls, no keys.
In dev, Turnstile is skipped (no secret) and downloads use the `/f/[id]` fallback.

Type-check: `npm run check`.

## Deploying to Cloudflare

1. Create the resources and copy the D1 `database_id` into `wrangler.toml`:
   ```sh
   npx wrangler d1 create open-igc-db
   npx wrangler r2 bucket create open-igc-files
   ```
2. Apply migrations to the remote DB: `npx wrangler d1 migrations apply open-igc-db --remote`
3. Give the R2 bucket a public custom domain and set `R2_PUBLIC_URL` (in `wrangler.toml`
   `[vars]`) to it, e.g. `https://files.example.org`, so downloads link straight to R2.
4. For spam protection, create a Cloudflare Turnstile widget and set:
   ```sh
   # public site key (non-secret) → wrangler.toml [vars] TURNSTILE_SITEKEY
   npx wrangler pages secret put TURNSTILE_SECRET   # the secret key
   ```
   When these are unset the upload form works without a challenge.
5. Build & deploy: `npm run build` then deploy per your Cloudflare Pages/Workers setup.

## Notes & possible future work

- Uploads with too few valid fixes, unparseable content, or implausible coordinates are
  rejected. Files over 5 MB are rejected (IGC files are far smaller).
- A production **rate-limit binding / WAF rule** should be added on the upload route.
- Deferred by design: anonymity option (strip pilot headers), public JSON research API,
  a bulk dataset dump, and optional map / altitude-chart visualization.
