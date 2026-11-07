/**
 * IGC H-record types that carry personally identifying info. Matched on the
 * 3-char header code at `line.slice(2, 5)` — the same slice `igc-parser` uses to
 * dispatch headers. Covers pilot-in-charge, second crew/copilot, glider
 * registration, and competition callsign. Glider *type* (GTY) is intentionally
 * left alone: it isn't personally identifying and is useful for search.
 */
const IDENTIFYING_HEADERS = new Set(['PLT', 'CM2', 'GID', 'CID']);

/**
 * Remove identifying header values from raw IGC text while keeping the file
 * structurally valid: the record key is preserved and only its value is blanked
 * (`HFPLTPILOTINCHARGE:John Doe` → `HFPLTPILOTINCHARGE:`). Line endings are
 * preserved byte-for-byte, so only the targeted lines change. Used both to build
 * the anonymized file that gets stored and to compute a name-independent id.
 */
export function stripIdentifyingHeaders(text: string): string {
  // Identifying H-records live only in the header block, which always precedes the
  // first B-record (the fixes — the bulk of the file). So split/map/join just the
  // head and copy the untouched tail as a single slice: O(header) instead of
  // O(file) allocation, which matters for multi-MB tracks on a CPU-metered worker.
  // headEnd = start of the fixes block: 0 if the file opens with a B-record, else
  // just after the newline before the first '\nB', else the whole file has no fixes.
  const headEnd = text.startsWith('B') ? 0 : text.indexOf('\nB') === -1 ? text.length : text.indexOf('\nB') + 1;
  const head = text.slice(0, headEnd);
  const tail = text.slice(headEnd);

  const strippedHead = head
    .split('\n')
    .map((line) => {
      // Preserve a trailing CR (IGC files are CRLF) so rejoining is byte-exact.
      const cr = line.endsWith('\r') ? '\r' : '';
      const body = cr ? line.slice(0, -1) : line;
      if (body[0] !== 'H' || !IDENTIFYING_HEADERS.has(body.slice(2, 5))) return line;
      const colon = body.indexOf(':');
      const stripped = colon === -1 ? body.slice(0, 5) : body.slice(0, colon + 1);
      return stripped + cr;
    })
    .join('\n');

  return strippedHead + tail;
}
