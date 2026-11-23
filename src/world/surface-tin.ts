/**
 * The surface of a tile built under its roads (roads first, then the land): the base belt TIN with
 * the roads' bed outlines and the edges of every ground cover (ground-cover.ts) as fixed edges and
 * the lattice nodes of the roads' pull bands as vertices, every vertex's height then replaced by the
 * pulled ground (road-pull.ts); each face then takes the cover under its centre. One function for
 * every builder of a tile's surface: the terrain mesh, the OSM drape and the collision ground.
 */
import type { Pad } from './aerodrome';
import type { Pt } from './contours';
import { EARTH_R, tileCenter, tileSizeMeters, type Tile } from './geodesy';
import { COVER_RANK, type CoverKind, type GroundCover } from './ground-cover';
import type { OsmArea, OsmLine } from './osm-types';
import type { P2 } from './ribbon-shapes';
import { fetchRoadDem, roadWindow, solveRoadHeights } from './road-heights';
import { buildRoadLevels } from './road-levels';
import { buildRoadNet, type RoadNet } from './road-net';
import { buildRoadPull, snapBorder, type RoadSurface } from './road-pull';
import { buildTerrainTin, type SurfacePlan, type TerrainTin, type TinOptions } from './terrain-tin';
import { classifyLine, roadPriority, tieBreak } from './way-styles';

export type { RoadSurface } from './road-pull';

/**
 * the most vertices a tile's surface may have: over it the youngest covers' edges go first, a park
 * before a road, and a road's or a river's bed outline with it
 */
export const MAX_SURFACE_VERTS = 30000;
/** the base relief's fixed edges get a vertex this often where they run through a pull band, metres */
const BAND_EDGE_STEP_M = 12;
/** at most this many band points a tile (about the lattice nodes it had: 65²) */
const MAX_BAND_POINTS = 4500;
/** the zoom with the roads (chunks.ts DETAIL_Z) */
const ROADS_Z = 14;
/** the covers drawn along a way: dropped from the surface, the way's ribbon lies over it (SurfaceTin.loose) */
const RIBBON_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(['runway', 'ballast', 'carriageway', 'shoulder', 'path', 'railZone']);

export interface SurfaceOptions extends TinOptions {
  roads?: RoadSurface;
  /** the tile's ground covers: every edge of them a fixed edge while the vertices last, each face its cover */
  cover?: GroundCover;
}

export interface SurfaceTin extends TerrainTin {
  /** ways whose edges the vertex budget left out (roads, paths, railways, runways): their ribbons lie on the ground as ever */
  loose?: Set<OsmLine>;
  /**
   * With `cover`: per face, the index of its cover in `cover.shapes` (the senior shape under its
   * centre, a dropped ribbon passed over), or −1 (the bare ground)
   */
  cover?: Int32Array;
}

/**
 * What goes into the surface or out of it together: a way's or an area's covers with the bed
 * outline of its way of the network (a pitch with its paint), or a bed alone
 */
interface Unit {
  /** its fixed lines (lattice, inside the tile) and their vertices */
  lines: Pt[][];
  count: number;
  /** its shapes (indices into cover.shapes) */
  shapes: number[];
  /** the way it is drawn along when it is left out: a ribbon kind's source or a bed's way */
  way?: OsmLine;
  /** its place: COVER_RANK, roadPriority, tieBreak of its senior shape (ground-cover.ts), then that shape's index */
  rank: number;
  prio: number;
  tie: number;
  first: number;
}

/**
 * A detailed (z14) tile's relief follows its lattice within this many metres, and its border line
 * too: its roads and rivers lie on the true relief (raw DEM), and a coarser one let them show
 * through it in trenches 10–16 m deep (14/9515/6394, where the belts left four vertices)
 */
export const Z14_RELIEF_TOL_M = 5;

export function buildSurfaceTin(tile: Tile, grid: number, heights: Float32Array, opts: SurfaceOptions = {}): SurfaceTin {
  const { roads, cover, ...given } = opts;
  const tinOpts: TinOptions = tile.z === ROADS_Z ? { borderTol: Z14_RELIEF_TOL_M, reliefTol: Z14_RELIEF_TOL_M, ...given } : given;
  const pull = roads && roads.net.ways.length ? buildRoadPull(tile, grid, roads) : undefined;
  if (!pull && !cover) return buildTerrainTin(tile, grid, heights, tinOpts);
  // where the covers' edges cross the tile border, whether kept or not: the neighbour has them too
  const coverBorder: Pt[] = [];
  const units = cover ? coverUnits(cover, grid, coverBorder, pull?.beds ?? [], roads?.net) : bedUnits(pull!.beds, roads!.net);
  let picked = 0;
  const tin = buildTerrainTin(tile, grid, heights, {
    ...tinOpts,
    // planned on the relief once it is built (one relief build, however many surface builds)
    surface: (relief): SurfacePlan => {
      const points: Pt[] = [];
      if (pull) {
        // the fall from a road to the relief: points on rows along the roads in their bands (not the
        // lattice: that made the bands square), and on the border the lattice nodes the roads pull
        // (the neighbour has the same) and where the outlines and rows cross it
        points.push(...pull.bandPoints(MAX_BAND_POINTS));
        for (let k = 0; k <= grid; k++) {
          for (const [i, j] of [[k, 0], [k, grid], [0, k], [grid, k]]) if (pull.weight(i, j) > 0) points.push({ x: i, y: j });
        }
        points.push(...pull.borderPoints);
        // and along the relief's fixed edges (isolines, coast) through the bands: an edge there is
        // straight between vertices far apart while the pulled ground under it is not
        const step = BAND_EDGE_STEP_M / (tileSizeMeters(tile) / grid);
        for (const [u, v] of relief.constraints) {
          const ax = relief.vx[u], ay = relief.vy[u], bx = relief.vx[v], by = relief.vy[v];
          if ((ax === bx && (ax === 0 || ax === grid)) || (ay === by && (ay === 0 || ay === grid))) continue; // the border: shared points only
          const n = Math.floor(Math.hypot(bx - ax, by - ay) / step);
          for (let k = 1; k < n; k++) {
            const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
            if (pull.weight(x, y) > 0) points.push({ x, y });
          }
        }
      }
      points.push(...coverBorder);
      // the outlines while the vertices last; a third of their vertices again for where they cross
      // the isolines, each other and the band points: one build, mostly
      let room = (MAX_SURFACE_VERTS - relief.vx.length - points.length) / 1.3;
      let attempt = 0;
      const pick = () => {
        picked = 0;
        for (let used = 0; picked < units.length && used + units[picked].count <= room; picked++) used += units[picked].count;
        return units.slice(0, picked).flatMap((u) => u.lines);
      };
      return {
        extraPoints: points,
        reshape: pull ? (x, y, h) => pull.height(x, y, h) : (_x, _y, h) => h,
        next: (vertices) => {
          if (vertices === undefined) return pick();
          if (vertices <= MAX_SURFACE_VERTS || picked === 0 || ++attempt >= 6) return undefined;
          room -= (vertices - MAX_SURFACE_VERTS) * 1.2 + 16;
          return pick();
        },
      };
    },
  });
  const loose = new Set<OsmLine>();
  for (const u of units.slice(picked)) if (u.way) loose.add(u.way);
  const out: SurfaceTin = loose.size ? { ...tin, loose } : tin;
  if (!cover) return out;
  // each face the senior cover under its centre: all its edges are the faces' (but a dropped unit's),
  // so the centre tells; a dropped ribbon is passed over (its ribbon lies over the faces)
  const dropped = new Uint8Array(cover.shapes.length);
  for (const u of units.slice(picked)) for (const si of u.shapes) if (RIBBON_KINDS.has(cover.shapes[si].kind)) dropped[si] = 1;
  const skip = (si: number) => dropped[si] === 1;
  const faces = new Int32Array(tin.tris.length);
  tin.tris.forEach((t, f) => {
    faces[f] = cover.locate((tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3, skip);
  });
  return { ...out, cover: faces };
}

/** each road's or river's bed outline alone, the senior first (as road-pull lays them) */
function bedUnits(beds: ReadonlyArray<{ way: number; edges: Pt[][] }>, net: RoadNet): Unit[] {
  return beds.map((b, i) => ({
    lines: b.edges, count: b.edges.reduce((s, e) => s + e.length, 0), shapes: [], way: net.ways[b.way].line, rank: 0, prio: 0, tie: 0, first: i,
  }));
}

/**
 * The covers by source (a way's or an area's shapes together, a pitch with its paint), each with the
 * bed outline of its way of the network, the senior first; a bed without a shape on its own, ranked
 * as its way's carriageway or water. Their edges cut to the tile; where they cross its border into `border`.
 */
function coverUnits(cover: GroundCover, grid: number, border: Pt[], beds: ReadonlyArray<{ way: number; edges: Pt[][] }>, net?: RoadNet): Unit[] {
  const units: Unit[] = [];
  const bySource = new Map<object, Unit>();
  cover.shapes.forEach((s, si) => {
    let u = bySource.get(s.source);
    if (!u) {
      const road = s.kind === 'carriageway' || s.kind === 'shoulder';
      u = { lines: [], count: 0, shapes: [], rank: COVER_RANK[s.kind], prio: s.prio, tie: road ? tieBreak((s.source as OsmLine).points[0]) : 0, first: si };
      bySource.set(s.source, u);
      units.push(u);
    }
    u.shapes.push(si);
    if (RIBBON_KINDS.has(s.kind)) u.way = s.source as OsmLine;
    for (const line of s.outline) for (const piece of clipToTile(line, grid, border)) {
      u.lines.push(piece);
      u.count += piece.length;
    }
  });
  beds.forEach((b, i) => {
    const line = net!.ways[b.way].line;
    let u = bySource.get(line);
    if (!u) {
      const road = !!line.tags.highway;
      u = {
        lines: [], count: 0, shapes: [], way: line, rank: COVER_RANK[road ? 'carriageway' : 'water'],
        prio: road ? roadPriority(line.tags, classifyLine(line.tags)?.width ?? 0) : 0, tie: road ? tieBreak(line.points[0]) : 0, first: cover.shapes.length + i,
      };
      bySource.set(line, u);
      units.push(u);
    }
    u.lines.push(...b.edges);
    for (const e of b.edges) u.count += e.length;
  });
  return units.sort((a, b) => a.rank - b.rank || b.prio - a.prio || a.tie - b.tie || a.first - b.first);
}

/**
 * The pieces of lattice polyline `line` inside the tile, each ending where it reaches the border,
 * exactly on it (snapped as the road beds are: the neighbour cuts its own the same); a stretch along
 * the border is no piece (the border is an edge already). Every point of it on the border into `border`.
 */
function clipToTile(line: ReadonlyArray<P2>, grid: number, border: Pt[]): Pt[][] {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  const onBorder = (p: Pt) => p.x === 0 || p.x === grid || p.y === 0 || p.y === grid;
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], [bx, by] = line[k];
    // wholly outside the tile
    if ((ax < 0 && bx < 0) || (ax > grid && bx > grid) || (ay < 0 && by < 0) || (ay > grid && by > grid)) {
      flush();
      continue;
    }
    const ts = [0, 1];
    for (const [pa, pb] of [[ax, bx], [ay, by]]) {
      if (pa === pb) continue;
      for (const edge of [0, grid]) {
        const t = (edge - pa) / (pb - pa);
        if (t > 0 && t < 1) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    for (let c = 1; c < ts.length; c++) {
      const p = snapBorder({ x: ax + (bx - ax) * ts[c - 1], y: ay + (by - ay) * ts[c - 1] }, grid);
      const q = snapBorder({ x: ax + (bx - ax) * ts[c], y: ay + (by - ay) * ts[c] }, grid);
      if (p.x === q.x && p.y === q.y) continue;
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const inside = mx >= 0 && mx <= grid && my >= 0 && my <= grid;
      for (const r of [p, q]) if (inside && onBorder(r)) border.push(r);
      // outside, or along the border
      if (!inside || (p.x === q.x && (p.x === 0 || p.x === grid)) || (p.y === q.y && (p.y === 0 || p.y === grid))) {
        flush();
        continue;
      }
      if (!cur.length) cur.push(p);
      cur.push(q);
      // a piece ends on the border: its end is a shared border vertex, never a split of the border's edge
      if (onBorder(q)) flush();
    }
  }
  flush();
  return pieces;
}

/**
 * The roads of a z14 tile with their heights: the network, its raw DEM (on the pads round an
 * aerodrome), the heights by the window along it, and the lifts of bridges over what they cross.
 * Undefined below z14 or without roads. Throws what demHeights throws (RetryableError).
 */
export async function fetchRoadSurface(
  tile: Tile,
  data: { lines: OsmLine[]; areas: OsmArea[] },
  pads: ReadonlyArray<Pad>,
): Promise<RoadSurface | undefined> {
  if (tile.z !== ROADS_Z) return undefined;
  const net = buildRoadNet(data.lines);
  if (!net.ways.length) return undefined;
  return roadSurfaceOf(tile, data, net, await fetchRoadDem(net, pads));
}

/**
 * The heights of a tile's network from its raw DEM: the window along it, water down in its channel
 * (WATER_DEPTH_M), and the lifts of bridges over what they cross between the two surfaces
 */
export function roadSurfaceOf(tile: Tile, data: { lines: OsmLine[]; areas: OsmArea[] }, net: RoadNet, dem: ArrayLike<number>): RoadSurface {
  const h = solveRoadHeights(net, dem, roadWindow(tileCenter(tile).lat));
  net.samples.forEach((s, i) => (h[i] -= net.ways[s.way].depth));
  // H along each way by metres from its start
  const wayOf = new Map<OsmLine, number>();
  net.ways.forEach((w, k) => wayOf.set(w.line, k));
  const heightAt = (line: OsmLine, d: number): number => {
    const k = wayOf.get(line);
    if (k === undefined) return NaN;
    const w = net.ways[k];
    let i = w.first;
    const last = w.first + w.count - 1;
    while (i < last && net.samples[i + 1].d < d) i++;
    if (i >= last) return h[last];
    const a = net.samples[i], b = net.samples[i + 1];
    const t = b.d > a.d ? Math.max(0, Math.min(1, (d - a.d) / (b.d - a.d))) : 0;
    return h[i] + (h[i + 1] - h[i]) * t;
  };
  // the plane of the network's metres (road-net.ts metresBetween)
  const c = tileCenter(tile);
  const ky = (EARTH_R * Math.PI) / 180, kx = ky * Math.cos((c.lat * Math.PI) / 180);
  const levels = buildRoadLevels(data.lines, data.areas, ([lon, lat]) => [(lon - c.lon) * kx, -(lat - c.lat) * ky], { height: heightAt });
  const z = Float64Array.from(net.samples, (s, i) => h[i] + levels.liftAt(net.ways[s.way].line, s.d));
  return { net, z };
}
