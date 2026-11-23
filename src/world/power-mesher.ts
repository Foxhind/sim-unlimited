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
 */
export const POWER = {
  /** a pylon's height without `height`, by the line's voltage (V): [from voltage, height m], highest first */
  PYLON_M: [[300000, 45], [150000, 36], [60000, 28], [0, 22]] as [number, number][],
  POLE_M: 10,
  /** a pylon's crossarm at this share of its height, each arm this share of the height long */
  ARM_AT: 0.78,
  ARM: 0.25,
  /** a pylon's foot (half the width) to its height, its waist at the crossarm */
  FOOT: 0.12,
  WAIST: 0.035,
  /** a pole's arm, each side, metres */
  POLE_ARM_M: 0.9,
  /** a span sags this share of its length at mid-span */
  SAG: 0.025,
  /** a sagging conductor is drawn in this many straight pieces */
  PIECES: 8,
  STEEL: [146, 150, 156] as RGB,
  CONCRETE: [176, 172, 164] as RGB,
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

  for (const l of lines) {
    if (!isPowerLine(l.tags) || l.points.length < 2) continue;
    const pylon = l.tags.power === 'line';
    const H = supportHeight(l.tags);
    const pts = l.points.map(toXZ);
    const n = pts.length;
    // per support: its ground, and its crossarm's unit direction (square to the line, the bisector at a bend)
    const base = l.points.map(([lon, lat]) => Math.max(0, sampleHeight(lon, lat)));
    const arms = pts.map((p, i) => {
      const dir = (a: [number, number], c: [number, number]): [number, number] => {
        const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz) || 1;
        return [dx / len, dz / len];
      };
      const d0 = i > 0 ? dir(pts[i - 1], p) : dir(p, pts[i + 1]);
      const d1 = i < n - 1 ? dir(p, pts[i + 1]) : d0;
      let tx = d0[0] + d1[0], tz = d0[1] + d1[1];
      const tl = Math.hypot(tx, tz);
      if (tl < 1e-6) [tx, tz] = d0; else { tx /= tl; tz /= tl; }
      return [-tz, tx] as [number, number];
    });
    const armLen = pylon ? H * POWER.ARM : POWER.POLE_ARM_M;
    const armY = pylon ? H * POWER.ARM_AT : H - 0.4;
    /** where conductor k (−1, 0 top, +1) of support i hangs */
    const attach = (i: number, k: number): V3 => {
      const [x, z] = pts[i], [ax, az] = arms[i];
      if (k === 0) return [x, base[i] + (pylon ? H : H + 0.4), z];
      return [x + ax * armLen * k, base[i] + armY, z + az * armLen * k];
    };

    for (let i = 0; i < n; i++) {
      if (!owns(l.points[i])) continue;
      const [x, z] = pts[i], [ax, az] = arms[i];
      const y0 = base[i];
      if (pylon) {
        // four legs from a wide foot to a narrow waist under the crossarm, then up to the peak
        const foot = H * POWER.FOOT, waist = H * POWER.WAIST;
        const t = Math.max(0.18, H * 0.008);
        // the legs' corners, in the arm's frame (along the arm, along the line)
        const corner = (s: number, k: number, y: number): V3 => {
          const [cu, cv] = [[1, 1], [-1, 1], [-1, -1], [1, -1]][k];
          const lx = -az, lz = ax;
          return [x + (ax * cu + lx * cv) * s, y, z + (az * cu + lz * cv) * s];
        };
        const yWaist = y0 + armY;
        for (let k = 0; k < 4; k++) {
          pushPrism(verts, ramps, steel, corner(foot, k, y0 - 1), corner(waist, k, yWaist), t);
          pushPrism(verts, ramps, steel, corner(waist, k, yWaist), [x, y0 + H, z], t * 0.8);
        }
        // frames at three levels and an X on each face between them
        const levels = [0, 0.33, 0.62, 1].map((f) => ({ y: y0 + armY * f, s: foot + (waist - foot) * f }));
        for (let lv = 1; lv < levels.length; lv++) {
          const { y, s } = levels[lv], lo = levels[lv - 1];
          for (let k = 0; k < 4; k++) {
            const k2 = (k + 1) % 4;
            pushPrism(verts, ramps, steel, corner(s, k, y), corner(s, k2, y), t * 0.7);
            pushPrism(verts, ramps, steel, corner(lo.s, k, lo.y), corner(s, k2, y), t * 0.5);
            pushPrism(verts, ramps, steel, corner(lo.s, k2, lo.y), corner(s, k, y), t * 0.5);
          }
        }
        // the crossarm: out to both conductors, braced back to the body
        const left = attach(i, -1), right = attach(i, 1);
        pushPrism(verts, ramps, steel, left, right, t);
        for (const end of [left, right]) pushPrism(verts, ramps, steel, end, [x, yWaist + H * 0.08, z], t * 0.6);
      } else {
        // a pole and its arm
        pushPrism(verts, ramps, concrete, [x, y0 - 0.5, z], [x, y0 + H + 0.4, z], 0.28);
        pushPrism(verts, ramps, concrete, attach(i, -1), attach(i, 1), 0.12);
      }
    }

    // the conductors of the spans whose middle this tile holds
    for (let i = 0; i + 1 < n; i++) {
      const [alon, alat] = l.points[i], [blon, blat] = l.points[i + 1];
      if (!owns([(alon + blon) / 2, (alat + blat) / 2])) continue;
      const span = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      const sag = span * POWER.SAG;
      for (const k of [-1, 0, 1]) {
        const a = attach(i, k), c = attach(i + 1, k);
        let prev: V3 = a;
        for (let s = 1; s <= POWER.PIECES; s++) {
          const t = s / POWER.PIECES;
          const p: V3 = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t - 4 * sag * t * (1 - t), a[2] + (c[2] - a[2]) * t];
          wires.push(prev[0], prev[1], prev[2], WIRE_INDEX, p[0], p[1], p[2], WIRE_INDEX);
          prev = p;
        }
      }
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps), wires: new Float32Array(wires) };
}
