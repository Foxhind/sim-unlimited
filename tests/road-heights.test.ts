import { expect, it } from 'vitest';
import { padAdjust } from '../src/world/aerodrome';
import { buildRoadNet, type NetSample } from '../src/world/road-net';
import { ROAD_WINDOW_M, roadWindow, solveRoadHeights } from '../src/world/road-heights';
import { demOf, padAround, road, SIZE } from './roads-helpers';

const flatThenStep = (x: number) => 500 + (x > SIZE / 2 ? 10 : 0);
it('smooths a step in the DEM over the window', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const h = solveRoadHeights(net, demOf(net, flatThenStep));
  for (let i = 1; i < h.length; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThan(1.5); // 10 m over ~180 m
  expect(h[0]).toBeCloseTo(500, 1);
  expect(h[h.length - 1]).toBeCloseTo(510, 1);
});
it('gives every way through a node one height there', () => {
  const a = road({ highway: 'primary' }, [[4, 32], [32, 32], [60, 32]]), b = road({ highway: 'residential' }, [[32, 32], [32, 60]]);
  const net = buildRoadNet([a, b]);
  const h = solveRoadHeights(net, demOf(net, (x, y) => 500 + 0.1 * y + 8 * Math.sin(x / 40)));
  const at = (w: number, lon: number, lat: number) => h[net.samples.findIndex((s) => s.way === w && s.lon === lon && s.lat === lat)];
  const [lon, lat] = a.points[1];
  expect(at(0, lon, lat)).toBeCloseTo(at(1, lon, lat), 9);
});
it('bends a motorway less than 0.2 m where a street joins it', () => {
  const dem = (_x: number, y: number) => 500 + 0.15 * (y - SIZE / 2); // the street climbs away at 15 %
  const mw = road({ highway: 'motorway' }, [[4, 32], [32, 32], [60, 32]]);
  const alone = buildRoadNet([mw]), joined = buildRoadNet([mw, road({ highway: 'residential' }, [[32, 32], [32, 60]])]);
  const h0 = solveRoadHeights(alone, demOf(alone, dem)), h1 = solveRoadHeights(joined, demOf(joined, dem));
  for (let i = 0; i < alone.samples.length; i++) expect(Math.abs(h1[i] - h0[i])).toBeLessThan(0.2);
});
it('is the same whichever part of the network a tile sees beyond the window', () => {
  const dem = (x: number, y: number) => 500 + 12 * Math.sin(x / 55) + 0.05 * y;
  const whole = road({ highway: 'secondary' }, [[2, 30], [20, 31], [40, 29], [62, 32]]);
  const cut = road({ highway: 'secondary' }, [[20, 31], [40, 29], [62, 32]]);
  const a = buildRoadNet([whole]), b = buildRoadNet([cut]);
  const ha = solveRoadHeights(a, demOf(a, dem)), hb = solveRoadHeights(b, demOf(b, dem));
  // a point further than the window from the cut: 5 cm
  const far = (s: NetSample) => (s.lon - whole.points[1][0]) * 111320 * Math.cos((s.lat * Math.PI) / 180) > ROAD_WINDOW_M + 5;
  let checked = 0;
  b.samples.forEach((s, i) => {
    if (!far(s)) return;
    const k = a.samples.findIndex((t) => t.lon === s.lon && t.lat === s.lat);
    expect(Math.abs(ha[k] - hb[i])).toBeLessThan(0.05);
    checked++;
  });
  expect(checked).toBeGreaterThan(50);
});
it('takes no height from a tunnel, and a bridge’s from under it', () => {
  const dem = (x: number) => 500 + (Math.abs(x - SIZE / 2) < 60 ? 40 : 0); // a 40 m ridge
  const t = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [28, 32]]), road({ highway: 'primary', tunnel: 'yes' }, [[28, 32], [36, 32]]), road({ highway: 'primary' }, [[36, 32], [60, 32]])]);
  const ht = solveRoadHeights(t, demOf(t, dem));
  expect(Math.max(...Array.from(ht).filter(Number.isFinite))).toBeLessThan(530);
  const b = buildRoadNet([road({ highway: 'primary', bridge: 'yes' }, [[20, 32], [44, 32]])]);
  const hb = solveRoadHeights(b, demOf(b, dem));
  expect(hb[Math.floor(hb.length / 2)]).toBeGreaterThan(530); // the ground under the bridge's middle
});
it('runs round a ring both ways', () => {
  const ring = Array.from({ length: 25 }, (_, k): [number, number] => [32 + 4 * Math.cos((k / 24) * 2 * Math.PI), 32 + 4 * Math.sin((k / 24) * 2 * Math.PI)]);
  ring[24] = ring[0];
  const net = buildRoadNet([road({ highway: 'tertiary', junction: 'roundabout' }, ring)]);
  const h = solveRoadHeights(net, demOf(net, (x) => 500 + 0.1 * x));
  expect(h[0]).toBeCloseTo(h[h.length - 1], 6);
  for (let i = 1; i < h.length; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThan(1);
});
it('is NaN where the DEM is missing all round, without throwing', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  expect(Array.from(solveRoadHeights(net, new Float64Array(net.samples.length).fill(NaN))).every(Number.isNaN)).toBe(true);
});
it('lays a road on an aerodrome pad on its plane', () => {
  const pad = padAround(32, 32, 300); // a flat pad at 500 m
  const [lon, lat] = road({ highway: 'service' }, [[32, 32], [33, 32]]).points[0];
  expect(padAdjust([pad], lon, lat, 512)).toBeCloseTo(500, 6);
});
it('narrows the window where a tile sees less than 150 m beyond its border', () => {
  expect(roadWindow(37)).toBe(ROAD_WINDOW_M);
  expect(roadWindow(65)).toBeLessThan(ROAD_WINDOW_M);
  expect(roadWindow(65)).toBeGreaterThan(50);
});
