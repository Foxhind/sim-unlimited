import { tileLattice, type Tile } from './geodesy';
import { parseLength } from './building-mesher';
import type { OsmPoint } from './osm-types';
import { demHeights } from './terrain-source';

/**
 * Summits (natural=peak with ele): the DEM's lattice averages a summit with the slopes round it, so
 * a mountain comes out lower and blunter than it is. The ground round a mapped summit is pulled up
 * to it: the lattice node nearest the summit to its `ele`, the nodes within REACH_M by the summit's
 * lift (its `ele` over the DEM at the summit) less linearly with their distance from it, to nothing
 * at REACH_M. As aerodrome pads flatten theirs (applyPads), for the terrain, the OSM drape and the
 * collision ground alike.
 */
export const PEAK = {
  /** a summit higher than the DEM under it by more than this is taken for a mapping error and left alone */
  MAX_LIFT_M: 150,
  /** how far round a summit the ground follows it up */
  REACH_M: 100,
} as const;

export interface Peak {
  lon: number;
  lat: number;
  ele: number;
}

/** a summit with the DEM's height under it (groundPeaks) */
export interface GroundedPeak extends Peak {
  ground: number;
}

/** the mapped summits with a height among a tile's points */
export function peaksOf(points: ReadonlyArray<OsmPoint>): Peak[] {
  const out: Peak[] = [];
  for (const p of points) {
    if (p.tags.natural !== 'peak') continue;
    const ele = parseLength(p.tags.ele);
    if (ele !== undefined) out.push({ lon: p.at[0], lat: p.at[1], ele });
  }
  return out;
}

/**
 * The DEM's height under each summit, at the tile's zoom: it depends only on the summit and the
 * zoom (demHeights), so the tiles on both sides of a border lift their shared nodes alike.
 * Summits where the DEM has no tile are dropped.
 */
export async function groundPeaks(peaks: ReadonlyArray<Peak>, z: number): Promise<GroundedPeak[]> {
  if (peaks.length === 0) return [];
  const ground = await demHeights(peaks.map((p) => [p.lon, p.lat] as const), z);
  const out: GroundedPeak[] = [];
  peaks.forEach((p, k) => {
    if (Number.isFinite(ground[k])) out.push({ ...p, ground: ground[k] });
  });
  return out;
}

const EARTH_CIRCUMFERENCE_M = 40075016.686;

/**
 * Pulls the ground up round each summit (see PEAK), when the summit is above the DEM under it by no
 * more than MAX_LIFT_M. Never lowers a node. Where summits overlap a node takes the highest pull, so
 * the result does not depend on their order. Border nodes rise too: the neighbour is given the
 * summits within reach of its border (overpass peak reach) and lifts them alike. Returns whether any rose.
 */
export function applyPeaks(dem: { heights: Float32Array }, tile: Tile, grid: number, peaks: ReadonlyArray<GroundedPeak>): boolean {
  const side = grid + 1;
  const toLattice = tileLattice(tile, grid);
  const target = new Map<number, number>();
  for (const p of peaks) {
    const lift = p.ele - p.ground;
    if (lift <= 0 || lift > PEAK.MAX_LIFT_M) continue;
    const [x, y] = toLattice([p.lon, p.lat]);
    // metres per lattice step at the summit (Web Mercator: the same both ways)
    const step = (EARTH_CIRCUMFERENCE_M * Math.cos((p.lat * Math.PI) / 180)) / (2 ** tile.z * grid);
    const r = PEAK.REACH_M / step;
    const ni = Math.round(x), nj = Math.round(y);
    const pull = (k: number, h: number) => {
      const was = target.get(k);
      if (was === undefined || h > was) target.set(k, h);
    };
    // the nearest node to the summit's height (when the lattice is coarser than REACH_M, it alone)
    if (ni >= 0 && nj >= 0 && ni <= grid && nj <= grid) pull(nj * side + ni, p.ele);
    for (let j = Math.max(0, Math.ceil(y - r)); j <= Math.min(grid, Math.floor(y + r)); j++) {
      for (let i = Math.max(0, Math.ceil(x - r)); i <= Math.min(grid, Math.floor(x + r)); i++) {
        if (i === ni && j === nj) continue;
        const d = Math.hypot(i - x, j - y) / r;
        if (d >= 1) continue;
        const k = j * side + i;
        pull(k, dem.heights[k] + lift * (1 - d));
      }
    }
  }
  let any = false;
  for (const [k, h] of target) {
    if (h > dem.heights[k]) {
      dem.heights[k] = h;
      any = true;
    }
  }
  return any;
}
