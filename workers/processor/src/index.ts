/**
 * Processor Worker: consumes the flight-processing queue that every upload feeds
 * (src/lib/upload.ts). For each flight it reads the stored file, computes the full
 * `suspicious` bitmask and, for clean flights, the XC scores, then sets `processed_at`.
 * Until then the flight is hidden from /browse and left out of /stats.
 *
 * `processed_at IS NULL` is the source of truth, not the queue: a send can fail after
 * the upload succeeded, and messages that exhaust their retries go to a dead-letter
 * queue nobody reads. The cron sweep re-enqueues whatever is still unprocessed.
 */
import IGCParser from 'igc-parser';
import { gunzipCapped, isGzip } from '../../../src/lib/gzip.ts';
import { SUSPICIOUS, suspiciousFlags, trackFixes, trackFlags } from '../../../src/lib/suspicious.ts';
import { scoreFlight } from '../../../scripts/lib/xcscore.ts';

interface ProcessMessage {
  id: string;
}

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  FLIGHT_QUEUE: Queue<ProcessMessage>;
}

/** Same cap as MAX_FILE_BYTES in src/lib/upload.ts: the inflated file never exceeds it. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Solver budget per rule, in evaluated solutions rather than milliseconds: workerd's
 * clock doesn't move during synchronous code (see `XcBudget`).
 *
 * Measured locally on 299 corpus files with the backfill's 20 s budget: 18 solutions/ms
 * on average, but only 6.4/ms on the slowest kind of track, since a solution's cost
 * grows with the track. Sized on that worst rate: 150k is ~24 s per rule locally, so
 * two rules stay under cpu_ms (300 s, one flight per invocation) even if prod runs 4×
 * slower than a laptop, as the app's uploads did. 4 of the 299 files needed more and
 * get the best score found so far, as on a backfill timeout.
 */
const LOOP_BUDGET = 150_000;

/** Uploads younger than this are left to their own message, so the sweep doesn't double them. */
const SWEEP_MIN_AGE_S = 600;
const SWEEP_LIMIT = 1000;
/** Queue.sendBatch accepts at most 100 messages. */
const SEND_BATCH = 100;

interface Outcome {
  suspicious: number | null;
  score_xcontest: number | null;
  score_ffvl: number | null;
}

const UNPROCESSABLE: Outcome = { suspicious: SUSPICIOUS.UNPROCESSABLE, score_xcontest: null, score_ffvl: null };

/**
 * Glitch checks, then scores for clean flights only: a glitchy track gives a
 * meaningless score. Pure CPU, so any throw here is the file's fault (or a solver bug)
 * and would fail again on retry: it maps to UNPROCESSABLE instead of a retry loop.
 */
function analyze(id: string, text: string, row: { duration_s: number; max_altitude: number | null }): Outcome {
  try {
    const parsed = IGCParser.parse(text, { lenient: true });
    const suspicious = suspiciousFlags({ ...row, suspicious: trackFlags(trackFixes(parsed)) });
    if (suspicious != null) return { suspicious, score_xcontest: null, score_ffvl: null };
    const { scores } = scoreFlight(parsed, { loops: LOOP_BUDGET });
    return { suspicious: null, ...scores };
  } catch (e) {
    console.error(`${id}: could not analyze`, e);
    return UNPROCESSABLE;
  }
}

/** I/O errors (D1, R2) propagate, so the caller retries the message. */
async function processFlight(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare('SELECT duration_s, max_altitude FROM flights WHERE id = ?')
    .bind(id)
    .first<{ duration_s: number; max_altitude: number | null }>();
  if (!row) return; // deleted since it was queued

  let outcome: Outcome;
  const obj = await env.BUCKET.get(`${id}.igc`);
  if (!obj) {
    console.error(`${id}: missing from R2`);
    outcome = UNPROCESSABLE;
  } else {
    // The binding returns the stored bytes as-is, and R2 holds gzip only.
    const raw = await obj.arrayBuffer();
    const buf = isGzip(raw) ? await gunzipCapped(raw, MAX_FILE_BYTES).catch(() => null) : raw;
    outcome = buf ? analyze(id, new TextDecoder().decode(buf), row) : UNPROCESSABLE;
  }

  await env.DB.prepare(
    'UPDATE flights SET suspicious = ?, score_xcontest = ?, score_ffvl = ?, processed_at = ? WHERE id = ?',
  )
    .bind(outcome.suspicious, outcome.score_xcontest, outcome.score_ffvl, Math.floor(Date.now() / 1000), id)
    .run();
}

export default {
  /**
   * One message at a time, never concurrently: igc-xc-score keeps module-level state, so
   * two scorings must not interleave. Synchronous solving already guarantees that inside
   * an isolate; awaiting each flight before the next keeps it obvious.
   */
  async queue(batch: MessageBatch<ProcessMessage>, env: Env): Promise<void> {
    const seen = new Set<string>();
    for (const msg of batch.messages) {
      const id = msg.body?.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id) || seen.has(id)) {
        msg.ack();
        continue;
      }
      seen.add(id);
      try {
        await processFlight(env, id);
        msg.ack();
      } catch (e) {
        console.error(`${id}: processing failed, will retry`, e);
        msg.retry();
      }
    }
  },

  /** Re-enqueue unprocessed flights: failed sends, dead-lettered messages, bulk imports. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - SWEEP_MIN_AGE_S;
    // A range on the partial index from migration 0009: reads only unprocessed rows.
    const { results } = await env.DB.prepare(
      'SELECT id FROM flights WHERE processed_at IS NULL AND uploaded_at < ? ORDER BY uploaded_at LIMIT ?',
    )
      .bind(cutoff, SWEEP_LIMIT)
      .all<{ id: string }>();
    for (let i = 0; i < results.length; i += SEND_BATCH) {
      await env.FLIGHT_QUEUE.sendBatch(results.slice(i, i + SEND_BATCH).map((r) => ({ body: { id: r.id } })));
    }
    if (results.length > 0) console.log(`Re-enqueued ${results.length} unprocessed flight(s).`);
  },
} satisfies ExportedHandler<Env, ProcessMessage>;
