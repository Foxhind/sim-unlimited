import { afterEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('../src/world/tile-cache', () => ({
  getOsmRaw: async (key: string) => (store.has(key) ? { key, ts: 0, json: store.get(key)! } : undefined),
  putOsmRaw: async (r: { key: string; json: string }) => void store.set(r.key, r.json),
}));

const { OsmSource } = await import('../src/world/osm-source');

const TILE = { z: 14, x: 9516, y: 6398 };
const API_REPLY = {
  elements: [
    { type: 'node', id: 1, lon: 29.1, lat: 36.62 }, { type: 'node', id: 2, lon: 29.1001, lat: 36.62 },
    { type: 'node', id: 3, lon: 29.1001, lat: 36.6201 }, { type: 'node', id: 4, lon: 29.1, lat: 36.6201 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'house' } },
    { type: 'way', id: 11, nodes: [1, 2], tags: { highway: 'path' } },
  ],
};

function stubFetch(overpass: () => Response | never) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input);
    calls.push(url.includes('api.openstreetmap.org') ? 'api' : 'overpass');
    if (url.includes('api.openstreetmap.org')) return new Response(JSON.stringify(API_REPLY), { status: 200 });
    return overpass();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  store.clear();
});

describe('OsmSource', () => {
  it('auto: Overpass unreachable → OSM API 0.6, then skips Overpass for a while', async () => {
    const calls = stubFetch(() => new Response('', { status: 502 }));
    const src = new OsmSource('auto');
    const data = await src.fetch(TILE, 'full');
    // the tile, then the four strips of roads round it (ROAD_REACH_M)
    const API_TILE = ['api', 'api', 'api', 'api', 'api'];
    expect(calls).toEqual(['overpass', ...API_TILE]);
    expect(data.buildings).toHaveLength(1);
    expect(data.lines).toHaveLength(0); // highway=path is not drawn
    await src.fetch({ ...TILE, x: TILE.x + 1 }, 'full');
    expect(calls).toEqual(['overpass', ...API_TILE, ...API_TILE]);
  });

  it('caches the filtered answer and serves it without the network', async () => {
    const calls = stubFetch(() => new Response('', { status: 502 }));
    await new OsmSource('osm-api').fetch(TILE, 'full');
    const cached = JSON.parse([...store.values()][0]) as { elements: Array<{ id: number }> };
    expect(cached.elements.map((e) => e.id)).toEqual([1, 2, 3, 4, 10]);
    await new OsmSource('osm-api').fetch(TILE, 'full');
    expect(calls).toEqual(['api', 'api', 'api', 'api', 'api']); // the tile and the strips round it, once
  });

  it('far tiles are not served by the API and not cached', async () => {
    const calls = stubFetch(() => new Response('', { status: 502 }));
    const data = await new OsmSource('osm-api').fetch({ z: 10, x: 594, y: 399 }, 'large');
    expect(data).toEqual({ areas: [], lines: [], points: [], buildings: [] });
    expect(calls).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('auto: a working Overpass is used as before', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    await new OsmSource('auto').fetch(TILE, 'full');
    expect(calls).toEqual(['overpass']);
  });
});
