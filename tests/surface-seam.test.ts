import { expect, it } from 'vitest';
import type { Tile } from '../src/world/geodesy';
import type { OsmLine } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { tinLatticeSampler, type TerrainTin } from '../src/world/terrain-tin';
import { bordersOf, demOf, GRID, lattice, road, seeded, TILE } from './roads-helpers';

const B: Tile = { ...TILE, x: TILE.x + 1 };
const relief = (x: number, y: number) => 500 + 25 * Math.sin(x / 300) + 0.06 * y;
const both = (roads: OsmLine[]) => [TILE, B].map((t) => {
  const net = buildRoadNet(roads), z = solveRoadHeights(net, demOf(net, relief));
  return buildSurfaceTin(t, GRID, lattice(relief, t), { borders: bordersOf(relief, t), roads: { net, z } });
});
const gap = ([a, b]: TerrainTin[]) => {
  const sa = tinLatticeSampler(a), sb = tinLatticeSampler(b);
  let w = 0;
  for (let y = 0; y <= GRID; y += 0.02) w = Math.max(w, Math.abs(sa(GRID, y) - sb(0, y)));
  return w;
};
for (const seed of [1, 7, 42, 99]) it(`meets its neighbour on the seam under scattered roads (seed ${seed})`, () => {
  const rnd = seeded(seed);
  const roads = Array.from({ length: 30 }, () => road({ highway: rnd() < 0.3 ? 'primary' : 'residential' }, [[40 + rnd() * 20, rnd() * 64], [66 + rnd() * 20, rnd() * 64]]));
  expect(gap(both(roads))).toBeLessThan(0.05);
});
it('meets its neighbour where a road runs along the border and where one grazes it', () => {
  expect(gap(both([road({ highway: 'primary' }, [[64, 4], [64, 60]])]))).toBeLessThan(0.05);
  expect(gap(both([road({ highway: 'secondary' }, [[40, 20], [64, 30], [88, 34]]), road({ highway: 'residential' }, [[50, 40], [64.2, 44], [50, 48]])]))).toBeLessThan(0.05);
});
