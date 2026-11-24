import { colourOf, snowy, type RGB } from '../engine/palette';
import { buildingFooting, isRuin, LEVEL_M, parseLength } from './building-mesher';
import { latLonToEnu, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmBuilding } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Ruins (building-mesher isRuin): roofless stone walls, as Kayaköy's hundreds of houses above
 * Fethiye stand. Round the outline a wall WALL_M thick, open to the sky, its top broken: at every
 * corner and every STEP_M along an edge it is at its own height, between them straight, so the
 * line of the top rises and falls. A house keeps a share of its height (INTACT), a stretch of
 * wall a share of that (KEPT); the short ends of a four-cornered house keep the stub of a gable.
 * The walls stand on the ground under each stretch (into it SINK_M), their tops from the footing
 * a house would have (buildingFooting): on a slope the uphill wall is the lower.
 */
export const RUIN = {
  WALL_M: 0.6,
  /** a ruin's wall height without `height` or `building:levels`: two storeys, as Kayaköy's houses */
  HEIGHT_M: 5.5,
  /** the top's height changes at most this far apart along a wall */
  STEP_M: 2.5,
  /** a house keeps this share of its height (by its hash) */
  INTACT: [0.45, 1] as const,
  /** a stretch of wall this share of the house's */
  KEPT: [0.5, 1] as const,
  /** no wall lower than this over the ground under it */
  MIN_M: 0.8,
  /** a gable end rises this much per metre from its corners to its middle (≈ 22°) */
  GABLE: 0.4,
  SINK_M: 0.3,
  /** the miter at a sharp corner is kept within this many wall thicknesses */
  MITER_LIMIT: 3,
  /** weathered limestone, a house picks one */
  STONE: [[176, 168, 152], [162, 154, 140], [186, 180, 166], [150, 142, 128]] as RGB[],
} as const;

export interface RuinMeshData {
  /** interleaved pos + normal (stride 6), as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

/** 0..1, fixed by the two integers */
function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** a ruin's wall height before it fell: its tags', else RUIN.HEIGHT_M */
export function ruinHeight(tags: Record<string, string>): number {
  const h = parseLength(tags.height);
  if (h !== undefined && h > 0.5 && h < 60) return h;
  const levels = parseLength(tags['building:levels']);
  if (levels !== undefined && levels > 0 && levels < 15) return levels * LEVEL_M;
  return RUIN.HEIGHT_M;
}

/** the ruins among a tile's buildings (its own share), in its ENU frame (x east, z south) */
export function buildRuins(tile: Tile, buildings: ReadonlyArray<OsmBuilding>, sampleHeight: HeightSampler): RuinMeshData {
  const center = tileCenter(tile);
  const verts: number[] = [];
  const ramps: number[] = [];
  const toXZ = ([lon, lat]: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const tri = (a: V3, b: V3, c: V3, ramp: number): void => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) return;
    n = n.map((v) => v / len);
    for (const p of [a, b, c]) verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    ramps.push(ramp, ramp, ramp);
  };
  /** a quad facing `out` (x, z), or up when omitted */
  const quad = (a: V3, b: V3, c: V3, d: V3, ramp: number, out?: XZ): void => {
    const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    const nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const flip = out ? nx * out[0] + nz * out[1] < 0 : ny < 0;
    if (flip) { tri(a, c, b, ramp); tri(a, d, c, ramp); } else { tri(a, b, c, ramp); tri(a, c, d, ramp); }
  };

  for (const b of buildings) {
    if (!isRuin(b.tags)) continue;
    const ll = (b.rings[0] ?? []).slice();
    if (ll.length > 1 && ll[0][0] === ll[ll.length - 1][0] && ll[0][1] === ll[ll.length - 1][1]) ll.pop();
    const pts = ll.map(toXZ);
    // drop repeated points
    for (let i = pts.length - 1; i > 0 && pts.length > 3; i--) {
      if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < 0.05) { pts.splice(i, 1); ll.splice(i, 1); }
    }
    if (pts.length < 3) continue;
    let area2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      area2 += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(area2) < 2 * 4) continue; // under 4 m²
    // inward: to the left of each edge when the ring turns that way in x, z
    const inSign = area2 > 0 ? 1 : -1;
    const n = pts.length;
    const lens = pts.map((p, i) => Math.hypot(pts[(i + 1) % n][0] - p[0], pts[(i + 1) % n][1] - p[1]));
    const t = Math.min(RUIN.WALL_M, Math.min(...lens) / 3);
    /** each edge's inward unit normal */
    const inward = pts.map((p, i): XZ => {
      const q = pts[(i + 1) % n], l = lens[i] || 1;
      return [(-(q[1] - p[1]) / l) * inSign, ((q[0] - p[0]) / l) * inSign];
    });
    /** the inner corner: the two edges' inner lines meet there (a sharp corner's miter kept short) */
    const inner = pts.map((p, i): XZ => {
      const a = inward[(i - 1 + n) % n], c = inward[i];
      const mx = a[0] + c[0], mz = a[1] + c[1];
      const dot = (mx * c[0] + mz * c[1]) || 1e-9;
      let k = t / dot;
      const ml = Math.hypot(mx, mz) * k;
      if (!(ml <= RUIN.MITER_LIMIT * t)) k = (RUIN.MITER_LIMIT * t) / (Math.hypot(mx, mz) || 1);
      return [p[0] + mx * k, p[1] + mz * k];
    });

    // the house: its first point (the same in every tile that has it) picks its stone and how much of it stands
    const id = Math.round(ll[0][0] * 1e7) ^ Math.imul(Math.round(ll[0][1] * 1e7), 31);
    const seed = (k: number) => hash2(id, k);
    const stone = RUIN.STONE[Math.floor(seed(1) * RUIN.STONE.length) % RUIN.STONE.length];
    const ramp = snowy(colourOf(stone));
    const intact = RUIN.INTACT[0] + (RUIN.INTACT[1] - RUIN.INTACT[0]) * seed(2);
    const full = ruinHeight(b.tags) * intact;
    const { base } = buildingFooting(ll, sampleHeight);
    const kept = (k: number) => RUIN.KEPT[0] + (RUIN.KEPT[1] - RUIN.KEPT[0]) * seed(k);
    // a four-cornered house's two shorter, opposite ends carry a gable
    const gable = n === 4 && lens[0] + lens[2] < lens[1] + lens[3] ? [0, 2] : n === 4 ? [1, 3] : [];
    const cornerTop = pts.map((_, i) => base + full * kept(100 + i));

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = pts[i], q = pts[j], pi = inner[i], qi = inner[j];
      const steps = Math.max(1, Math.round(lens[i] / RUIN.STEP_M));
      const out: XZ = [-inward[i][0], -inward[i][1]];
      const station = (k: number) => {
        const s = k / steps;
        const o: XZ = [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
        const w: XZ = [pi[0] + (qi[0] - pi[0]) * s, pi[1] + (qi[1] - pi[1]) * s];
        const llAt: LonLat = [ll[i][0] + (ll[j][0] - ll[i][0]) * s, ll[i][1] + (ll[j][1] - ll[i][1]) * s];
        const ground = Math.max(sampleHeight(llAt[0], llAt[1]), 0);
        let top = k === 0 ? cornerTop[i] : k === steps ? cornerTop[j] : base + full * kept(1000 + i * 64 + k);
        if (gable.includes(i) && k > 0 && k < steps) top += Math.min(s, 1 - s) * lens[i] * RUIN.GABLE * intact * kept(2000 + i * 64 + k);
        top = Math.max(top, ground + RUIN.MIN_M);
        return { o, w, top, foot: ground - RUIN.SINK_M };
      };
      let a = station(0);
      for (let k = 1; k <= steps; k++) {
        const c = station(k);
        // the outer face, the inner face, the broken top
        quad([a.o[0], a.foot, a.o[1]], [c.o[0], c.foot, c.o[1]], [c.o[0], c.top, c.o[1]], [a.o[0], a.top, a.o[1]], ramp, out);
        quad([a.w[0], a.foot, a.w[1]], [c.w[0], c.foot, c.w[1]], [c.w[0], c.top, c.w[1]], [a.w[0], a.top, a.w[1]], ramp, inward[i]);
        quad([a.o[0], a.top, a.o[1]], [c.o[0], c.top, c.o[1]], [c.w[0], c.top, c.w[1]], [a.w[0], a.top, a.w[1]], ramp);
        a = c;
      }
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
