import { expect, it } from 'vitest';
import { buildRoadNet, isCarriageway, isRailWay, isUrbanPath, NET_STEP_M } from '../src/world/road-net';
import { M, road } from './roads-helpers';

it('takes roads with a carriageway, not paths', () => {
  expect(isCarriageway({ highway: 'residential' })).toBe(true);
  expect(isCarriageway({ highway: 'trunk_link' })).toBe(true);
  expect(isCarriageway({ highway: 'track' })).toBe(true);
  for (const hw of ['footway', 'path', 'cycleway', 'steps', 'bridleway']) expect(isCarriageway({ highway: hw })).toBe(false);
  expect(isCarriageway({ railway: 'rail' })).toBe(false);
});
it('takes the urban paths by the roads\' rules, not the trails', () => {
  // 14/9517/6398: a footway's and a cycleway's bridge over the river's mouth 6–7 m up beside the
  // street's at 4 m, their lift over the drawn ground standing on the banks: with heights of their
  // own from the network they are at the streets' level
  for (const hw of ['footway', 'cycleway', 'steps']) expect(isUrbanPath({ highway: hw })).toBe(true);
  for (const hw of ['path', 'bridleway', 'residential']) expect(isUrbanPath({ highway: hw })).toBe(false);
  const lines = ['footway', 'cycleway', 'steps', 'path', 'bridleway'].map((hw, i) => road({ highway: hw }, [[4, 4 + 4 * i], [20, 4 + 4 * i]]));
  const net = buildRoadNet(lines);
  expect(net.ways.map((w) => w.line.tags.highway)).toEqual(['footway', 'cycleway', 'steps']);
  // a footway's bed: its width, and the band and weight of the least road
  expect([net.ways[0].half, net.ways[0].band, net.ways[0].weight]).toEqual([1, 25, 8]);
});
it('gives each class its bed, band and weight', () => {
  // a two-way motorway (one carriageway of a dual one is half as wide)
  const net = buildRoadNet([road({ highway: 'motorway', oneway: 'no' }, [[4, 4], [20, 4]]), road({ highway: 'tertiary' }, [[4, 8], [20, 8]]), road({ highway: 'residential' }, [[4, 12], [20, 12]])]);
  expect(net.ways.map((w) => [w.half, w.band, w.weight])).toEqual([[13, 45, 8000], [6, 40, 729], [4, 25, 343]]);
});
it('samples a way at its vertices and no further apart than 10 m', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 4], [20, 4], [20, 9]])]);
  const s = net.samples;
  for (let i = 1; i < s.length; i++) expect(s[i].d - s[i - 1].d).toBeLessThanOrEqual(NET_STEP_M + 1e-6);
  expect(s[s.length - 1].d).toBeCloseTo((16 + 5) / M, 0);
});
it('joins ways at a shared node and nowhere else', () => {
  const a = road({ highway: 'primary' }, [[4, 8], [12, 8], [20, 8]]), b = road({ highway: 'residential' }, [[12, 8], [12, 16]]);
  const over = road({ highway: 'secondary', bridge: 'yes' }, [[8, 4], [8, 12]]); // crosses a, shares no node
  const net = buildRoadNet([a, b, over]);
  const reach = (from: number) => { const seen = new Set([from]); const q = [from]; while (q.length) for (const [k] of net.next[q.pop()!]) if (!seen.has(k)) { seen.add(k); q.push(k); } return seen; };
  const fromA = reach(net.ways[0].first);
  expect(fromA.has(net.ways[1].first)).toBe(true);
  expect(fromA.has(net.ways[2].first)).toBe(false);
  expect(net.ways[2].bridge).toBe(true);
});
it('survives degenerate ways', () => {
  expect(() => buildRoadNet([road({ highway: 'primary' }, [[4, 4]]), road({ highway: 'primary' }, [[4, 4], [4, 4]]), road({ highway: 'primary' }, [[4, 4], [8, 4], [4, 4]])])).not.toThrow();
});
it('takes an untagged canal 8 m wide, a river 18 m, a tagged width as it is', () => {
  // a town's canal (14/9517/6397): at 18 m it reached under the roads along its banks
  const net = buildRoadNet([
    road({ waterway: 'canal' }, [[4, 4], [20, 4]]), road({ waterway: 'river' }, [[4, 8], [20, 8]]), road({ waterway: 'canal', width: '30' }, [[4, 12], [20, 12]]),
  ]);
  expect(net.ways.map((w) => w.half)).toEqual([4, 9, 15]);
});
it('takes rivers, canals and streams as water ways, below every road, not a culvert', () => {
  const net = buildRoadNet([
    road({ waterway: 'river' }, [[4, 4], [20, 4]]), road({ waterway: 'stream', width: '5' }, [[4, 8], [20, 8]]),
    road({ waterway: 'canal', tunnel: 'culvert', width: '18' }, [[4, 12], [20, 12]]), road({ waterway: 'ditch' }, [[4, 16], [20, 16]]),
    road({ highway: 'service' }, [[4, 20], [20, 20]]),
  ]);
  expect(net.ways.map((w) => [w.water, w.half, w.band, w.tunnel])).toEqual([[true, 9, 30, false], [true, 2.5, 12, false], [true, 9, 30, true], [false, 2.5, 25, false]]);
  expect(Math.max(...net.ways.filter((w) => w.water).map((w) => w.prio))).toBeLessThan(net.ways[3].prio);
});
it('takes the railways by the roads\' rules: a bed of their ballast, senior to every road, weighted as a motorway', () => {
  // 55.80917, 37.94793: tracks on the raw DEM took every bump of it beside a road bridge's approach
  for (const r of ['rail', 'narrow_gauge', 'light_rail']) expect(isRailWay({ railway: r })).toBe(true);
  for (const t of [{ railway: 'abandoned' }, { railway: 'platform' }, { highway: 'residential' }]) expect(isRailWay(t)).toBe(false);
  const net = buildRoadNet([road({ railway: 'rail' }, [[4, 4], [20, 4]]), road({ highway: 'motorway' }, [[4, 8], [20, 8]]), road({ railway: 'rail', tunnel: 'yes' }, [[4, 12], [20, 12]])]);
  expect(net.ways.map((w) => [w.half, w.band, w.weight, w.water, w.tunnel])).toEqual([[3, 40, 8000, false, false], [net.ways[1].half, 45, 8000, false, false], [3, 40, 8000, false, true]]);
  expect(net.ways[0].prio).toBeGreaterThan(net.ways[1].prio);
});
