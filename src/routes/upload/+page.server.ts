import { fail } from '@sveltejs/kit';
import { ingestIgc } from '$lib/upload';
import type { Actions, PageServerLoad } from './$types';

const MAX_FILES = 500;

export const load: PageServerLoad = async ({ platform }) => {
  // Expose the public Turnstile site key (empty in dev → widget hidden).
  return { turnstileSiteKey: platform?.env?.TURNSTILE_SITEKEY ?? '' };
};

async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

interface FileResult {
  name: string;
  status: 'added' | 'duplicate' | 'error';
  id?: string;
  error?: string;
}

export const actions: Actions = {
  default: async ({ request, platform, getClientAddress }) => {
    if (!platform?.env) return fail(503, { error: 'Storage unavailable.' });
    const { DB_NAME: DB, BUCKET, TURNSTILE_SECRET } = platform.env;

    const form = await request.formData();

    // Spam check — only enforced when a secret is configured (skipped in dev).
    if (TURNSTILE_SECRET) {
      const token = String(form.get('cf-turnstile-response') ?? '');
      const ok = token && (await verifyTurnstile(TURNSTILE_SECRET, token, getClientAddress()));
      if (!ok)
        return fail(400, {
          error: 'Anti-spam check failed. Please try again.',
        });
    }

    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return fail(400, { error: 'No files selected.' });
    if (files.length > MAX_FILES) return fail(400, { error: `Too many files (max ${MAX_FILES}).` });

    // Applies to every file in this submission: strip identifying details and
    // list the pilot as "Anonymous".
    const anonymous = form.get('anonymous') != null;

    const now = Math.floor(Date.now() / 1000);
    const results: FileResult[] = [];

    for (const file of files) {
      try {
        const result = await ingestIgc({ DB_NAME: DB, BUCKET }, await file.arrayBuffer(), {
          anonymous,
          uploadedAt: now,
        });
        if (!result.ok) {
          results.push({ name: file.name, status: 'error', error: result.error });
          continue;
        }
        results.push({ name: file.name, status: result.status, id: result.flight.id });
      } catch (e) {
        results.push({
          name: file.name,
          status: 'error',
          error: (e as Error).message,
        });
      }
    }

    return { results };
  },
};
