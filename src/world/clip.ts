/**
 * Clip OSM geometry to its tile. Overpass and the OSM API both return whole ways for any way
 * touching the bbox, but a tile's drape only knows its own terrain: outside the tile the height
 * sampler clamps to the border, so the overhang would float above (or sink into) the neighbour's
 * relief, and the neighbour draws the same road again on its own terrain. Each tile therefore
 * keeps only what lies inside it; the neighbour draws the rest.
 */
import { tileBounds, type Tile, type TileBounds } from './geodesy';
import type { LonLat, OsmTileData } from './osm-types';

/** pieces of a polyline inside the box (Liang–Barsky per segment); touching runs are joined */
export function clipPolyline(points: LonLat[], b: TileBounds): LonLat[][] {
  const out: LonLat[][] = [];
  let run: LonLat[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1;
    let inside = true;
    for (const [p, q] of [[-dx, x0 - b.west], [dx, b.east - x0], [-dy, y0 - b.south], [dy, b.north - y0]]) {
      if (p === 0) {
        if (q < 0) inside = false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (!inside || t0 > t1) {
      flush();
      continue;
    }
    const a: LonLat = t0 === 0 ? points[i] : [x0 + dx * t0, y0 + dy * t0];
    const c: LonLat = t1 === 1 ? points[i + 1] : [x0 + dx * t1, y0 + dy * t1];
    if (t0 > 0) flush(); // entered from outside
    if (!run.length) run.push(a);
    run.push(c);
    if (t1 < 1) flush(); // left the box
  }
  flush();
  return out;
}

/** a ring clipped to the box (Sutherland–Hodgman; the box is convex), closed; [] when nothing is left */
export function clipRing(ring: LonLat[], b: TileBounds): LonLat[] {
  let pts = ring;
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
  const edges: Array<[(p: LonLat) => number]> = [
    [(p) => p[0] - b.west],
    [(p) => b.east - p[0]],
    [(p) => p[1] - b.south],
    [(p) => b.north - p[1]],
  ];
  for (const [dist] of edges) {
    if (pts.length < 3) return [];
    const next: LonLat[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dp = dist(p), dq = dist(q);
      if (dp >= 0) next.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    pts = next;
  }
  if (pts.length < 3) return [];
  return [...pts, pts[0]];
}

/** the tile's share of its OSM data: lines and areas cut at the border, buildings and points by position */
export function clipTileData(data: OsmTileData, tile: Tile): OsmTileData {
  const b = tileBounds(tile);
  // half-open on east/south so a point on a shared border belongs to exactly one tile
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const areas: OsmTileData['areas'] = [];
  for (const a of data.areas) {
    const outer = clipRing(a.rings[0] ?? [], b);
    if (!outer.length) continue;
    const holes = a.rings.slice(1).map((r) => clipRing(r, b)).filter((r) => r.length);
    areas.push({ rings: [outer, ...holes], tags: a.tags });
  }
  return {
    areas,
    lines: data.lines.flatMap((l) => clipPolyline(l.points, b).map((points) => ({ points, tags: l.tags }))),
    points: data.points.filter((p) => owns(p.at)),
    buildings: data.buildings.filter((bd) => {
      const ring = bd.rings[0];
      if (!ring?.length) return false;
      let lon = 0, lat = 0;
      for (const p of ring) { lon += p[0]; lat += p[1]; }
      return owns([lon / ring.length, lat / ring.length]);
    }),
  };
}
