import { error } from '@sveltejs/kit';

/** Cap on how much of a bad value gets echoed back in an error message. */
const MAX_ECHO = 32;

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
    const echo = raw.length > MAX_ECHO ? `${raw.slice(0, MAX_ECHO)}…` : raw;
    throw error(400, `Invalid "${name}" parameter: expected a whole number, got "${echo}".`);
  }

  const n = Number(raw);
  if (n < opts.min) throw error(400, `Invalid "${name}" parameter: must be at least ${opts.min}.`);
  if (n > opts.max) throw error(400, `Invalid "${name}" parameter: must be at most ${opts.max}.`);

  return n;
}
