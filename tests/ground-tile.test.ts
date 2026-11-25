import { describe, expect, it, vi } from 'vitest';
import { gridLatLon } from '../src/world/geodesy';
import { buildGroundTile, groundSampler, packGround } from '../src/world/ground-tile';
import { buildGroundCover } from '../src/world/ground-cover';
import { parseOverpass } from '../src/world/overpass';
import { fetchRoadSurface } from '../src/world/surface-tin';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { tinSampler } from '../src/world/terrain-tin';
import { bordersOf, demOf, GRID, lattice, road, TILE, townOverpassJson } from './roads-helpers';

const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
vi.mock('../src/world/tile-cache', () => ({
  setOsmRawStamp: () => undefined,
  getOsmRaw: async () => ({ key: 'raw', ts: 0, json: townOverpassJson() }),
}));
vi.mock('../src/world/terrain-source', async (orig) => ({
  ...(await orig<typeof import('../src/world/terrain-source')>()),
  loadTileDem: async () => ({ heights: lattice(relief), borders: bordersOf(relief) }),
  demHeights: async (points: ReadonlyArray<unknown>) => new Float64Array(points.length).fill(500),
}));

describe('a ground tile packed for the main thread', () => {
  it('samples the same surface as the TIN it was packed from', () => {
    const relief = (xm: number, ym: number) => 500 + 0.1 * xm + 0.2 * ym;
    const net = buildRoadNet([road({ highway: 'primary' }, [[5, 24], [59, 24]])]);
    const tin = buildSurfaceTin(TILE, GRID, lattice(relief), { roads: { net, z: solveRoadHeights(net, demOf(net, relief)) } });
    const packed = packGround(tin, []);
    // plain arrays that cross a worker boundary
    expect(packed.tris).toBeInstanceOf(Uint32Array);
    expect(packed.vx).toBeInstanceOf(Float64Array);
    const a = tinSampler(tin, TILE), b = groundSampler(packed, TILE);
    for (let j = 0; j <= 20; j++) {
      for (let i = 0; i <= 20; i++) {
        const ll = gridLatLon(TILE, (i * GRID) / 20, (j * GRID) / 20, GRID);
        expect(b(ll.lon, ll.lat)).toBe(a(ll.lon, ll.lat));
      }
    }
  });
});

describe('the collision ground of a tile with its covers', () => {
  it('is the surface the terrain worker renders: the same TIN built with the covers', async () => {
    const data = parseOverpass(JSON.parse(townOverpassJson()));
    const roads = await fetchRoadSurface(TILE, data, []);
    const cover = buildGroundCover(TILE, GRID, data, roads);
    const rendered = buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), coast: undefined, pads: [], roads, cover });
    const bare = buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), coast: undefined, pads: [], roads });
    expect(rendered.tris.length).not.toBe(bare.tris.length); // the covers' edges are in the surface
    const g = await buildGroundTile(TILE);
    const want = packGround(rendered, undefined);
    expect(g.tris).toEqual(want.tris);
    expect(g.vx).toEqual(want.vx);
    expect(g.vy).toEqual(want.vy);
    expect(g.vh).toEqual(want.vh);
  });
});
