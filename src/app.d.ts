// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types';
import type { ProcessMessage } from '$lib/upload';

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    interface Platform {
      env: {
        DB: D1Database;
        BUCKET: R2Bucket;
        /** Producer side of the flight-processing queue; workers/processor consumes it. */
        FLIGHT_QUEUE: Queue<ProcessMessage>;
        /** Public base URL of the R2 bucket, e.g. "https://files.example.org". Empty in dev. */
        R2_PUBLIC_URL?: string;
      };
    }
  }
}

export {};
