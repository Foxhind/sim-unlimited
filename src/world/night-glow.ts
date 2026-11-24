import { GLOW_LEVELS, rampGlowLevel, withGlow } from '../engine/palette';
import { enuToLatLon, latLonToEnu, tileCenter, tileSizeMeters, type Tile } from './geodesy';
import type { OsmBuilding } from './osm-types';
import { isRuin } from './building-mesher';
import type { TerrainTin } from './terrain-tin';
import { setTreeColour, treeColour, TREE_STRIDE } from './props-mesher';

/** a terrain triangle locator, as tinLocator returns */
export type TriLocator = (lon: number, lat: number) => { tri: number } | null;

/** shoelace area of a closed lon/lat ring in square metres (tile-centre ENU) */
function ringArea(ring: [number, number][], center: { lat: number; lon: number }): number {
  const pts = ring.map(([lon, lat]) => latLonToEnu(center, lat, lon, 0));
  let a = 0;
  // open or closed: the closing edge of a closed ring is degenerate and adds nothing
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * Share of every TIN triangle's area covered by building footprints (0..1). A building counts
 * whole toward the triangle under the centroid of its outer ring; `building:part` outlines are
 * skipped, they repeat the area of the building they belong to.
 */
export function buildingCoverage(tin: TerrainTin, tile: Tile, buildings: OsmBuilding[], locate: TriLocator): Float32Array {
  const center = tileCenter(tile);
  const built = new Float64Array(tin.tris.length);
  for (const b of buildings) {
    // a ruin village is dark
    if (!b.tags.building || isRuin(b.tags)) continue;
    const outer = b.rings[0];
    if (!outer || outer.length < 3) continue;
    let area = ringArea(outer, center);
    for (let k = 1; k < b.rings.length; k++) area -= ringArea(b.rings[k], center);
    if (!(area > 0)) continue;
    let lon = 0, lat = 0;
    const first = outer[0], last = outer[outer.length - 1];
    const m = first[0] === last[0] && first[1] === last[1] ? outer.length - 1 : outer.length;
    for (let i = 0; i < m; i++) { lon += outer[i][0]; lat += outer[i][1]; }
    const hit = locate(lon / m, lat / m);
    if (hit) built[hit.tri] += area;
  }
  // lattice cells are square in local metres (Web Mercator), tileSizeMeters / grid on a side
  const cell = tileSizeMeters(tile) / tin.grid;
  const out = new Float32Array(tin.tris.length);
  tin.tris.forEach((t, i) => {
    const { vx, vy } = tin;
    const lattice = Math.abs((vx[t.b] - vx[t.a]) * (vy[t.c] - vy[t.a]) - (vx[t.c] - vx[t.a]) * (vy[t.b] - vy[t.a])) / 2;
    const area = lattice * cell * cell;
    out[i] = area > 0 ? Math.min(1, built[i] / area) : 0;
  });
  return out;
}

/** below this built-up share a triangle stays dark (a farm or two in the fields) */
export const GLOW_MIN_COVERAGE = 0.005;
/** at this built-up share and above, the brightest level (a dense city centre) */
export const GLOW_FULL_COVERAGE = 0.35;

/**
 * Glow level 0..GLOW_LEVELS from the built-up share: square-root response, so a suburb is already
 * clearly lit and a city centre is the brightest; under GLOW_MIN_COVERAGE nothing.
 */
export function glowLevel(coverage: number): number {
  if (!(coverage >= GLOW_MIN_COVERAGE)) return 0;
  return Math.max(1, Math.min(GLOW_LEVELS, Math.ceil(GLOW_LEVELS * Math.sqrt(coverage / GLOW_FULL_COVERAGE))));
}

export function glowLevels(coverage: Float32Array): Uint8Array {
  return Uint8Array.from(coverage, glowLevel);
}

/**
 * Stamps the glow level of the terrain triangle beneath onto a triangle mesh (stride-6 pos+normal,
 * one ramp per vertex, tile-centre ENU): each triangle takes the level under its centroid, so roads,
 * areas, buildings and masts are lit as the ground they stand on. A face that already glows brighter
 * (a street-lit road) keeps its own level.
 */
export function applyGlow(vertices: Float32Array, ramps: Uint32Array, tile: Tile, locate: TriLocator, levels: Uint8Array): void {
  const center = tileCenter(tile);
  for (let v = 0; v + 2 < ramps.length; v += 3) {
    const o = v * 6;
    const x = (vertices[o] + vertices[o + 6] + vertices[o + 12]) / 3;
    const z = (vertices[o + 2] + vertices[o + 8] + vertices[o + 14]) / 3;
    const ll = enuToLatLon(center, x, -z, 0);
    const hit = locate(ll.lon, ll.lat);
    const lvl = hit ? levels[hit.tri] : 0;
    if (lvl === 0) continue;
    for (let k = 0; k < 3; k++) if (lvl > rampGlowLevel(ramps[v + k])) ramps[v + k] = withGlow(ramps[v + k], lvl);
  }
}

/** the same for tree instances (props-mesher TREE_STRIDE): the level goes into their face colour */
export function applyGlowToTrees(trees: Float32Array, tile: Tile, locate: TriLocator, levels: Uint8Array): void {
  const center = tileCenter(tile);
  for (let i = 0; i + TREE_STRIDE - 1 < trees.length; i += TREE_STRIDE) {
    const ll = enuToLatLon(center, trees[i], -trees[i + 2], 0);
    const hit = locate(ll.lon, ll.lat);
    const lvl = hit ? levels[hit.tri] : 0;
    if (lvl > 0) setTreeColour(trees, i, withGlow(treeColour(trees, i), lvl));
  }
}
