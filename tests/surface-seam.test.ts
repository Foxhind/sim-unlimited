import { expect, it } from 'vitest';
import type { Tile } from '../src/world/geodesy';
import type { OsmLine } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildSurfaceTin } from '../src/world/surface-tin';
import type { GroundCover } from '../src/world/ground-cover';
import type { OsmArea, OsmPoint } from '../src/world/osm-types';
import type { SurfaceTin } from '../src/world/surface-tin';
import { tinLatticeSampler, type TerrainTin } from '../src/world/terrain-tin';
import { areaOf, bordersOf, coverTin, demOf, GRID, lattice, road, seeded, TILE } from './roads-helpers';

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

/** the two tiles either side of the seam with their ground covers */
const neighbours = (d: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }) => [TILE, B].map((t) => coverTin(d, relief, t));
/** covers across the seam at a sharp angle (a few degrees off it): a street, a footway, and a thin park the street runs through */
const sharpCrossing = () => ({
  lines: [road({ highway: 'residential' }, [[61.3, 4.2], [66.8, 59.7]]), road({ highway: 'footway' }, [[63.2, 35.5], [64.9, 62.1]])],
  areas: [areaOf({ leisure: 'park' }, [[62.9, 10.3], [65.4, 26.1], [64.6, 27.0]])],
  points: [],
});
const seamMismatch = (a: { tin: TerrainTin }, b: { tin: TerrainTin }) => gap([a.tin, b.tin]);
/**
 * Points along the seam where the face of the one tile on it has another cover (its kind and source)
 * than the face of the other: the faces on the border, found by their edge along it
 */
function seamCoverMismatch(a: { tin: SurfaceTin; cover: GroundCover }, b: { tin: SurfaceTin; cover: GroundCover }): number {
  const onSeam = ({ tin, cover }: { tin: SurfaceTin; cover: GroundCover }, x: number) => {
    const spans: { y0: number; y1: number; what: string }[] = [];
    tin.tris.forEach((t, f) => {
      const on = [t.a, t.b, t.c].filter((v) => tin.vx[v] === x);
      if (on.length !== 2) return;
      const s = tin.cover![f], shape = cover.shapes[s];
      const what = s < 0 ? 'ground' : `${shape.kind} ${JSON.stringify((shape.source as { tags: object }).tags)} ${JSON.stringify('points' in shape.source ? shape.source.points[0] : (shape.source as OsmArea).rings[0][0])}`;
      spans.push({ y0: Math.min(tin.vy[on[0]], tin.vy[on[1]]), y1: Math.max(tin.vy[on[0]], tin.vy[on[1]]), what });
    });
    return (y: number) => spans.find((sp) => sp.y0 <= y && y <= sp.y1)?.what;
  };
  const sa = onSeam(a, GRID), sb = onSeam(b, 0);
  let n = 0;
  for (let y = 0.00337; y < GRID; y += 0.01) if (sa(y) !== sb(y)) n++;
  return n;
}
it('agrees on the covers and heights where a cover edge crosses the seam at a sharp angle', () => {   // Review Focus 1
  const [a, b] = neighbours(sharpCrossing());
  expect(seamMismatch(a, b)).toBeLessThan(0.05);
  expect(seamCoverMismatch(a, b)).toBe(0);
});
