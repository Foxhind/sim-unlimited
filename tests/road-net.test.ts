import { expect, it } from 'vitest';
import { buildRoadNet, isCarriageway, NET_STEP_M } from '../src/world/road-net';
import { M, road } from './roads-helpers';

it('takes roads with a carriageway, not paths', () => {
  expect(isCarriageway({ highway: 'residential' })).toBe(true);
  expect(isCarriageway({ highway: 'trunk_link' })).toBe(true);
  expect(isCarriageway({ highway: 'track' })).toBe(true);
  for (const hw of ['footway', 'path', 'cycleway', 'steps', 'bridleway']) expect(isCarriageway({ highway: hw })).toBe(false);
  expect(isCarriageway({ railway: 'rail' })).toBe(false);
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
it('takes rivers, canals and streams as water ways, below every road, not a culvert', () => {
  const net = buildRoadNet([
    road({ waterway: 'river' }, [[4, 4], [20, 4]]), road({ waterway: 'stream', width: '5' }, [[4, 8], [20, 8]]),
    road({ waterway: 'canal', tunnel: 'culvert' }, [[4, 12], [20, 12]]), road({ waterway: 'ditch' }, [[4, 16], [20, 16]]),
    road({ highway: 'service' }, [[4, 20], [20, 20]]),
  ]);
  expect(net.ways.map((w) => [w.water, w.half, w.band, w.tunnel])).toEqual([[true, 9, 30, false], [true, 2.5, 12, false], [true, 9, 30, true], [false, 2.5, 25, false]]);
  expect(Math.max(...net.ways.filter((w) => w.water).map((w) => w.prio))).toBeLessThan(net.ways[3].prio);
});
