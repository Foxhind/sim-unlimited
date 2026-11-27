import { colourOf, type RGB } from '../engine/palette';
import { SolidMesh } from './crane-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmArea } from './osm-types';
import type { HeightSampler } from './terrain-source';
import { dockKind } from './way-styles';

/**
 * Docks (waterway=dock): a wet or tidal one is water (way-styles classifyArea); a dry dock is a
 * concrete basin, its floor tinted, its coping walls along its edge and a row of keel blocks down its
 * middle; a floating dock (dock=floating) a pontoon on the water, its wing walls along both long
 * sides. A dock's long axis is its outline's longest edge's; a dock is drawn by the tile holding its
 * vertex mean.
 */
export const DOCK = {
  /** a dry dock's coping: its width, height over the ground and depth into it */
  COPING_W: 1.2, COPING_H: 0.6, COPING_SINK: 0.5,
  /** its keel blocks: size, spacing, the share of the length they cover */
  BLOCK_M: [1.4, 1.2, 1.4] as [number, number, number], BLOCK_EVERY_M: 6, BLOCK_SHARE: 0.85,
  /** a floating dock: its deck over the water, its wing walls' width and height (shares of its beam, within bounds) */
  DECK_M: 1.5, HULL_SINK_M: 1,
  WING_SHARE: 0.12, WING_W: [2.5, 6] as [number, number],
  WING_H_SHARE: 0.35, WING_H: [7, 15] as [number, number],
  CONCRETE: [168, 164, 156] as RGB,
  KEEL: [86, 74, 62] as RGB,
  HULL: [112, 54, 44] as RGB,
  WING: [98, 104, 110] as RGB,
} as const;


export interface DockData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
}

type XZ = [number, number];

/** a ring's long axis (its longest edge's direction) and its extents along it and across, about its vertex mean */
export function dockFrame(ring: XZ[]): { c: XZ; u: XZ; v: XZ; u0: number; u1: number; v0: number; v1: number } {
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i][0]; cz += ring[i][1]; }
  const c: XZ = [cx / n, cz / n];
  let best = 0, u: XZ = [1, 0];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
  }
  const v: XZ = [-u[1], u[0]];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = ring[i][0] - c[0], dz = ring[i][1] - c[1];
    const pu = dx * u[0] + dz * u[1], pv = dx * v[0] + dz * v[1];
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
  }
  return { c, u, v, u0, u1, v0, v1 };
}

/** the dry and floating docks among `areas` whose vertex mean `tile` holds */
export function buildDocks(tile: Tile, areas: ReadonlyArray<OsmArea>, sampleHeight: HeightSampler): DockData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const toXZ = ([lon, lat]: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const m = new SolidMesh();
  const D = DOCK;
  const concrete = colourOf(D.CONCRETE), keel = colourOf(D.KEEL), hull = colourOf(D.HULL), wing = colourOf(D.WING);
  for (const a of areas) {
    const kind = dockKind(a.tags);
    if (kind !== 'dry' && kind !== 'floating') continue;
    const outer = a.rings[0];
    if (!outer || outer.length < 4) continue;
    const n = outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1] ? outer.length - 1 : outer.length;
    let lon = 0, lat = 0;
    for (let i = 0; i < n; i++) { lon += outer[i][0]; lat += outer[i][1]; }
    const mid: LonLat = [lon / n, lat / n];
    if (!owns(mid)) continue;
    const ring = outer.map(toXZ);
    const f = dockFrame(ring);
    const P = (pu: number, pv: number): XZ => [f.c[0] + f.u[0] * pu + f.v[0] * pv, f.c[1] + f.u[1] * pu + f.v[1] * pv];
    if (kind === 'dry') {
      // the coping along every edge, just inside it, on the ground under its middle
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (l < 0.5) continue;
        const ll: LonLat = [(outer[i][0] + outer[(i + 1) % n][0]) / 2, (outer[i][1] + outer[(i + 1) % n][1]) / 2];
        const g = sampleHeight(ll[0], ll[1]);
        m.block((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, q[0] - p[0], q[1] - p[1], l + D.COPING_W, D.COPING_W, g - D.COPING_SINK, g + D.COPING_H, concrete);
      }
      // the keel blocks down the middle
      const len = (f.u1 - f.u0) * D.BLOCK_SHARE;
      const count = Math.max(1, Math.floor(len / D.BLOCK_EVERY_M));
      const um = (f.u0 + f.u1) / 2, vm = (f.v0 + f.v1) / 2;
      const g = sampleHeight(mid[0], mid[1]);
      for (let k = 0; k < count; k++) {
        const pu = um - len / 2 + (len * (k + 0.5)) / count;
        const [x, z] = P(pu, vm);
        m.block(x, z, f.u[0], f.u[1], D.BLOCK_M[0], D.BLOCK_M[2], g - 0.2, g + D.BLOCK_M[1], keel);
      }
      continue;
    }
    // a floating dock on the water (sea level, or the water's surface under it)
    const g = Math.max(0, sampleHeight(mid[0], mid[1]));
    const beam = f.v1 - f.v0, length = f.u1 - f.u0;
    const um = (f.u0 + f.u1) / 2, vm = (f.v0 + f.v1) / 2;
    const [cx, cz] = P(um, vm);
    m.block(cx, cz, f.u[0], f.u[1], length, beam, g - D.HULL_SINK_M, g + D.DECK_M, hull);
    const ww = Math.max(D.WING_W[0], Math.min(D.WING_W[1], beam * D.WING_SHARE));
    const wh = Math.max(D.WING_H[0], Math.min(D.WING_H[1], beam * D.WING_H_SHARE));
    for (const side of [f.v0 + ww / 2, f.v1 - ww / 2]) {
      const [x, z] = P(um, side);
      m.block(x, z, f.u[0], f.u[1], length, ww, g + D.DECK_M, g + D.DECK_M + wh, wing);
    }
  }
  return { vertices: new Float32Array(m.verts), ramps: new Uint32Array(m.ramps) };
}
