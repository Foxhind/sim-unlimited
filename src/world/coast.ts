/**
 * OSM coastline for the terrain TIN. In tiles whose OSM is loaded, natural=coastline decides what
 * is sea instead of the DEM alone: a coastal plain at −3…+2 m in Terrarium (14/9516/6395) lay
 * below the 0.5 m shoreline the DEM gives and flooded whole districts.
 *
 * OSM draws the coastline with the land on its left and the water on its right. Ways are used
 * whole (not clipped to the tile): the side of a point is that of the nearest coastline segment,
 * which may lie beyond the tile border.
 */
import type { LonLat, OsmLine } from './osm-types';
import type { Tile } from './geodesy';
import type { Pt } from './contours';

/** the natural=coastline ways among a tile's OSM lines, as given (whole ways) */
export function coastlineWays(lines: ReadonlyArray<OsmLine>): LonLat[][] {
  return lines.filter((l) => l.tags.natural === 'coastline' && l.points.length >= 2).map((l) => l.points);
}

/** a way in lattice coordinates of `tile` ([0, grid]², y down = south), repeated points dropped */
export function toLatticeLine(tile: Tile, grid: number, way: ReadonlyArray<LonLat>): Pt[] {
  const n = 2 ** tile.z;
  const out: Pt[] = [];
  for (const [lon, lat] of way) {
    const sinLat = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    const p = { x: (((lon + 180) / 360) * n - tile.x) * grid, y: (merc * n - tile.y) * grid };
    const q = out[out.length - 1];
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p);
  }
  return out;
}

const cross = (a: Pt, b: Pt, p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

/**
 * Sea test from coastline polylines in lattice coordinates. On the map the water is right of a
 * way (cross product < 0 with y north); the lattice y axis points south, which flips the sign, so
 * here the water lies where cross(a, b, p) > 0.
 *
 * At a shared vertex the nearest segment is ambiguous; there the turn of the line decides: where
 * the water side is the outer side of the bend it is the union of both segments' water sides,
 * otherwise their intersection. Undefined where the nearest point is a loose end of a way: the
 * coastline goes on somewhere not downloaded, and the side cannot be told.
 */
export function coastSeaTest(lines: ReadonlyArray<Pt[]>, near?: Pt): (p: Pt, dist?: { d: number }) => boolean | undefined {
  const water = (a: Pt, b: Pt, p: Pt) => cross(a, b, p) > 0;
  // every segment once, nearest to `near` (the tile) first: the best distance shrinks at once, and
  // the search stops where no farther segment can be nearer (ways run to 2000 nodes)
  const segs: Array<{ l: number; i: number; x0: number; y0: number; x1: number; y1: number; d: number }> = [];
  lines.forEach((l, li) => {
    for (let i = 0; i + 1 < l.length; i++) {
      const a = l[i], b = l[i + 1];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const d = near ? Math.hypot(Math.max(0, x0 - near.x, near.x - x1), Math.max(0, y0 - near.y, near.y - y1)) : 0;
      segs.push({ l: li, i, x0, y0, x1, y1, d });
    }
  });
  segs.sort((s1, s2) => s1.d - s2.d);
  // `dist`, when given, gets the distance from p to the nearest coastline (lattice cells)
  return (p, dist) => {
    let best = Infinity;
    let sea: boolean | undefined = false;
    // a segment is at least its box's distance from `near` minus p's own distance from `near` away
    const off = near ? Math.hypot(p.x - near.x, p.y - near.y) : 0;
    for (const s of segs) {
      if (near && s.d - off > 0 && (s.d - off) * (s.d - off) >= best) break;
      const bx = Math.max(0, s.x0 - p.x, p.x - s.x1), by = Math.max(0, s.y0 - p.y, p.y - s.y1);
      if (bx * bx + by * by >= best) continue;
      const l = lines[s.l], i = s.i, last = l.length - 1;
      const closed = l.length > 3 && l[0].x === l[last].x && l[0].y === l[last].y;
      const a = l[i], b = l[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const qx = a.x + dx * t - p.x, qy = a.y + dy * t - p.y;
      const d2 = qx * qx + qy * qy;
      if (d2 >= best) continue;
      best = d2;
      // nearest at a vertex shared with the neighbouring segment: decide by the bend there
      const atStart = t === 0 && (i > 0 || closed), atEnd = t === 1 && (i + 1 < last || closed);
      if ((t === 0 && !atStart) || (t === 1 && !atEnd)) {
        // nearest at a loose end of a way: its continuation was not downloaded (it does not touch
        // the tile), and extending the last segment would make a half-plane of sea behind it
        sea = undefined;
      } else if (atStart || atEnd) {
        const u = atStart ? l[i > 0 ? i - 1 : last - 1] : a;
        const v = atStart ? a : b;
        const w = atStart ? b : l[i + 2 <= last ? i + 2 : 1];
        const w1 = water(u, v, p), w2 = water(v, w, p);
        // the water side is outside the bend when the line turns towards the land
        const towardsLand = -cross(u, v, w) > 0;
        sea = towardsLand ? w1 || w2 : w1 && w2;
      } else {
        sea = water(a, b, p);
      }
    }
    if (dist) dist.d = Math.sqrt(best);
    return sea;
  };
}

/**
 * Coastline ways joined where one ends at the next one's start (OSM splits the coastline into
 * ways that share their end nodes). Inserted one by one into the TIN, the shared node of the
 * second would be dropped as already lying on a fixed edge, leaving a gap in the shore.
 */
export function joinLines(lines: ReadonlyArray<Pt[]>): Pt[][] {
  const key = (p: Pt) => `${p.x},${p.y}`;
  const pending = lines.map((l) => l.slice());
  const out: Pt[][] = [];
  while (pending.length) {
    let cur = pending.shift()!;
    for (let grew = true; grew; ) {
      grew = false;
      const closed = key(cur[0]) === key(cur[cur.length - 1]);
      if (closed) break;
      for (let i = 0; i < pending.length; i++) {
        const l = pending[i];
        if (key(l[0]) === key(cur[cur.length - 1])) cur = cur.concat(l.slice(1));
        else if (key(l[l.length - 1]) === key(cur[0])) cur = l.concat(cur.slice(1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(cur);
  }
  return out;
}
