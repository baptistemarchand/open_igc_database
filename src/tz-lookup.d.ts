/**
 * `tz-lookup` ships no types. It's a single self-contained CJS file ending in
 * `typeof module !== "undefined" && (module.exports = tzlookup)`, i.e. the export *is*
 * the function — so a default import is the right shape under both Vite's CJS interop
 * (the worker build) and Node's (the `tsx` import script).
 */
declare module 'tz-lookup' {
  /**
   * Look up the IANA time-zone id for a coordinate, e.g. 'Europe/Paris'.
   * Throws `RangeError('invalid coordinates')` on NaN or out-of-range input, and
   * returns an 'Etc/GMT±n' zone over open water. Never returns null.
   */
  export default function tzlookup(lat: number, lon: number): string;
}
