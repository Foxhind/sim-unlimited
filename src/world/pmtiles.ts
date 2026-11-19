/**
 * A minimal PMTiles v3 reader over HTTP Range requests: header, root and leaf directories (cached),
 * tiles by z/x/y. Enough for the sim's own OSM tiles (M6, tiles/SimProfile.java).
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

const HEADER_BYTES = 127;
/** the spec keeps the header and root directory within the first 16 KiB */
const FIRST_FETCH = 16384;

enum Compression { Unknown = 0, None = 1, Gzip = 2, Brotli = 3, Zstd = 4 }

export interface PmtilesHeader {
  rootOffset: number;
  rootLength: number;
  leafOffset: number;
  tileDataOffset: number;
  internalCompression: Compression;
  tileCompression: Compression;
  minZoom: number;
  maxZoom: number;
  /** degrees */
  bounds: { west: number; south: number; east: number; north: number };
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function u64(v: DataView, at: number): number {
  return v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;
}

export function parseHeader(buf: Uint8Array): PmtilesHeader {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder().decode(buf.subarray(0, 7));
  if (magic !== 'PMTiles' || buf[7] !== 3) throw new Error(`pmtiles: not a v3 archive (${magic} v${buf[7]})`);
  return {
    rootOffset: u64(v, 8),
    rootLength: u64(v, 16),
    leafOffset: u64(v, 40),
    tileDataOffset: u64(v, 56),
    internalCompression: buf[97],
    tileCompression: buf[98],
    minZoom: buf[100],
    maxZoom: buf[101],
    bounds: {
      west: v.getInt32(102, true) / 1e7,
      south: v.getInt32(106, true) / 1e7,
      east: v.getInt32(110, true) / 1e7,
      north: v.getInt32(114, true) / 1e7,
    },
  };
}

/** Hilbert tile id: every tile of the zooms below, then the tile's index on the z Hilbert curve */
export function zxyToTileId(z: number, x: number, y: number): number {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  let d = 0;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return acc + d;
}

function varint(buf: Uint8Array, pos: { p: number }): number {
  let r = 0, s = 0, b: number;
  do {
    b = buf[pos.p++];
    r += (b & 0x7f) * 2 ** s;
    s += 7;
  } while (b & 0x80);
  return r;
}

export function parseDirectory(buf: Uint8Array): Entry[] {
  const pos = { p: 0 };
  const n = varint(buf, pos);
  const entries: Entry[] = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    id += varint(buf, pos);
    entries.push({ tileId: id, offset: 0, length: 0, runLength: 0 });
  }
  for (const e of entries) e.runLength = varint(buf, pos);
  for (const e of entries) e.length = varint(buf, pos);
  for (let i = 0; i < n; i++) {
    const v = varint(buf, pos);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

/** the entry holding `tileId`: the last with tileId ≤ it (a leaf pointer, or a run that covers it) */
function findEntry(entries: Entry[], tileId: number): Entry | undefined {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId <= tileId) lo = mid + 1;
    else hi = mid - 1;
  }
  const e = entries[hi];
  if (!e) return undefined;
  if (e.runLength === 0) return e;
  return tileId < e.tileId + e.runLength ? e : undefined;
}

export async function decompress(buf: Uint8Array, c: Compression): Promise<Uint8Array> {
  if (c === Compression.None || c === Compression.Unknown) return buf;
  if (c !== Compression.Gzip) throw new Error(`pmtiles: compression ${c} is not supported`);
  const stream = new Blob([buf as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type RangeFetch = (offset: number, length: number) => Promise<Uint8Array>;

export function httpRange(url: string, fetchImpl: typeof fetch = fetch): RangeFetch {
  return async (offset, length) => {
    const res = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new Error(`pmtiles ${url}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // a server that ignores Range answers 200 with the whole file
    return res.status === 200 && buf.length > length ? buf.subarray(offset, offset + length) : buf;
  };
}

const LEAF_CACHE_MAX = 64;

export class Pmtiles {
  private head?: Promise<{ header: PmtilesHeader; root: Entry[] }>;
  private leaves = new Map<number, Promise<Entry[]>>();

  constructor(private readonly range: RangeFetch) {}

  header(): Promise<PmtilesHeader> {
    return this.init().then((h) => h.header);
  }

  private init() {
    this.head ??= (async () => {
      const first = await this.range(0, FIRST_FETCH);
      const header = parseHeader(first.subarray(0, HEADER_BYTES));
      const rootBytes = header.rootOffset + header.rootLength <= first.length
        ? first.subarray(header.rootOffset, header.rootOffset + header.rootLength)
        : await this.range(header.rootOffset, header.rootLength);
      const root = parseDirectory(await decompress(rootBytes, header.internalCompression));
      return { header, root };
    })().catch((err) => {
      this.head = undefined;
      throw err;
    });
    return this.head;
  }

  private leaf(header: PmtilesHeader, e: Entry): Promise<Entry[]> {
    const at = header.leafOffset + e.offset;
    let hit = this.leaves.get(at);
    if (hit) this.leaves.delete(at);
    else {
      hit = this.range(at, e.length).then((b) => decompress(b, header.internalCompression)).then(parseDirectory);
      hit.catch(() => this.leaves.delete(at));
    }
    this.leaves.set(at, hit);
    if (this.leaves.size > LEAF_CACHE_MAX) this.leaves.delete(this.leaves.keys().next().value!);
    return hit;
  }

  /** the tile's decompressed bytes, or undefined when the archive has no such tile */
  async tile(z: number, x: number, y: number): Promise<Uint8Array | undefined> {
    const { header, root } = await this.init();
    if (z < header.minZoom || z > header.maxZoom) return undefined;
    const id = zxyToTileId(z, x, y);
    let entries = root;
    for (let depth = 0; depth < 4; depth++) {
      const e = findEntry(entries, id);
      if (!e) return undefined;
      if (e.runLength > 0) {
        const data = await this.range(header.tileDataOffset + e.offset, e.length);
        return decompress(data, header.tileCompression);
      }
      entries = await this.leaf(header, e);
    }
    throw new Error('pmtiles: directories nested too deep');
  }
}
