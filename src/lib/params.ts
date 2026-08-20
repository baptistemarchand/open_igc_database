import { error } from '@sveltejs/kit';

/** Cap on how much of a bad value gets echoed back in an error message. */
const MAX_ECHO = 32;

/** Truncate a caller-supplied value before quoting it back in a 400. */
function echo(raw: string): string {
  return raw.length > MAX_ECHO ? `${raw.slice(0, MAX_ECHO)}…` : raw;
}

/**
 * Read an integer query param, rejecting anything malformed with a 400.
 *
 * An absent param yields `opts.default`. Anything else must be a plain run of
 * digits within `[min, max]` — non-digit characters (including `-`, `.`, `e` and
 * an empty `?limit=`) and out-of-range values all throw rather than being coerced
 * or clamped. Strict on purpose: silently serving a different page size than the
 * one asked for hides the cap from callers, who then can't tell a clamped page
 * from a short final page.
 */
export function intParam(
  params: URLSearchParams,
  name: string,
  opts: { default: number; min: number; max: number },
): number {
  const raw = params.get(name);
  if (raw === null) return opts.default;

  if (!/^\d+$/.test(raw)) {
    throw error(400, `Invalid "${name}" parameter: expected a whole number, got "${echo(raw)}".`);
  }

  const n = Number(raw);
  if (n < opts.min) throw error(400, `Invalid "${name}" parameter: must be at least ${opts.min}.`);
  if (n > opts.max) throw error(400, `Invalid "${name}" parameter: must be at most ${opts.max}.`);

  return n;
}

/**
 * Read a comma-separated list of field names, rejecting anything unrecognised with a 400.
 *
 * Same reject-don't-coerce policy as `intParam`: an absent param yields `opts.default`,
 * but a name that isn't in `opts.allowed` throws rather than being dropped, so a typo
 * surfaces as an error instead of a silently wrong-shaped response. `opts.all` names a
 * reserved keyword meaning "everything"; it can't be mixed with explicit names, since
 * that combination has no meaning beyond the keyword alone.
 *
 * The result is ordered by `opts.allowed`, not by the caller's list, and deduplicated —
 * so response key order is stable and independent of the request.
 */
export function fieldsParam<T extends string>(
  params: URLSearchParams,
  name: string,
  opts: { allowed: readonly T[]; default: readonly T[]; all?: string },
): T[] {
  const raw = params.get(name);
  if (raw === null) return [...opts.default];

  const requested = raw.split(',').map((s) => s.trim());

  if (opts.all !== undefined && requested.includes(opts.all)) {
    if (requested.length > 1) {
      throw error(400, `Invalid "${name}" parameter: "${opts.all}" cannot be combined with other field names.`);
    }
    return [...opts.allowed];
  }

  const wanted = new Set<string>();
  for (const field of requested) {
    if (field === '') {
      throw error(400, `Invalid "${name}" parameter: empty field name in "${echo(raw)}".`);
    }
    if (!(opts.allowed as readonly string[]).includes(field)) {
      const known = [...opts.allowed, ...(opts.all === undefined ? [] : [opts.all])].join(', ');
      throw error(400, `Invalid "${name}" parameter: unknown field "${echo(field)}". Available: ${known}.`);
    }
    wanted.add(field);
  }

  return opts.allowed.filter((f) => wanted.has(f));
}
