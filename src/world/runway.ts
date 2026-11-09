import { gridLatLon, latLonToEnu, tileCenter, type Tile } from './geodesy';
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

/**
 * Q40: flatten DEM lattice vertices under aeroway=runway ribbons to a plane
 * (mean DEM height of the core strip), blending into the natural relief at the
 * edges. Mutates heights; returns true when at least one runway was applied.
 */
export function flattenRunways(heights: Float32Array, tile: Tile, grid: number, lines: OsmLine[]): boolean {
  const runways = lines.filter((l) => l.tags.aeroway === 'runway' && l.points.length >= 2);
  if (!runways.length) return false;
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
  let applied = false;
  for (const rw of runways) {
    const pts = rw.points.map(([lon, lat]) => {
      const [e, n] = latLonToEnu(center, lat, lon, 0);
      return [e, -n] as [number, number];
    });
    const half = (parseLength(rw.tags.width) ?? 45) / 2;
    const dist = new Float64Array(side * side);
    let coreSum = 0;
    let coreCount = 0;
    let edgeSum = 0;
    let edgeCount = 0;
    for (let k = 0; k < side * side; k++) {
      let d = Infinity;
      for (let s = 0; s < pts.length - 1; s++) {
        d = Math.min(d, distToSegment(vx[k], vz[k], pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
      }
      dist[k] = d;
      if (d <= half) {
        coreSum += heights[k];
        coreCount++;
      } else if (d <= half + BLEND_M) {
        edgeSum += heights[k];
        edgeCount++;
      }
    }
    if (!coreCount && !edgeCount) continue;
    const plane = coreCount ? coreSum / coreCount : edgeSum / edgeCount;
    for (let k = 0; k < side * side; k++) {
      const d = dist[k];
      if (d <= half) heights[k] = plane;
      else if (d <= half + BLEND_M) {
        const t = 1 - (d - half) / BLEND_M;
        heights[k] = heights[k] * (1 - t) + plane * t;
      }
    }
    applied = true;
  }
  return applied;
}