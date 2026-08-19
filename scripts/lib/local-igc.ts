/**
 * Local .igc-corpus helpers shared by scripts/import-igc.ts and
 * scripts/backfill-gzip.ts.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { stripIdentifyingHeaders } from '../../src/lib/igc.ts';

/**
 * Hex SHA-256 of the given bytes — the flight id and R2 key. The Worker uses
 * `crypto.subtle`; node:crypto over the same UTF-8 bytes yields the identical hex.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Matches both naming conventions seen in the wild: plain `*.igc` and `*.igc.gz`
 * (the gzip extension kept on top, e.g. this repo's own scripts/backfill-gzip.ts
 * corpus). Content, not the name, determines whether a file is actually gzip. */
const IGC_FILE_RE = /\.igc(\.gz)?$/i;

/** Recursively (optionally) find every `*.igc`/`*.igc.gz` file under dir, sorted for stable order. */
export async function findIgcFiles(dir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(p);
      } else if (e.isFile() && IGC_FILE_RE.test(e.name)) {
        out.push(p);
      }
    }
  };
  await walk(dir);
  out.sort();
  return out;
}

/**
 * Map every local .igc file under dir to its flight id (SHA-256 of
 * identifier-stripped bytes), assuming each file is itself gzip-compressed
 * (matching what scripts/import-igc.ts and scripts/backfill-gzip.ts expect).
 * Unreadable/non-gzip files are skipped silently (if they were never a valid
 * import, they're not in D1 either, so they're irrelevant to any id lookup).
 */
export async function mapLocalIdsToPaths(dir: string, recursive: boolean): Promise<Map<string, string>> {
  const files = await findIgcFiles(dir, recursive);
  const map = new Map<string, string>();
  for (const path of files) {
    try {
      const text = new TextDecoder().decode(gunzipSync(await readFile(path)));
      const id = sha256Hex(new TextEncoder().encode(stripIdentifyingHeaders(text)));
      map.set(id, path);
    } catch {
      continue;
    }
  }
  return map;
}
