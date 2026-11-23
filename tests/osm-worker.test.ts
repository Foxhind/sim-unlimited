import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bordersOf, GRID, lattice, TILE, townOverpassJson, parkOverpassJson } from './roads-helpers';
import type { SurfaceTin } from '../src/world/surface-tin';

const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
const store = new Map<string, unknown>();
let osmJson: string | undefined;

vi.mock('../src/world/tile-cache', () => ({
  SCHEMA_VERSION: 63,
  getCachedMesh: async (key: string) => store.get(key),
  putCachedMesh: async (r: { key: string }) => void store.set(r.key, r),
  getOsmRaw: async () => (osmJson ? { key: 'raw', ts: 0, json: osmJson } : undefined),
}));
vi.mock('../src/world/terrain-source', async (orig) => ({
  ...(await orig<typeof import('../src/world/terrain-source')>()),
  loadTileDem: async () => ({ heights: lattice(relief), borders: bordersOf(relief) }),
  demHeights: async (points: ReadonlyArray<unknown>) => new Float64Array(points.length).fill(500),
}));
/** every surface TIN a worker builds, in order */
const tins: SurfaceTin[] = [];
vi.mock('../src/world/surface-tin', async (orig) => {
  const m = await orig<typeof import('../src/world/surface-tin')>();
  return { ...m, buildSurfaceTin: (...a: Parameters<typeof m.buildSurfaceTin>) => { const t = m.buildSurfaceTin(...a); tins.push(t); return t; } };
});

type Handler = (e: { data: unknown }) => Promise<void>;
const posted: Array<Record<string, any>> = [];
const load = async (path: string): Promise<Handler> => {
  const scope = { onmessage: null as null | Handler, postMessage: (m: Record<string, any>) => void posted.push(m) };
  vi.stubGlobal('self', scope);
  await import(path);
  return scope.onmessage!;
};
const terrain = await load('../src/workers/terrain.worker');
const osm = await load('../src/workers/osm.worker');
const { OSM_MESH_SCHEMA } = await import('../src/workers/osm.worker');

async function terrainTin(): Promise<SurfaceTin> {
  posted.length = 0; tins.length = 0;
  await terrain({ data: { type: 'tile', id: 1, tile: TILE, grid: GRID } });
  expect(posted[0].type).toBe('mesh');
  return tins[0];
}
async function osmReply(detail: 'full' | 'large' = 'full'): Promise<{ res: Record<string, any>; tin?: SurfaceTin }> {
  posted.length = 0; tins.length = 0;
  await osm({ data: { type: 'osm', id: 2, tile: TILE, detail } });
  expect(posted[0].type).toBe('mesh');
  return { res: posted[0], tin: tins[0] };
}

beforeEach(() => {
  store.clear();
  osmJson = townOverpassJson();
});

describe('the OSM worker with the covers', () => {
  it('builds the drape on the same surface and covers as the terrain worker', async () => {
    const t = await terrainTin();
    store.clear();
    const o = (await osmReply()).tin!;
    expect(t.cover).toBeDefined();
    expect(o.tris).toEqual(t.tris);
    expect(o.cover).toEqual(t.cover);
  });

  it('builds the covers for a z14 tile with a park and no roads, and says the terrain needs a rebuild', async () => {
    osmJson = parkOverpassJson();
    const { res, tin } = await osmReply();
    expect(tin!.cover).toBeDefined();
    expect(res.roads).toBe(true);
    // from the cache the flag is false
    const again = await osmReply();
    expect(again.res.roads).toBe(false);
  });

  it('builds no cover below the detail zoom', async () => {
    const { tin, res } = await osmReply('large');
    expect(tin!.cover).toBeUndefined();
    expect(res.roads).toBe(false);
  });

  it('sends no glow ground', async () => {
    const { res } = await osmReply();
    expect('glowVertices' in res).toBe(false);
    expect('glowRamps' in res).toBe(false);
    const cached = [...store.values()][0] as Record<string, unknown>;
    expect('glowVertices' in cached).toBe(false);
  });

  it('sends and caches the depth levels of the drape, the roads and the water, per vertex or none', async () => {
    const { res } = await osmReply();
    const cached = [...store.values()][0] as Record<string, ArrayBuffer>;
    for (const m of [res, cached]) {
      for (const [levels, ramps] of [['levels', 'ramps'], ['rLevels', 'rRamps'], ['wLevels', 'wRamps']]) {
        expect(m[levels]).toBeInstanceOf(ArrayBuffer);
        expect([0, m[ramps].byteLength]).toContain(m[levels].byteLength);
      }
    }
    // from the cache the same
    const again = await osmReply();
    for (const k of ['levels', 'rLevels', 'wLevels']) expect(again.res[k].byteLength).toBe(res[k].byteLength);
  });

  it('is cache schema 74', () => {
    expect(OSM_MESH_SCHEMA).toBe(74);
  });
});
