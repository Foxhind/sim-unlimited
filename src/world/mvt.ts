/**
 * A minimal Mapbox Vector Tile (MVT 2.1) reader: layers, features, their properties and geometry
 * as rings / lines in tile units (0..extent, y down). Enough for the far OSM ring (OpenFreeMap).
 */

export type MvtValue = string | number | boolean;

export interface MvtFeature {
  /** 1 point, 2 line, 3 polygon */
  type: number;
  props: Record<string, MvtValue>;
  /** points: one part per point; lines: one part per line; polygons: one part per ring (exteriors clockwise in tile units, area > 0) */
  parts: Array<Array<[number, number]>>;
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

class Reader {
  p = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  varint(): number {
    let r = 0, s = 0, b: number;
    do {
      b = this.buf[this.p++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  }
  sub(): Reader {
    const n = this.varint();
    const r = new Reader(this.buf.subarray(this.p, this.p + n));
    this.p += n;
    return r;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) { const n = this.varint(); this.p += n; }
    else if (wire === 5) this.p += 4;
    else throw new Error(`mvt: wire type ${wire}`);
  }
  get done(): boolean {
    return this.p >= this.end;
  }
}

const zigzag = (v: number) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2);
const utf8 = new TextDecoder();

function readValue(r: Reader): MvtValue {
  let v: MvtValue = '';
  while (!r.done) {
    const tag = r.varint();
    const f = tag >> 3, w = tag & 7;
    if (f === 1) { const n = r.varint(); v = utf8.decode(r.buf.subarray(r.p, r.p + n)); r.p += n; }
    else if (f === 2) { v = new DataView(r.buf.buffer, r.buf.byteOffset + r.p, 4).getFloat32(0, true); r.p += 4; }
    else if (f === 3) { v = new DataView(r.buf.buffer, r.buf.byteOffset + r.p, 8).getFloat64(0, true); r.p += 8; }
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = zigzag(r.varint());
    else if (f === 7) v = r.varint() !== 0;
    else r.skip(w);
  }
  return v;
}

function readGeometry(r: Reader): Array<Array<[number, number]>> {
  const parts: Array<Array<[number, number]>> = [];
  let x = 0, y = 0;
  let part: Array<[number, number]> | undefined;
  while (!r.done) {
    const cmd = r.varint();
    const id = cmd & 7, count = cmd >> 3;
    if (id === 1 || id === 2) {
      for (let i = 0; i < count; i++) {
        x += zigzag(r.varint());
        y += zigzag(r.varint());
        if (id === 1) { part = [[x, y]]; parts.push(part); }
        else part?.push([x, y]);
      }
    } else if (id === 7) {
      if (part && part.length) part.push([part[0][0], part[0][1]]);
    } else {
      throw new Error(`mvt: command ${id}`);
    }
  }
  return parts;
}

/** `wanted`: decode only these layers (the rest are skipped unread) */
export function decodeMvt(data: Uint8Array, wanted?: ReadonlySet<string>): MvtLayer[] {
  const tile = new Reader(data);
  const out: MvtLayer[] = [];
  while (!tile.done) {
    const tag = tile.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { tile.skip(tag & 7); continue; }
    const l = tile.sub();
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: MvtValue[] = [];
    const raw: Reader[] = [];
    while (!l.done) {
      const t = l.varint();
      const f = t >> 3;
      if (f === 1) { const n = l.varint(); name = utf8.decode(l.buf.subarray(l.p, l.p + n)); l.p += n; }
      else if (f === 2) raw.push(l.sub());
      else if (f === 3) { const n = l.varint(); keys.push(utf8.decode(l.buf.subarray(l.p, l.p + n))); l.p += n; }
      else if (f === 4) values.push(readValue(l.sub()));
      else if (f === 5) extent = l.varint();
      else l.skip(t & 7);
    }
    if (wanted && !wanted.has(name)) continue;
    const features: MvtFeature[] = [];
    for (const fr of raw) {
      let type = 0;
      const props: Record<string, MvtValue> = {};
      let parts: Array<Array<[number, number]>> = [];
      while (!fr.done) {
        const t = fr.varint();
        const f = t >> 3;
        if (f === 3) type = fr.varint();
        else if (f === 2) {
          const tr = fr.sub();
          while (!tr.done) {
            const k = tr.varint(), v = tr.varint();
            if (keys[k] !== undefined && values[v] !== undefined) props[keys[k]] = values[v];
          }
        } else if (f === 4) parts = readGeometry(fr.sub());
        else fr.skip(t & 7);
      }
      features.push({ type, props, parts });
    }
    out.push({ name, extent, features });
  }
  return out;
}

/** signed area of a ring in tile units: > 0 for exterior rings (clockwise with y down) */
export function ringArea(ring: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}
