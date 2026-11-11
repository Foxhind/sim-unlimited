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

const DEFAULT_HEIGHT: Record<string, number> = { mast: 60, antenna: 20, tower: 80 };

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
  /** square lattice trusses: interleaved pos+normal (stride 6) with Uint16 ramps, as the building mesh */
  vertices: Float32Array;
  ramps: Uint16Array;
  /** far stand-in: one vertical GL line per mast, vertex pairs of x, y, z, palette index */
  lines: Float32Array;
  /** red night lights on the mast axis: x, y, z, palette index */
  beacons: Float32Array;
}

type V3 = [number, number, number];
const MAST_RAMP = RAMP.HULL_LIGHT;
const LINE_INDEX = rampIndex(RAMP.HULL_LIGHT, 8);
const MAX_PANELS = 120;

/**
 * Antenna masts from OSM point objects: a four-legged lattice truss (legs, a horizontal frame and
 * one diagonal brace per face in every panel, each member a thin square prism), a vertical line for
 * far views, and red beacons every 25 m. Coordinates are tile-centre ENU like the other meshes.
 */
export function buildMasts(points: OsmPoint[], tile: Tile, sampleHeight: HeightSampler): MastData {
  const center = tileCenter(tile);
  const verts: number[] = [];
  const ramps: number[] = [];
  const lines: number[] = [];
  const beacons: number[] = [];

  const quad = (a: V3, b: V3, c: V3, d: V3, n: V3): void => {
    for (const p of [a, b, c, a, c, d]) {
      verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
      ramps.push(MAST_RAMP);
    }
  };
  /** square prism of side t from p to q (side faces only: the ends are hidden in the joints) */
  const member = (p: V3, q: V3, t: number): void => {
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
      quad(corner(p, a0, a1), corner(p, b0, b1), corner(q, b0, b1), corner(q, a0, a1), [n[0] / nl, n[1] / nl, n[2] / nl]);
    }
  };

  for (const pt of points) {
    if (!isAntenna(pt.tags)) continue;
    const [lon, lat] = pt.at;
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    const x = e, z = -n;
    const y0 = Math.max(0, sampleHeight(lon, lat));
    const H = antennaHeight(pt.tags);
    const top = y0 + H;

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

    lines.push(x, y0, z, LINE_INDEX, x, top, z, LINE_INDEX);
    // on the axis, just above the panel frame so the lattice does not hide them
    for (const hy of beaconHeights(H)) beacons.push(x, y0 + hy + 0.3, z, LIGHT.RED);
  }

  return {
    vertices: new Float32Array(verts),
    ramps: new Uint16Array(ramps),
    lines: new Float32Array(lines),
    beacons: new Float32Array(beacons),
  };
}
