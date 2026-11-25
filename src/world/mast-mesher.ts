import { LIGHT, RAMP, rampIndex } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileCenter, type Tile } from './geodesy';
import type { OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';

/** a point object that stands for an antenna mast: mast, antenna, communication tower */
export function isAntenna(tags: Record<string, string>): boolean {
  const mm = tags.man_made;
  return mm === 'mast' || mm === 'antenna' || (mm === 'tower' && tags['tower:type'] === 'communication');
}

/**
 * a mast without height: 25 m, the median of the masts with communication:mobile_phone=yes that have
 * a height in the Austria, Central and Far Eastern Russia, Israel and Turkey extracts (777 of 8413)
 */
const DEFAULT_HEIGHT: Record<string, number> = { mast: 25, antenna: 20, tower: 80 };

/**
 * A mast is a cell-site monopole (a hexagonal tube with the sector antennas' housings on three sides)
 * unless mapped as a lattice or it is too tall for one: then a lattice truss, as the towers
 */
export const MONOPOLE = {
  MAX_HEIGHT_M: 60,
  /** the tube's radius at the foot: this share of the height, within the bounds; at the top a share of that */
  FOOT_SHARE: 0.03,
  FOOT_M: [0.4, 1.0] as [number, number],
  TOP_SHARE: 0.45,
  /** the antenna housings: height, width, depth, gap off the tube, top below the tube's top (m) */
  HOUSING: { HEIGHT_M: 2.2, WIDTH_M: 0.45, DEPTH_M: 0.18, GAP_M: 0.25, BELOW_TOP_M: 0.2 },
};

/** a mast drawn as a monopole: man_made=mast not tagged as a lattice, up to MONOPOLE.MAX_HEIGHT_M */
export function isMonopole(tags: Record<string, string>): boolean {
  if (tags.man_made !== 'mast') return false;
  const c = tags['tower:construction'];
  if (c === 'lattice' || c === 'guyed_lattice') return false;
  return antennaHeight(tags) <= MONOPOLE.MAX_HEIGHT_M;
}

export function antennaHeight(tags: Record<string, string>): number {
  const h = parseLength(tags.height) ?? DEFAULT_HEIGHT[tags.man_made] ?? 30;
  return Math.max(5, Math.min(700, h));
}

/** obstruction lights every 25 m of height, from 25 m up (and none below it) */
export const BEACON_SPACING_M = 25;
export function beaconHeights(height: number): number[] {
  const out: number[] = [];
  for (let y = BEACON_SPACING_M; y <= height + 1e-6; y += BEACON_SPACING_M) out.push(y);
  return out;
}

export interface MastData {
  /** monopoles and square lattice trusses: interleaved pos+normal (stride 6) with Uint32 face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** far stand-in: one vertical GL line per mast, vertex pairs of x, y, z, palette index */
  lines: Float32Array;
  /** red night lights on the mast axis: x, y, z, palette index */
  beacons: Float32Array;
}

type V3 = [number, number, number];
const MAST_RAMP = RAMP.HULL_LIGHT;
const TUBE_RAMP = RAMP.CONCRETE;
const HOUSING_RAMP = RAMP.HULL_LIGHT;
const LINE_INDEX = rampIndex(RAMP.HULL_LIGHT, 8);
const MAX_PANELS = 120;

/**
 * A square prism of side t from p to q, side faces only (the ends are hidden in the joints), into a
 * mesh of pos + normal (stride 6) with a face colour per vertex: a member of a lattice truss.
 */
export function pushPrism(verts: number[], ramps: number[], ramp: number, p: V3, q: V3, t: number): void {
  const d: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return;
  d[0] /= len; d[1] /= len; d[2] /= len;
  // any axis not parallel to d
  const ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const h = t / 2;
  const corner = (base: V3, su: number, sv: number): V3 => [
    base[0] + (u[0] * su + v[0] * sv) * h,
    base[1] + (u[1] * su + v[1] * sv) * h,
    base[2] + (u[2] * su + v[2] * sv) * h,
  ];
  const signs: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i < 4; i++) {
    const [a0, a1] = signs[i];
    const [b0, b1] = signs[(i + 1) % 4];
    const n: V3 = [
      u[0] * (a0 + b0) + v[0] * (a1 + b1),
      u[1] * (a0 + b0) + v[1] * (a1 + b1),
      u[2] * (a0 + b0) + v[2] * (a1 + b1),
    ];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const nn: V3 = [n[0] / nl, n[1] / nl, n[2] / nl];
    const a = corner(p, a0, a1), b = corner(p, b0, b1), c = corner(q, b0, b1), e = corner(q, a0, a1);
    for (const pt of [a, b, c, a, c, e]) {
      verts.push(pt[0], pt[1], pt[2], nn[0], nn[1], nn[2]);
      ramps.push(ramp);
    }
  }
}

function pushTri(verts: number[], ramps: number[], ramp: number, a: V3, b: V3, c: V3, n: V3): void {
  for (const p of [a, b, c]) {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    ramps.push(ramp);
  }
}

/**
 * A monopole at (x, z) from y0 to top: a tapering hexagonal tube (sides and a top cap; its foot a
 * metre into the ground for slopes) and three antenna housings, flat boxes around its top a third of
 * a turn apart, turned by `turn` (rad).
 */
export function pushMonopole(verts: number[], ramps: number[], x: number, z: number, y0: number, top: number, turn: number): void {
  const H = top - y0;
  const r0 = Math.max(MONOPOLE.FOOT_M[0], Math.min(MONOPOLE.FOOT_M[1], H * MONOPOLE.FOOT_SHARE));
  const r1 = r0 * MONOPOLE.TOP_SHARE;
  const yb = y0 - 1;
  const ring = (r: number, y: number, k: number): V3 => {
    const a = turn + (k * Math.PI) / 3;
    return [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
  };
  // a side's normal: out through the middle of its face, tilted up by the taper
  const lean = (r0 - r1) / (top - yb);
  const cosHalf = Math.cos(Math.PI / 6);
  for (let k = 0; k < 6; k++) {
    const a = turn + ((k + 0.5) * Math.PI) / 3;
    const nl = Math.hypot(cosHalf, lean);
    const n: V3 = [(Math.cos(a) * cosHalf) / nl, lean / nl, (Math.sin(a) * cosHalf) / nl];
    const p0 = ring(r0, yb, k), p1 = ring(r0, yb, k + 1), q1 = ring(r1, top, k + 1), q0 = ring(r1, top, k);
    // counter-clockwise seen from outside
    pushTri(verts, ramps, TUBE_RAMP, p0, q1, p1, n);
    pushTri(verts, ramps, TUBE_RAMP, p0, q0, q1, n);
  }
  const up: V3 = [0, 1, 0];
  const c: V3 = [x, top, z];
  for (let k = 0; k < 6; k++) pushTri(verts, ramps, TUBE_RAMP, c, ring(r1, top, k + 1), ring(r1, top, k), up);

  const h = MONOPOLE.HOUSING;
  const hy1 = top - h.BELOW_TOP_M, hy0 = hy1 - h.HEIGHT_M;
  // the tube's radius at the housings' middle
  const rMid = r1 + (r0 - r1) * ((top - (hy0 + hy1) / 2) / (top - yb));
  for (let s = 0; s < 3; s++) {
    const a = turn + (s * 2 * Math.PI) / 3;
    const ox = Math.cos(a), oz = Math.sin(a); // out from the tube
    const tx = -oz, tz = ox; // along the housing's face
    const d0 = rMid + h.GAP_M, d1 = d0 + h.DEPTH_M, w = h.WIDTH_M / 2;
    const corner = (d: number, t: number, y: number): V3 => [x + ox * d + tx * t, y, z + oz * d + tz * t];
    const quad = (a0: V3, b0: V3, b1: V3, a1: V3, n: V3): void => {
      pushTri(verts, ramps, HOUSING_RAMP, a0, b1, b0, n);
      pushTri(verts, ramps, HOUSING_RAMP, a0, a1, b1, n);
    };
    quad(corner(d1, -w, hy0), corner(d1, w, hy0), corner(d1, w, hy1), corner(d1, -w, hy1), [ox, 0, oz]);
    quad(corner(d0, w, hy0), corner(d0, -w, hy0), corner(d0, -w, hy1), corner(d0, w, hy1), [-ox, 0, -oz]);
    quad(corner(d0, -w, hy0), corner(d1, -w, hy0), corner(d1, -w, hy1), corner(d0, -w, hy1), [-tx, 0, -tz]);
    quad(corner(d1, w, hy0), corner(d0, w, hy0), corner(d0, w, hy1), corner(d1, w, hy1), [tx, 0, tz]);
    quad(corner(d0, -w, hy1), corner(d1, -w, hy1), corner(d1, w, hy1), corner(d0, w, hy1), up);
    quad(corner(d0, w, hy0), corner(d1, w, hy0), corner(d1, -w, hy0), corner(d0, -w, hy0), [0, -1, 0]);
  }
}

/** a stable turn for a mast's housings from its place: masts side by side do not all face one way */
function placeTurn(lon: number, lat: number): number {
  const h = Math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * ((2 * Math.PI) / 3);
}

/**
 * Antenna masts from OSM point objects: a cell-site monopole (isMonopole) or a four-legged lattice truss (legs, a horizontal frame and
 * one diagonal brace per face in every panel, each member a thin square prism), a vertical line for
 * far views, and red beacons every 25 m. Coordinates are tile-centre ENU like the other meshes.
 */
export function buildMasts(points: OsmPoint[], tile: Tile, sampleHeight: HeightSampler): MastData {
  const center = tileCenter(tile);
  const verts: number[] = [];
  const ramps: number[] = [];
  const lines: number[] = [];
  const beacons: number[] = [];

  const member = (p: V3, q: V3, t: number): void => pushPrism(verts, ramps, MAST_RAMP, p, q, t);

  for (const pt of points) {
    if (!isAntenna(pt.tags)) continue;
    const [lon, lat] = pt.at;
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    const x = e, z = -n;
    const y0 = Math.max(0, sampleHeight(lon, lat));
    const H = antennaHeight(pt.tags);
    const top = y0 + H;

    if (isMonopole(pt.tags)) {
      pushMonopole(verts, ramps, x, z, y0, top, placeTurn(lon, lat));
    } else {
      // truss: width grows with height, panels about as tall as the truss is wide
      const w = Math.max(1.2, Math.min(4, H * 0.02));
      const t = Math.max(0.15, w * 0.07);
      const panels = Math.max(1, Math.min(MAX_PANELS, Math.round(H / w)));
      const ph = H / panels;
      const c = w / 2;
      const legs: [number, number][] = [[-c, -c], [c, -c], [c, c], [-c, c]];
      const at = (k: number, y: number): V3 => [x + legs[k][0], y, z + legs[k][1]];
      // legs start a little below the ground so they meet the terrain on slopes
      for (let k = 0; k < 4; k++) member(at(k, y0 - 1), at(k, top), t);
      for (let p = 0; p <= panels; p++) {
        const y = y0 + p * ph;
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          member(at(k, y), at(k2, y), t * 0.8);
          // one diagonal per face, alternating direction from panel to panel
          if (p < panels) {
            const yn = y + ph;
            if ((p + k) % 2 === 0) member(at(k, y), at(k2, yn), t * 0.7);
            else member(at(k2, y), at(k, yn), t * 0.7);
          }
        }
      }
    }

    lines.push(x, y0, z, LINE_INDEX, x, top, z, LINE_INDEX);
    // on the axis, just above the panel frame so the lattice does not hide them; a monopole's only on its top
    const lit = isMonopole(pt.tags) ? (H >= BEACON_SPACING_M ? [H] : []) : beaconHeights(H);
    for (const hy of lit) beacons.push(x, y0 + hy + 0.3, z, LIGHT.RED);
  }

  return {
    vertices: new Float32Array(verts),
    ramps: new Uint32Array(ramps),
    lines: new Float32Array(lines),
    beacons: new Float32Array(beacons),
  };
}
