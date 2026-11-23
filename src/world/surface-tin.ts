/**
 * The surface of a tile built under its roads (roads first, then the land): the base belt TIN with
 * the roads' bed outlines as fixed edges and the lattice nodes of their pull bands as vertices, every
 * vertex's height then replaced by the pulled ground (road-pull.ts). One function for every builder
 * of a tile's surface: the terrain mesh, the OSM drape and the collision ground.
 */
import type { Pad } from './aerodrome';
import type { Pt } from './contours';
import { EARTH_R, tileCenter, tileSizeMeters, type Tile } from './geodesy';
import type { OsmArea, OsmLine } from './osm-types';
import { fetchRoadDem, roadWindow, solveRoadHeights } from './road-heights';
import { buildRoadLevels } from './road-levels';
import { buildRoadNet } from './road-net';
import { buildRoadPull, type RoadSurface } from './road-pull';
import { buildTerrainTin, type SurfacePlan, type TerrainTin, type TinOptions } from './terrain-tin';

export type { RoadSurface } from './road-pull';

/** the most vertices a tile's surface may have: over it the youngest roads' bed outlines go first */
export const MAX_SURFACE_VERTS = 12000;
/** the base relief's fixed edges get a vertex this often where they run through a pull band, metres */
const BAND_EDGE_STEP_M = 12;
/** at most this many band points a tile (about the lattice nodes it had: 65²) */
const MAX_BAND_POINTS = 4500;
/** the zoom with the roads (chunks.ts DETAIL_Z) */
const ROADS_Z = 14;

export interface SurfaceOptions extends TinOptions {
  roads?: RoadSurface;
}

export interface SurfaceTin extends TerrainTin {
  /** roads whose bed edges the vertex budget left out: their ribbons lie on the ground as ever */
  loose?: Set<OsmLine>;
}

/**
 * A detailed (z14) tile's relief follows its lattice within this many metres, and its border line
 * too: its roads and rivers lie on the true relief (raw DEM), and a coarser one let them show
 * through it in trenches 10–16 m deep (14/9515/6394, where the belts left four vertices)
 */
export const Z14_RELIEF_TOL_M = 5;

export function buildSurfaceTin(tile: Tile, grid: number, heights: Float32Array, opts: SurfaceOptions = {}): SurfaceTin {
  const { roads, ...given } = opts;
  const tinOpts: TinOptions = tile.z === ROADS_Z ? { borderTol: Z14_RELIEF_TOL_M, reliefTol: Z14_RELIEF_TOL_M, ...given } : given;
  if (!roads || !roads.net.ways.length) return buildTerrainTin(tile, grid, heights, tinOpts);
  const pull = buildRoadPull(tile, grid, roads);
  // the bed outlines, the water first (a river is long and in plain sight), then the senior roads
  const beds = [...pull.beds.filter((b) => roads.net.ways[b.way].water), ...pull.beds.filter((b) => !roads.net.ways[b.way].water)];
  const counts = beds.map((b) => b.edges.reduce((s, e) => s + e.length, 0));
  let picked = 0;
  const tin = buildTerrainTin(tile, grid, heights, {
    ...tinOpts,
    // planned on the relief once it is built (one relief build, however many surface builds)
    surface: (relief): SurfacePlan => {
      // the fall from a road to the relief: points on rows along the roads in their bands (not the
      // lattice: that made the bands square), and on the border the lattice nodes the roads pull
      // (the neighbour has the same) and where the outlines and rows cross it
      const points: Pt[] = pull.bandPoints(MAX_BAND_POINTS);
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
      // the outlines while the vertices last; a third of their vertices again for where they cross
      // the isolines, each other and the band points: one build, mostly
      let room = (MAX_SURFACE_VERTS - relief.vx.length - points.length) / 1.3;
      let attempt = 0;
      const pick = () => {
        picked = 0;
        for (let used = 0; picked < counts.length && used + counts[picked] <= room; picked++) used += counts[picked];
        return beds.slice(0, picked).flatMap((b) => b.edges);
      };
      return {
        extraPoints: points,
        reshape: (x, y, h) => pull.height(x, y, h),
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
  for (const b of beds.slice(picked)) loose.add(roads.net.ways[b.way].line);
  return loose.size ? { ...tin, loose } : tin;
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
  const dem = await fetchRoadDem(net, pads);
  const h = solveRoadHeights(net, dem, roadWindow(tileCenter(tile).lat));
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
