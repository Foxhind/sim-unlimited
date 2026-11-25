import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bordersOf, GRID, lattice, TILE, townOverpassJson, parkOverpassJson } from './roads-helpers';
import type { SurfaceTin } from '../src/world/surface-tin';

const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
const store = new Map<string, unknown>();
let osmJson: string | undefined;
/** when the raw OSM was downloaded */
let osmTs = 0;
/** the cache refuses every write (its quota) */
let cacheFull = false;

vi.mock('../src/world/tile-cache', () => ({
  setOsmRawStamp: () => undefined,
  SCHEMA_VERSION: 69,
  getCachedMesh: async (key: string) => store.get(key),
  putCachedMesh: async (r: { key: string }) => {
    if (cacheFull) throw new DOMException('quota', 'QuotaExceededError');
    store.set(r.key, r);
  },
  getOsmRaw: async () => (osmJson ? { key: 'raw', ts: osmTs, json: osmJson } : undefined),
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

/** the cached entry whose key starts so: the OSM worker's mesh (osmmesh), the terrain's (dem) */
const cachedOf = (prefix: string) => [...store.entries()].find(([k]) => k.startsWith(prefix))?.[1] as Record<string, any> | undefined;

beforeEach(() => {
  cacheFull = false;
  store.clear();
  osmJson = townOverpassJson();
  osmTs = 0;
});

describe('the OSM worker with the covers', () => {
  it('a full cache fails no tile: both workers send their meshes', async () => {
    cacheFull = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await osmReply()).res.bVertices).toBeInstanceOf(ArrayBuffer);
    expect(await terrainTin()).toBeDefined();
    expect(store.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves the z14 terrain mesh on its surface in the terrain\'s cache: the same bytes, no surface built again', async () => {
    osmTs = 7;
    const o = await osmReply();
    const shared = cachedOf('dem/')!;
    expect(shared.key).toMatch(/\/op@7$|\/o@7$/);
    // the terrain worker takes it: a mesh, no surface built
    expect(await terrainTin()).toBeUndefined();
    expect(new Uint8Array(posted[0].vertices)).toEqual(new Uint8Array(shared.vertices));
    // and it is what the terrain worker builds itself
    store.delete(shared.key);
    const t = await terrainTin();
    expect(t.tris).toEqual(o.tin!.tris);
    const own = cachedOf('dem/')!;
    for (const k of ['vertices', 'ramps', 'morph']) expect(own[k] && new Uint8Array(own[k])).toEqual(shared[k] && new Uint8Array(shared[k]));
    expect([own.nearCount, own.farCount]).toEqual([shared.nearCount, shared.farCount]);
  });

  it('leaves no terrain mesh below the detail zoom, nor over one already cached', async () => {
    await osmReply('large');
    expect(cachedOf('dem/')).toBeUndefined();
    await terrainTin();
    const before = cachedOf('dem/')!;
    for (const k of [...store.keys()]) if (k.startsWith('osmmesh')) store.delete(k);
    await osmReply();
    expect(cachedOf('dem/')).toBe(before);
  });

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

  it('builds again once the raw OSM was downloaded anew, on the surface the terrain worker builds from it', async () => {
    const first = await osmReply();
    expect(first.tin).toBeDefined();
    expect((await osmReply()).tin).toBeUndefined();
    // the raw was fetched again (by whoever): neither worker serves the mesh of the old one
    osmJson = parkOverpassJson();
    osmTs = 1000;
    const { res, tin } = await osmReply();
    expect(tin).toBeDefined();
    expect(res.roads).toBe(true);
    // the terrain mesh of the new raw is the OSM worker's, cached on its surface: no surface built again
    expect(await terrainTin()).toBeUndefined();
    // and the terrain worker builds that surface itself without it
    for (const k of [...store.keys()]) if (k.startsWith('dem/')) store.delete(k);
    const t = await terrainTin();
    expect(t.tris).toEqual(tin!.tris);
    expect(t.cover).toEqual(tin!.cover);
    // and both from the cache after
    expect((await osmReply()).tin).toBeUndefined();
    expect(await terrainTin()).toBeUndefined();
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
    const cached = cachedOf('osmmesh')!;
    expect('glowVertices' in cached).toBe(false);
  });

  it('sends and caches the structure kinds of the building vertices: ascending runs on whole triangles', async () => {
    const { res } = await osmReply();
    const cached = cachedOf('osmmesh') as Record<string, ArrayBuffer>;
    for (const m of [res, cached]) {
      const runs = new Uint32Array(m.bKinds);
      const vertexCount = m.bRamps.byteLength / 4;
      expect(runs.length % 2).toBe(0);
      if (vertexCount > 0) expect(runs[0]).toBe(0);
      for (let i = 0; i < runs.length; i += 2) {
        expect(runs[i] % 3).toBe(0);
        expect(runs[i]).toBeLessThanOrEqual(vertexCount);
        if (i) expect(runs[i]).toBeGreaterThan(runs[i - 2]);
      }
    }
  });

  it('sends and caches the depth levels of the drape, the roads and the water, per vertex or none', async () => {
    const { res } = await osmReply();
    const cached = cachedOf('osmmesh') as Record<string, ArrayBuffer>;
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

  it('is cache schema 115', () => {
    expect(OSM_MESH_SCHEMA).toBe(115);
  });
});
