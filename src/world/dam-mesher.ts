import { colourOf, snowy, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmLine } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Dams and weirs mapped as lines across a valley or a river (waterway=dam | weir). A dam is an
 * embankment: its crest level along the whole line, OVER_M over the highest ground under it, its
 * faces sloping SLOPE out on both sides down to the ground; a weir a low concrete sill, its top
 * OVER_M over the ground under it. A piece of either is drawn by the tile holding its middle.
 */
export const DAM = {
  dam: { CREST_M: 5, OVER_M: 1, SLOPE: 2 },
  weir: { CREST_M: 1.5, OVER_M: 0.6, SLOPE: 0 },
  /** the ground is read along the line this often, metres */
  STEP_M: 4,
  SINK_M: 0.5,
  CREST_RGB: [170, 166, 156] as RGB,
  EARTH_RGB: [138, 132, 108] as RGB,
  CONCRETE_RGB: [184, 180, 172] as RGB,
} as const;

export type DamKind = 'dam' | 'weir';

export function damKind(tags: Record<string, string>): DamKind | undefined {
  return tags.waterway === 'dam' || tags.waterway === 'weir' ? tags.waterway : undefined;
}

export interface DamData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

/** the dams and weirs among `lines` (whole lines), the pieces whose middle `tile` holds */
export function buildDams(tile: Tile, lines: ReadonlyArray<OsmLine>, sampleHeight: HeightSampler): DamData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
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
  const crestRamp = snowy(colourOf(DAM.CREST_RGB)), earth = snowy(colourOf(DAM.EARTH_RGB)), concrete = snowy(colourOf(DAM.CONCRETE_RGB));

  for (const l of lines) {
    const kind = damKind(l.tags);
    if (!kind || l.points.length < 2) continue;
    const K = DAM[kind];
    const half = (parseLength(l.tags.width) ?? K.CREST_M) / 2;
    // stations along the line every STEP_M (and at its vertices), with the ground under each
    const st: { p: XZ; ll: LonLat; g: number; d: XZ }[] = [];
    for (let i = 0; i + 1 < l.points.length; i++) {
      const a = l.points[i], c = l.points[i + 1], pa = toXZ(a), pc = toXZ(c);
      const len = Math.hypot(pc[0] - pa[0], pc[1] - pa[1]);
      if (len < 1e-3) continue;
      const d: XZ = [(pc[0] - pa[0]) / len, (pc[1] - pa[1]) / len];
      const steps = Math.max(1, Math.ceil(len / DAM.STEP_M));
      for (let k = st.length && i > 0 ? 1 : 0; k <= steps; k++) {
        const t = k / steps, ll: LonLat = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
        st.push({ p: [pa[0] + (pc[0] - pa[0]) * t, pa[1] + (pc[1] - pa[1]) * t], ll, g: Math.max(0, sampleHeight(ll[0], ll[1])), d });
      }
    }
    if (st.length < 2) continue;
    // a dam's crest level along it, a weir's over the ground under each point
    const level = Math.max(...st.map((s) => s.g)) + K.OVER_M;
    const top = (s: { g: number }) => (kind === 'dam' ? level : s.g + K.OVER_M);
    const P = (s: { p: XZ; d: XZ }, u: number, y: number): V3 => [s.p[0] - s.d[1] * u, y, s.p[1] + s.d[0] * u];
    const toe = (s: { g: number }) => half + K.SLOPE * Math.max(0, top(s) - s.g);
    for (let k = 0; k + 1 < st.length; k++) {
      const a = st[k], c = st[k + 1];
      if (!owns([(a.ll[0] + c.ll[0]) / 2, (a.ll[1] + c.ll[1]) / 2])) continue;
      const ya = top(a), yc = top(c);
      face([P(a, -half, ya), P(c, -half, yc), P(c, half, yc), P(a, half, ya)], [0, 1, 0], crestRamp);
      for (const side of [-1, 1]) {
        const out: V3 = [-a.d[1] * side, K.SLOPE ? 1 : 0, a.d[0] * side];
        face([P(a, side * half, ya), P(c, side * half, yc), P(c, side * toe(c), c.g - DAM.SINK_M), P(a, side * toe(a), a.g - DAM.SINK_M)], out, kind === 'dam' ? earth : concrete);
      }
    }
    // its ends, where the line ends in this tile's share
    for (const [s, dir] of [[st[0], -1], [st[st.length - 1], 1]] as const) {
      if (!owns(s.ll)) continue;
      const y = top(s), out: V3 = [s.d[0] * dir, 0, s.d[1] * dir];
      face([P(s, -toe(s), s.g - DAM.SINK_M), P(s, -half, y), P(s, half, y), P(s, toe(s), s.g - DAM.SINK_M)], out, kind === 'dam' ? earth : concrete);
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
