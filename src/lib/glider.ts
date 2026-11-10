/**
 * Glider-string normalization: turns the free-text HFGTY header (`glider_type`) into a
 * `(brand_key, model_key)` pair, the key of `glider_aliases` (migration 0010).
 *
 * The raw string is kept on the flight; this only decides which strings are "the same".
 * Measured on the prod corpus (2026-11-10): 5,716 distinct raw strings, 3,123 once
 * lowercased and reduced to letters and digits, 2,512 once the brand is set apart too.
 * Matching stays deliberately mechanical: anything smarter (typos, generations, two
 * gliders in one string) is curation, in data/gliders.csv.
 *
 * Dependency-free, so the processor, the scripts and the app can all import it.
 */

export interface Brand {
  /** Stored in `glider_aliases.brand_key` and `data/gliders.csv`, never renamed. */
  key: string;
  name: string;
  /** Spellings as joined tokens: "Air Design" and "AirDesign" both give `airdesign`. */
  aliases: string[];
}

/**
 * Brands seen at the start of corpus strings. A string whose brand is missing here gets
 * `brand_key = ''` and the brand stays inside its model key, so adding a brand later
 * only creates new aliases: re-run `npm run gliders:remote -- --link`.
 */
export const BRANDS: readonly Brand[] = [
  { key: 'advance', name: 'Advance', aliases: ['advance'] },
  { key: 'aircross', name: 'Aircross', aliases: ['aircross'] },
  { key: 'airdesign', name: 'Air Design', aliases: ['airdesign'] },
  { key: 'airwave', name: 'Airwave', aliases: ['airwave'] },
  { key: 'apco', name: 'Apco', aliases: ['apco', 'apcoaviation'] },
  { key: 'axis', name: 'Axis', aliases: ['axis'] },
  { key: 'bgd', name: 'BGD', aliases: ['bgd', 'brunogibertdesign'] },
  { key: 'davinci', name: 'Davinci', aliases: ['davinci', 'davincigliders'] },
  { key: 'dudek', name: 'Dudek', aliases: ['dudek'] },
  { key: 'firebird', name: 'Firebird', aliases: ['firebird'] },
  { key: 'flow', name: 'Flow', aliases: ['flow', 'flowparagliders'] },
  { key: 'freex', name: 'Freex', aliases: ['freex'] },
  { key: 'gin', name: 'Gin', aliases: ['gin', 'gingliders'] },
  { key: 'gradient', name: 'Gradient', aliases: ['gradient'] },
  { key: 'icaro', name: 'Icaro', aliases: ['icaro', 'icaroparagliders'] },
  { key: 'independence', name: 'Independence', aliases: ['independence'] },
  { key: 'itv', name: 'ITV', aliases: ['itv'] },
  { key: 'kortel', name: 'Kortel', aliases: ['kortel'] },
  { key: 'macpara', name: 'Mac Para', aliases: ['macpara', 'mac'] },
  { key: 'nervures', name: 'Nervures', aliases: ['nervures'] },
  { key: 'niviuk', name: 'Niviuk', aliases: ['niviuk'] },
  { key: 'nova', name: 'Nova', aliases: ['nova'] },
  { key: 'ozone', name: 'Ozone', aliases: ['ozone'] },
  { key: 'phi', name: 'Phi', aliases: ['phi'] },
  { key: 'skyparagliders', name: 'Sky Paragliders', aliases: ['sky', 'skyparagliders'] },
  { key: 'skywalk', name: 'Skywalk', aliases: ['skywalk'] },
  { key: 'sol', name: 'Sol', aliases: ['sol', 'solparagliders'] },
  { key: 'supair', name: 'Supair', aliases: ['supair'] },
  { key: 'swing', name: 'Swing', aliases: ['swing'] },
  { key: 'tripleseven', name: 'Triple Seven', aliases: ['tripleseven', '777'] },
  { key: 'up', name: 'UP', aliases: ['up', 'upinternational'] },
  { key: 'uturn', name: 'U-Turn', aliases: ['uturn'] },
  { key: 'windtech', name: 'Windtech', aliases: ['windtech'] },
];

export const BRANDS_BY_KEY: ReadonlyMap<string, Brand> = new Map(BRANDS.map((b) => [b.key, b]));

const BRAND_BY_ALIAS = new Map(BRANDS.flatMap((b) => b.aliases.map((a) => [a, b.key] as const)));
const MAX_ALIAS_TOKENS = 3;

/**
 * Whole-string placeholders: device defaults (`NKN`, `not set`, `APPAREIL`…) and the
 * generic word for paraglider. Together they are ~49% of prod flights. They get no alias,
 * so they never show up as a curation to-do.
 */
const NO_GLIDER = new Set([
  '',
  'notset',
  'nkn',
  'none',
  'null',
  'unknown',
  'default',
  'appareil',
  'glider',
  'paraglider',
  'parapente',
  'parapendio',
  'gleitschirm',
  'para',
  'wing',
  'test',
  'na',
  'gliders',
  'paragliders',
]);

/**
 * Size tokens, dropped when they end the string: a size is the same glider. Only letter
 * sizes: numeric ones (`22`, `25`) can't be told from a generation number.
 */
const SIZES = new Set(['xxs', 'xs', 's', 'sm', 'ms', 'm', 'ml', 'l', 'xl', 'xxl']);

export interface GliderKey {
  /** A `BRANDS` key, or '' when the string starts with no known brand. */
  brand_key: string;
  /** Lowercase letters and digits only, never empty. */
  model_key: string;
}

/** `(brand_key, model_key)` for a raw HFGTY value, or null when it names no glider. */
export function gliderKey(raw: string | null | undefined): GliderKey | null {
  // NFKD splits accents off their letter, so the split below drops them.
  const tokens = (raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (NO_GLIDER.has(tokens.join(''))) return null;

  let brand_key = '';
  // Longest spelling first: "Gin Gliders Leopard" is brand `gin`, model `leopard`.
  for (let n = Math.min(MAX_ALIAS_TOKENS, tokens.length - 1); n >= 1; n--) {
    const brand = BRAND_BY_ALIAS.get(tokens.slice(0, n).join(''));
    if (brand) {
      brand_key = brand;
      tokens.splice(0, n);
      break;
    }
  }
  if (tokens.length > 1 && SIZES.has(tokens[tokens.length - 1])) tokens.pop();

  const model_key = tokens.join('');
  // A bare brand ("Ozone", "Gin Gliders") has no model left: no glider either.
  if (!model_key || NO_GLIDER.has(model_key) || BRAND_BY_ALIAS.has(model_key)) return null;
  return { brand_key, model_key };
}

/**
 * SQL expression giving the glider an alias resolves to, NULL when none or ambiguous.
 * `brand` and `model` are SQL expressions for the alias: `?` params, or *qualified*
 * columns (`glider_aliases.brand_key`). A bare `brand_key` would bind to `glider_keys`
 * inside the subqueries and match every row.
 *
 * An exact (brand, model) key wins. A brandless alias falls back on its model key alone,
 * but only when a single glider lists it: unbranded "Delta 3" goes to Ozone only while
 * no other brand has a Delta 3 in the curated data.
 */
export function resolveGliderSql(brand: string, model: string): string {
  return `COALESCE(
    (SELECT k.glider_id FROM glider_keys k WHERE k.brand_key = ${brand} AND k.model_key = ${model}),
    (SELECT CASE WHEN COUNT(DISTINCT k.glider_id) = 1 THEN MIN(k.glider_id) END
       FROM glider_keys k WHERE ${brand} = '' AND k.model_key = ${model})
  )`;
}
