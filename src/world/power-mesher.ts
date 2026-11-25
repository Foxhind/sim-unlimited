import { colourOf, RAMP, rampIndex, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import { pushPrism } from './mast-mesher';
import type { LonLat, OsmLine } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Power lines (power=line: lattice pylons; power=minor_line: poles), from the lines alone: in OSM
 * every vertex of a power line is its tower or pole. Each support stands on the ground at its
 * vertex, its crossarm square to the line (the bisector at a bend); the conductors hang from the
 * arms' ends to the next support's with a sag (a parabola, SAG of the span at mid-span), as 1 px GL
 * lines, near and far. The supports are building-mesh solids.
 *
 * Supports so close that their crossarms would cross (a tower shared by several lines, a line's
 * last vertices mapped a few metres off another's tower) are one support: the tallest (pylons
 * before poles), standing and turned as on its own line; every line's conductors hang from it.
 */
export const POWER = {
  /** a pylon's height without `height`, by the line's voltage (V): [from voltage, height m], highest first */
  PYLON_M: [[300000, 45], [150000, 36], [60000, 28], [0, 22]] as [number, number][],
  POLE_M: 10,
  /**
   * A pylon is the common double-circuit lattice tower: three tiers of crossarms on both sides (the
   * middle one the longest), a conductor hanging from each arm's tip on an insulator string, and an
   * earth wire on the peak. Per tier: its height share and its arm's length share of the height.
   */
  TIERS: [[0.6, 0.17], [0.73, 0.21], [0.86, 0.17]] as [number, number][],
  /** an insulator string hangs this share of the height under its arm's tip */
  INSULATOR: 0.06,
  /** a pylon's foot (half the width) to its height, its waist at the lowest tier, its top at the highest */
  FOOT: 0.12,
  WAIST: 0.04,
  TOP: 0.03,
  /** panels of bracing under the waist */
  PANELS: 5,
  /** a crossarm's top chord's thickness to the height (the bottom chord 0.7 of it, an insulator 0.5) */
  CHORD: 0.03,
  /** a pole's arm, each side, metres */
  POLE_ARM_M: 0.9,
  /** a span sags this share of its length at mid-span */
  SAG: 0.025,
  /** a sagging conductor is drawn in this many straight pieces */
  PIECES: 8,
  STEEL: [146, 150, 156] as RGB,
  CONCRETE: [176, 172, 164] as RGB,
  /** glass insulator strings */
  INSULATOR_RGB: [96, 112, 104] as RGB,
  /** supports nearer than the sum of their arms' reach are merged, within this at most (m) */
  MERGE_MAX_M: 50,
} as const;

/** a conductor's colour: dark grey 1 px lines */
const WIRE_INDEX = rampIndex(RAMP.ASPHALT, 3);

export function isPowerLine(tags: Record<string, string>): boolean {
  return tags.power === 'line' || tags.power === 'minor_line';
}

/** a support's height on line `tags`: `height`, else by the highest of its voltages (a pole on a minor line) */
export function supportHeight(tags: Record<string, string>): number {
  const h = parseLength(tags.height);
  if (h !== undefined && h > 3 && h < 200) return h;
  if (tags.power === 'minor_line') return POWER.POLE_M;
  const v = Math.max(0, ...(tags.voltage ?? '').split(';').map((s) => parseFloat(s)).filter((x) => Number.isFinite(x)));
  return POWER.PYLON_M.find(([from]) => v >= from)![1];
}

export interface PowerData {
  /** the supports: pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** the conductors: GL line vertex pairs of x, y, z, palette index */
  wires: Float32Array;
}

type V3 = [number, number, number];

/** how far a support's arms reach out from its axis (m) */
export function armReach(pylon: boolean, H: number): number {
  return pylon ? Math.max(...POWER.TIERS.map(([, arm]) => arm)) * H : POWER.POLE_ARM_M;
}

/** one support: where it stands, its kind and height, its crossarm's unit direction */
interface Support {
  lon: number;
  lat: number;
  x: number;
  z: number;
  y0: number;
  H: number;
  pylon: boolean;
  arm: [number, number];
}

/**
 * The supports standing in `tile` and the spans whose middle is in it, of the whole power lines
 * among `lines` (not clipped: a span past the border is drawn by the tile holding its middle).
 */
export function buildPower(tile: Tile, lines: ReadonlyArray<OsmLine>, sampleHeight: HeightSampler): PowerData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const verts: number[] = [];
  const ramps: number[] = [];
  const wires: number[] = [];
  const toXZ = ([lon, lat]: LonLat): [number, number] => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const steel = colourOf(POWER.STEEL), concrete = colourOf(POWER.CONCRETE);

  // every vertex of every power line a support, turned square to its own line (the bisector at a bend)
  const power = lines.filter((l) => isPowerLine(l.tags) && l.points.length >= 2);
  const own: Support[][] = power.map((l) => {
    const pylon = l.tags.power === 'line';
    const H = supportHeight(l.tags);
    const pts = l.points.map(toXZ);
    const n = pts.length;
    const dir = (a: [number, number], c: [number, number]): [number, number] => {
      const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz) || 1;
      return [dx / len, dz / len];
    };
    return pts.map((p, i) => {
      const d0 = i > 0 ? dir(pts[i - 1], p) : dir(p, pts[i + 1]);
      const d1 = i < n - 1 ? dir(p, pts[i + 1]) : d0;
      let tx = d0[0] + d1[0], tz = d0[1] + d1[1];
      const tl = Math.hypot(tx, tz);
      if (tl < 1e-6) [tx, tz] = d0; else { tx /= tl; tz /= tl; }
      const [lon, lat] = l.points[i];
      return { lon, lat, x: p[0], z: p[1], y0: Math.max(0, sampleHeight(lon, lat)), H, pylon, arm: [-tz, tx] as [number, number] };
    });
  });

  // merged: the tallest first (the same order in every tile), each kept unless a kept one stands
  // within both arms' reach
  const order = own.flat().sort((p, q) => Number(q.pylon) - Number(p.pylon) || q.H - p.H || p.lon - q.lon || p.lat - q.lat);
  const CELL = POWER.MERGE_MAX_M;
  const grid = new Map<string, Support[]>();
  const keyOf = (cx: number, cz: number) => `${cx},${cz}`;
  const kept = new Map<Support, Support>();
  for (const s of order) {
    const cx = Math.floor(s.x / CELL), cz = Math.floor(s.z / CELL);
    let into: Support | undefined;
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const k of grid.get(keyOf(cx + dx, cz + dz)) ?? []) {
        const d = Math.hypot(k.x - s.x, k.z - s.z);
        if (d < Math.min(POWER.MERGE_MAX_M, armReach(k.pylon, k.H) + armReach(s.pylon, s.H)) && d < best) {
          best = d;
          into = k;
        }
      }
    }
    if (into) { kept.set(s, into); continue; }
    kept.set(s, s);
    const key = keyOf(cx, cz);
    const cell = grid.get(key);
    if (cell) cell.push(s); else grid.set(key, [s]);
  }

  /**
   * Where a line's conductors hang at support s, in the same order at every support: a pylon's six
   * (per tier, the arm's tip on each side, an insulator string under it) then its earth wire on the
   * peak; a pole's two arm ends and its top. On another line's support (merged) by that one's arm,
   * turned the line's way so its conductors do not cross, at that one's height if of its kind.
   */
  const attach = (s: Support, pylon: boolean, H: number, sign: number): V3[] => {
    const { x, z, y0 } = s;
    const ax = s.arm[0] * sign, az = s.arm[1] * sign;
    const at = (d: number, y: number): V3 => [x + ax * d, y, z + az * d];
    if (!pylon) return [at(-POWER.POLE_ARM_M, y0 + H - 0.4), at(POWER.POLE_ARM_M, y0 + H - 0.4), at(0, y0 + H + 0.4)];
    const out: V3[] = [];
    for (const [hy, arm] of POWER.TIERS) for (const side of [-1, 1]) out.push(at(side * arm * H, y0 + (hy - POWER.INSULATOR) * H));
    out.push(at(0, y0 + H));
    return out;
  };

  // the supports: each kept one once, by the tile holding its foot
  for (const s of order) {
    if (kept.get(s) !== s || !owns([s.lon, s.lat])) continue;
    const { x, z, y0, H } = s;
    const [ax, az] = s.arm;
    const hangs = attach(s, s.pylon, H, 1);
    if (s.pylon) {
      const t = Math.max(0.18, H * 0.008);
      const insulator = colourOf(POWER.INSULATOR_RGB);
      // the body's corners at a height share f: its half-width tapers from the foot to the waist
      // (the lowest tier), then less to the top tier; in the arm's frame (along the arm, along the line)
      const [waistAt] = POWER.TIERS[0], [topAt] = POWER.TIERS[POWER.TIERS.length - 1];
      const half = (f: number) => f <= waistAt
        ? H * (POWER.FOOT + ((POWER.WAIST - POWER.FOOT) * f) / waistAt)
        : H * (POWER.WAIST + ((POWER.TOP - POWER.WAIST) * Math.min(1, (f - waistAt) / (topAt - waistAt))));
      const lx = -az, lz = ax;
      const corner = (f: number, k: number): V3 => {
        const [cu, cv] = [[1, 1], [-1, 1], [-1, -1], [1, -1]][k];
        const w = half(f);
        return [x + (ax * cu + lx * cv) * w, y0 + f * H, z + (az * cu + lz * cv) * w];
      };
      // the levels of the body's frames: panels under the waist, then each tier, the top tier last
      const levels: number[] = [];
      for (let p = 0; p <= POWER.PANELS; p++) levels.push((waistAt * p) / POWER.PANELS);
      for (const [hy] of POWER.TIERS.slice(1)) levels.push(hy);
      for (let k = 0; k < 4; k++) {
        // the legs (sunk a metre on slopes), then the peak's four members up to the earth wire
        const foot = corner(0, k);
        pushPrism(verts, ramps, steel, [foot[0], y0 - 1, foot[2]], foot, t);
        for (let lv = 0; lv + 1 < levels.length; lv++) pushPrism(verts, ramps, steel, corner(levels[lv], k), corner(levels[lv + 1], k), t);
        pushPrism(verts, ramps, steel, corner(topAt, k), [x, y0 + H, z], t * 0.8);
      }
      // a frame at every level and an X on every face between levels
      for (let lv = 1; lv < levels.length; lv++) {
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          pushPrism(verts, ramps, steel, corner(levels[lv], k), corner(levels[lv], k2), t * 0.7);
          pushPrism(verts, ramps, steel, corner(levels[lv - 1], k), corner(levels[lv], k2), t * 0.5);
          pushPrism(verts, ramps, steel, corner(levels[lv - 1], k2), corner(levels[lv], k), t * 0.5);
        }
      }
      // the crossarms: per tier and side, a top and a bottom chord from the body to the tip, the
      // insulator string hanging from the tip to its conductor
      POWER.TIERS.forEach(([hy, arm], ti) => {
        for (const side of [-1, 1]) {
          const tip: V3 = [x + ax * side * arm * H, y0 + hy * H, z + az * side * arm * H];
          const w = half(hy);
          const root = (dy: number): V3 => [x + ax * side * w, y0 + hy * H + dy, z + az * side * w];
          // a crossarm is a lattice girder a metre or so deep: its chords as solid bars of that
          // weight (thin members vanish under a pixel within a few hundred metres)
          pushPrism(verts, ramps, steel, root(0), tip, H * POWER.CHORD);
          pushPrism(verts, ramps, steel, root(-H * 0.035), tip, H * POWER.CHORD * 0.7);
          pushPrism(verts, ramps, insulator, tip, hangs[ti * 2 + (side + 1) / 2], H * POWER.CHORD * 0.5);
        }
      });
    } else {
      // a pole and its arm
      pushPrism(verts, ramps, concrete, [x, y0 - 0.5, z], [x, y0 + H + 0.4, z], 0.28);
      pushPrism(verts, ramps, concrete, hangs[0], hangs[1], 0.12);
    }
  }

  // the conductors of the spans whose middle this tile holds, from support to support
  power.forEach((l, li) => {
    const sup = own[li].map((s) => kept.get(s)!);
    const hangs = own[li].map((s, i) => {
      const k = sup[i];
      const sign = s.arm[0] * k.arm[0] + s.arm[1] * k.arm[1] < 0 ? -1 : 1;
      return attach(k, s.pylon, k.pylon === s.pylon ? k.H : s.H, sign);
    });
    for (let i = 0; i + 1 < l.points.length; i++) {
      if (sup[i] === sup[i + 1]) continue;
      const [alon, alat] = l.points[i], [blon, blat] = l.points[i + 1];
      if (!owns([(alon + blon) / 2, (alat + blat) / 2])) continue;
      const span = Math.hypot(sup[i + 1].x - sup[i].x, sup[i + 1].z - sup[i].z);
      const sag = span * POWER.SAG;
      for (let k = 0; k < hangs[i].length; k++) {
        const a = hangs[i][k], c = hangs[i + 1][k];
        let prev: V3 = a;
        for (let s = 1; s <= POWER.PIECES; s++) {
          const t = s / POWER.PIECES;
          const p: V3 = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t - 4 * sag * t * (1 - t), a[2] + (c[2] - a[2]) * t];
          wires.push(prev[0], prev[1], prev[2], WIRE_INDEX, p[0], p[1], p[2], WIRE_INDEX);
          prev = p;
        }
      }
    }
  });
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps), wires: new Float32Array(wires) };
}
