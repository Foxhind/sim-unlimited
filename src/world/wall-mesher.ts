import { colourOf, pointValue, snowy, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmLine } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Walls (barrier=wall | retaining_wall | city_wall): a garden's or a field's wall following the
 * ground; a retaining wall from the lower ground (on the right of the line, as OSM maps it) up to
 * the higher; a town's wall high and thick, crenellated (Gemiler island's Byzantine one). Fences
 * (barrier=fence): a thin panel on the ground, coloured by its fence_type or material, its height
 * within FENCE_MAX_M (a stone one is a dry-stone wall). Each a solid band along the line, its
 * joints mitred; a piece drawn by the tile holding its middle. Along the top of every one a 1 px
 * GL line too (drawn with the power lines' conductors): a fence a few centimetres thick, a garden
 * wall of 30, are under a pixel from above, and the line keeps them in sight at any scale.
 * Hedges are left out.
 */
export const WALL = {
  /** height, thickness by kind (`height` and `width` tags over them) */
  HEIGHT_M: { wall: 1.8, retaining_wall: 1.5, city_wall: 6, fence: 1.5 } as Record<WallKind, number>,
  THICK_M: { wall: 0.3, retaining_wall: 0.5, city_wall: 2.5, fence: 0.06 } as Record<WallKind, number>,
  /** a fence's tagged height kept within this (9.9 m on a Fethiye fence is a slip) */
  FENCE_MAX_M: 4,
  /** a dry-stone wall: lower and thicker */
  DRY: { HEIGHT_M: 1.2, THICK_M: 0.6 },
  /** into the ground under it */
  SINK_M: 0.3,
  /** a retaining wall's top over the higher ground, and where it reads that ground (either side) */
  RETAIN_OVER_M: 0.3,
  RETAIN_PROBE_M: 3,
  /** a city wall's merlons: every, long, high, as a share of its thickness (to the outer face) */
  MERLON: { EVERY_M: 2.6, LONG_M: 1.3, HIGH_M: 0.9, SHARE: 0.45 },
  MITER_LIMIT: 2,
  COLOURS: {
    concrete: [180, 178, 172], stone: [188, 178, 156], dry_stone: [176, 164, 140], brick: [164, 92, 72], wood: [140, 108, 80],
    metal: [122, 126, 130], steel: [122, 126, 130], chain_link: [138, 142, 144], bars: [96, 98, 102], railing: [96, 98, 102],
    wire: [138, 142, 144], mesh: [138, 142, 144], split_rail: [146, 112, 82], pole: [146, 112, 82], picket: [168, 136, 100],
  } as Record<string, RGB>,
  /** the line along a wall's top: its colour × this */
  LINE_SHADE: 0.45,
  /** a fence without a known fence_type or material: painted metal */
  FENCE: [118, 122, 126] as RGB,
  STONE: [184, 174, 152] as RGB,
} as const;

export type WallKind = 'wall' | 'retaining_wall' | 'city_wall' | 'fence';

export function wallKind(tags: Record<string, string>): WallKind | undefined {
  const b = tags.barrier;
  return b === 'wall' || b === 'retaining_wall' || b === 'city_wall' || b === 'fence' ? b : undefined;
}

/** a fence of stone (fence_type=stone, material=stone) stands as a dry-stone wall */
const stoneFence = (tags: Record<string, string>): boolean => tags.barrier === 'fence' && (tags.fence_type === 'stone' || tags.material === 'stone');

function wallColour(tags: Record<string, string>, kind: WallKind): RGB {
  const m = (kind === 'fence' ? tags.fence_type ?? tags.material ?? '' : tags.material ?? tags.wall ?? '').toLowerCase();
  return WALL.COLOURS[m] ?? WALL.COLOURS[(tags.material ?? '').toLowerCase()] ?? (kind === 'fence' ? WALL.FENCE : kind === 'wall' ? WALL.COLOURS.concrete : WALL.STONE);
}

export interface WallData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** along the top of each: GL line vertex pairs of x, y, z, colour value (palette pointValue) */
  lines: Float32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

/** the walls among `lines` (the whole lines, not clipped), the pieces whose middle `tile` holds */
export function buildWalls(tile: Tile, lines: ReadonlyArray<OsmLine>, sampleHeight: HeightSampler): WallData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const verts: number[] = [];
  const tops: number[] = [];
  const ramps: number[] = [];
  const toXZ = ([lon, lat]: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  /** a flat face of its own plane's normal, turned to the side of `hint` */
  const face = (p: V3[], hint: V3, ramp: number) => {
    const [a, bb, c] = p;
    let nx = (bb[1] - a[1]) * (c[2] - a[2]) - (bb[2] - a[2]) * (c[1] - a[1]);
    let ny = (bb[2] - a[2]) * (c[0] - a[0]) - (bb[0] - a[0]) * (c[2] - a[2]);
    let nz = (bb[0] - a[0]) * (c[1] - a[1]) - (bb[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    const s = (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? -1 : 1) / l;
    nx *= s; ny *= s; nz *= s;
    for (const [i, j, k] of p.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]]) {
      const q = [p[i], p[j], p[k]];
      const cx = (q[1][1] - q[0][1]) * (q[2][2] - q[0][2]) - (q[1][2] - q[0][2]) * (q[2][1] - q[0][1]);
      const cy = (q[1][2] - q[0][2]) * (q[2][0] - q[0][0]) - (q[1][0] - q[0][0]) * (q[2][2] - q[0][2]);
      const cz = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
      for (const v of cx * nx + cy * ny + cz * nz < 0 ? [q[0], q[2], q[1]] : q) verts.push(v[0], v[1], v[2], nx, ny, nz);
      ramps.push(ramp, ramp, ramp);
    }
  };
  /** a closed box from its eight corners: bottom then top, each counter-clockwise from above */
  const block = (c: V3[], ramp: number, top = ramp) => {
    const [b0, b1, b2, b3, t0, t1, t2, t3] = c;
    const mid: V3 = [c.reduce((s, p) => s + p[0], 0) / 8, c.reduce((s, p) => s + p[1], 0) / 8, c.reduce((s, p) => s + p[2], 0) / 8];
    const out = (p: V3[]): V3 => {
      const m = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length, p.reduce((s, q) => s + q[2], 0) / p.length];
      return [m[0] - mid[0], m[1] - mid[1], m[2] - mid[2]];
    };
    for (const f of [[t0, t1, t2, t3], [b0, b1, b2, b3], [b0, b1, t1, t0], [b1, b2, t2, t1], [b2, b3, t3, t2], [b3, b0, t0, t3]]) {
      face(f, out(f), f[0] === t0 && f[1] === t1 && f[2] === t2 ? top : ramp);
    }
  };

  for (const l of lines) {
    const kind = wallKind(l.tags);
    if (!kind || l.points.length < 2) continue;
    const dry = (l.tags.wall ?? l.tags.material) === 'dry_stone' || stoneFence(l.tags);
    const tagged = parseLength(l.tags.height);
    const H = (kind === 'fence' && tagged !== undefined ? Math.min(WALL.FENCE_MAX_M, tagged) : tagged) ?? (dry ? WALL.DRY.HEIGHT_M : WALL.HEIGHT_M[kind]);
    const T = parseLength(l.tags.width) ?? (dry ? WALL.DRY.THICK_M : WALL.THICK_M[kind]);
    const rgb = stoneFence(l.tags) ? WALL.COLOURS.dry_stone : wallColour(l.tags, kind);
    const ramp = snowy(colourOf(rgb));
    // the line darker than the wall: from above a fence reads as the dark stroke of its shadow
    const shade = (v: number) => Math.round(v * WALL.LINE_SHADE);
    const lineValue = pointValue(colourOf([shade(rgb[0]), shade(rgb[1]), shade(rgb[2])]));
    const pts = l.points.map(toXZ);
    const n = pts.length;
    const closed = n > 3 && pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1];
    // per vertex: the unit left of the line (x east, z south: the left of (dx, dz) is (dz, −dx)) mitred at a joint
    const dir = (i: number): XZ => {
      const a = pts[i], c = pts[i + 1], len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      return [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
    };
    const left = pts.map((_, i): XZ => {
      const before = i > 0 ? dir(i - 1) : closed ? dir(n - 2) : undefined;
      const after = i < n - 1 ? dir(i) : closed ? dir(0) : undefined;
      const d0 = before ?? after!, d1 = after ?? before!;
      const l0: XZ = [d0[1], -d0[0]], l1: XZ = [d1[1], -d1[0]];
      let mx = l0[0] + l1[0], mz = l0[1] + l1[1];
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) return l1;
      mx /= ml; mz /= ml;
      const k = Math.min(WALL.MITER_LIMIT, 1 / Math.max(1e-3, mx * l1[0] + mz * l1[1]));
      return [mx * k, mz * k];
    });
    const ground = l.points.map(([lon, lat]) => Math.max(0, sampleHeight(lon, lat)));
    /** a retaining wall: its bottom on the lower side's ground, its top over the higher side's */
    const span = l.points.map(([lon, lat], i): [number, number] => {
      if (kind !== 'retaining_wall') return [ground[i] - WALL.SINK_M, ground[i] + H];
      const P = WALL.RETAIN_PROBE_M, kx = 1 / (111320 * Math.cos((lat * Math.PI) / 180)), ky = 1 / 111320;
      // world (x east, z south) to lon/lat offsets: z south is −lat
      const side = (s: number) => Math.max(0, sampleHeight(lon + left[i][0] * P * s * kx, lat - left[i][1] * P * s * ky));
      const high = side(1), low = side(-1);
      return [Math.min(low, ground[i]) - WALL.SINK_M, Math.max(high + WALL.RETAIN_OVER_M, low + H)];
    });
    const corner = (i: number, s: number, y: number): V3 => [pts[i][0] + left[i][0] * s * T / 2, y, pts[i][1] + left[i][1] * s * T / 2];
    for (let i = 0; i + 1 < n; i++) {
      const [alon, alat] = l.points[i], [blon, blat] = l.points[i + 1];
      if (!owns([(alon + blon) / 2, (alat + blat) / 2])) continue;
      if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) < 0.05) continue;
      const [ya0, ya1] = span[i], [yb0, yb1] = span[i + 1];
      block([corner(i, 1, ya0), corner(i + 1, 1, yb0), corner(i + 1, -1, yb0), corner(i, -1, ya0),
        corner(i, 1, ya1), corner(i + 1, 1, yb1), corner(i + 1, -1, yb1), corner(i, -1, ya1)], ramp);
      // its top's centre line: in sight from above whatever its thickness
      tops.push(pts[i][0], ya1, pts[i][1], lineValue, pts[i + 1][0], yb1, pts[i + 1][1], lineValue);
      if (kind !== 'city_wall') continue;
      // merlons on its left half, every EVERY_M from the way's own start along this piece
      const M = WALL.MERLON, len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      const [dx, dz] = dir(i), lx = dz, lz = -dx;
      for (let d = M.EVERY_M / 2; d + M.LONG_M / 2 < len; d += M.EVERY_M) {
        const t0 = (d - M.LONG_M / 2) / len, t1 = (d + M.LONG_M / 2) / len;
        const at = (t: number, s: number, up: number): V3 => {
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          const y = ya1 + (yb1 - ya1) * t;
          return [x + lx * s, y + up, z + lz * s];
        };
        const o = T / 2, inner = T / 2 - T * M.SHARE;
        block([at(t0, o, -0.05), at(t1, o, -0.05), at(t1, inner, -0.05), at(t0, inner, -0.05),
          at(t0, o, M.HIGH_M), at(t1, o, M.HIGH_M), at(t1, inner, M.HIGH_M), at(t0, inner, M.HIGH_M)], ramp);
      }
    }
    // the ends of an open wall are its blocks' end faces already
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps), lines: new Float32Array(tops) };
}
