/**
 * Minimal browser-side ZIP reader: lists entries from the central directory and
 * inflates them one at a time with the native `DecompressionStream('deflate-raw')`,
 * same zero-dependency bias as the gzip path in `upload.ts`.
 *
 * Supports what pilots' tools and OS "compress folder" actions produce: stored (0) and
 * deflate (8) entries, nested folders, data descriptors. Rejects ZIP64 and encrypted
 * entries rather than misreading them.
 */

export interface ZipEntry {
  /** Path inside the archive, e.g. `flights/2024/foo.igc`. */
  path: string;
  /** Inflates this entry. Each call re-reads it, so callers can keep memory to one file at a time. */
  read: () => Promise<ArrayBuffer>;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

export function listZipEntries(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('Not a valid ZIP file.');

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  // ZIP64 marks overflowing fields with all-ones; the real values live in a record we don't parse.
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== CDH_SIG) throw new Error('Corrupt ZIP directory.');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const path = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith('/')) continue;
    entries.push({
      path,
      read: async () => {
        if (flags & 1) throw new Error('Encrypted ZIP entries are not supported.');
        if (compSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 entries are not supported.');
        // Sizes come from the central directory: the local header's may be zero when a data descriptor follows.
        if (view.getUint32(localOffset, true) !== LFH_SIG) throw new Error('Corrupt ZIP entry.');
        const start =
          localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const data = new Uint8Array(buf, start, compSize);
        if (method === 0) return data.slice().buffer;
        if (method !== 8) throw new Error(`Unsupported ZIP compression method (${method}).`);
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer();
      },
    });
  }
  return entries;
}

/** The end-of-central-directory record sits in the last 22 bytes plus an optional ≤64 KB comment. */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}
