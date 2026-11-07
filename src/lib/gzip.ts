/**
 * Gzip helpers on the native Compression Streams API, shared by the Worker (`workerd`),
 * Node scripts and the browser upload page. No dependency, same bias as `zip.ts`.
 */

export async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Gzip magic bytes. An IGC file is ASCII text and can never start with 0x1f. */
export function isGzip(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b.length === 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * Inflate `buf`, giving up as soon as the output passes `maxBytes`: the input is
 * untrusted, and a few KB of gzip can expand to gigabytes. Returns null when over the
 * cap; throws when `buf` is not valid gzip.
 */
export async function gunzipCapped(buf: ArrayBuffer, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
