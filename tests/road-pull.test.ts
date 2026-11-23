import { expect, it } from 'vitest';
import { buildRoadNet, type RoadNet } from '../src/world/road-net';
import { BED_MARGIN_M, buildRoadPull } from '../src/world/road-pull';
import { GRID, M, road, TILE } from './roads-helpers';

const flatAt = (h: number) => (net: RoadNet) => ({ net, z: new Float64Array(net.samples.length).fill(h) });
it('is the road’s height on its bed and the base beyond its band', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]); // bed 9.5 m, band 45 m
  const pull = buildRoadPull(TILE, GRID, flatAt(520)(net));
  for (const off of [0, 5, 9]) expect(pull.height(32, 32 + off * M, 500)).toBeCloseTo(520, 6);
  expect(pull.height(32, 32 + 60 * M, 500)).toBeCloseTo(500, 6);
  expect(pull.weight(32, 32 + 60 * M)).toBe(0);
});
it('falls off smoothly and monotonically across the band', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const pull = buildRoadPull(TILE, GRID, flatAt(520)(net));
  let prev = 520;
  for (let off = 9.5; off <= 54.5; off += 1) { const h = pull.height(32, 32 + off * M, 500); expect(h).toBeLessThanOrEqual(prev + 1e-9); expect(prev - h).toBeLessThan(1.2); prev = h; }
});
it('keeps each bed at its own road where another runs in its band at another height', () => {
  const lo = road({ highway: 'residential' }, [[4, 32], [60, 32]]), hi = road({ highway: 'primary' }, [[4, 32 + 25 * M], [60, 32 + 25 * M]]);
  const net = buildRoadNet([lo, hi]);
  const z = Float64Array.from(net.samples, (s) => (s.way === 0 ? 500 : 508));
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.height(32, 32, 504)).toBeCloseTo(500, 6);
  expect(pull.height(32, 32 + 25 * M, 504)).toBeCloseTo(508, 6);
});
it('gives the senior road’s height where beds overlap', () => {
  const main = road({ highway: 'primary' }, [[4, 32], [60, 32]]), side = road({ highway: 'residential' }, [[32, 32], [32, 60]]);
  const net = buildRoadNet([side, main]);
  const z = Float64Array.from(net.samples, (s) => (s.way === 0 ? 503 : 500)); // the side road 3 m up
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.height(32, 32 + 5 * M, 500)).toBeCloseTo(500, 6); // on the primary's bed, on the side road's axis
});
it('does not pull to a bridge or a tunnel, nor to a road without a height', () => {
  const net = buildRoadNet([road({ highway: 'primary', bridge: 'yes' }, [[4, 32], [60, 32]]), road({ highway: 'primary' }, [[4, 50], [60, 50]])]);
  const z = Float64Array.from(net.samples, (s) => (s.way === 0 ? 520 : NaN));
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.weight(32, 32)).toBe(0);
  expect(pull.weight(32, 50)).toBe(0);
  expect(pull.beds.length).toBe(0);
});
it('outlines each bed within 0.2 m of the road’s height along it', () => {
  const net = buildRoadNet([road({ highway: 'secondary' }, [[4, 30], [20, 34], [44, 28], [60, 33]])]);
  const z = Float64Array.from(net.samples, (s) => 500 + 6 * Math.sin(s.d / 50));
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.beds[0].edges.length).toBeGreaterThanOrEqual(2);
  for (const line of pull.beds[0].edges) for (let k = 1; k < line.length; k++) for (let t = 0; t <= 1; t += 0.1) {
    const x = line[k - 1].x + (line[k].x - line[k - 1].x) * t, y = line[k - 1].y + (line[k].y - line[k - 1].y) * t;
    // the relief there (base) about the road's own height: the outline runs just off the bed
    const chord = pull.height(line[k - 1].x, line[k - 1].y, 500) * (1 - t) + pull.height(line[k].x, line[k].y, 500) * t;
    expect(Math.abs(pull.height(x, y, 500) - chord)).toBeLessThanOrEqual(0.2);
  }
});
it('cuts a junior bed’s outline out of a senior bed, and every outline out of the tile', () => {
  const main = road({ highway: 'primary' }, [[-10, 32], [74, 32]]), side = road({ highway: 'residential' }, [[32, 32], [32, 60]]);
  const net = buildRoadNet([side, main]);
  const pull = buildRoadPull(TILE, GRID, flatAt(500)(net));
  expect(pull.beds.map((b) => b.way)).toEqual([1, 0]);
  // the residential's outline ends on the primary's (BED_MARGIN_M beyond its bed's edge)
  for (const p of pull.beds[1].edges.flat()) expect(Math.abs(p.y - 32) / M).toBeGreaterThan(9.5 + BED_MARGIN_M - 0.05);
  for (const p of pull.beds.flatMap((b) => b.edges.flat())) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(GRID);
  }
});
it('has a height on the bed past a dead end', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [32, 32]])]);
  const pull = buildRoadPull(TILE, GRID, flatAt(520)(net));
  expect(pull.height(32 + 8 * M, 32, 500)).toBeCloseTo(520, 6);
});
it('outlines a straight road on an even grade with few vertices (no more than one in 60 m)', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[6, 10], [58, 40]])]);
  const z = Float64Array.from(net.samples, (s) => 500 + 0.05 * s.d);
  const pull = buildRoadPull(TILE, GRID, { net, z });
  const len = net.samples[net.samples.length - 1].d;
  for (const e of pull.beds[0].edges) expect(e.length).toBeLessThanOrEqual(Math.ceil(len / 60) * 2 + 2);
});
it('lets a road outrank a river beside it: its band is the road’s alone, the water keeps its own bed', () => {
  // a primary at 506 m and a canal 30 m off it at 500 m (water 2.5 m down in its channel)
  const main = road({ highway: 'primary' }, [[4, 32], [60, 32]]), canal = road({ waterway: 'canal' }, [[4, 32 + 30 * M], [60, 32 + 30 * M]]);
  const both = buildRoadNet([main, canal]), alone = buildRoadNet([main]);
  const zOf = (net: RoadNet) => Float64Array.from(net.samples, (s) => (net.ways[s.way].water ? 497.5 : 506));
  const pb = buildRoadPull(TILE, GRID, { net: both, z: zOf(both) }), pa = buildRoadPull(TILE, GRID, { net: alone, z: zOf(alone) });
  // between the road's bed and the water's: as without the canal
  for (const off of [12, 15, 18]) expect(pb.height(32, 32 + off * M, 503)).toBeCloseTo(pa.height(32, 32 + off * M, 503), 9);
  // on the water: its own level, though in the road's band
  expect(pb.height(32, 32 + 30 * M, 503)).toBeCloseTo(497.5, 9);
});
it('keeps a road’s outline at the road’s height where a river’s bed runs under it', () => {
  // a canal (18 m wide) whose bed reaches over the road's edge
  const main = road({ highway: 'residential' }, [[4, 32], [60, 32]]), canal = road({ waterway: 'canal' }, [[4, 32 + 10 * M], [60, 32 + 10 * M]]);
  const net = buildRoadNet([main, canal]);
  const pull = buildRoadPull(TILE, GRID, { net, z: Float64Array.from(net.samples, (s) => (net.ways[s.way].water ? 497.5 : 506)) });
  for (const p of pull.beds.find((b) => b.way === 0)!.edges.flat()) expect(pull.height(p.x, p.y, 503)).toBeCloseTo(506, 2);
});
it('keeps the outline at the end of an approach to a bridge at the road’s height, over a river under it', () => {
  const s = 6;
  const approach = road({ highway: 'residential' }, [[4, 32], [32 - s * M, 32]]), bridge = road({ highway: 'residential', bridge: 'yes', layer: '1' }, [[32 - s * M, 32], [32 + s * M, 32]]);
  const canal = road({ waterway: 'canal' }, [[32, 4], [32, 60]]);
  const net = buildRoadNet([approach, bridge, canal]);
  const pull = buildRoadPull(TILE, GRID, { net, z: Float64Array.from(net.samples, (p) => (net.ways[p.way].water ? 497.5 : 506)) });
  for (const p of pull.beds.find((b) => b.way === 0)!.edges.flat()) expect(pull.height(p.x, p.y, 503)).toBeCloseTo(506, 2);
});
it('keeps the outline round a bend at the road’s height, rivers’ beds under it either side', () => {
  const pts: [number, number][] = [[4, 24], [30, 30], [50, 46]]; // a 26° bend, then on
  const bend = road({ highway: 'residential' }, pts);
  // a canal on either side, its bed reaching under the road's edges
  const side = (o: number) => road({ waterway: 'canal' }, pts.map(([x, y]): [number, number] => [x - o * M * 0.3, y + o * M]));
  const net = buildRoadNet([bend, side(11), side(-11)]);
  const pull = buildRoadPull(TILE, GRID, { net, z: Float64Array.from(net.samples, (p) => (net.ways[p.way].water ? 497.5 : 506)) });
  for (const p of pull.beds.find((b) => b.way === 0)!.edges.flat()) expect(pull.height(p.x, p.y, 503)).toBeCloseTo(506, 2);
});
