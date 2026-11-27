import { describe, expect, it } from 'vitest';
import {
  featureName, KIND_PRIORITY, mapLevelForSpan, MapFeatureSource, parseMapFeatures, shownAt,
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

  it('the flight map shows villages and every airfield, the start-screen map towns and ICAO airfields', () => {
    expect(mapLevelForSpan(40000)).toBe('local');
    expect(mapLevelForSpan(500000)).toBe('region');
    const f = parseMapFeatures(json);
    expect(f.filter((x) => shownAt(x, 'local'))).toHaveLength(7);
    expect(f.filter((x) => shownAt(x, 'region')).map((x) => x.code ?? x.names.name))
      .toEqual(['Frankfurt am Main', 'Mainz', 'EDDF', 'EDFE']);
    expect(KIND_PRIORITY.city).toBeLessThan(KIND_PRIORITY.village);
  });

  it('source: the prepared places.json of the archives over the box, once each, retried after a failure', async () => {
    const box = { west: 8, south: 49.9, east: 9, north: 50.5 };
    const located: unknown[] = [];
    const locate = async (b: unknown) => {
      located.push(b);
      return ['https://x/a.places.json'];
    };
    let calls = 0;
    let fail = true;
    const fetchImpl = (async () => {
      calls++;
      if (fail) return new Response('', { status: 503 });
      return new Response(JSON.stringify(json));
    }) as typeof fetch;
    const src = new MapFeatureSource(locate, fetchImpl);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(src.features(box, 'local', 0)).toEqual([]);
      await settle();
      expect(located).toHaveLength(1);
      src.features(box, 'local', 0);
      await settle();
      await settle();
      expect(calls).toBe(1);
      // failed: not asked again before the retry time; the same box is not located again
      src.features(box, 'local', 1000);
      await settle();
      expect(calls).toBe(1);
      expect(located).toHaveLength(1);
      fail = false;
      src.features(box, 'local', Date.now() + 120000);
      await settle();
      await settle();
      expect(calls).toBe(2);
      expect(src.features(box, 'local')).toHaveLength(7);
      // features outside the box are left out; the file is not fetched again
      expect(src.features({ west: 8.6, south: 50.1, east: 8.7, north: 50.2 }, 'local')).toHaveLength(2);
      await settle();
      expect(calls).toBe(2);
    } finally {
      console.warn = warn;
    }
  });

  it('an archive without places.json (404) is not asked for again', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const src = new MapFeatureSource(async () => ['https://x/old.places.json'], fetchImpl);
    const box = { west: 0, south: 0, east: 1, north: 1 };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    src.features(box, 'local');
    await settle();
    src.features(box, 'local');
    await settle();
    await settle();
    src.features(box, 'local', Date.now() + 1e9);
    await settle();
    expect(calls).toBe(1);
  });
});
