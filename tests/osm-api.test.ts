import { describe, expect, it } from 'vitest';
import { RetryableError } from '../src/engine/queue';
import { completeRelations, fetchOsmApiMap, filterOsmApi, parseFilter } from '../src/world/osm-api';
import { osmFilter, parseOverpass, type OverpassJson } from '../src/world/overpass';

const node = (id: number, lon: number, lat: number, tags?: Record<string, string>) => ({ type: 'node' as const, id, lon, lat, ...(tags ? { tags } : {}) });
const way = (id: number, nodes: number[], tags?: Record<string, string>) => ({ type: 'way' as const, id, nodes, ...(tags ? { tags } : {}) });

// a square of nodes 1..4 and a line 5..6, plus unrelated nodes
const API: OverpassJson = {
  elements: [
    node(1, 0, 0), node(2, 0.001, 0), node(3, 0.001, 0.001), node(4, 0, 0.001),
    node(5, 0, 0.002), node(6, 0.001, 0.002), node(7, 0.002, 0.002, { amenity: 'bench' }),
    node(8, 0.003, 0.003, { aeroway: 'helipad' }),
    node(9, 0.004, 0.004), node(10, 0.005, 0.005),
    way(100, [1, 2, 3, 4, 1], { building: 'yes' }),
    way(101, [5, 6], { highway: 'footway' }),
    way(102, [5, 6], { highway: 'primary_link', name: 'Link' }),
    way(103, [9, 10], { highway: 'service' }),
    way(104, [1, 2, 3, 4, 1], { barrier: 'fence' }),
    { type: 'relation', id: 200, members: [{ type: 'way', ref: 104, role: 'outer' }], tags: { type: 'multipolygon', landuse: 'grass' } },
    { type: 'relation', id: 201, members: [{ type: 'way', ref: 103, role: 'outer' }], tags: { type: 'route', route: 'bus' } },
  ],
};

describe('parseFilter', () => {
  it('reads every Overpass statement of both detail levels', () => {
    const full = parseFilter(osmFilter('full'));
    expect(full.length).toBe((osmFilter('full').match(/;/g) ?? []).length);
    expect(full[0]).toMatchObject({ type: 'way', clauses: [{ key: 'building' }] });
    const multi = full.find((s) => s.type === 'relation' && s.clauses.some((c) => c.key === 'building'))!;
    expect(multi.clauses).toMatchObject([{ key: 'building' }, { key: 'type', op: '=', value: 'multipolygon' }]);
    expect(parseFilter(osmFilter('large')).length).toBeGreaterThan(5);
  });
});

describe('filterOsmApi', () => {
  const ids = (j: OverpassJson) => j.elements.map((e) => `${e.type[0]}${e.id}`);
  const out = filterOsmApi(API, 'full');

  it('keeps what the Overpass filter selects and drops the rest', () => {
    expect(ids(out)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n8', 'w100', 'w102', 'w104', 'r200']);
  });

  it('matches ~ like Overpass (unanchored regex) and = exactly', () => {
    expect(ids(out)).toContain('w102'); // primary_link ~ "…|primary|…"
    expect(ids(out)).not.toContain('w101'); // footway
    expect(ids(out)).not.toContain('w103'); // service, only in a bus route
  });

  it('keeps tags only on matched elements; members and geometry nodes are bare', () => {
    const get = (k: string) => out.elements.find((e) => `${e.type[0]}${e.id}` === k)!;
    expect(get('w100').tags).toEqual({ building: 'yes' });
    expect(get('w104').tags).toBeUndefined(); // fence, only an outer member of the grass multipolygon
    expect(get('n8').tags).toEqual({ aeroway: 'helipad' });
    expect(get('n1').tags).toBeUndefined();
  });

  it('parses into the same shapes as an Overpass answer', () => {
    const data = parseOverpass(out);
    expect(data.buildings).toHaveLength(1);
    expect(data.areas.map((a) => a.tags.landuse)).toEqual(['grass']);
    expect(data.lines.map((l) => l.tags.highway)).toEqual(['primary_link']);
    expect(data.points.map((p) => p.tags.aeroway)).toEqual(['helipad']);
  });

  it('far tiles use the large filter', () => {
    // only the grass multipolygon (with its bare member and nodes) is in the large filter
    expect(ids(filterOsmApi(API, 'large'))).toEqual(['n1', 'n2', 'n3', 'n4', 'w104', 'r200']);
  });
});

describe('fetchOsmApiMap', () => {
  const B = { west: 29, south: 36, east: 29.02, north: 36.02 };
  const reply = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('requests map.json with west,south,east,north', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(u), reply(200, { elements: [node(1, 29.01, 36.01)] }))) as unknown as typeof fetch;
    const j = await fetchOsmApiMap(B, f);
    expect(urls).toEqual(['https://api.openstreetmap.org/api/0.6/map.json?bbox=29.0000000,36.0000000,29.0200000,36.0200000']);
    expect(j.elements).toHaveLength(1);
  });

  it('quarters a bbox with too many nodes and merges without duplicates', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      if (urls.length === 1) return reply(400, 'You requested too many nodes (limit is 50000). Either request a smaller area, or use planet.osm');
      return reply(200, { elements: [node(1, 29.01, 36.01), node(urls.length, 29, 36)] });
    }) as unknown as typeof fetch;
    const j = await fetchOsmApiMap(B, f);
    expect(urls).toHaveLength(5);
    expect(j.elements.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('other 400s fail; 429/509/5xx and network errors retry later', async () => {
    const once = (r: Response | Error) => (async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
    await expect(fetchOsmApiMap(B, once(reply(400, 'bbox malformed')))).rejects.not.toBeInstanceOf(RetryableError);
    for (const s of [429, 509, 503]) await expect(fetchOsmApiMap(B, once(reply(s, '')))).rejects.toBeInstanceOf(RetryableError);
    await expect(fetchOsmApiMap(B, once(new TypeError('Failed to fetch')))).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('completeRelations', () => {
  // grass multipolygon whose second outer way lies outside the bbox (map.json leaves it out)
  const cut: OverpassJson = {
    elements: [
      node(1, 0, 0), node(2, 0.001, 0),
      way(300, [1, 2]),
      { type: 'relation', id: 400, members: [{ type: 'way', ref: 300, role: 'outer' }, { type: 'way', ref: 301, role: 'outer' }], tags: { type: 'multipolygon', landuse: 'grass' } },
      { type: 'relation', id: 401, members: [{ type: 'way', ref: 999, role: 'outer' }], tags: { type: 'route', route: 'bus' } },
    ],
  };
  const full = { elements: [node(1, 0, 0), node(2, 0.001, 0), node(3, 0.0005, 0.001), way(300, [1, 2]), way(301, [2, 3, 1]), cut.elements[3]] };

  it('fetches /relation/{id}/full only for selected relations missing members, and closes the ring', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(u), new Response(JSON.stringify(full), { status: 200 }))) as unknown as typeof fetch;
    const done = filterOsmApi(await completeRelations(cut, 'full', f), 'full');
    expect(urls).toEqual(['https://api.openstreetmap.org/api/0.6/relation/400/full.json']); // not the bus route
    const ring = parseOverpass(done).areas[0].rings[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(4);
  });

  it('drops a relation that is gone or too large instead of drawing an open ring', async () => {
    const gone = (async () => new Response('', { status: 410 })) as unknown as typeof fetch;
    expect(parseOverpass(filterOsmApi(await completeRelations(cut, 'full', gone), 'full')).areas).toEqual([]);
    const huge: OverpassJson = {
      elements: [{ type: 'relation', id: 402, members: Array.from({ length: 301 }, (_, k) => ({ type: 'way', ref: 1000 + k, role: 'outer' })), tags: { type: 'multipolygon', natural: 'water' } }],
    };
    const never = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    expect((await completeRelations(huge, 'full', never)).elements).toEqual([]);
  });

  it('a rate limit retries later, after Retry-After when given', async () => {
    const limited = (async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } })) as unknown as typeof fetch;
    const err = await completeRelations(cut, 'full', limited).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryMs).toBe(7000);
  });
});
