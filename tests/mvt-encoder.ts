// A tiny MVT encoder for the tests (the same as in far-osm.test.ts).
import type { MvtValue } from '../src/world/mvt';

export const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
};
export const field = (f: number, wire: number) => varint((f << 3) | wire);
export const bytes = (f: number, b: number[]) => [...field(f, 2), ...varint(b.length), ...b];
export const str = (f: number, s: string) => bytes(f, [...new TextEncoder().encode(s)]);
export const zz = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);

export interface F { type: 1 | 2 | 3; props: Record<string, MvtValue>; parts: Array<Array<[number, number]>> }

export function geometry(type: number, parts: Array<Array<[number, number]>>): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  for (const part of parts) {
    const pts = type === 3 ? part.slice(0, -1) : part; // polygons: ClosePath instead of the repeated first point
    out.push((1 << 3) | 1, zz(pts[0][0] - x), zz(pts[0][1] - y));
    [x, y] = pts[0];
    out.push(((pts.length - 1) << 3) | 2);
    for (const [px, py] of pts.slice(1)) { out.push(zz(px - x), zz(py - y)); x = px; y = py; }
    if (type === 3) out.push((1 << 3) | 7);
  }
  return out.flatMap((v) => varint(v));
}

export function layer(name: string, features: F[], extent = 4096): number[] {
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const idx = <T>(list: T[], v: T) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
  const feats = features.map((f) => {
    const tags = Object.entries(f.props).flatMap(([k, v]) => [idx(keys, k), idx(values, v)]);
    return bytes(2, [...bytes(2, tags.flatMap((t) => varint(t))), ...field(3, 0), ...varint(f.type), ...bytes(4, geometry(f.type, f.parts))]);
  });
  const vals = values.map((v) => bytes(4, typeof v === 'string' ? str(1, v) : typeof v === 'boolean' ? [...field(7, 0), v ? 1 : 0] : [...field(5, 0), ...varint(v)]));
  return bytes(3, [...field(15, 0), 2, ...str(1, name), ...feats.flat(), ...keys.flatMap((k) => str(3, k)), ...vals.flat(), ...field(5, 0), ...varint(extent)]);
}


export const mvt = (...layers: number[][]) => new Uint8Array(layers.flat());
export const square = (x: number, y: number, s: number): Array<[number, number]> => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
