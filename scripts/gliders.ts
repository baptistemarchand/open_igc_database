/**
 * Sync the curated glider list (data/gliders.csv) into D1, and optionally link existing
 * flights to their glider alias (migration 0010).
 *
 *   npm run gliders:local  [-- --link] [-- --dry-run]
 *   npm run gliders:remote [-- --link] [-- --dry-run]
 *
 * Every run:
 *   1. upserts `gliders` by slug (so ids, and the aliases pointing at them, stay stable)
 *      and deletes the slugs no longer listed;
 *   2. rebuilds `glider_keys` from the CSV;
 *   3. re-resolves every alias (a few thousand rows): this is what applies a curation
 *      change, the flights themselves are never rewritten.
 *
 * `--link` also creates the aliases of every distinct `glider_type` in D1 and points
 * unlinked flights at them. Needed once for the flights uploaded before migration 0010,
 * and again after adding a brand to BRANDS (src/lib/glider.ts), which changes keys. New
 * uploads don't need it: workers/processor links them. It reads `glider_type` off its
 * covering index (one entry per flight, ~187k reads on prod) and writes each linked
 * flight once; re-running only touches flights still unlinked.
 *
 * Statements go through `wrangler d1 execute --file`, values inlined as literals. Every
 * one is validated against a strict pattern, never escaped (same argument as
 * scripts/backfill-takeoff-time.ts). Raw `glider_type` strings are free text, so they
 * travel hex-encoded (`CAST(X'…' AS TEXT)`) instead.
 *
 * Remote auth: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the env or a gitignored
 * scripts/import.env, as for the other scripts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDS_BY_KEY, gliderKey, resolveGliderSql } from '../src/lib/glider.ts';
import { loadEnvFile } from './lib/cf-api.ts';

const DB_NAME = 'open-igc-db';
const CSV_PATH = new URL('../data/gliders.csv', import.meta.url);
/** D1 refuses statements over 100 KB. */
const MAX_STATEMENT_BYTES = 80_000;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY = /^[a-z0-9]+$/;
/** Display names: letters, digits and a little punctuation. No quotes, so no escaping. */
const MODEL = /^[\p{L}\p{N}][\p{L}\p{N} .+/-]*$/u;

interface CuratedGlider {
  slug: string;
  brand_key: string;
  model: string;
  model_keys: string[];
}

function parseCsv(text: string): CuratedGlider[] {
  const lines = text.trim().split('\n');
  if (lines[0] !== 'slug,brand_key,model,model_keys') throw new Error('data/gliders.csv: unexpected header');
  const errors: string[] = [];
  const slugs = new Set<string>();
  const keys = new Map<string, string>();
  const gliders = lines.slice(1).map((line, i) => {
    const at = `data/gliders.csv:${i + 2}`;
    const [slug, brand_key, model, rawKeys, ...extra] = line.split(',');
    const model_keys = (rawKeys ?? '').split('|');
    if (extra.length) errors.push(`${at}: too many fields`);
    if (!SLUG.test(slug)) errors.push(`${at}: bad slug ${JSON.stringify(slug)}`);
    if (slugs.has(slug)) errors.push(`${at}: duplicate slug ${slug}`);
    slugs.add(slug);
    if (!BRANDS_BY_KEY.has(brand_key)) errors.push(`${at}: unknown brand_key ${JSON.stringify(brand_key)}`);
    if (!MODEL.test(model ?? '')) errors.push(`${at}: bad model ${JSON.stringify(model)}`);
    for (const k of model_keys) {
      if (!KEY.test(k)) errors.push(`${at}: bad model key ${JSON.stringify(k)}`);
      const owner = keys.get(`${brand_key}/${k}`);
      if (owner) errors.push(`${at}: key ${brand_key}/${k} already belongs to ${owner}`);
      keys.set(`${brand_key}/${k}`, slug);
    }
    return { slug, brand_key, model, model_keys };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  return gliders;
}

function syncSql(gliders: CuratedGlider[]): string[] {
  const glidersValues = gliders
    .map((g) => `('${g.slug}', '${BRANDS_BY_KEY.get(g.brand_key)!.name}', '${g.model}')`)
    .join(',\n  ');
  const keyValues = gliders
    .flatMap((g) => g.model_keys.map((k) => `('${g.slug}', '${g.brand_key}', '${k}')`))
    .join(',\n  ');
  return [
    'DELETE FROM glider_keys;',
    `INSERT INTO gliders (slug, brand, model) VALUES\n  ${glidersValues}\n` +
      'ON CONFLICT (slug) DO UPDATE SET brand = excluded.brand, model = excluded.model;',
    `DELETE FROM gliders WHERE slug NOT IN (${gliders.map((g) => `'${g.slug}'`).join(', ')});`,
    `WITH v(slug, brand_key, model_key) AS (VALUES\n  ${keyValues})\n` +
      'INSERT INTO glider_keys (brand_key, model_key, glider_id)\n' +
      'SELECT v.brand_key, v.model_key, g.id FROM v JOIN gliders g ON g.slug = v.slug;',
  ];
}

/** Applies the curated keys to every alias, including the ones `--link` just created. */
const RESOLVE_SQL = `UPDATE glider_aliases SET glider_id = ${resolveGliderSql('glider_aliases.brand_key', 'glider_aliases.model_key')};`;

/** Alias inserts, then flight updates, each split to stay under the statement limit. */
function linkSql(rawTypes: string[]): string[] {
  const byRaw = rawTypes.flatMap((t) => {
    const k = gliderKey(t);
    return k ? [{ hex: Buffer.from(t, 'utf8').toString('hex'), ...k }] : [];
  });
  for (const r of byRaw) {
    // gliderKey's output is [a-z0-9] by construction; checked anyway since it's inlined.
    if (!/^[a-z0-9]*$/.test(r.brand_key) || !KEY.test(r.model_key)) throw new Error(`bad key ${JSON.stringify(r)}`);
  }
  const aliases = [...new Map(byRaw.map((r) => [`${r.brand_key}/${r.model_key}`, r])).values()];

  const chunked = (rows: string[], head: string, tail: string): string[] => {
    const out: string[] = [];
    let cur: string[] = [];
    let size = 0;
    for (const row of rows) {
      if (cur.length && size + row.length > MAX_STATEMENT_BYTES) {
        out.push(head + cur.join(',\n  ') + tail);
        cur = [];
        size = 0;
      }
      cur.push(row);
      size += row.length + 4;
    }
    if (cur.length) out.push(head + cur.join(',\n  ') + tail);
    return out;
  };

  return [
    ...chunked(
      aliases.map((a) => `('${a.brand_key}', '${a.model_key}')`),
      'INSERT INTO glider_aliases (brand_key, model_key) VALUES\n  ',
      '\nON CONFLICT (brand_key, model_key) DO NOTHING;',
    ),
    ...chunked(
      byRaw.map((r) => `(CAST(X'${r.hex}' AS TEXT), '${r.brand_key}', '${r.model_key}')`),
      'WITH v(glider_type, brand_key, model_key) AS (VALUES\n  ',
      ')\nUPDATE flights SET glider_alias_id = a.id\n' +
        'FROM v JOIN glider_aliases a ON a.brand_key = v.brand_key AND a.model_key = v.model_key\n' +
        'WHERE flights.glider_type = v.glider_type AND flights.glider_alias_id IS NULL;',
    ),
  ];
}

function wrangler(target: string, args: string[], capture = false): string {
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, target, ...args], {
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`wrangler exited with ${res.status}${capture ? `\n${res.stdout}` : ''}`);
  return res.stdout ?? '';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = argv.includes('--remote') ? '--remote' : argv.includes('--local') ? '--local' : null;
  if (!target) throw new Error('pass --local or --remote');
  const link = argv.includes('--link');
  const dryRun = argv.includes('--dry-run');
  await loadEnvFile();

  const gliders = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const statements = syncSql(gliders);

  if (link) {
    const out = wrangler(
      target,
      ['--json', '--command', 'SELECT DISTINCT glider_type AS t FROM flights WHERE glider_type IS NOT NULL'],
      true,
    );
    const rawTypes = (JSON.parse(out) as { results: { t: string }[] }[])[0].results.map((r) => r.t);
    console.log(`${rawTypes.length} distinct glider_type values`);
    statements.push(...linkSql(rawTypes));
  }
  statements.push(RESOLVE_SQL);

  const dir = mkdtempSync(join(tmpdir(), 'gliders-'));
  const file = join(dir, 'gliders.sql');
  writeFileSync(file, statements.join('\n\n') + '\n');
  console.log(`${gliders.length} gliders, ${statements.length} statements → ${file}`);
  if (dryRun) return;
  try {
    wrangler(target, ['--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
