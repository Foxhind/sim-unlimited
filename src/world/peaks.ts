import { tileLattice, type Tile } from './geodesy';
import { parseLength } from './building-mesher';
import type { OsmPoint } from './osm-types';

/**
 * Summits (natural=peak with ele): the DEM's lattice averages a summit with the slopes round it, so
 * a mountain comes out lower and blunter than it is. The lattice node nearest a mapped summit is
 * raised to its `ele`, as aerodrome pads flatten theirs (applyPads), for the terrain, the OSM drape
 * and the collision ground alike.
 */
export const PEAK = {
  /** a summit higher than its node by more than this is taken for a mapping error and left alone */
  MAX_LIFT_M: 150,
} as const;

export interface Peak {
  lon: number;
  lat: number;
  ele: number;
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
 * Raises the lattice node nearest each summit to its height, when that is above the node and by no
 * more than MAX_LIFT_M. Only nodes inside the tile: a node on its border is its neighbour's too, and
 * the neighbour's fetch may not hold the summit (the tiles would part there). Returns whether any rose.
 */
export function applyPeaks(dem: { heights: Float32Array }, tile: Tile, grid: number, peaks: ReadonlyArray<Peak>): boolean {
  const side = grid + 1;
  const toLattice = tileLattice(tile, grid);
  let any = false;
  for (const p of peaks) {
    const [x, y] = toLattice([p.lon, p.lat]);
    const i = Math.round(x), j = Math.round(y);
    if (i <= 0 || j <= 0 || i >= grid || j >= grid) continue;
    const k = j * side + i;
    const lift = p.ele - dem.heights[k];
    if (lift <= 0 || lift > PEAK.MAX_LIFT_M) continue;
    dem.heights[k] = p.ele;
    any = true;
  }
  return any;
}
