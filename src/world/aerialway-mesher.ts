import { colourOf, RAMP, rampIndex, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import { pushPrism } from './mast-mesher';
import type { LonLat, OsmLine, OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Cable cars and chair lifts (aerialway=gondola | cable_car | chair_lift | mixed_lift), as the
 * Babadağ lifts above Ölüdeniz climb from 225 m to 1900 m. A line's ends are its stations (a
 * block the ropes run into); its inner vertices are pylons where a node aerialway=pylon stands on
 * them, bends of the line elsewhere (none mapped on the line: every inner vertex a pylon). A pylon
 * is a steel column with a crossbeam carrying the two ropes, one each way, GAUGE_M apart; the
 * ropes run between the supports with a sag, as 1 px GL lines (the power lines' conductors), and
 * the cabins or chairs hang from them every SPACING_M. Supports, stations and cabins are
 * building-mesh solids: a support or a station is drawn by the tile it stands in, a cabin by the
 * tile it hangs over, a piece of rope by the tile holding its middle.
 */
export const AERIALWAY = {
  /** a pylon's height without `height` on its node */
  PYLON_M: { gondola: 22, cable_car: 35, chair_lift: 12, mixed_lift: 16 } as Record<LiftKind, number>,
  /** the two ropes' distance apart */
  GAUGE_M: { gondola: 6, cable_car: 10, chair_lift: 4.5, mixed_lift: 6 } as Record<LiftKind, number>,
  /** a cabin or chair on each rope every this far along the line */
  SPACING_M: { gondola: 80, cable_car: 0, chair_lift: 16, mixed_lift: 30 } as Record<LiftKind, number>,
  /** the ropes leave a station this high over its ground */
  STATION_ROPE_M: 6,
  /** a station's block: along the line, beyond the gauge each side, high */
  STATION: { LENGTH_M: 16, SIDE_M: 3, HEIGHT_M: 8 },
  /** a span between supports sags this share of its length at its middle */
  SAG: 0.015,
  /** a rope is drawn in straight pieces at most this long */
  PIECE_M: 25,
  /** a pylon's column, its crossbeam and the sheave trains at the beam's ends */
  COLUMN_M: 1.1,
  BEAM_M: 0.6,
  SHEAVES_M: 4,
  /** a gondola's cabin (a cable car's the double), its hanger under the rope; a chair */
  CABIN: { W: 2, H: 2.4, HANGER_M: 2.6 },
  CHAIR: { W: 1.8, D: 0.6, H: 0.5, HANGER_M: 2.4 },
  STEEL: [120, 126, 134] as RGB,
  STATION_WALL: [214, 208, 196] as RGB,
  STATION_ROOF: [96, 98, 104] as RGB,
  CABIN_RGB: [206, 52, 44] as RGB,
  CHAIR_RGB: [44, 48, 56] as RGB,
} as const;

export type LiftKind = 'gondola' | 'cable_car' | 'chair_lift' | 'mixed_lift';

export function liftKind(tags: Record<string, string>): LiftKind | undefined {
  const a = tags.aerialway;
  return a === 'gondola' || a === 'cable_car' || a === 'chair_lift' || a === 'mixed_lift' ? a : undefined;
}

/** a ropes' colour: dark grey 1 px lines, as the conductors */
const ROPE_INDEX = rampIndex(RAMP.ASPHALT, 3);

export interface AerialwayData {
  /** supports, stations and cabins: pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** the ropes: GL line vertex pairs of x, y, z, palette index */
  ropes: Float32Array;
}

type V3 = [number, number, number];
type XZ = [number, number];

/**
 * The lifts among `lines` (the whole lines, not clipped), their pylons and stations by the nodes
 * among `points` (aerialway=pylon | station), as `tile` draws them
 */
export function buildAerialways(tile: Tile, lines: ReadonlyArray<OsmLine>, points: ReadonlyArray<OsmPoint>, sampleHeight: HeightSampler): AerialwayData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const verts: number[] = [];
  const ramps: number[] = [];
  const ropes: number[] = [];
  const toXZ = ([lon, lat]: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  /** back to lon/lat, for the ground and the tile's share: linear about the tile (it is small) */
  const toLL = (x: number, z: number, a: LonLat, pa: XZ, c: LonLat, pc: XZ): LonLat => {
    const len2 = (pc[0] - pa[0]) ** 2 + (pc[1] - pa[1]) ** 2 || 1;
    const t = ((x - pa[0]) * (pc[0] - pa[0]) + (z - pa[1]) * (pc[1] - pa[1])) / len2;
    return [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
  };
  const ground = ([lon, lat]: LonLat) => Math.max(0, sampleHeight(lon, lat));
  const pylonAt = new Map<string, OsmPoint>();
  for (const p of points) if (p.tags.aerialway === 'pylon') pylonAt.set(`${p.at[0]},${p.at[1]}`, p);
  const steel = colourOf(AERIALWAY.STEEL);

  /** a closed box: centre of its foot `c`, `along` a unit x, z direction, its sizes along, across, up */
  const box = (c: V3, along: XZ, l: number, w: number, h: number, ramp: number, roof = ramp): void => {
    const [ax, az] = along, cx = -az, cz = ax;
    const P = (u: number, v: number, y: number): V3 => [c[0] + ax * u * l / 2 + cx * v * w / 2, c[1] + y, c[2] + az * u * l / 2 + cz * v * w / 2];
    const face = (p: V3[], n: V3, r: number) => {
      for (const k of [0, 1, 2, 0, 2, 3]) verts.push(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2]);
      for (let k = 0; k < 6; k++) ramps.push(r);
    };
    // counter-clockwise seen from outside
    face([P(-1, -1, h), P(-1, 1, h), P(1, 1, h), P(1, -1, h)], [0, 1, 0], roof);
    face([P(-1, -1, 0), P(1, -1, 0), P(1, 1, 0), P(-1, 1, 0)], [0, -1, 0], ramp);
    face([P(1, -1, 0), P(1, -1, h), P(1, 1, h), P(1, 1, 0)], [ax, 0, az], ramp);
    face([P(-1, 1, 0), P(-1, 1, h), P(-1, -1, h), P(-1, -1, 0)], [-ax, 0, -az], ramp);
    face([P(1, 1, 0), P(1, 1, h), P(-1, 1, h), P(-1, 1, 0)], [cx, 0, cz], ramp);
    face([P(-1, -1, 0), P(-1, -1, h), P(1, -1, h), P(1, -1, 0)], [-cx, 0, -cz], ramp);
  };

  for (const l of lines) {
    const kind = liftKind(l.tags);
    if (!kind || l.points.length < 2) continue;
    const pts = l.points.map(toXZ);
    const n = pts.length;
    const gauge = AERIALWAY.GAUGE_M[kind];
    // along the line: each vertex's distance from the start, each segment's direction
    const dist = [0];
    for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const dir = (i: number): XZ => {
      const a = pts[Math.min(i, n - 2)], c = pts[Math.min(i, n - 2) + 1], len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      return [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
    };
    // the supports: the ends, and the inner vertices with a pylon (every one when the line has none mapped)
    const mapped = l.points.slice(1, -1).some((p) => pylonAt.has(`${p[0]},${p[1]}`));
    const supports = [0];
    for (let i = 1; i < n - 1; i++) if (!mapped || pylonAt.has(`${l.points[i][0]},${l.points[i][1]}`)) supports.push(i);
    supports.push(n - 1);
    /** the ropes' height over each support */
    const ropeY = supports.map((i) => {
      const g = ground(l.points[i]);
      if (i === 0 || i === n - 1) return g + AERIALWAY.STATION_ROPE_M;
      const h = parseLength(pylonAt.get(`${l.points[i][0]},${l.points[i][1]}`)?.tags.height);
      return g + (h !== undefined && h > 3 && h < 150 ? h : AERIALWAY.PYLON_M[kind]) - 0.5;
    });
    /** the point on the line `d` metres from its start, the segment it lies on */
    const at = (d: number): { p: XZ; seg: number } => {
      let s = 0;
      while (s < n - 2 && dist[s + 1] < d) s++;
      const t = (d - dist[s]) / ((dist[s + 1] - dist[s]) || 1);
      return { p: [pts[s][0] + (pts[s + 1][0] - pts[s][0]) * t, pts[s][1] + (pts[s + 1][1] - pts[s][1]) * t], seg: s };
    };
    /** the rope's height `d` metres along: straight between its supports, sagging */
    const ropeAt = (d: number): number => {
      let k = 0;
      while (k < supports.length - 2 && dist[supports[k + 1]] < d) k++;
      const d0 = dist[supports[k]], d1 = dist[supports[k + 1]], span = d1 - d0 || 1;
      const t = Math.min(1, Math.max(0, (d - d0) / span));
      return ropeY[k] + (ropeY[k + 1] - ropeY[k]) * t - 4 * AERIALWAY.SAG * span * t * (1 - t);
    };
    const llOf = (p: XZ, seg: number): LonLat => toLL(p[0], p[1], l.points[seg], pts[seg], l.points[seg + 1], pts[seg + 1]);

    // the ropes, one each side, in pieces: the tile holding a piece's middle draws it
    const total = dist[n - 1];
    const cuts = new Set<number>(dist);
    for (let d = 0; d < total; d += AERIALWAY.PIECE_M) cuts.add(d);
    const ds = [...cuts].sort((x, y) => x - y);
    for (const side of [-1, 1]) {
      for (let k = 0; k + 1 < ds.length; k++) {
        const mid = at((ds[k] + ds[k + 1]) / 2);
        if (!owns(llOf(mid.p, mid.seg))) continue;
        // both ends offset square to the piece's own segment (a bend's two pieces meet at its vertex)
        const [dx, dz] = dir(mid.seg);
        const end = (d: number): V3 => {
          const t = (d - dist[mid.seg]) / ((dist[mid.seg + 1] - dist[mid.seg]) || 1);
          const p: XZ = [pts[mid.seg][0] + (pts[mid.seg + 1][0] - pts[mid.seg][0]) * t, pts[mid.seg][1] + (pts[mid.seg + 1][1] - pts[mid.seg][1]) * t];
          return [p[0] - dz * side * gauge / 2, ropeAt(d), p[1] + dx * side * gauge / 2];
        };
        const a = end(ds[k]), c = end(ds[k + 1]);
        ropes.push(a[0], a[1], a[2], ROPE_INDEX, c[0], c[1], c[2], ROPE_INDEX);
      }
    }

    // the supports standing in this tile
    supports.forEach((i, k) => {
      if (!owns(l.points[i])) return;
      const [x, z] = pts[i], g = ground(l.points[i]);
      // along the line there: the bisector at a pylon on a bend
      const d0 = dir(Math.max(0, i - 1)), d1 = dir(i);
      let [tx, tz] = i === 0 ? d1 : i === n - 1 ? d0 : [d0[0] + d1[0], d0[1] + d1[1]];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      if (i === 0 || i === n - 1) {
        const S = AERIALWAY.STATION;
        box([x, g - 1, z], [tx, tz], S.LENGTH_M, gauge + 2 * S.SIDE_M, S.HEIGHT_M + 1, colourOf(AERIALWAY.STATION_WALL), colourOf(AERIALWAY.STATION_ROOF));
        return;
      }
      const top = ropeY[k] + 0.5;
      pushPrism(verts, ramps, steel, [x, g - 1, z], [x, top + 0.3, z], AERIALWAY.COLUMN_M);
      // the crossbeam square to the line, the sheave trains along it under each rope
      const cx = -tz, cz = tx, half = gauge / 2 + 0.5;
      pushPrism(verts, ramps, steel, [x - cx * half, top, z - cz * half], [x + cx * half, top, z + cz * half], AERIALWAY.BEAM_M);
      for (const side of [-1, 1]) {
        const sx = x + cx * side * gauge / 2, sz = z + cz * side * gauge / 2, s = AERIALWAY.SHEAVES_M / 2;
        pushPrism(verts, ramps, steel, [sx - tx * s, top - 0.4, sz - tz * s], [sx + tx * s, top - 0.4, sz + tz * s], 0.35);
      }
    });

    // the cabins or chairs, every SPACING_M on each rope (a cable car's two at a third of the way, one each side)
    const spacing = AERIALWAY.SPACING_M[kind];
    const marks: [number, number][] = [];
    if (spacing > 0) {
      for (const side of [-1, 1]) {
        // the two ropes' cabins out of step by half the spacing, none inside a station
        for (let d = spacing * (side > 0 ? 0.5 : 1); d < total - AERIALWAY.STATION.LENGTH_M / 2; d += spacing) {
          if (d > AERIALWAY.STATION.LENGTH_M / 2) marks.push([d, side]);
        }
      }
    } else {
      marks.push([total / 3, -1], [(2 * total) / 3, 1]);
    }
    const chair = kind === 'chair_lift';
    for (const [d, side] of marks) {
      const s = at(d);
      if (!owns(llOf(s.p, s.seg))) continue;
      const [dx, dz] = dir(s.seg);
      const x = s.p[0] - dz * side * gauge / 2, z = s.p[1] + dx * side * gauge / 2, y = ropeAt(d);
      if (chair) {
        const C = AERIALWAY.CHAIR;
        pushPrism(verts, ramps, steel, [x, y, z], [x, y - C.HANGER_M, z], 0.08);
        box([x, y - C.HANGER_M - C.H, z], [-dz, dx], C.W, C.D, C.H, colourOf(AERIALWAY.CHAIR_RGB));
      } else {
        const C = AERIALWAY.CABIN, k = kind === 'cable_car' ? 2 : 1;
        pushPrism(verts, ramps, steel, [x, y, z], [x, y - C.HANGER_M, z], 0.12);
        box([x, y - C.HANGER_M - C.H * k, z], [dx, dz], C.W * k, C.W * k, C.H * k, colourOf(AERIALWAY.CABIN_RGB), colourOf(AERIALWAY.STEEL));
      }
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps), ropes: new Float32Array(ropes) };
}
