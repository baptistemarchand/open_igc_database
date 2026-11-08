# Open IGC Database

A free, open, public database of paragliding flights (IGC tracklogs), built for research.
Anyone can upload their `.igc` files and browse everyone else's.

Three pages:

- **Upload** — add one or many IGC files (public domain / CC0).
- **Browse** — search by pilot, date, and glider; sort by duration, altitude, or date.
- **Flight** — textual metadata for a flight + a `.igc` download link.

## Architecture

Serverless on Cloudflare: one SvelteKit app and one queue-consumer Worker.

- **SvelteKit** (`@sveltejs/adapter-cloudflare`) serves the pages and handles upload.
- **R2** stores the `.igc` files gzip-compressed (object key = SHA-256 of the bytes →
  free dedup), served with `Content-Encoding: gzip` so browsers/`fetch` decode
  transparently (`curl`/`wget` need `--compressed`). Downloads are served straight from
  R2's public domain in production (zero egress, no Worker cost); in dev they fall back
  to the `/f/[id]` route which streams from the binding.
- **D1** (SQLite) stores only lightweight flight metadata for search — never track points.
- IGC files are parsed at upload (`igc-parser`), to extract metadata. A file already
  in the database (same track, named or anonymous) is refused.
- **Queues + processor Worker** (`workers/processor/`): every upload pushes its flight
  id onto the `flight-processing` queue. The processor checks the track for GPS
  glitches and computes XContest/FFVL scores, then sets `processed_at`. Until then the
  flight is hidden from Browse and not counted in the stats. Scoring is too heavy for
  the app's Worker, which is why it lives in its own Worker (on Workers Paid).

```
upload ──► app Worker ──► D1 row (processed_at NULL) + R2 file
                │
                └──► queue flight-processing ──► processor Worker ──► D1: suspicious, scores, processed_at
                          ▲                                  │
                          └──── cron every 30 min: re-enqueue rows still unprocessed
```

Key files: `src/lib/igc.ts` (parse + validate + extract), `src/lib/db.ts` (D1 queries),
`src/lib/upload.ts` (upload pipeline), `workers/processor/src/index.ts` (processing),
`migrations/0001_init.sql` (schema).

## Local development

```sh
npm install
# Create/refresh the local D1 database (Miniflare-backed, real SQLite):
npx wrangler d1 migrations apply open-igc-db --local
npm run dev
```

`vite dev` exposes the R2/D1 bindings on `event.platform.env` via the adapter's
platformProxy (local Miniflare state under `.wrangler/state`) — no cloud calls, no keys.
In dev, downloads use the `/f/[id]` fallback.

To process uploads locally, run the consumer next to it (same local D1/R2/queue state):
`npm run processor:dev`. `curl localhost:8788/__scheduled` fires its cron.

Type-check: `npm run check` and `npm run check:processor`.

## Deploying to Cloudflare

1. Create the resources and copy the D1 `database_id` into `wrangler.toml`:
   ```sh
   npx wrangler d1 create open-igc-db
   npx wrangler r2 bucket create open-igc-files
   ```
   ```sh
   npx wrangler queues create flight-processing
   npx wrangler queues create flight-processing-dlq
   ```
2. Apply migrations to the remote DB: `npx wrangler d1 migrations apply open-igc-db --remote`
3. Give the R2 bucket a public custom domain and set `R2_PUBLIC_URL` (in `wrangler.toml`
   `[vars]`) to it, e.g. `https://files.example.org`, so downloads link straight to R2.
4. Deploy the processor (`npm run processor:deploy`, needs Workers Paid for its CPU
   limit), then build & deploy the app: `npm run build` then deploy per your Cloudflare
   Pages/Workers setup.

## Notes & possible future work

- Uploads with too few valid fixes, unparseable content, or implausible coordinates are
  rejected. Files over 5 MB are rejected (IGC files are far smaller).
- A production **rate-limit binding / WAF rule** should be added on the upload route.
- Deferred by design: anonymity option (strip pilot headers), public JSON research API,
  a bulk dataset dump, and optional map / altitude-chart visualization.
