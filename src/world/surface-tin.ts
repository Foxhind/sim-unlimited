/**
 * The surface of a tile built under its roads (roads first, then the land): the base belt TIN with
 * the roads' bed outlines as fixed edges and the lattice nodes of their pull bands as vertices, every
 * vertex's height then replaced by the pulled ground (road-pull.ts). One function for every builder
 * of a tile's surface: the terrain mesh, the OSM drape and the collision ground.
 */
import type { Pad } from './aerodrome';
import type { Pt } from './contours';
import { EARTH_R, tileCenter, type Tile } from './geodesy';
import type { OsmArea, OsmLine } from './osm-types';
import { fetchRoadDem, roadWindow, solveRoadHeights } from './road-heights';
import { buildRoadLevels } from './road-levels';
import { buildRoadNet } from './road-net';
import { buildRoadPull, type RoadSurface } from './road-pull';
import { buildTerrainTin, type TerrainTin, type TinOptions } from './terrain-tin';

export type { RoadSurface } from './road-pull';

/** the most vertices a tile's surface may have: over it the youngest roads' bed outlines go first */
export const MAX_SURFACE_VERTS = 12000;
/** the zoom with the roads (chunks.ts DETAIL_Z) */
const ROADS_Z = 14;

export interface SurfaceOptions extends TinOptions {
  roads?: RoadSurface;
}

export interface SurfaceTin extends TerrainTin {
  /** roads whose bed edges the vertex budget left out: their ribbons lie on the ground as ever */
  loose?: Set<OsmLine>;
}

export function buildSurfaceTin(tile: Tile, grid: number, heights: Float32Array, opts: SurfaceOptions = {}): SurfaceTin {
  const { roads, ...tinOpts } = opts;
  const base = buildTerrainTin(tile, grid, heights, tinOpts);
  if (!roads || !roads.net.ways.length) return base;
  const pull = buildRoadPull(tile, grid, roads);
  // the lattice nodes the roads pull: they carry the fall from a road to the relief
  // and the ring just outside the bands, at the relief's own height: it keeps the fall inside
  const side = grid + 1;
  const pulled = new Uint8Array(side * side);
  for (let j = 0; j <= grid; j++) for (let i = 0; i <= grid; i++) pulled[j * side + i] = pull.weight(i, j) > 0 ? 1 : 0;
  const points: Pt[] = [];
  for (let j = 0; j <= grid; j++) for (let i = 0; i <= grid; i++) {
    // a border node by its neighbours along the border only: the neighbour tile decides the same
    const onX = i === 0 || i === grid, onY = j === 0 || j === grid;
    let near = false;
    for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) {
      const ii = i + di, jj = j + dj;
      if ((onX && ii !== i && !onY) || (onY && jj !== j && !onX) || ((onX && onY) && di !== 0 && dj !== 0)) continue;
      near = ii >= 0 && ii <= grid && jj >= 0 && jj <= grid && pulled[jj * side + ii] === 1;
    }
    if (near) points.push({ x: i, y: j });
  }
  if (!points.length && !pull.beds.length) return base;

  // the bed outlines, senior first, while the vertices last (crossings come on top: built, counted,
  // and built again with fewer if over)
  const counts = pull.beds.map((b) => b.edges.reduce((s, e) => s + e.length, 0));
  // a tenth of the outline vertices again for where they cross the isolines and each other
  let room = (MAX_SURFACE_VERTS - base.vx.length - points.length - pull.borderPoints.length) / 1.1;
  let tin: TerrainTin | undefined;
  let picked = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    picked = 0;
    for (let used = 0; picked < counts.length && used + counts[picked] <= room; picked++) used += counts[picked];
    tin = buildTerrainTin(tile, grid, heights, {
      ...tinOpts,
      fixedLines: pull.beds.slice(0, picked).flatMap((b) => b.edges),
      extraPoints: [...points, ...pull.borderPoints],
      reshape: (x, y, h) => pull.height(x, y, h),
    });
    if (tin.vx.length <= MAX_SURFACE_VERTS || picked === 0) break;
    room -= (tin.vx.length - MAX_SURFACE_VERTS) * 1.2 + 16;
  }
  const loose = new Set<OsmLine>();
  for (const b of pull.beds.slice(picked)) loose.add(roads.net.ways[b.way].line);
  return loose.size ? { ...tin!, loose } : tin!;
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
