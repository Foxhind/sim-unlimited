import { colourOf, LIGHT, RAMP, rampIndex, type RGB } from '../engine/palette';
import { parseColor, parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import { pushPrism } from './mast-mesher';
import type { LonLat, OsmArea, OsmLine, OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Cranes (man_made=crane), by crane:type: a construction site's tower crane, a port's portal crane
 * (a slewing house on a portal over its rail, a luffing boom), a container gantry (legs over the quay,
 * its boom out over the water; inland a yard gantry over its rails), a floor-mounted jib crane, a
 * boat yard's travel lift. Untyped, a crane by the water is a portal crane, any other a tower crane.
 *
 * A crane mapped as a way runs on the rails it is drawn along (parseOverpass makes it a point at the
 * way's middle with RAIL_TAG, its bearing). A port crane's boom reaches out over the nearest water
 * (the coastline, water areas, rivers and docks within NEAR_WATER_M), across its rail; a tower crane's
 * jib points a way of its own (its place's hash). Their tallest points carry red lights at night.
 */
export const CRANE = {
  /** an untyped crane this near the water is a port's portal crane */
  NEAR_WATER_M: 80,
  /** a port crane's boom turns to water this near */
  REACH_WATER_M: 200,
  TOWER: {
    /** the mast's height (to the jib) without a height tag, and its bounds */
    MAST_M: 40, MIN_M: 12, MAX_M: 90,
    /** the square mast's side and panel, its chords */
    SIDE_M: 1.7, CHORD_M: 0.18,
    /** the jib's length: this share of the mast, within the bounds; its section (width, depth) and panel */
    JIB_SHARE: 1.1, JIB_M: [30, 65] as [number, number], JIB_W: 1.2, JIB_H: 1.4, JIB_PANEL: 2.4,
    /** the counter-jib: a share of the jib, its counterweight's size */
    COUNTER_SHARE: 0.3, WEIGHT_M: [2.4, 2.2, 2.4] as [number, number, number],
    /** the head over the slewing unit */
    HEAD_M: 7,
  },
  /** sizes at scale 1, with the height (to the boom's knuckle) they make */
  PORTAL: { HEIGHT_M: 32, GAUGE_M: 10.5, SPACING_M: 10, PORTAL_M: 9, HOUSE: [8, 4.5, 4.5] as [number, number, number], BOOM_M: 24, BOOM_DEG: 60, JIB_FORE_M: 14, JIB_BACK_M: 6 },
  /** a ship-to-shore container crane at scale 1: to its apex */
  QUAY_GANTRY: { HEIGHT_M: 72, GAUGE_M: 30, SPACING_M: 17, PORTAL_M: 40, BOOM_Y_M: 42, OUTREACH_M: 50, BACKREACH_M: 15, BOOM_W: 5, BOOM_H: 3 },
  /** a yard gantry over its rails at scale 1 */
  YARD_GANTRY: { HEIGHT_M: 20, SPAN_M: 26, SPACING_M: 14, CANTILEVER_M: 6 },
  JIB: { HEIGHT_M: 12, REACH_M: 14 },
  TRAVEL_LIFT: { HEIGHT_M: 10, WIDTH_M: 8, LENGTH_M: 10 },
  /** a scale from a height tag stays within these */
  SCALE: [0.5, 1.8] as [number, number],
  YELLOW: [232, 186, 36] as RGB,
  ORANGE: [226, 150, 36] as RGB,
  BLUE: [58, 108, 168] as RGB,
  WHITE: [228, 228, 222] as RGB,
  CONCRETE: [150, 148, 142] as RGB,
  GLASS: [40, 52, 60] as RGB,
} as const;

/** a crane mapped along its rails: the rails' bearing, degrees clockwise from north (parseOverpass) */
export const RAIL_TAG = 'sim:crane_rail';

export type CraneKind = 'tower' | 'portal' | 'quay_gantry' | 'yard_gantry' | 'jib' | 'travel_lift';

export function isCrane(tags: Record<string, string>): boolean {
  return tags.man_made === 'crane';
}

/** a crane's kind by its crane:type; untyped, by whether it stands by the water */
export function craneKind(tags: Record<string, string>, byWater: boolean): CraneKind {
  const t = tags['crane:type'];
  if (t === 'tower_crane') return 'tower';
  if (t === 'portal_crane') return 'portal';
  if (t === 'gantry_crane' || t === 'container_crane') return byWater ? 'quay_gantry' : 'yard_gantry';
  if (t === 'travel_lift') return 'travel_lift';
  if (t !== undefined && t !== 'yes') return 'jib';
  return byWater ? 'portal' : 'tower';
}

export interface CraneData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** far stand-in: a vertical GL line per crane, vertex pairs of x, y, z, palette index (as the masts') */
  lines: Float32Array;
  /** red night lights: x, y, z, palette index (as the masts') */
  beacons: Float32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** solids into a mesh of pos + normal (stride 6) with a face colour per vertex */
export class SolidMesh {
  readonly verts: number[] = [];
  readonly ramps: number[] = [];

  /** a flat polygon (3 or 4 corners, in order) facing the side of `out` */
  face(p: V3[], out: V3, ramp: number): void {
    let n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-12) return;
    n = norm(n);
    const flip = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
    if (flip) n = [-n[0], -n[1], -n[2]];
    const tris = p.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
    for (const t of tris) {
      const q = flip ? [p[t[0]], p[t[2]], p[t[1]]] : [p[t[0]], p[t[1]], p[t[2]]];
      for (const v of q) this.verts.push(v[0], v[1], v[2], n[0], n[1], n[2]);
      this.ramps.push(ramp, ramp, ramp);
    }
  }

  /**
   * A box from p to q (its axis), `w` wide and `h` deep across it: `h` along `up` (made square to
   * the axis), `w` across both
   */
  beam(p: V3, q: V3, w: number, h: number, ramp: number, up: V3 = [0, 1, 0]): void {
    const d = norm(sub(q, p));
    let s = cross(d, up);
    if (Math.hypot(s[0], s[1], s[2]) < 1e-6) s = cross(d, [1, 0, 0]);
    s = norm(s);
    const u = norm(cross(s, d));
    const c = (o: V3, a: number, b: number): V3 => [o[0] + s[0] * a * w / 2 + u[0] * b * h / 2, o[1] + s[1] * a * w / 2 + u[1] * b * h / 2, o[2] + s[2] * a * w / 2 + u[2] * b * h / 2];
    const corners: [number, number][] = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
    for (let i = 0; i < 4; i++) {
      const [a0, b0] = corners[i], [a1, b1] = corners[(i + 1) % 4];
      // the face between corners i and i+1: its outward normal is the side they share
      const out: V3 = norm([s[0] * (a0 + a1) + u[0] * (b0 + b1), s[1] * (a0 + a1) + u[1] * (b0 + b1), s[2] * (a0 + a1) + u[2] * (b0 + b1)]);
      this.face([c(p, a0, b0), c(p, a1, b1), c(q, a1, b1), c(q, a0, b0)], out, ramp);
    }
    this.face(corners.map(([a, b]) => c(q, a, b)), d, ramp);
    this.face(corners.map(([a, b]) => c(p, a, b)), [-d[0], -d[1], -d[2]], ramp);
  }

  /** an upright box: centre (x, z) turned so its length runs along (dx, dz), from y0 to y1 */
  block(x: number, z: number, dx: number, dz: number, length: number, width: number, y0: number, y1: number, ramp: number): void {
    const l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l;
    this.beam([x - ux * length / 2, (y0 + y1) / 2, z - uz * length / 2], [x + ux * length / 2, (y0 + y1) / 2, z + uz * length / 2], width, y1 - y0, ramp);
  }

  /**
   * A lattice truss from p to q of section w × h (h along `up`): four chords, a frame every `panel`
   * and one diagonal per face in each panel, alternating, each member a thin square prism
   */
  truss(p: V3, q: V3, w: number, h: number, panel: number, chord: number, ramp: number, up: V3 = [0, 1, 0]): void {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const d = norm(sub(q, p));
    let s = cross(d, up);
    if (Math.hypot(s[0], s[1], s[2]) < 1e-6) s = cross(d, [1, 0, 0]);
    s = norm(s);
    const u = norm(cross(s, d));
    const n = Math.max(1, Math.round(L / panel));
    const corner = (k: number, t: number): V3 => {
      const a = k === 0 || k === 3 ? -1 : 1, b = k < 2 ? -1 : 1;
      return [p[0] + d[0] * t + s[0] * a * w / 2 + u[0] * b * h / 2, p[1] + d[1] * t + s[1] * a * w / 2 + u[1] * b * h / 2, p[2] + d[2] * t + s[2] * a * w / 2 + u[2] * b * h / 2];
    };
    const m = (a: V3, b: V3, t: number) => pushPrism(this.verts, this.ramps, ramp, a, b, t);
    for (let k = 0; k < 4; k++) m(corner(k, 0), corner(k, L), chord);
    for (let i = 0; i <= n; i++) {
      const t = (L * i) / n;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        m(corner(k, t), corner(k2, t), chord * 0.7);
        if (i < n) {
          const tn = (L * (i + 1)) / n;
          if ((i + k) % 2 === 0) m(corner(k, t), corner(k2, tn), chord * 0.6);
          else m(corner(k2, t), corner(k, tn), chord * 0.6);
        }
      }
    }
  }
}

/** a stable number in [0, 1) from a place */
function hash01(lon: number, lat: number): number {
  const h = Math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** the water's edges near the tile: the coastline, water areas' and docks' rings, rivers and canals */
function waterEdges(lines: ReadonlyArray<OsmLine>, areas: ReadonlyArray<OsmArea>): LonLat[][] {
  const out: LonLat[][] = [];
  for (const l of lines) {
    const t = l.tags;
    if (t.natural === 'coastline' || t.waterway === 'river' || t.waterway === 'canal') out.push(l.points);
  }
  for (const a of areas) {
    const t = a.tags;
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'river' || t.waterway === 'canal' || t.waterway === 'dock') {
      for (const r of a.rings) out.push(r);
    }
  }
  return out;
}

/** the nearest point of `edges` (tile XZ) to p, within `max` metres */
function nearestOn(edges: XZ[][], p: XZ, max: number): XZ | undefined {
  let best: XZ | undefined, bd = max;
  for (const e of edges) {
    for (let i = 0; i + 1 < e.length; i++) {
      const a = e[i], b = e[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
      const q: XZ = [a[0] + dx * t, a[1] + dz * t];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = q; }
    }
  }
  return best;
}

/** a scale from a height tag against a kind's own height */
function scaleOf(tags: Record<string, string>, height: number): number {
  const h = parseLength(tags.height);
  if (h === undefined) return 1;
  return Math.max(CRANE.SCALE[0], Math.min(CRANE.SCALE[1], h / height));
}

/**
 * The cranes among `points` standing in `tile`; `lines` and `areas` the whole fetch's, for the water
 * their booms reach out over
 */
export function buildCranes(tile: Tile, points: ReadonlyArray<OsmPoint>, lines: ReadonlyArray<OsmLine>, areas: ReadonlyArray<OsmArea>, sampleHeight: HeightSampler): CraneData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const mesh = new SolidMesh();
  const lineOut: number[] = [];
  const beacons: number[] = [];
  const toXZ = ([lon, lat]: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const cranes = points.filter((p) => isCrane(p.tags) && owns(p.at));
  if (!cranes.length) return { vertices: new Float32Array(0), ramps: new Uint32Array(0), lines: new Float32Array(0), beacons: new Float32Array(0) };
  // the water's edges within reach of the tile
  const margin = CRANE.REACH_WATER_M / 111320;
  const near = (ll: LonLat) => ll[0] > b.west - margin * 2 && ll[0] < b.east + margin * 2 && ll[1] > b.south - margin && ll[1] < b.north + margin;
  const edges = waterEdges(lines, areas).filter((e) => e.some(near)).map((e) => e.map(toXZ));
  const LINE = rampIndex(RAMP.HULL_LIGHT, 8);

  for (const c of cranes) {
    const [x, z] = toXZ(c.at);
    const g = Math.max(0, sampleHeight(c.at[0], c.at[1]));
    const water = nearestOn(edges, [x, z], CRANE.REACH_WATER_M);
    const byWater = water !== undefined && Math.hypot(water[0] - x, water[1] - z) <= CRANE.NEAR_WATER_M;
    const kind = craneKind(c.tags, byWater);
    // the rails' direction (x east, z south), mapped or square to the water's
    const railDeg = parseFloat(c.tags[RAIL_TAG] ?? '');
    let rail: XZ | undefined = Number.isFinite(railDeg) ? [Math.sin((railDeg * Math.PI) / 180), -Math.cos((railDeg * Math.PI) / 180)] : undefined;
    // the boom's direction: to the water, square to the rails where they are mapped
    let fore: XZ;
    if (water && Math.hypot(water[0] - x, water[1] - z) > 1e-3) {
      const w: XZ = [(water[0] - x), (water[1] - z)];
      const wl = Math.hypot(w[0], w[1]);
      fore = [w[0] / wl, w[1] / wl];
      if (rail) {
        const perp: XZ = [-rail[1], rail[0]];
        fore = perp[0] * fore[0] + perp[1] * fore[1] >= 0 ? perp : [-perp[0], -perp[1]];
      }
    } else if (rail) {
      fore = [-rail[1], rail[0]];
    } else {
      const a = hash01(c.at[0], c.at[1]) * 2 * Math.PI;
      fore = [Math.cos(a), Math.sin(a)];
    }
    rail ??= [fore[1], -fore[0]];
    const tagged = parseColor(c.tags.colour ?? c.tags.color);
    const top = buildOne(mesh, kind, c.tags, x, z, g, fore, rail, tagged);
    lineOut.push(x, g, z, LINE, x, top.y, z, LINE);
    for (const l of top.lights) beacons.push(l[0], l[1], l[2], LIGHT.RED);
  }
  return { vertices: new Float32Array(mesh.verts), ramps: new Uint32Array(mesh.ramps), lines: new Float32Array(lineOut), beacons: new Float32Array(beacons) };
}

/** one crane at (x, z) on ground g: its boom along `fore`, its rails along `rail`; its top and its lights */
function buildOne(m: SolidMesh, kind: CraneKind, tags: Record<string, string>, x: number, z: number, g: number, fore: XZ, rail: XZ, tagged: RGB | undefined): { y: number; lights: V3[] } {
  // a point `f` metres along the boom, `r` along the rails, at height y
  const at = (f: number, r: number, y: number): V3 => [x + fore[0] * f + rail[0] * r, y, z + fore[1] * f + rail[1] * r];
  const concrete = colourOf(CRANE.CONCRETE), white = colourOf(CRANE.WHITE), glass = colourOf(CRANE.GLASS);

  if (kind === 'tower') {
    const T = CRANE.TOWER;
    const H = Math.max(T.MIN_M, Math.min(T.MAX_M, parseLength(tags.height) ?? T.MAST_M));
    const paint = colourOf(tagged ?? CRANE.YELLOW);
    const y1 = g + H;
    // its footing, its mast
    m.block(x, z, fore[0], fore[1], T.SIDE_M + 2.5, T.SIDE_M + 2.5, g - 1, g + 0.8, concrete);
    m.truss([x, g, z], [x, y1, z], T.SIDE_M, T.SIDE_M, T.SIDE_M, T.CHORD_M, paint, [fore[0], 0, fore[1]]);
    // the slewing unit and the cab beside the jib's root
    m.block(x, z, fore[0], fore[1], T.SIDE_M + 0.8, T.SIDE_M + 0.8, y1, y1 + 1.2, paint);
    const cab = at(0.4, T.SIDE_M / 2 + 1.1, 0);
    m.block(cab[0], cab[2], fore[0], fore[1], 2.4, 1.9, y1 - 1.2, y1 + 1, white);
    const yj = y1 + 1.2;
    const L = Math.max(T.JIB_M[0], Math.min(T.JIB_M[1], H * T.JIB_SHARE));
    const C = L * T.COUNTER_SHARE;
    // the jib: a truss hanging off the head; the counter-jib a flat girder with its weight
    m.truss(at(T.SIDE_M / 2, 0, yj), at(L, 0, yj), T.JIB_W, T.JIB_H, T.JIB_PANEL, T.CHORD_M * 0.8, paint);
    m.beam(at(-T.SIDE_M / 2, 0, yj + 0.3), at(-C, 0, yj + 0.3), 1.8, 0.6, paint);
    const wt = at(-C + T.WEIGHT_M[0] / 2 + 0.3, 0, 0);
    m.block(wt[0], wt[2], fore[0], fore[1], T.WEIGHT_M[0], T.WEIGHT_M[2], yj - T.WEIGHT_M[1] + 0.3, yj + 0.3, concrete);
    // the head, a pyramid over the slewing unit, and its ties to the jib and the counter-jib
    const apex = at(0, 0, yj + T.HEAD_M);
    const hs = T.SIDE_M / 2;
    for (const [f, r] of [[hs, hs], [hs, -hs], [-hs, hs], [-hs, -hs]]) pushPrism(m.verts, m.ramps, paint, at(f, r, yj), apex, 0.25);
    pushPrism(m.verts, m.ramps, paint, apex, at(L * 0.65, 0, yj + T.JIB_H / 2), 0.12);
    pushPrism(m.verts, m.ramps, paint, apex, at(-C, 0, yj + 0.6), 0.12);
    // the trolley halfway out, its hook block below
    const tr = at(L * 0.5, 0, 0);
    m.block(tr[0], tr[2], fore[0], fore[1], 1.6, 1.4, yj - T.JIB_H / 2 - 0.8, yj - T.JIB_H / 2, white);
    m.block(tr[0], tr[2], fore[0], fore[1], 0.6, 0.6, yj - 14, yj - 13, paint);
    pushPrism(m.verts, m.ramps, concrete, [tr[0], yj - 13, tr[2]], [tr[0], yj - T.JIB_H / 2 - 0.8, tr[2]], 0.06);
    return { y: apex[1], lights: [[apex[0], apex[1] + 0.4, apex[2]], at(L, 0, yj + T.JIB_H / 2 + 0.3)] };
  }

  if (kind === 'portal') {
    const P = CRANE.PORTAL;
    const s = scaleOf(tags, P.HEIGHT_M);
    const paint = colourOf(tagged ?? CRANE.ORANGE);
    const G = P.GAUGE_M * s, A = P.SPACING_M * s, yp = g + P.PORTAL_M * s, leg = 0.9 * s;
    // the portal: four legs over the rails, their bogies, the frame on top
    for (const f of [-G / 2, G / 2]) {
      for (const r of [-A / 2, A / 2]) {
        m.beam(at(f, r, g - 0.5), at(f * 0.85, r * 0.85, yp), leg, leg, paint);
        const bg = at(f, r, 0);
        m.block(bg[0], bg[2], rail[0], rail[1], 3 * s, 1.2 * s, g - 0.3, g + 1.2 * s, paint);
      }
      m.beam(at(f * 0.85, -A / 2 * 0.85, yp), at(f * 0.85, A / 2 * 0.85, yp), 1.2 * s, 1.2 * s, paint);
    }
    for (const r of [-A / 2, A / 2]) m.beam(at(-G / 2 * 0.85, r * 0.85, yp), at(G / 2 * 0.85, r * 0.85, yp), 1.2 * s, 1.2 * s, paint);
    // the slewing ring, the machinery house set back, its counterweight behind
    m.block(x, z, fore[0], fore[1], 4 * s, 4 * s, yp + 0.6 * s, yp + 1.6 * s, paint);
    const [hl, hw, hh] = P.HOUSE;
    const yh = yp + 1.6 * s;
    const hc = at(-1.5 * s, 0, 0);
    m.block(hc[0], hc[2], fore[0], fore[1], hl * s, hw * s, yh, yh + hh * s, paint);
    const cw = at(-1.5 * s - hl * s / 2 - 1 * s, 0, 0);
    m.block(cw[0], cw[2], fore[0], fore[1], 2 * s, hw * s * 0.9, yh + 0.5 * s, yh + 3 * s, concrete);
    // the cab at the boom's root, its glass front
    const cab = at(hl * s / 2 - 1.5 * s + 1 * s, hw * s / 2 + 0.6 * s, 0);
    m.block(cab[0], cab[2], fore[0], fore[1], 2 * s, 1.8 * s, yh + 0.5 * s, yh + 3 * s, white);
    const gl = at(hl * s / 2 - 1.5 * s + 2.05 * s, hw * s / 2 + 0.6 * s, 0);
    m.block(gl[0], gl[2], fore[0], fore[1], 0.1, 1.5 * s, yh + 1.6 * s, yh + 2.8 * s, glass);
    // the A-frame over the house
    const apex = at(-2.5 * s, 0, yh + hh * s + 7 * s);
    for (const r of [-hw * s / 2, hw * s / 2]) {
      m.beam(at(-hl * s / 2 - 1.5 * s + 0.5 * s, r, yh + hh * s), apex, 0.6 * s, 0.6 * s, paint);
      m.beam(at(hl * s / 2 - 1.5 * s - 0.5 * s, r, yh + hh * s), apex, 0.6 * s, 0.6 * s, paint);
    }
    // the boom up to its knuckle, the jib across it reaching out, the tie from the apex
    const pivot = at(hl * s / 2 - 1.5 * s, 0, yh + 1.2 * s);
    const rad = (P.BOOM_DEG * Math.PI) / 180;
    const knuckle = at(hl * s / 2 - 1.5 * s + Math.cos(rad) * P.BOOM_M * s, 0, yh + 1.2 * s + Math.sin(rad) * P.BOOM_M * s);
    m.beam(pivot, knuckle, 1.4 * s, 1.1 * s, paint, [fore[0], 0, fore[1]]);
    const kf = Math.cos(rad) * P.BOOM_M * s + hl * s / 2 - 1.5 * s;
    const tip = at(kf + P.JIB_FORE_M * s, 0, knuckle[1] - 2 * s);
    m.beam(at(kf - P.JIB_BACK_M * s, 0, knuckle[1] + 0.8 * s), tip, 0.9 * s, 1 * s, paint);
    pushPrism(m.verts, m.ramps, paint, apex, at(kf - P.JIB_BACK_M * s, 0, knuckle[1] + 0.8 * s), 0.3 * s);
    // the hook's ropes from the tip
    pushPrism(m.verts, m.ramps, concrete, tip, [tip[0], tip[1] - 12 * s, tip[2]], 0.08);
    return { y: Math.max(knuckle[1], apex[1]) + 0.5, lights: [] };
  }

  if (kind === 'quay_gantry') {
    const Q = CRANE.QUAY_GANTRY;
    const s = scaleOf(tags, Q.HEIGHT_M);
    const paint = colourOf(tagged ?? CRANE.BLUE);
    const G = Q.GAUGE_M * s, A = Q.SPACING_M * s, yp = g + Q.PORTAL_M * s, yb = g + Q.BOOM_Y_M * s, leg = 1.6 * s;
    // the legs, waterside and landside, in two frames along the quay
    for (const f of [-G / 2, G / 2]) {
      for (const r of [-A / 2, A / 2]) {
        m.beam(at(f, r, g - 0.5), at(f, r, yp), leg, leg, paint);
        const bg = at(f, r, 0);
        m.block(bg[0], bg[2], rail[0], rail[1], 5 * s, 1.6 * s, g - 0.3, g + 1.6 * s, paint);
      }
      // the sill along the quay low down, and the portal beam on top
      m.beam(at(f, -A / 2, g + 12 * s), at(f, A / 2, g + 12 * s), 1.4 * s, 1.4 * s, paint);
      m.beam(at(f, -A / 2, yp), at(f, A / 2, yp), 1.6 * s, 2 * s, paint);
    }
    for (const r of [-A / 2, A / 2]) m.beam(at(-G / 2, r, yp), at(G / 2, r, yp), 1.6 * s, 2 * s, paint);
    // the boom: back over the land, out over the water, on the portal; its machinery house at the back
    const back = -G / 2 - Q.BACKREACH_M * s, out = G / 2 + Q.OUTREACH_M * s;
    for (const r of [-Q.BOOM_W * s / 2, Q.BOOM_W * s / 2]) m.beam(at(back, r, yb), at(out, r, yb), 1.2 * s, Q.BOOM_H * s, paint);
    for (const f of [back, -G / 2, G / 2, out]) m.beam(at(f, -Q.BOOM_W * s / 2, yb), at(f, Q.BOOM_W * s / 2, yb), 0.8 * s, 0.8 * s, paint);
    // the boom's legs down to the portal (it stands over the frames)
    for (const f of [-G / 2, G / 2]) for (const r of [-A / 2, A / 2]) m.beam(at(f, r, yp), at(f, Math.sign(r) * Q.BOOM_W * s / 2, yb), 1 * s, 1 * s, paint);
    const house = at(back + 6 * s, 0, 0);
    m.block(house[0], house[2], fore[0], fore[1], 11 * s, Q.BOOM_W * s + 1.5 * s, yb + Q.BOOM_H * s / 2, yb + Q.BOOM_H * s / 2 + 5 * s, white);
    // the apex frame over the waterside legs, its forestays to the tip and backstays to the house
    const apex = at(G / 2 - 2 * s, 0, g + Q.HEIGHT_M * s);
    for (const r of [-Q.BOOM_W * s / 2, Q.BOOM_W * s / 2]) {
      m.beam(at(G / 2, r, yb + Q.BOOM_H * s / 2), apex, 1.1 * s, 1.1 * s, paint);
      m.beam(at(-G / 2 + 4 * s, r, yb + Q.BOOM_H * s / 2), apex, 1.1 * s, 1.1 * s, paint);
      pushPrism(m.verts, m.ramps, paint, apex, at(out - 2 * s, r, yb + Q.BOOM_H * s / 2), 0.35 * s);
      pushPrism(m.verts, m.ramps, paint, apex, at(G / 2 + Q.OUTREACH_M * s * 0.5, r, yb + Q.BOOM_H * s / 2), 0.35 * s);
    }
    // the trolley with its cab under the boom over the water
    const tr = at(G / 2 + 12 * s, 0, 0);
    m.block(tr[0], tr[2], fore[0], fore[1], 4 * s, Q.BOOM_W * s * 0.8, yb - Q.BOOM_H * s / 2 - 3 * s, yb - Q.BOOM_H * s / 2, white);
    return { y: apex[1], lights: [[apex[0], apex[1] + 0.5, apex[2]], at(out, 0, yb + Q.BOOM_H * s / 2 + 0.4)] };
  }

  if (kind === 'yard_gantry') {
    const Y = CRANE.YARD_GANTRY;
    const s = scaleOf(tags, Y.HEIGHT_M);
    const paint = colourOf(tagged ?? CRANE.BLUE);
    const S = Y.SPAN_M * s, A = Y.SPACING_M * s, yt = g + Y.HEIGHT_M * s, C = Y.CANTILEVER_M * s;
    for (const r of [-A / 2, A / 2]) {
      for (const f of [-S / 2, S / 2]) {
        m.beam(at(f, r, g - 0.5), at(f, r, yt), 1.1 * s, 1.1 * s, paint);
        const bg = at(f, r, 0);
        m.block(bg[0], bg[2], rail[0], rail[1], 3 * s, 1.2 * s, g - 0.3, g + 1.2 * s, paint);
      }
      m.beam(at(-S / 2 - C, r, yt), at(S / 2 + C, r, yt), 1.4 * s, 2.2 * s, paint);
    }
    for (const f of [-S / 2, S / 2]) {
      m.beam(at(f, -A / 2, g + 1.5 * s), at(f, A / 2, g + 1.5 * s), 0.8 * s, 0.8 * s, paint);
      m.beam(at(f, -A / 2, yt), at(f, A / 2, yt), 0.9 * s, 0.9 * s, paint);
    }
    const tr = at(S * 0.15, 0, 0);
    m.block(tr[0], tr[2], fore[0], fore[1], 4 * s, A + 1.5 * s, yt + 1.1 * s, yt + 3 * s, white);
    return { y: yt + 3 * s, lights: [] };
  }

  if (kind === 'travel_lift') {
    const T = CRANE.TRAVEL_LIFT;
    const s = scaleOf(tags, T.HEIGHT_M);
    const paint = colourOf(tagged ?? CRANE.BLUE);
    const W = T.WIDTH_M * s, L = T.LENGTH_M * s, yt = g + T.HEIGHT_M * s;
    // a portal open at one end over a boat: its legs, two girders along it, a cross beam at the closed end
    for (const r of [-W / 2, W / 2]) {
      for (const f of [-L / 2, L / 2]) m.beam(at(f, r, g - 0.3), at(f, r, yt), 0.7 * s, 0.7 * s, paint);
      m.beam(at(-L / 2, r, yt), at(L / 2, r, yt), 0.8 * s, 1.2 * s, paint);
    }
    m.beam(at(-L / 2, -W / 2, yt), at(-L / 2, W / 2, yt), 0.8 * s, 1.2 * s, paint);
    return { y: yt + 0.6 * s, lights: [] };
  }

  // a jib crane: a post, its jib, the tie between them
  const J = CRANE.JIB;
  const s = scaleOf(tags, J.HEIGHT_M);
  const paint = colourOf(tagged ?? CRANE.YELLOW);
  const yt = g + J.HEIGHT_M * s;
  m.block(x, z, fore[0], fore[1], 3 * s, 3 * s, g - 0.5, g + 0.6, concrete);
  m.beam([x, g, z], [x, yt, z], 1.2 * s, 1.2 * s, paint, [fore[0], 0, fore[1]]);
  m.beam(at(0, 0, yt - 0.4 * s), at(J.REACH_M * s, 0, yt - 0.4 * s), 0.8 * s, 0.9 * s, paint);
  m.beam(at(-3 * s, 0, yt - 0.4 * s), at(0, 0, yt - 0.4 * s), 0.8 * s, 0.9 * s, paint);
  const wt = at(-2.4 * s, 0, 0);
  m.block(wt[0], wt[2], fore[0], fore[1], 1.4 * s, 1.2 * s, yt - 2 * s, yt, concrete);
  pushPrism(m.verts, m.ramps, paint, [x, yt + 3 * s, z], at(J.REACH_M * s * 0.7, 0, yt), 0.15 * s);
  pushPrism(m.verts, m.ramps, paint, [x, yt, z], [x, yt + 3 * s, z], 0.5 * s);
  return { y: yt + 3 * s, lights: [] };
}

/**
 * A crane mapped as a way, as a point: an open way is its rails, the crane at their middle; a closed
 * one its footprint, the crane at its vertex mean along its longest edge. Its rails' bearing in RAIL_TAG
 */
export function craneOnWay(geom: LonLat[], tags: Record<string, string>): OsmPoint {
  const k = 111320 * Math.cos((geom[0][1] * Math.PI) / 180);
  const closed = geom.length > 3 && geom[0][0] === geom[geom.length - 1][0] && geom[0][1] === geom[geom.length - 1][1];
  const bearing = (a: LonLat, b: LonLat) => ((Math.atan2((b[0] - a[0]) * k, (b[1] - a[1]) * 111320) * 180) / Math.PI + 360) % 360;
  const seg = (i: number) => Math.hypot((geom[i + 1][0] - geom[i][0]) * k, (geom[i + 1][1] - geom[i][1]) * 111320);
  if (closed) {
    const n = geom.length - 1;
    let lon = 0, lat = 0, best = -1, at = 0;
    for (let i = 0; i < n; i++) {
      lon += geom[i][0]; lat += geom[i][1];
      if (seg(i) > best) { best = seg(i); at = i; }
    }
    return { at: [lon / n, lat / n], tags: { ...tags, [RAIL_TAG]: bearing(geom[at], geom[at + 1]).toFixed(1) } };
  }
  let total = 0;
  for (let i = 0; i + 1 < geom.length; i++) total += seg(i);
  let left = total / 2;
  let mid: LonLat = geom[0];
  for (let i = 0; i + 1 < geom.length; i++) {
    const l = seg(i);
    if (left <= l && l > 0) {
      const t = left / l;
      mid = [geom[i][0] + (geom[i + 1][0] - geom[i][0]) * t, geom[i][1] + (geom[i + 1][1] - geom[i][1]) * t];
      break;
    }
    left -= l;
  }
  return { at: mid, tags: total > 1 ? { ...tags, [RAIL_TAG]: bearing(geom[0], geom[geom.length - 1]).toFixed(1) } : tags };
}
