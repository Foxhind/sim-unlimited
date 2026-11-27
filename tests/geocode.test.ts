import { describe, expect, it } from 'vitest';
import { distinctPlaces, Geocoder, NOMINATIM, placeOf } from '../src/ui/geocode';

describe('finding a start point by name (Nominatim)', () => {
  it('a hit: its name and the last three parts of where it is, in capitals, postcodes left out', () => {
    expect(placeOf({ lat: '46.2017', lon: '6.1469', name: 'Genève', display_name: 'Genève, Genève, 1204, Schweiz/Suisse/Svizzera/Svizra' }))
      .toEqual({ name: 'GENÈVE', where: 'GENÈVE, SCHWEIZ/SUISSE/SVIZZERA/SVIZRA', lat: 46.2017, lon: 6.1469 });
    expect(placeOf({ lat: 'x', lon: '1' })).toBeNull();
    // no name: the first part of the display name
    expect(placeOf({ lat: '1', lon: '2', display_name: 'A, B, C, D, E' })?.where).toBe('C, D, E');
  });
  it('the same name in the same place once', () => {
    const p = { name: 'A', where: 'B', lat: 1, lon: 2 };
    expect(distinctPlaces([p, { ...p, lat: 3 }, { ...p, where: 'C' }])).toHaveLength(2);
  });
  it('a map link or coordinates: one place at once, no request', async () => {
    let asked = 0;
    const g = new Geocoder((async () => { asked++; return new Response('[]'); }) as unknown as typeof fetch);
    expect(await g.search('47.26, 11.39', 'en')).toEqual([{ name: '47.26000, 11.39000', where: '', lat: 47.26, lon: 11.39 }]);
    expect(await g.search('   ', 'en')).toEqual([]);
    expect(asked).toBe(0);
  });
  it('asks in the language, no sooner than a second after the last request; fails on an error status', async () => {
    let t = 0;
    const urls: string[] = [], times: number[] = [];
    const slept: number[] = [];
    const g = new Geocoder(
      (async (url: string) => { urls.push(url); times.push(t); return new Response(JSON.stringify([{ lat: '1', lon: '2', name: 'X', display_name: 'X, Y' }])); }) as unknown as typeof fetch,
      () => t,
      async (ms) => { slept.push(ms); t += ms; },
    );
    const [a, b] = await Promise.all([g.search('Paris', 'ru'), g.search('Lyon', 'ru')]);
    expect(a[0].name).toBe('X');
    expect(b).toHaveLength(1);
    expect(urls[0]).toContain('q=Paris');
    expect(urls[0]).toContain('accept-language=ru');
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(NOMINATIM.GAP_MS);
    const bad = new Geocoder((async () => new Response('', { status: 429 })) as unknown as typeof fetch, () => 0, async () => undefined);
    await expect(bad.search('Paris', 'en')).rejects.toThrow(/429/);
  });
});
