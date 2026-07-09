// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB_NAME: D1Database;
				BUCKET: R2Bucket;
				/** Public base URL of the R2 bucket, e.g. "https://files.example.org". Empty in dev. */
				R2_PUBLIC_URL?: string;
				/** Cloudflare Turnstile site key (public). Empty in dev → widget hidden, check skipped. */
				TURNSTILE_SITEKEY?: string;
				/** Cloudflare Turnstile secret. Unset in dev → upload skips the check. */
				TURNSTILE_SECRET?: string;
			};
		}
	}
}

export {};
