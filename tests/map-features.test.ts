import { describe, expect, it } from 'vitest';
import { RetryableError } from '../src/engine/queue';
import {
  featureName, featureTiles, KIND_PRIORITY, mapFeatureQuery, mapLevelForSpan, MapFeatureSource, parseMapFeatures,
  type FeatureStore,
} from '../src/world/map-features';
import type { OverpassJson } from '../src/world/overpass';

const json = {
  elements: [
    { type: 'node', id: 1, lat: 50.11, lon: 8.68, tags: { place: 'city', name: 'Frankfurt am Main', 'name:ru': 'Франкфурт-на-Майне' } },
    { type: 'node', id: 2, lat: 50.0, lon: 8.27, tags: { place: 'town', name: 'Mainz' } },
    { type: 'node', id: 3, lat: 50.2, lon: 8.5, tags: { place: 'village', name: 'Dorf', 'name:en': 'Village' } },
    { type: 'node', id: 4, lat: 50.3, lon: 8.6, tags: { place: 'hamlet', name: 'Weiler' } },
    { type: 'way', id: 5, center: { lat: 50.033, lon: 8.57 }, tags: { aeroway: 'aerodrome', icao: 'EDDF', iata: 'FRA', name: 'Frankfurt Airport' } },
    { type: 'way', id: 6, center: { lat: 50.15, lon: 8.4 }, tags: { aeroway: 'aerodrome', icao: 'EDFE', name: 'Egelsbach' } },
    { type: 'way', id: 7, center: { lat: 50.16, lon: 8.41 }, tags: { aeroway: 'aerodrome', name: 'Segelfluggelände' } },
    { type: 'node', id: 8, lat: 50.12, lon: 8.69, tags: { aeroway: 'heliport', name: 'Klinikum' } },
    { type: 'way', id: 9, tags: { aeroway: 'aerodrome' } }, // no centre: skipped
  ],
} as unknown as OverpassJson;

describe('map features', () => {
  it('reads settlements and airfields (ways at their centre), skipping other places', () => {
    const f = parseMapFeatures(json);
    expect(f.map((x) => x.kind)).toEqual(['city', 'town', 'village', 'airport', 'airfield', 'airfield', 'heliport']);
    const eddf = f.find((x) => x.code === 'EDDF')!;
    expect(eddf.kind).toBe('airport');
    expect([eddf.lat, eddf.lon]).toEqual([50.033, 8.57]);
    expect(f.find((x) => x.code === 'EDFE')!.kind).toBe('airfield');
    expect(f[0].code).toBeUndefined();
  });

  it('names follow the UI language, then English, then the local name', () => {
    const [city, town, village] = parseMapFeatures(json);
    expect(featureName(city, 'ru')).toBe('Франкфурт-на-Майне');
    expect(featureName(city, 'en')).toBe('Frankfurt am Main');
    expect(featureName(village, 'ua')).toBe('Village');
    expect(featureName(town, 'ru')).toBe('Mainz');
  });

  it('the flight map asks for villages and every airfield, the start-screen map for towns and ICAO airfields', () => {
    expect(mapLevelForSpan(40000)).toBe('local');
    expect(mapLevelForSpan(500000)).toBe('region');
    const tile = { z: 10, x: 536, y: 346 };
    const local = mapFeatureQuery(tile, 'local');
    expect(local).toContain('city|town|village');
    expect(local).toContain('aerodrome|heliport');
    expect(local).toContain('out center tags');
    const region = mapFeatureQuery({ z: 7, x: 67, y: 43 }, 'region');
    expect(region).not.toContain('village');
    expect(region).toContain('["icao"]');
    // a 40 km box at 50° N needs a few z10 tiles
    const tiles = featureTiles({ lat: 50.1, lon: 8.66 }, 0.18, 0.28, 'local');
    expect(tiles.every((t) => t.z === 10)).toBe(true);
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(tiles.length).toBeLessThanOrEqual(12);
    expect(KIND_PRIORITY.city).toBeLessThan(KIND_PRIORITY.village);
  });

  it('source: cache first, Overpass once per tile, one request at a time, retry after a failure', async () => {
    const saved = new Map<string, string>();
    const store: FeatureStore = { get: async (k) => saved.get(k), put: async (k, v) => { saved.set(k, v); } };
    let calls = 0;
    let fail = true;
    const fetchQuery = async () => {
      calls++;
      if (fail) throw new RetryableError(1000, 'busy');
      return JSON.stringify(json);
    };
    const src = new MapFeatureSource(store, fetchQuery);
    const tile = { z: 10, x: 536, y: 346 };
    const settle = () => new Promise((r) => setTimeout(r, 0));

    expect(src.features([tile], 'local', 0)).toEqual([]);
    await settle();
    expect(calls).toBe(1);
    // failed: not asked again before the retry time
    src.features([tile], 'local', 1000);
    await settle();
    expect(calls).toBe(1);
    fail = false;
    src.features([tile], 'local', Date.now() + 120000);
    await settle();
    await settle();
    expect(calls).toBe(2);
    expect(src.version).toBe(1);
    expect(src.features([tile], 'local')).toHaveLength(7);
    expect(saved.size).toBe(1);

    // a fresh source reads the cached tile without Overpass
    const again = new MapFeatureSource(store, fetchQuery);
    again.features([tile], 'local');
    await settle();
    await settle();
    expect(calls).toBe(2);
    expect(again.features([tile], 'local')).toHaveLength(7);
  });
});

describe('map feature queue', () => {
  it('fetches the tile asked for last first and drops tiles no map wants any more', async () => {
    const asked: string[] = [];
    let release: () => void = () => {};
    const store: FeatureStore = { get: async () => undefined, put: async () => {} };
    const fetchQuery = (q: string) => {
      asked.push(q);
      return new Promise<string>((r) => { release = () => r('{"elements":[]}'); });
    };
    const src = new MapFeatureSource(store, fetchQuery);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const t = (x: number) => ({ z: 10, x, y: 346 });
    src.features([t(1)], 'local', 0); // in flight
    await settle();
    src.features([t(2), t(3)], 'local', 100); // flown past: never asked again
    src.features([t(4)], 'local', 10000);
    release();
    await settle();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe(mapFeatureQuery(t(4), 'local'));
    release();
    await settle();
    await settle();
    expect(asked).toHaveLength(2);
  });
});
