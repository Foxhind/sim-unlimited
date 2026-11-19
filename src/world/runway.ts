import { enuToLatLon, latLonToEnu, type LatLon } from './geodesy';
import type { OsmLine } from './osm-types';

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
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
