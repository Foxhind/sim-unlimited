import { colourOf, snowy, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Tombs (tomb=*, on historic=tomb or archaeological_site=tomb), as Lycia left them round Fethiye:
 * - rock-cut: a temple's front carved in a cliff (the tomb of Amyntas over the town): steps, a
 *   pilaster at each side, two columns, the dark doorway, an architrave and a pediment, in front of
 *   a wedge of the rock it is cut in, its face as high as the front and its top running back down
 *   into the slope (the relief's 30 m cells smooth the cliff away);
 * - sarcophagus: a Lycian sarcophagus, a stone chest on a tall base under a pointed, ogival lid;
 * - pillar_tomb: a stone pillar with the burial chamber on its top (the Harpy tomb of Xanthos).
 * A tomb is mapped as a point or an outline (its middle): no tag says where a carved front faces, so
 * it faces down the slope there (outwards, as a cliff tomb does), on flat ground as its hash turns it.
 */
export const TOMB = {
  ROCK: { W: 7, H: 8, STEP_M: 0.6, BLOCK_BACK_M: 12, BLOCK_SIDE_M: 3, BLOCK_UP_M: 2.5, RELIEF_M: 0.5, BROW: 4, BROW_DROP_M: 1.6 },
  SARCOPHAGUS: { L: 3, W: 1.9, BASE_M: 2.2, CHEST_M: 1.5, LID_M: 1.7 },
  PILLAR: { W: 2, H: 6, CHAMBER_M: 1.6 },
  /** the slope is read this far either side of the tomb */
  SLOPE_PROBE_M: 8,
  /** flatter than this (m per m), the slope says nothing of the facing */
  FLAT: 0.05,
  LIMESTONE: [204, 194, 172] as RGB,
  /** the cliff bands' bare rock (area-styles cliff) */
  ROCK_RGB: [176, 170, 158] as RGB,
  DARK: [44, 40, 38] as RGB,
} as const;

export type TombKind = 'rock-cut' | 'sarcophagus' | 'pillar';

export function tombKind(tags: Record<string, string>): TombKind | undefined {
  const t = (tags.tomb ?? '').toLowerCase();
  if (t === 'rock-cut' || t === 'rock_cut') return 'rock-cut';
  if (t === 'sarcophagus' || t === 'lycian_sarcophagus') return 'sarcophagus';
  if (t === 'pillar_tomb' || t === 'pillar') return 'pillar';
  return undefined;
}

export interface TombData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

function hash(lon: number, lat: number): number {
  let h = Math.imul(Math.round(lon * 1e7), 0x9e3779b1) ^ Math.imul(Math.round(lat * 1e7), 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** the unit x, z direction a tomb at (lon, lat) faces: down the slope, else by its hash */
export function tombFacing(at: LonLat, sampleHeight: HeightSampler): XZ {
  const [lon, lat] = at, P = TOMB.SLOPE_PROBE_M;
  const dLon = P / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = P / 111320;
  const gx = (sampleHeight(lon + dLon, lat) - sampleHeight(lon - dLon, lat)) / (2 * P);
  const gn = (sampleHeight(lon, lat + dLat) - sampleHeight(lon, lat - dLat)) / (2 * P);
  // x east, z south: the uphill gradient is (gx, −gn); down the slope its opposite
  const l = Math.hypot(gx, gn);
  if (l > TOMB.FLAT) return [-gx / l, gn / l];
  const a = hash(lon, lat) * 2 * Math.PI;
  return [Math.cos(a), Math.sin(a)];
}

/** the tombs among `points` (an outline's at its middle: overpass.ts) standing in `tile` */
export function buildTombs(tile: Tile, points: ReadonlyArray<OsmPoint>, sampleHeight: HeightSampler): TombData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const verts: number[] = [];
  const ramps: number[] = [];
  const toXZ = ([lon, lat]: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  /** a flat face of its own normal (its plane's), turned to the side of `hint` */
  const flat = (p: V3[], hint: V3, ramp: number) => {
    const [a, b, c] = p;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? -1 : 1) * (Math.hypot(nx, ny, nz) || 1);
    nx /= l; ny /= l; nz /= l;
    face(p, [nx, ny, nz], ramp);
  };
  /** a flat face, its triangles wound counter-clockwise seen from the side `n` points to */
  const face = (p: V3[], n: V3, ramp: number) => {
    for (const [i, j, k] of p.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]]) {
      const a = p[i], b = p[j], c = p[k];
      const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      for (const q of cx * n[0] + cy * n[1] + cz * n[2] < 0 ? [a, c, b] : [a, b, c]) verts.push(q[0], q[1], q[2], n[0], n[1], n[2]);
      ramps.push(ramp, ramp, ramp);
    }
  };

  for (const pt of points) {
    const kind = tombKind(pt.tags);
    if (!kind || !owns(pt.at)) continue;
    const [x0, z0] = toXZ(pt.at);
    const g = Math.max(0, sampleHeight(pt.at[0], pt.at[1]));
    // its frame: f out of its front, s across it (u), y up
    const [fx, fz] = tombFacing(pt.at, sampleHeight);
    const sx = -fz, sz = fx;
    const P = (u: number, v: number, y: number): V3 => [x0 + sx * u + fx * v, y, z0 + sz * u + fz * v];
    /** a closed box in the frame: across u0..u1, out v0..v1, up y0..y1 */
    const box = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, ramp: number, top = ramp) => {
      face([P(u0, v0, y1), P(u0, v1, y1), P(u1, v1, y1), P(u1, v0, y1)], [0, 1, 0], top);
      face([P(u0, v0, y0), P(u1, v0, y0), P(u1, v1, y0), P(u0, v1, y0)], [0, -1, 0], ramp);
      face([P(u0, v1, y0), P(u1, v1, y0), P(u1, v1, y1), P(u0, v1, y1)], [fx, 0, fz], ramp);
      face([P(u1, v0, y0), P(u0, v0, y0), P(u0, v0, y1), P(u1, v0, y1)], [-fx, 0, -fz], ramp);
      face([P(u1, v1, y0), P(u1, v0, y0), P(u1, v0, y1), P(u1, v1, y1)], [sx, 0, sz], ramp);
      face([P(u0, v0, y0), P(u0, v1, y0), P(u0, v1, y1), P(u0, v0, y1)], [-sx, 0, -sz], ramp);
    };
    const stone = snowy(colourOf(TOMB.LIMESTONE)), dark = colourOf(TOMB.DARK);

    if (kind === 'rock-cut') {
      const R = TOMB.ROCK, W = parseLength(pt.tags.width) ?? R.W, H = parseLength(pt.tags.height) ?? R.H;
      const half = W / 2, d = R.RELIEF_M;
      // the rock it is cut in: an outcrop round the front, its brow broken (lower to its ends, by the
      // tomb's hash), its top in facets back down into the slope
      const rock = snowy(colourOf(TOMB.ROCK_RGB)), ru = half + R.BLOCK_SIDE_M, rb = -R.BLOCK_BACK_M, top = g + H + R.BLOCK_UP_M;
      const brow = Array.from({ length: R.BROW + 1 }, (_, k): [number, number] => {
        const u = -ru + (2 * ru * k) / R.BROW, end = k === 0 || k === R.BROW;
        return [u, end ? top - R.BROW_DROP_M * 1.5 : top - R.BROW_DROP_M * hash(pt.at[0] + k, pt.at[1])];
      });
      for (let k = 0; k < R.BROW; k++) {
        const [u0, y0] = brow[k], [u1, y1] = brow[k + 1];
        face([P(u0, 0, g - 1), P(u1, 0, g - 1), P(u1, 0, y1), P(u0, 0, y0)], [fx, 0, fz], rock);
        flat([P(u0, 0, y0), P(u1, 0, y1), P(u1, rb, g - 1), P(u0, rb, g - 1)], [fx, 1, fz], rock);
      }
      flat([P(ru, 0, g - 1), P(ru, rb, g - 1), P(ru, 0, brow[R.BROW][1])], [sx, 0, sz], rock);
      flat([P(-ru, 0, g - 1), P(-ru, 0, brow[0][1]), P(-ru, rb, g - 1)], [-sx, 0, -sz], rock);
      // the steps, the pilasters, the columns, the doorway between them
      box(-half, half, 0, d * 1.6, g - 1, g + R.STEP_M, stone);
      const colTop = g + R.STEP_M + H * 0.55;
      for (const side of [-1, 1]) {
        box(side * half - (side > 0 ? 0.8 : 0), side * half + (side < 0 ? 0.8 : 0), 0, d, g + R.STEP_M, colTop, stone);
        box(side * W / 6 - 0.3, side * W / 6 + 0.3, d * 0.4, d * 1.2, g + R.STEP_M, colTop, stone);
      }
      face([P(-W / 8, 0.02, g + R.STEP_M), P(W / 8, 0.02, g + R.STEP_M), P(W / 8, 0.02, g + R.STEP_M + H * 0.4), P(-W / 8, 0.02, g + R.STEP_M + H * 0.4)], [fx, 0, fz], dark);
      // the architrave across, the pediment over it: a triangle front and back, its two sloping tops
      const arch = colTop + H * 0.1;
      box(-half - 0.2, half + 0.2, 0, d * 1.4, colTop, arch, stone);
      const apex = arch + H * 0.22, v1 = d * 1.2;
      face([P(-half - 0.2, v1, arch), P(half + 0.2, v1, arch), P(0, v1, apex)], [fx, 0, fz], stone);
      face([P(half + 0.2, 0, arch), P(-half - 0.2, 0, arch), P(0, 0, apex)], [-fx, 0, -fz], stone);
      const slope = (side: number): V3 => {
        const l = Math.hypot(apex - arch, half + 0.2);
        return [(sx * side * (apex - arch)) / l, (half + 0.2) / l, (sz * side * (apex - arch)) / l];
      };
      face([P(half + 0.2, 0, arch), P(0, 0, apex), P(0, v1, apex), P(half + 0.2, v1, arch)], slope(1), stone);
      face([P(0, 0, apex), P(-half - 0.2, 0, arch), P(-half - 0.2, v1, arch), P(0, v1, apex)], slope(-1), stone);
    } else if (kind === 'sarcophagus') {
      // its long side along the facing's square (u), as it stands by the road or the cliff
      const S = TOMB.SARCOPHAGUS, hl = S.L / 2, hw = S.W / 2;
      box(-hl - 0.2, hl + 0.2, -hw - 0.2, hw + 0.2, g - 0.6, g + S.BASE_M, stone);
      const c0 = g + S.BASE_M, c1 = c0 + S.CHEST_M;
      box(-hl, hl, -hw, hw, c0, c1, stone);
      // the ogival lid: its two curved sides in two pieces each up to the crest, the gable ends, the crest
      const lid = (t: number): [number, number] => [hw * 1.08 * (1 - t * t), c1 + S.LID_M * t];
      const steps = [0, 0.55, 1];
      for (const side of [-1, 1]) {
        for (let k = 0; k + 1 < steps.length; k++) {
          const [w0, y0] = lid(steps[k]), [w1, y1] = lid(steps[k + 1]);
          const nv = side * (y1 - y0), ny = Math.abs(w0 - w1), l = Math.hypot(nv, ny) || 1;
          const n: V3 = [(fx * nv) / l, ny / l, (fz * nv) / l];
          const a = P(-hl - 0.1, side * w0, y0), bb = P(hl + 0.1, side * w0, y0), c = P(hl + 0.1, side * w1, y1), dd = P(-hl - 0.1, side * w1, y1);
          face([a, bb, c, dd], n, stone);
        }
      }
      for (const end of [-1, 1]) {
        const u = end * (hl + 0.1), n: V3 = [sx * end, 0, sz * end];
        const ring = steps.map((t) => lid(t));
        const pts = [...ring.map(([w, y]) => P(u, -w, y)), ...ring.slice(0, -1).reverse().map(([w, y]) => P(u, w, y))];
        // a fan from the crest
        for (let i = 0; i + 1 < pts.length; i++) {
          face([P(u, 0, c1), pts[i], pts[i + 1]], n, stone);
        }
      }
      box(-hl - 0.15, hl + 0.15, -0.15, 0.15, c1 + S.LID_M - 0.05, c1 + S.LID_M + 0.3, stone);
    } else {
      const S = TOMB.PILLAR, hw = S.W / 2;
      box(-hw, hw, -hw, hw, g - 0.6, g + S.H, stone);
      box(-hw - 0.3, hw + 0.3, -hw - 0.3, hw + 0.3, g + S.H, g + S.H + S.CHAMBER_M, stone);
      box(-hw - 0.5, hw + 0.5, -hw - 0.5, hw + 0.5, g + S.H + S.CHAMBER_M, g + S.H + S.CHAMBER_M + 0.4, stone);
      face([P(-0.4, hw + 0.31, g + S.H + 0.3), P(0.4, hw + 0.31, g + S.H + 0.3), P(0.4, hw + 0.31, g + S.H + 1.2), P(-0.4, hw + 0.31, g + S.H + 1.2)], [fx, 0, fz], dark);
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
