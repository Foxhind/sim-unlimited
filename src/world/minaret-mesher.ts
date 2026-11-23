import { colourOf, RAMP, rampIndex, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmBuilding, OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Minarets: the slender towers that mark a Turkish town from far away. OSM rarely maps them
 * (3 against 59 mosques round Fethiye in 2026), so two sources:
 * - mapped: man_made=tower + tower:type=minaret (a point, or a footprint taken at its middle);
 * - guessed (GUESS): every mosque (building=mosque, or a building with amenity=place_of_worship +
 *   religion=muslim) with no minaret mapped near it gets one, at the corner of its outline farthest
 *   from Mecca (the qibla wall is the far side; the minaret stands by the entrance and its court).
 * Each is an octagonal shaft, a balcony (şerefe) ring at BALCONY of its height, a thinner upper shaft
 * and a pencil cone of lead, in building mesh format; far away a vertical line like a mast's.
 */
export const MINARET = {
  GUESS: true,
  /** a mapped minaret without `height` */
  HEIGHT_M: 28,
  /** a guessed one: from the mosque's size, BASE_M + PER_M × √(footprint m²), kept to MIN_M..MAX_M */
  BASE_M: 14,
  PER_M: 0.5,
  MIN_M: 16,
  MAX_M: 40,
  /** a minaret mapped within this of a mosque's outline is its own: no guess */
  NEAR_M: 40,
  /** the shaft's radius to its height, at least MIN_RADIUS_M */
  RADIUS: 0.05,
  MIN_RADIUS_M: 0.9,
  /** the balcony's height share, its overhang and depth to the radius */
  BALCONY: 0.72,
  BALCONY_OUT: 0.55,
  BALCONY_DEPTH: 0.45,
  /** the upper shaft's radius to the lower's, the cone's height to the whole */
  UPPER: 0.8,
  CONE: 0.2,
  SIDES: 8,
  STONE: [234, 230, 220] as RGB,
  LEAD: [118, 124, 132] as RGB,
} as const;

/** the Kaaba, Mecca */
const KAABA: LonLat = [39.8262, 21.4225];

export function isMosque(tags: Record<string, string>): boolean {
  if (tags.building === 'mosque') return true;
  return tags.amenity === 'place_of_worship' && tags.religion === 'muslim' && tags.building !== undefined && tags.building !== 'no';
}

export function isMappedMinaret(tags: Record<string, string>): boolean {
  return tags['tower:type'] === 'minaret' || tags.building === 'minaret' || tags['building:part'] === 'minaret' || tags.man_made === 'minaret';
}

/** initial great-circle bearing from `from` to `to`, radians clockwise from north */
export function bearing(from: LonLat, to: LonLat): number {
  const r = Math.PI / 180;
  const [l1, p1] = [from[0] * r, from[1] * r], [l2, p2] = [to[0] * r, to[1] * r];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return Math.atan2(y, x);
}

export interface MinaretSite {
  at: LonLat;
  height: number;
}

/** metres east, north of `o` */
function local(o: LonLat, p: LonLat): [number, number] {
  return [(p[0] - o[0]) * 111320 * Math.cos((o[1] * Math.PI) / 180), (p[1] - o[1]) * 111320];
}

/**
 * Where the minarets of a tile stand: the mapped ones among `points` and the outlines of
 * `buildings`, and (GUESS) one by each mosque among `buildings` with none of those near it.
 * `known` are every mapped minaret round (not only the tile's), so a mosque by the border
 * still sees its own.
 */
export function minaretSites(points: ReadonlyArray<OsmPoint>, buildings: ReadonlyArray<OsmBuilding>, known: ReadonlyArray<LonLat> = []): MinaretSite[] {
  const sites: MinaretSite[] = [];
  const mapped: LonLat[] = [...known];
  for (const p of points) {
    if (p.tags.man_made !== 'tower' || p.tags['tower:type'] !== 'minaret') continue;
    sites.push({ at: p.at, height: parseLength(p.tags.height) ?? MINARET.HEIGHT_M });
    mapped.push(p.at);
  }
  // minarets drawn as buildings or parts are the building mesher's: they only stop a guess
  for (const b of buildings) if (isMappedMinaret(b.tags) && b.rings[0]?.length) mapped.push(b.rings[0][0]);
  if (!MINARET.GUESS) return sites;
  for (const b of buildings) {
    if (!isMosque(b.tags)) continue;
    const ring = b.rings[0];
    if (!ring || ring.length < 3) continue;
    const o = ring[0];
    const pts = ring.map((p) => local(o, p));
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      area += x0 * y1 - x1 * y0;
      cx += x0; cy += y0;
    }
    area = Math.abs(area) / 2;
    cx /= pts.length; cy /= pts.length;
    const reach = Math.max(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy))) + MINARET.NEAR_M;
    if (mapped.some((m) => { const [x, y] = local(o, m); return Math.hypot(x - cx, y - cy) <= reach; })) continue;
    // the corner farthest from Mecca, the minaret a little out from it along the corner's diagonal
    const q = bearing(ring[0], KAABA);
    const away: [number, number] = [-Math.sin(q), -Math.cos(q)];
    let best = 0;
    pts.forEach(([x, y], i) => { if (x * away[0] + y * away[1] > pts[best][0] * away[0] + pts[best][1] * away[1]) best = i; });
    const [bx, by] = pts[best];
    const dl = Math.hypot(bx - cx, by - cy) || 1;
    const height = Math.max(MINARET.MIN_M, Math.min(MINARET.MAX_M, MINARET.BASE_M + MINARET.PER_M * Math.sqrt(area)));
    const out = radiusFor(height) * 1.2;
    const mx = bx + ((bx - cx) / dl) * out, my = by + ((by - cy) / dl) * out;
    const kx = 111320 * Math.cos((o[1] * Math.PI) / 180);
    sites.push({ at: [o[0] + mx / kx, o[1] + my / 111320], height });
  }
  return sites;
}

function radiusFor(height: number): number {
  return Math.max(MINARET.MIN_RADIUS_M, height * MINARET.RADIUS);
}

export interface MinaretData {
  /** pos + normal (stride 6), as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** far stand-in: one vertical GL line each, vertex pairs of x, y, z, palette index (as the masts') */
  lines: Float32Array;
}

const LINE_INDEX = rampIndex(RAMP.CONCRETE, 13);

type V3 = [number, number, number];

/** the minarets standing in `tile` (their sites in it), in its ENU frame (x east, z south) */
export function buildMinarets(sites: ReadonlyArray<MinaretSite>, tile: Tile, sampleHeight: HeightSampler): MinaretData {
  const center = tileCenter(tile);
  const verts: number[] = [];
  const ramps: number[] = [];
  const lines: number[] = [];
  const stone = colourOf(MINARET.STONE), lead = colourOf(MINARET.LEAD);
  const push = (p: V3, n: V3, ramp: number) => { verts.push(p[0], p[1], p[2], n[0], n[1], n[2]); ramps.push(ramp); };
  const S = MINARET.SIDES;
  const ring = (x: number, z: number, r: number, y: number, k: number): V3 => {
    const t = (k / S) * Math.PI * 2;
    return [x + r * Math.cos(t), y, z + r * Math.sin(t)];
  };
  /** a frustum from radius r0 at y0 to r1 at y1 (r1 = 0: a cone), flat-shaded faces */
  const frustum = (x: number, z: number, r0: number, y0: number, r1: number, y1: number, ramp: number): void => {
    for (let k = 0; k < S; k++) {
      const a0 = ring(x, z, r0, y0, k), b0 = ring(x, z, r0, y0, k + 1);
      const a1 = ring(x, z, r1, y1, k), b1 = ring(x, z, r1, y1, k + 1);
      // the face's normal: out from the axis, tilted by the slope
      const t = ((k + 0.5) / S) * Math.PI * 2;
      const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
      const l = Math.hypot(1, slope);
      const n: V3 = [Math.cos(t) / l, slope / l, Math.sin(t) / l];
      for (const p of [a0, b0, b1]) push(p, n, ramp);
      if (r1 > 0) for (const p of [a0, b1, a1]) push(p, n, ramp);
    }
  };
  /** a flat ring face (an annulus, or a disc for rIn = 0) at y, facing up or down */
  const annulus = (x: number, z: number, rIn: number, rOut: number, y: number, up: boolean, ramp: number): void => {
    const n: V3 = [0, up ? 1 : -1, 0];
    for (let k = 0; k < S; k++) {
      const o0 = ring(x, z, rOut, y, k), o1 = ring(x, z, rOut, y, k + 1);
      const i0 = ring(x, z, rIn, y, k), i1 = ring(x, z, rIn, y, k + 1);
      for (const p of [o0, o1, i1]) push(p, n, ramp);
      if (rIn > 0) for (const p of [o0, i1, i0]) push(p, n, ramp);
    }
  };

  for (const s of sites) {
    const [lon, lat] = s.at;
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    const x = e, z = -n;
    const base = Math.max(0, sampleHeight(lon, lat));
    const H = s.height;
    const r = radiusFor(H), ru = r * MINARET.UPPER;
    const yb = base + H * MINARET.BALCONY, depth = r * MINARET.BALCONY_DEPTH, rb = r * (1 + MINARET.BALCONY_OUT);
    const yc = base + H * (1 - MINARET.CONE);
    // the lower shaft from under the ground (slopes) to the balcony
    frustum(x, z, r, base - 1, r, yb - depth, stone);
    // the balcony: its underside, rim and floor
    annulus(x, z, r, rb, yb - depth, false, stone);
    frustum(x, z, rb, yb - depth, rb, yb, stone);
    annulus(x, z, ru, rb, yb, true, stone);
    // the upper shaft, a lead cap's rim, the cone
    frustum(x, z, ru, yb, ru, yc, stone);
    frustum(x, z, ru, yc, 0, base + H, lead);
    lines.push(x, base, z, LINE_INDEX, x, base + H, z, LINE_INDEX);
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps), lines: new Float32Array(lines) };
}
