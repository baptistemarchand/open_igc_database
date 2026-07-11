import { fail } from '@sveltejs/kit';
import { ingestIgc } from '$lib/upload';
import type { Actions } from './$types';

const MAX_FILES = 500;

interface FileResult {
  name: string;
  status: 'added' | 'duplicate' | 'error';
  id?: string;
  error?: string;
}

export const actions: Actions = {
  default: async ({ request, platform }) => {
    if (!platform?.env) return fail(503, { error: 'Storage unavailable.' });
    const { DB_NAME: DB, BUCKET } = platform.env;

    const form = await request.formData();

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
