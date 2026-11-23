import { expect, it } from 'vitest';
import type { OsmLine } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildSurfaceTin, MAX_SURFACE_VERTS, Z14_RELIEF_TOL_M, type SurfaceOptions } from '../src/world/surface-tin';
import { buildTerrainTin, tinLatticeSampler } from '../src/world/terrain-tin';
import { area, at, cracks, demOf, GRID, lattice, M, padAround, road, seeded, SIZE, TILE } from './roads-helpers';

const slope = lattice((x, y) => 500 + 0.2 * x + 0.05 * y);
const surfaceOf = (roads: OsmLine[], h: Float32Array = slope, opts: SurfaceOptions = {}) => {
  const net = buildRoadNet(roads), z = solveRoadHeights(net, demOf(net, (x, y) => 500 + 0.2 * x + 0.05 * y));
  return { tin: buildSurfaceTin(TILE, GRID, h, { ...opts, roads: { net, z } }), net, z };
};
it('is the base TIN without roads (to the z14 tolerances)', () => {
  const hills = lattice((x, y) => 520 + 15 * Math.sin(x / 140) * Math.cos(y / 170));
  expect(buildSurfaceTin(TILE, GRID, hills)).toEqual(buildTerrainTin(TILE, GRID, hills, { borderTol: Z14_RELIEF_TOL_M, reliefTol: Z14_RELIEF_TOL_M }));
});
it('lays the ground level across a road on a hillside, at the road’s height', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]); // runs south across a 20 % cross slope
  const { tin } = surfaceOf([r]);
  for (const y of [400, 800, 1200]) { const h = at(tin, SIZE / 2, y); for (const off of [-9, -4, 4, 9]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(h, 1); }
});
it('leaves the ground beyond the bands as the base relief', () => {
  const base = buildTerrainTin(TILE, GRID, slope), { tin } = surfaceOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  for (const y of [300, 900]) for (const off of [-120, 120]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(at(base, SIZE / 2 + off, y), 3);
});
it('has no steeper ground beside the road than the pull makes', () => {
  const { tin } = surfaceOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  // 20 % cross slope: 9.5 m bed + 45 m band; no face steeper than 60 % across (no wall)
  for (let off = -60; off < 60; off += 2) expect(Math.abs(at(tin, SIZE / 2 + off + 2, 900) - at(tin, SIZE / 2 + off, 900)) / 2).toBeLessThan(0.6);
});
it('covers the tile once, with no vertex on another face’s edge', () => {
  const rnd = seeded(11);
  const roads = Array.from({ length: 60 }, () => road({ highway: rnd() < 0.3 ? 'primary' : 'residential' }, [[rnd() * 64, rnd() * 64], [rnd() * 64, rnd() * 64]]));
  const { tin } = surfaceOf(roads);
  expect(area(tin)).toBeCloseTo(GRID * GRID, 6);
  expect(cracks(tin)).toBe(0);
});
it('survives two ways along the same line', () => {
  const pts: [number, number][] = [[6, 30], [58, 34]];
  const { tin } = surfaceOf([road({ highway: 'primary' }, pts), road({ highway: 'primary' }, pts), road({ highway: 'residential' }, [pts[0], [32, 32]])]);
  expect(area(tin)).toBeCloseTo(GRID * GRID, 6);
  expect(cracks(tin)).toBe(0);
});
it('keeps the sea the sea beside a coast road and under a causeway', () => {
  const coast = lattice((x) => (x < SIZE / 2 ? 0 : 3 + 0.02 * (x - SIZE / 2)));
  const net = buildRoadNet([road({ highway: 'primary' }, [[33, 4], [33, 60]]), road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const tin = buildSurfaceTin(TILE, GRID, coast, { roads: { net, z: new Float64Array(net.samples.length).fill(4) } });
  for (const y of [300, 1200]) expect(at(tin, SIZE / 4, y)).toBe(0);
});
it('keeps an aerodrome pad flat under a road across it', () => {
  const pad = padAround(32, 32, 300), flat = lattice(() => 500);
  const net = buildRoadNet([road({ highway: 'service' }, [[20, 32], [44, 32]])]);
  const tin = buildSurfaceTin(TILE, GRID, flat, { pads: [pad], roads: { net, z: new Float64Array(net.samples.length).fill(506) } });
  expect(at(tin, SIZE / 2, SIZE / 2)).toBeCloseTo(500, 6);
});
it('lets the youngest roads’ edges go over the budget, and still steps nowhere', () => {
  const rnd = seeded(5);
  const roads = Array.from({ length: 2500 }, () => { const x = rnd() * 62 + 1, y = rnd() * 62 + 1; return road({ highway: 'residential' }, [[x, y], [x + rnd() - 0.5, y + rnd() - 0.5]]); });
  const { tin } = surfaceOf(roads);
  expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
  expect(tin.loose!.size).toBeGreaterThan(0);
  expect(cracks(tin)).toBe(0);
});
it('leaves a road without a height on the ground as ever', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]), net = buildRoadNet([r]);
  const tin = buildSurfaceTin(TILE, GRID, slope, { roads: { net, z: new Float64Array(net.samples.length).fill(NaN) } });
  expect(tin.vh).toEqual(buildTerrainTin(TILE, GRID, slope).vh);
});
it('lays a river level across in a valley with a cross slope, its banks pulled to it', () => {
  const r = road({ waterway: 'river' }, [[32, 4], [32, 60]]); // 18 m wide, the valley side rising east at 20 %
  const { tin } = surfaceOf([r]);
  for (const y of [400, 800, 1200]) {
    const h = at(tin, SIZE / 2, y);
    for (const off of [-8, -4, 4, 8]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(h, 1);
  }
});
it('carries the fall from a diagonal road along it, not stepped by the lattice', () => {
  // a road at 30° to the lattice on a 20 % cross slope: the ground 25 m off it, followed along it,
  // runs as smoothly as the relief and the road do (no zigzag from lattice nodes)
  const r = road({ highway: 'primary' }, [[6, 10], [58, 40]]);
  const { tin } = surfaceOf([r]);
  const ux = 52 / Math.hypot(52, 30), uy = 30 / Math.hypot(52, 30);
  const prof: number[] = [];
  for (let s = 400; s <= 1400; s += 5) {
    const xm = 6 / M + ux * s - uy * 25, ym = 10 / M + uy * s + ux * 25;
    prof.push(at(tin, xm, ym));
  }
  let worst = 0;
  for (let i = 1; i + 1 < prof.length; i++) worst = Math.max(worst, Math.abs(prof[i + 1] - 2 * prof[i] + prof[i - 1]));
  expect(worst).toBeLessThan(0.25);
});
it('follows the relief within Z14_RELIEF_TOL_M on a z14 tile, hills lower than a belt included', () => {
  const hills = (x: number, y: number) => 520 + 15 * Math.sin(x / 140) * Math.cos(y / 170);
  const h = lattice(hills), tin = buildSurfaceTin(TILE, GRID, h);
  const s = tinLatticeSampler(tin);
  let worst = 0;
  for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) worst = Math.max(worst, Math.abs(s(i, j) - h[j * (GRID + 1) + i]));
  expect(worst).toBeLessThanOrEqual(Z14_RELIEF_TOL_M + 0.01);
});
it('outlines the roads before the rivers when the vertices run short', () => {
  const rnd = seeded(5);
  const roads = Array.from({ length: 2500 }, () => { const x = rnd() * 62 + 1, y = rnd() * 62 + 1; return road({ highway: 'residential' }, [[x, y], [x + rnd() - 0.5, y + rnd() - 0.5]]); });
  const canal = road({ waterway: 'canal' }, [[2, 30], [62, 34]]);
  const { tin } = surfaceOf([canal, ...roads]);
  expect(tin.loose!.has(canal)).toBe(true);
});
