import { colourOf, snowy, type RGB } from '../engine/palette';
import { isPitchGround } from './aerodrome';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmArea } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Stadium stands (leisure=stadium, an area on its level pad: aerodrome.ts PITCH_PAD). No tag says
 * where a stadium's stands are: along its long sides (most grounds have them there, the ends often
 * open), each a wedge of seating rising from the pitch side to the outline, a wall behind it down
 * to the ground and closed ends. Their depth grows with the stadium (DEPTH_SHARE of the square root
 * of its area, within DEPTH_M), their rake RAKE. Drawn by the tile holding the stadium's centre.
 */
export const STADIUM = {
  DEPTH_SHARE: 0.08,
  DEPTH_M: [3, 18] as const,
  /** the seating's rise per metre of depth (≈ 27°) */
  RAKE: 0.5,
  /** an edge is a long side within this angle of the stadium's long axis */
  SIDE_DEG: 30,
  /** no stand on an edge shorter than this */
  MIN_EDGE_M: 15,
  SINK_M: 0.5,
  SEATS: [150, 52, 46] as RGB,
  CONCRETE: [196, 192, 184] as RGB,
} as const;

export interface StadiumData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

/** the stands of the stadiums among `areas` (whole areas) whose centre `tile` holds */
export function buildStadiums(tile: Tile, areas: ReadonlyArray<OsmArea>, sampleHeight: HeightSampler): StadiumData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const verts: number[] = [];
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
  const seats = snowy(colourOf(STADIUM.SEATS)), concrete = snowy(colourOf(STADIUM.CONCRETE));

  for (const a of areas) {
    if (a.tags.leisure !== 'stadium' || !isPitchGround(a.tags)) continue;
    const ll = (a.rings[0] ?? []).slice();
    if (ll.length > 1 && ll[0][0] === ll[ll.length - 1][0] && ll[0][1] === ll[ll.length - 1][1]) ll.pop();
    if (ll.length < 3) continue;
    // its centre (the vertices' mean) in this tile
    const cl = ll.reduce((s, p) => [s[0] + p[0] / ll.length, s[1] + p[1] / ll.length], [0, 0]);
    if (!(cl[0] >= b.west && cl[0] < b.east && cl[1] > b.south && cl[1] <= b.north)) continue;
    const pts = ll.map(toXZ), n = pts.length;
    let area2 = 0;
    for (let i = 0; i < n; i++) area2 += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
    const area = Math.abs(area2) / 2;
    const depth = Math.max(STADIUM.DEPTH_M[0], Math.min(STADIUM.DEPTH_M[1], STADIUM.DEPTH_SHARE * Math.sqrt(area)));
    const rise = depth * STADIUM.RAKE;
    // the long axis: the principal direction of the outline's points
    const mx = pts.reduce((s, p) => s + p[0], 0) / n, mz = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, szz = 0, sxz = 0;
    for (const [x, z] of pts) { sxx += (x - mx) ** 2; szz += (z - mz) ** 2; sxz += (x - mx) * (z - mz); }
    const axis = 0.5 * Math.atan2(2 * sxz, sxx - szz), ax: XZ = [Math.cos(axis), Math.sin(axis)];
    const cosSide = Math.cos((STADIUM.SIDE_DEG * Math.PI) / 180);
    // inward: to the left of each edge when the ring turns that way in x, z
    const inSign = area2 > 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < STADIUM.MIN_EDGE_M) continue;
      const d: XZ = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      if (Math.abs(d[0] * ax[0] + d[1] * ax[1]) < cosSide) continue;
      const inw: XZ = [-d[1] * inSign, d[0] * inSign];
      // the stand's ends kept back from the corners by its depth (the next side's own stand, the open ends)
      const t0 = Math.min(depth, len / 4), t1 = len - t0;
      const at = (t: number, w: number, y: number): V3 => [p[0] + d[0] * t + inw[0] * w, y, p[1] + d[1] * t + inw[1] * w];
      const lla = ll[i], llb = ll[(i + 1) % n];
      const g = (t: number) => Math.max(0, sampleHeight(lla[0] + ((llb[0] - lla[0]) * t) / len, lla[1] + ((llb[1] - lla[1]) * t) / len));
      const g0 = g(t0), g1 = g(t1);
      const out: V3 = [-inw[0], 0, -inw[1]];
      // the seating, from the pitch side (inner, at the ground) up to the outline
      face([at(t0, depth, g0), at(t1, depth, g1), at(t1, 0, g1 + rise), at(t0, 0, g0 + rise)], [inw[0], 1, inw[1]], seats);
      // the wall behind it, down into the ground
      face([at(t0, 0, g0 - STADIUM.SINK_M), at(t1, 0, g1 - STADIUM.SINK_M), at(t1, 0, g1 + rise), at(t0, 0, g0 + rise)], out, concrete);
      // its ends
      for (const [t, gg, s] of [[t0, g0, -1], [t1, g1, 1]] as const) {
        face([at(t, depth, gg - STADIUM.SINK_M), at(t, 0, gg - STADIUM.SINK_M), at(t, 0, gg + rise), at(t, depth, gg)], [d[0] * s, 0, d[1] * s], concrete);
      }
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
