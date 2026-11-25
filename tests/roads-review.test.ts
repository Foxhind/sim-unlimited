/** cases the whole-branch review found: bridges of every kind, ground under short bridges, seams under per-tile differences */
import { expect, it } from 'vitest';
import { enuToLatLon, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { OsmLine, OsmTileData } from '../src/world/osm-types';
import { solveRoadHeights } from '../src/world/road-heights';
import { LEVEL_M } from '../src/world/road-levels';
import { buildRoadNet, WATER_DEPTH_M, type RoadNet } from '../src/world/road-net';
import { buildRoadPull, BED_MARGIN_M } from '../src/world/road-pull';
import { buildSurfaceTin, roadSurfaceOf } from '../src/world/surface-tin';
import { tinLatticeSampler, tinSampler, type TerrainTin } from '../src/world/terrain-tin';
import { bordersOf, demOf, GRID, lattice, M, metresOf, road, TILE } from './roads-helpers';

const flatZ = (net: RoadNet, h = 500) => new Float64Array(net.samples.length).fill(h);

it('lifts a railway bridge and a footbridge over a road by their own heights (the roads’ rules)', () => {
  const under = road({ highway: 'primary' }, [[32, 10], [32, 54]]);
  for (const br of [road({ railway: 'rail', bridge: 'yes' }, [[20, 32], [44, 32]]), road({ highway: 'footway', bridge: 'yes' }, [[20, 32], [44, 32]])]) {
    const lines = [under, br], net = buildRoadNet(lines);
    // a railway and a footway are ways of the network: the lift is in their heights, as a street's (roadSurfaceOf)
    const roads = roadSurfaceOf(TILE, { lines, areas: [] }, net, demOf(net, () => 500));
    const tin = buildSurfaceTin(TILE, GRID, lattice(() => 500), { roads });
    const data: OsmTileData = { areas: [], points: [], buildings: [], lines };
    const m = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: tinSampler(tin, TILE), tin, roads });
    const c = tileCenter(TILE);
    let top = -Infinity;
    for (const mesh of [m.roads, m.bridges, m]) for (let i = 0; i < mesh.vertexCount; i++) {
      const ll = enuToLatLon(c, mesh.vertices[i * 6], -mesh.vertices[i * 6 + 2], 0), [xm, ym] = metresOf(ll.lon, ll.lat);
      if (Math.abs(ym - 32 / M) < 4 && Math.abs(xm - 32 / M) < 2) top = Math.max(top, mesh.vertices[i * 6 + 1]);
    }
    expect(top, br.tags.railway ?? br.tags.highway).toBeGreaterThan(500 + LEVEL_M);
  }
});

/** a short bridge of `span` metres west–east through the centre, its approaches, and `under` across its middle */
const bridged = (span: number, under: OsmLine, cls = 'primary') => {
  const s = (span * M) / 2;
  const lines = [road({ highway: cls }, [[10, 32], [32 - s, 32]]), road({ highway: cls, bridge: 'yes' }, [[32 - s, 32], [32 + s, 32]]), road({ highway: cls }, [[32 + s, 32], [54, 32]]), under];
  const net = buildRoadNet(lines);
  return { net, z: Float64Array.from(net.samples, (p) => (p.way === 3 ? 500 : 506)) };
};
it('leaves the ground under a short bridge to the river under it', () => {
  for (const span of [30, 60]) {
    const roads = bridged(span, road({ waterway: 'river', width: '20' }, [[32, 4], [32, 60]]));
    const pull = buildRoadPull(TILE, GRID, roads);
    for (const off of [-8, 0, 8]) expect(pull.height(32, 32 + off * M, 500), `span ${span}, ${off} m`).toBeCloseTo(500, 6);
  }
});
it('leaves the road under a short overpass at its own height', () => {
  const roads = bridged(20, road({ highway: 'residential' }, [[32, 10], [32, 54]]));
  const pull = buildRoadPull(TILE, GRID, roads);
  for (const off of [-3, -1, 0, 1, 3]) expect(pull.height(32 + off * M, 32, 500), `${off} m`).toBeCloseTo(500, 3);
});

const relief = (x: number, y: number) => 500 + 0.12 * y + 0.03 * x;
const seamGap = (a: TerrainTin, b: TerrainTin) => {
  const sa = tinLatticeSampler(a), sb = tinLatticeSampler(b);
  let w = 0;
  for (let y = 0; y <= GRID; y += 0.02) w = Math.max(w, Math.abs(sa(GRID, y) - sb(0, y)));
  return w;
};
const B: Tile = { ...TILE, x: TILE.x + 1 };
const tileOf = (t: Tile, lines: OsmLine[]) => {
  const net = buildRoadNet(lines);
  return buildSurfaceTin(t, GRID, lattice(relief, t), { borders: bordersOf(relief, t), roads: { net, z: solveRoadHeights(net, demOf(net, relief)) } });
};
it('meets its neighbour whatever order the two tiles list the ways in', () => {
  const lines = [road({ highway: 'residential' }, [[50, 20], [63.9, 30], [80, 40]]), road({ highway: 'residential' }, [[63.9, 30], [63.9, 50]])];
  expect(seamGap(tileOf(TILE, lines), tileOf(B, [...lines].reverse()))).toBeLessThan(0.05);
});
it('meets its neighbour where the two tiles cut a long segment at different places', () => {
  const at = (x: number): [number, number] => [x, 30 + ((x - 40) * 4) / 50];
  expect(seamGap(tileOf(TILE, [road({ highway: 'residential' }, [at(40), at(80)])]), tileOf(B, [road({ highway: 'residential' }, [at(50), at(90)])]))).toBeLessThan(0.05);
});
it('gives a straight graded road its own height just off its bed, wherever its samples fall', () => {
  const net = buildRoadNet([road({ highway: 'residential' }, [[4, 32], [60, 32]])]);
  const z = Float64Array.from(net.samples, (s) => 500 + 0.2 * s.d);
  const pull = buildRoadPull(TILE, GRID, { net, z });
  const [x0] = metresOf(...(net.ways[0].line.points[0] as [number, number]));
  for (let x = 20; x < 40; x += 0.37) {
    const [xm] = metresOf(...(road({}, [[x, 32]]).points[0] as [number, number]));
    const want = 500 + 0.2 * (xm - x0);
    // the relief there at the road's own height: what is measured is R, the roads' height
    expect(pull.height(x, 32 + (4 + BED_MARGIN_M) * M, want)).toBeCloseTo(want, 1);
  }
});
it('keeps a bed outline off the bed at a corner', () => {
  // an 80° turn (unmitred, its outline came 0.7 m into the bed); in a hairpin the two legs' beds
  // overlap and the inner outline lies on the other leg's bed, as it should
  const net = buildRoadNet([road({ highway: 'residential' }, [[10, 32], [32, 32], [34, 44]])]);
  const pull = buildRoadPull(TILE, GRID, { net, z: flatZ(net) });
  const axis = net.samples;
  for (const p of pull.beds[0].edges.flat()) {
    let d = Infinity;
    for (const w of net.ways) for (let k = w.first; k + 1 < w.first + w.count; k++) {
      const [ax, ay] = metresOf(axis[k].lon, axis[k].lat), [bx, by] = metresOf(axis[k + 1].lon, axis[k + 1].lat);
      const px = p.x / M, py = p.y / M, dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    expect(d).toBeGreaterThan(4 - 0.05);
  }
});
it('has a height a hair off the bed edge', () => {
  const net = buildRoadNet([road({ highway: 'residential' }, [[4, 32], [60, 32]])]);
  const pull = buildRoadPull(TILE, GRID, { net, z: flatZ(net, 520) });
  // just past the edge, where the smooth step rounds to 1 (u / (1 − u) would be ∞ / ∞)
  for (let k = 1; k < 400; k++) expect(Number.isFinite(pull.height(32, 32 + (4 + k * 1e-15) * M, 500))).toBe(true);
});

it('keeps a short bridge over a canal level with the street: the water lies in its channel', () => {
  // flat ground at 500 m; a 10 m tertiary bridge (layer 1) over a canal at a junction
  const s = (10 * M) / 2;
  const lines: OsmLine[] = [
    road({ highway: 'tertiary' }, [[32, 10], [32, 32 - s]]), road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [[32, 32 - s], [32, 32 + s]]),
    road({ highway: 'tertiary' }, [[32, 32 + s], [32, 54]]), road({ highway: 'residential' }, [[10, 32 - s], [32, 32 - s]]),
    road({ waterway: 'canal' }, [[4, 32], [60, 32]]),
  ];
  const net = buildRoadNet(lines);
  const roads = roadSurfaceOf(TILE, { lines, areas: [] }, net, new Float64Array(net.samples.length).fill(500));
  const of = (k: number) => Array.from(roads.z.subarray(net.ways[k].first, net.ways[k].first + net.ways[k].count));
  expect(Math.max(...of(1))).toBeLessThan(500 + 0.05); // the bridge: no hump
  expect(Math.max(...of(0), ...of(2), ...of(3))).toBeLessThan(500 + 0.05); // nor ramps on the streets round it
  for (const v of of(4)) expect(v).toBeCloseTo(500 - WATER_DEPTH_M.canal, 6); // the canal 2.5 m down
});
