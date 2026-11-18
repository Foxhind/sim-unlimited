import { enuToLatLon, gridLatLon, latLonToEnu, tileCenter, type LatLon, type Tile } from './geodesy';
import type { OsmLine } from './osm-types';
import { parseLength } from './building-mesher';

const BLEND_M = 35;

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export interface RunwayPlane {
  /** centerline in tile-local ENU (x, z) */
  pts: [number, number][];
  half: number;
  plane: number;
  /** distance from each (grid+1)^2 lattice vertex to the centerline */
  dist: Float64Array;
}

/**
 * Q40: one shared plane per runway, averaged along the centerline so it exists
 * even when the coarse terrain lattice has no vertex inside the narrow core.
 */
export function computeRunwayPlanes(
  tile: Tile,
  grid: number,
  lines: OsmLine[],
  sample: (lon: number, lat: number) => number,
): RunwayPlane[] {
  const runways = lines.filter((l) => l.tags.aeroway === 'runway' && l.points.length >= 2);
  if (!runways.length) return [];
  const center = tileCenter(tile);
  const side = grid + 1;
  const vx = new Float64Array(side * side);
  const vz = new Float64Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const ll = gridLatLon(tile, i, j, grid);
      const [e, n] = latLonToEnu(center, ll.lat, ll.lon, 0);
      vx[j * side + i] = e;
      vz[j * side + i] = -n;
    }
  }
  const planes: RunwayPlane[] = [];
  for (const rw of runways) {
    const pts = rw.points.map(([lon, lat]) => {
      const [e, n] = latLonToEnu(center, lat, lon, 0);
      return [e, -n] as [number, number];
    });
    const half = (parseLength(rw.tags.width) ?? 45) / 2;
    let sum = 0;
    let count = 0;
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s];
      const [bx, bz] = pts[s + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 25));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const ll = enuToLatLon(center, ax + (bx - ax) * t, -(az + (bz - az) * t), 0);
        sum += sample(ll.lon, ll.lat);
        count++;
      }
    }
    const dist = new Float64Array(side * side);
    for (let k = 0; k < side * side; k++) {
      let d = Infinity;
      for (let s = 0; s < pts.length - 1; s++) {
        d = Math.min(d, distToSegment(vx[k], vz[k], pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
      }
      dist[k] = d;
    }
    planes.push({ pts, half, plane: sum / count, dist });
  }
  return planes;
}

/** Flatten DEM lattice vertices under runway ribbons, blending into natural relief. */
export function flattenRunways(
  heights: Float32Array,
  tile: Tile,
  grid: number,
  lines: OsmLine[],
  sample: (lon: number, lat: number) => number,
): boolean {
  const side = grid + 1;
  const planes = computeRunwayPlanes(tile, grid, lines, sample);
  for (const p of planes) {
    for (let k = 0; k < side * side; k++) {
      const d = p.dist[k];
      if (d <= p.half) heights[k] = p.plane;
      else if (d <= p.half + BLEND_M) {
        const t = 1 - (d - p.half) / BLEND_M;
        heights[k] = heights[k] * (1 - t) + p.plane * t;
      }
    }
  }
  return planes.length > 0;
}
const UNPAVED = /^(grass|dirt|earth|ground|gravel|sand|unpaved|compacted|fine_gravel|mud|snow|ice)$/;
/** an unpaved strip counts as this much farther away, so a click near an airport picks its paved runway */
const UNPAVED_PENALTY_M = 2000;

export interface RunwayStart {
  lat: number;
  lon: number;
  /** true heading along the runway, degrees */
  hdg: number;
}

/**
 * Takeoff position on the OSM runway nearest `at` (within `maxDist` m): `inset` m in from the runway
 * end nearer `at`, facing down the runway towards its other end. Null when no runway is that close.
 */
export function runwayStart(lines: OsmLine[], at: LatLon, maxDist = 4000, inset = 60): RunwayStart | null {
  let best: { pts: [number, number][]; score: number } | null = null;
  for (const l of lines) {
    if (l.tags.aeroway !== 'runway' || l.points.length < 2) continue;
    const pts = l.points.map(([lon, lat]) => {
      const [e, n] = latLonToEnu(at, lat, lon, 0);
      return [e, n] as [number, number];
    });
    const [ax, ay] = pts[0];
    const [bx, by] = pts[pts.length - 1];
    if (Math.hypot(bx - ax, by - ay) < 100) continue; // a closed outline or a stub, not a centreline
    let d = Infinity;
    for (let s = 0; s < pts.length - 1; s++) d = Math.min(d, distToSegment(0, 0, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
    if (d > maxDist) continue;
    const score = d + (UNPAVED.test(l.tags.surface ?? '') ? UNPAVED_PENALTY_M : 0);
    if (!best || score < best.score) best = { pts, score };
  }
  if (!best) return null;
  const { pts } = best;
  const first = pts[0], last = pts[pts.length - 1];
  const [from, to] = Math.hypot(...first) <= Math.hypot(...last) ? [first, last] : [last, first];
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const k = Math.min(inset, len / 4) / len;
  const ll = enuToLatLon(at, from[0] + dx * k, from[1] + dy * k, 0);
  return { lat: ll.lat, lon: ll.lon, hdg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
}
