import { beforeEach, describe, expect, it } from 'vitest';
import { RetryableError } from '../src/engine/queue';
import { completeRelations, fetchOsmApiMap, fetchOsmApiTile, filterOsmApi, parseFilter, parseRetryAfter, resetOsmApiCooldown } from '../src/world/osm-api';
import { osmFilter, overpassQuery, parseOverpass, ROAD_REACH_M, type OverpassJson } from '../src/world/overpass';

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
    way(101, [5, 6], { highway: 'corridor' }),
    way(102, [5, 6], { highway: 'primary_link', name: 'Link' }),
    way(103, [9, 10], { highway: 'proposed' }),
    way(104, [1, 2, 3, 4, 1], { barrier: 'hedge' }),
    { type: 'relation', id: 200, members: [{ type: 'way', ref: 104, role: 'outer' }], tags: { type: 'multipolygon', landuse: 'farmland' } },
    { type: 'relation', id: 201, members: [{ type: 'way', ref: 103, role: 'outer' }], tags: { type: 'route', route: 'bus' } },
  ],
};

beforeEach(resetOsmApiCooldown);

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
    expect(ids(out)).toContain('w102'); // primary_link ~ "^((…|primary|…)(_link)?|…)$"
    expect(ids(out)).not.toContain('w101'); // corridor
    expect(ids(out)).not.toContain('w103'); // proposed, only in a bus route
  });

  it('keeps tags only on matched elements; members and geometry nodes are bare', () => {
    const get = (k: string) => out.elements.find((e) => `${e.type[0]}${e.id}` === k)!;
    expect(get('w100').tags).toEqual({ building: 'yes' });
    expect(get('w104').tags).toBeUndefined(); // hedge, only an outer member of the grass multipolygon
    expect(get('n8').tags).toEqual({ aeroway: 'helipad' });
    expect(get('n1').tags).toBeUndefined();
  });

  it('parses into the same shapes as an Overpass answer', () => {
    const data = parseOverpass(out);
    expect(data.buildings).toHaveLength(1);
    expect(data.areas.map((a) => a.tags.landuse)).toEqual(['farmland']);
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

describe('roads round a near tile', () => {
  const B = { west: 29, south: 36, east: 29.02, north: 36.02 };
  it('the OSM API adds the drawn roads of the strips round the tile, bare nodes only', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      const elements = urls.length === 1
        ? [node(1, 29.01, 36.01), way(10, [1], { building: 'yes' })]
        // every strip: a tertiary (node 2 inside the tile's answer already), a corridor, a building, a tagged node
        : [node(1, 29.01, 36.01), node(2, 29.01, 36.021, { entrance: 'yes' }), node(3, 29.01, 36.0205),
          way(20, [1, 2], { highway: 'tertiary' }), way(21, [2, 3], { highway: 'corridor' }), way(22, [3, 2], { building: 'yes' }),
          // what a bridge may cross out there (road-levels.ts): railways, waterways, water
          way(23, [2, 3], { railway: 'rail' }), way(24, [2, 3], { waterway: 'river' }), way(25, [2, 3, 2], { natural: 'water' }),
          way(26, [2, 3], { railway: 'abandoned' }), way(27, [2, 3, 2], { natural: 'wood' }),
          // a summit pulls up the ground over the border (peaks.ts): kept with its tags
          node(4, 29.005, 36.0203, { natural: 'peak', ele: '1200' })];
      return new Response(JSON.stringify({ elements }), { status: 200 });
    }) as unknown as typeof fetch;
    const j = await fetchOsmApiTile(B, 'full', f);
    expect(urls).toHaveLength(5);
    expect(j.elements.map((e) => `${e.type}/${e.id}`).sort()).toEqual(['node/1', 'node/2', 'node/3', 'node/4', 'way/10', 'way/20', 'way/23', 'way/24', 'way/25']);
    expect(j.elements.find((e) => e.id === 2)).not.toHaveProperty('tags');
    expect(j.elements.find((e) => e.type === 'node' && e.id === 4)).toHaveProperty('tags.natural', 'peak');
    // the strips reach ROAD_REACH_M past the tile
    const north = new URL(urls[1]).searchParams.get('bbox')!.split(',').map(Number);
    expect(north[1]).toBeCloseTo(36.02, 6);
    expect((north[3] - 36.02) * 111320).toBeCloseTo(ROAD_REACH_M, 0);
    // far tiles: no strips
    urls.length = 0;
    await fetchOsmApiTile(B, 'large', f);
    expect(urls).toHaveLength(1);
  });

  it('Overpass selects the drawn roads in the grown bbox', () => {
    const q = overpassQuery({ z: 14, x: 9919, y: 5117 }, 'full');
    expect(q).toMatch(/way\["highway"~"\^\(\(motorway[^;]*\]\([\d.]+,[\d.]+,[\d.]+,[\d.]+\);/);
    // a far tile: only the summits round it (peaks.ts), no roads
    expect(overpassQuery({ z: 14, x: 9919, y: 5117 }, 'large')).not.toMatch(/highway[^;]*\]\([\d.]+,/);
  });
});

describe('completeRelations', () => {
  // grass multipolygon whose second outer way lies outside the bbox (map.json leaves it out)
  const cut: OverpassJson = {
    elements: [
      node(1, 0, 0), node(2, 0.001, 0),
      way(300, [1, 2]),
      { type: 'relation', id: 400, members: [{ type: 'way', ref: 300, role: 'outer' }, { type: 'way', ref: 301, role: 'outer' }], tags: { type: 'multipolygon', landuse: 'farmland' } },
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

describe('rate limit cooldown', () => {
  const B = { west: 29, south: 36, east: 29.1, north: 36.1 };
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('60')).toBe(60000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('0')).toBeNull();
    expect(parseRetryAfter('Wed, 11 Nov 2026 17:58:44 GMT', Date.parse('Wed, 11 Nov 2026 17:57:44 GMT'))).toBe(60000);
  });

  it('assumes 60 s for a 509 whose Retry-After the browser hides', async () => {
    const f = (async () => new Response('You have downloaded too much data. Please try again in 60 seconds.', { status: 509 })) as unknown as typeof fetch;
    const err = await fetchOsmApiMap(B, f).catch((e: unknown) => e);
    expect((err as RetryableError).retryMs).toBe(60000);
  });

  it('sends no request while the penalty lasts', async () => {
    let calls = 0;
    const limited = (async () => { calls++; return new Response('', { status: 509 }); }) as unknown as typeof fetch;
    await fetchOsmApiMap(B, limited).catch(() => {});
    for (let i = 0; i < 5; i++) {
      const err = await fetchOsmApiMap(B, limited).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).retryMs).toBeGreaterThan(50000);
    }
    expect(calls).toBe(1);
  });
});
