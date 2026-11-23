import { expect, it } from 'vitest';
import { enuToLatLon, tileCenter } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { OsmLine, OsmTileData } from '../src/world/osm-types';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildRoadNet } from '../src/world/road-net';
import type { RoadSurface } from '../src/world/road-pull';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { buildTerrainMesh } from '../src/world/terrain-mesher';
import { tinSampler } from '../src/world/terrain-tin';
import { demOf, GRID, lattice, metresOf, road, SIZE, TILE } from './roads-helpers';

const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
const slope = lattice(relief);
const roadsOf = (lines: OsmLine[], fn = relief): RoadSurface => {
  const net = buildRoadNet(lines);
  return { net, z: solveRoadHeights(net, demOf(net, fn)) };
};

it('builds the terrain mesh on the surface under the roads', () => {
  const roads = roadsOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  const plain = buildTerrainMesh({ tile: TILE, grid: GRID, heights: slope }), withRoads = buildTerrainMesh({ tile: TILE, grid: GRID, heights: slope, roads });
  expect(withRoads.vertexCount).toBeGreaterThan(plain.vertexCount);
});

/** the steepest cross slope (east) of the road ribbon's faces in the middle third of a road running south */
const ribbonRoll = (withRoads: boolean): number => {
  const r = road({ highway: 'primary' }, [[32, 2], [32, 62]]);
  const roads = roadsOf([r]);
  const tin = buildSurfaceTin(TILE, GRID, slope, withRoads ? { roads } : {});
  const data: OsmTileData = { areas: [], points: [], buildings: [], lines: [r] };
  const m = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: tinSampler(tin, TILE), tin, ...(withRoads ? { roads } : {}) }).roads;
  let worst = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const zSouth = m.vertices[i * 6 + 2];
    if (Math.abs(zSouth) > SIZE / 6) continue;
    worst = Math.max(worst, Math.abs(m.vertices[i * 6 + 3] / m.vertices[i * 6 + 4]));
  }
  return worst;
};
it('lays a road’s ribbon level across on a hillside', () => {
  expect(ribbonRoll(true)).toBeLessThan(0.03);
  expect(ribbonRoll(false)).toBeGreaterThan(0.15);
});

it('builds a bridge at the road’s own height, over ground left as it was', () => {
  // a 30 m deep valley under the bridge's middle, the bridge across it
  const valley = (x: number) => 500 - 80 * Math.max(0, 1 - Math.abs(x - SIZE / 2) / 150);
  const b = road({ highway: 'primary', bridge: 'yes' }, [[20, 32], [44, 32]]);
  const net = buildRoadNet([b]);
  const roads: RoadSurface = { net, z: new Float64Array(net.samples.length).fill(503) };
  const tin = buildSurfaceTin(TILE, GRID, lattice(valley), { roads });
  const data: OsmTileData = { areas: [], points: [], buildings: [], lines: [b] };
  const m = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: tinSampler(tin, TILE), tin, roads }).roads;
  const c = tileCenter(TILE);
  const mid: number[] = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const x = m.vertices[i * 6], z = m.vertices[i * 6 + 2];
    const ll = enuToLatLon(c, x, -z, 0), [xm] = metresOf(ll.lon, ll.lat);
    if (Math.abs(xm - SIZE / 2) < 20) mid.push(m.vertices[i * 6 + 1]);
  }
  expect(mid.length).toBeGreaterThan(0);
  for (const y of mid) expect(Math.abs(y - 503)).toBeLessThan(2); // the deck at 503 m (+ its ribbon bias), the valley floor at 420 m
});
