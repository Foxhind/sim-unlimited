import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AREA_STYLES, type AreaStyles } from '../src/world/area-styles';
import { bordersOf, GRID, lattice, TILE, townOverpassJson, parkOverpassJson } from './roads-helpers';

const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
const store = new Map<string, unknown>();
const getCachedMesh = vi.fn(async (key: string) => store.get(key));
const putCachedMesh = vi.fn(async (r: { key: string }) => void store.set(r.key, r));
let osmJson: string | undefined;
/** when the raw OSM was downloaded */
let osmTs = 0;

vi.mock('../src/world/tile-cache', () => ({
  SCHEMA_VERSION: 69,
  getCachedMesh: (key: string) => getCachedMesh(key),
  putCachedMesh: (r: { key: string }) => putCachedMesh(r),
  getOsmRaw: async () => (osmJson ? { key: 'raw', ts: osmTs, json: osmJson } : undefined),
}));
vi.mock('../src/world/terrain-source', async (orig) => ({
  ...(await orig<typeof import('../src/world/terrain-source')>()),
  loadTileDem: async () => ({ heights: lattice(relief), borders: bordersOf(relief) }),
  demHeights: async (points: ReadonlyArray<unknown>) => new Float64Array(points.length).fill(500),
}));

/** the worker's reply to a request, and the messages it posted */
const posted: Array<Record<string, any>> = [];
const scope = { onmessage: null as null | ((e: { data: unknown }) => Promise<void>), postMessage: (m: Record<string, any>) => void posted.push(m) };
vi.stubGlobal('self', scope);
await import('../src/workers/terrain.worker');

async function ask(req: Record<string, unknown>): Promise<Record<string, any>> {
  posted.length = 0;
  await scope.onmessage!({ data: { type: 'tile', id: 1, tile: TILE, grid: GRID, ...req } });
  expect(posted[0].type).toBe('mesh');
  return posted[0];
}

const GREEN: AreaStyles = { ...DEFAULT_AREA_STYLES, park: { colour: [255, 0, 255], mode: 'normal', strength: 1 } };

beforeEach(() => {
  store.clear();
  getCachedMesh.mockClear();
  putCachedMesh.mockClear();
  osmJson = townOverpassJson();
  osmTs = 0;
});

describe('the terrain worker with the covers', () => {
  it('builds a z14 tile with OSM with its road faces after the near ones, and caches the counts', async () => {
    const m = await ask({});
    const vertexCount = m.ramps.byteLength / 4;
    expect(m.nearCount).toBeGreaterThan(0);
    expect(m.farCount).toBeGreaterThan(m.nearCount);
    expect(m.farCount).toBeLessThanOrEqual(vertexCount);
    expect(putCachedMesh).toHaveBeenCalledTimes(1);
    const cached = putCachedMesh.mock.calls[0][0] as { nearCount?: number; farCount?: number };
    expect([cached.nearCount, cached.farCount]).toEqual([m.nearCount, m.farCount]);
    // a second request is the cached mesh with the same counts
    const again = await ask({});
    expect([again.nearCount, again.farCount]).toEqual([m.nearCount, m.farCount]);
    expect(putCachedMesh).toHaveBeenCalledTimes(1);
  });

  it('builds again once the raw OSM was downloaded anew: a cached mesh is of the raw OSM that built it', async () => {
    const town = await ask({});
    expect(putCachedMesh).toHaveBeenCalledTimes(1);
    // the raw expired and was fetched again (another day's OSM): the OSM mesh is built from it, so is the terrain
    osmJson = parkOverpassJson();
    osmTs = 1000;
    const park = await ask({});
    expect(putCachedMesh).toHaveBeenCalledTimes(2);
    expect(putCachedMesh.mock.calls[1][0].key).not.toBe(putCachedMesh.mock.calls[0][0].key);
    expect(park.farCount - park.nearCount).not.toBe(town.farCount - town.nearCount);
    // the same raw again: the cached mesh
    await ask({});
    expect(putCachedMesh).toHaveBeenCalledTimes(2);
  });

  it('has no counts without OSM: the whole mesh is drawn as ever', async () => {
    osmJson = undefined;
    const m = await ask({});
    expect(m.nearCount).toBeUndefined();
    expect(m.farCount).toBeUndefined();
  });

  it('neither reads nor writes the cache with area styles not the defaults, and colours a park face with the filter', async () => {
    const plain = await ask({});
    getCachedMesh.mockClear();
    putCachedMesh.mockClear();
    const styled = await ask({ areaStyles: GREEN });
    expect(getCachedMesh).not.toHaveBeenCalled();
    expect(putCachedMesh).not.toHaveBeenCalled();
    const a = new Uint32Array(plain.ramps), b = new Uint32Array(styled.ramps);
    expect(b.length).toBe(a.length);
    expect(b.some((v, i) => v !== a[i])).toBe(true);
    // the default styles are the cached way
    getCachedMesh.mockClear();
    await ask({ areaStyles: DEFAULT_AREA_STYLES });
    expect(getCachedMesh).toHaveBeenCalledTimes(1);
  });

  it('builds the covers for a z14 tile whose OSM has a park and no roads: a park-coloured face', async () => {
    osmJson = parkOverpassJson();
    const plain = await ask({});
    expect(plain.nearCount).toBeDefined();
    // the park's filter reaches the faces, so the cover was built
    const styled = await ask({ areaStyles: GREEN });
    const a = new Uint32Array(plain.ramps), b = new Uint32Array(styled.ramps);
    expect(b.some((v, i) => v !== a[i])).toBe(true);
  });
});
