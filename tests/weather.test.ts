import { describe, expect, it } from 'vitest';
import { weatherLines } from '../src/flight/hud';
import {
  cloudCode, compassPoint, parseWeather, surfaceFor, WEATHER_MAX_AGE_MS, WeatherService, weatherUrl, type Weather,
} from '../src/world/weather';

const AT = { lat: 55.75, lon: 37.62 };
const SAMPLE = {
  current: {
    time: '2026-11-12T17:00', interval: 900, temperature_2m: -16.4, cloud_cover: 75,
    wind_speed_10m: 5.2, wind_direction_10m: 225, wind_gusts_10m: 11.0,
  },
};

describe('winter thresholds', () => {
  it('snow from -4 °C, ice from -15 °C, nothing without data', () => {
    expect(surfaceFor(-3.9)).toEqual({ snow: false, ice: false });
    expect(surfaceFor(-4)).toEqual({ snow: true, ice: false });
    expect(surfaceFor(-14.9)).toEqual({ snow: true, ice: false });
    expect(surfaceFor(-15)).toEqual({ snow: true, ice: true });
    expect(surfaceFor(-40)).toEqual({ snow: true, ice: true });
    expect(surfaceFor(undefined)).toEqual({ snow: false, ice: false });
    expect(surfaceFor(NaN)).toEqual({ snow: false, ice: false });
  });
});

describe('Open-Meteo', () => {
  it('asks only for current temperature, clouds and wind in m/s', () => {
    const u = new URL(weatherUrl(AT));
    expect(u.origin).toBe('https://api.open-meteo.com');
    expect(u.searchParams.get('latitude')).toBe('55.750');
    expect(u.searchParams.get('current')).toBe('temperature_2m,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
    expect(u.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(u.searchParams.has('apikey')).toBe(false);
  });

  it('parses the current block (time in UTC)', () => {
    const w = parseWeather(SAMPLE, AT)!;
    expect(w).toMatchObject({ tempC: -16.4, cloudPct: 75, windFromDeg: 225, windMs: 5.2, gustMs: 11, at: AT });
    expect(w.time).toBe(Date.UTC(2026, 10, 12, 17, 0));
    expect(parseWeather({}, AT)).toBeUndefined();
    expect(parseWeather({ current: { cloud_cover: 3 } }, AT)).toBeUndefined();
    expect(parseWeather(null, AT)).toBeUndefined();
  });
});

describe('WeatherService', () => {
  const okFetch = () => {
    const calls: string[] = [];
    const fn = (url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
    };
    return { calls, fn };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('fetches once, then again only when stale or 25+ km away', async () => {
    const f = okFetch();
    const s = new WeatherService(f.fn);
    s.update(AT, 0);
    s.update(AT, 10); // in flight: no second request
    await flush();
    expect(f.calls).toHaveLength(1);
    expect(s.tempC).toBe(-16.4);
    expect(s.surface).toEqual({ snow: true, ice: true });
    s.update({ lat: AT.lat + 0.1, lon: AT.lon }, 1000); // ~11 km
    expect(f.calls).toHaveLength(1);
    s.update({ lat: AT.lat + 0.3, lon: AT.lon }, 2000); // ~33 km
    await flush();
    expect(f.calls).toHaveLength(2);
    s.update({ lat: AT.lat + 0.3, lon: AT.lon }, 2000 + WEATHER_MAX_AGE_MS + 1);
    await flush();
    expect(f.calls).toHaveLength(3);
  });

  it('keeps going after a failure, retrying a minute later', async () => {
    let n = 0;
    const s = new WeatherService(() => {
      n++;
      return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
    });
    const warn = console.warn;
    console.warn = () => {};
    s.update(AT, 0);
    await flush();
    s.update(AT, 30000);
    await flush();
    expect(n).toBe(1);
    s.update(AT, 61000);
    await flush();
    console.warn = warn;
    expect(n).toBe(2);
    expect(s.current).toBeUndefined();
  });

  it('a forced temperature wins over the live one', async () => {
    const s = new WeatherService(okFetch().fn);
    s.tempOverride = 2;
    s.update(AT, 0);
    await flush();
    expect(s.tempC).toBe(2);
    expect(s.surface).toEqual({ snow: false, ice: false });
  });
});

describe('HUD weather lines', () => {
  const w = parseWeather(SAMPLE, AT) as Weather;
  it('metric: m/s, gusts, cloud octas', () => {
    expect(weatherLines(w, w.tempC, 'metric', 'en')).toEqual(['TEMP -16°C', 'WIND 225° SW 5G11 M/S', 'CLD BKN 75%']);
    expect(weatherLines(w, w.tempC, 'metric', 'ru')).toEqual(['ТЕМП -16°C', 'ВЕТЕР 225° ЮЗ 5G11 М/С', 'ОБЛ BKN 75%']);
  });
  it('imperial: knots; calm; loading; plus sign above zero', () => {
    expect(weatherLines(w, w.tempC, 'imperial', 'en')[1]).toBe('WIND 225° SW 10G21 KT');
    expect(weatherLines({ ...w, windMs: 0.2, gustMs: 0.2 }, 3, 'metric', 'en').slice(0, 2)).toEqual(['TEMP +3°C', 'WIND CALM']);
    expect(weatherLines(undefined, undefined, 'metric', 'en')).toEqual(['WEATHER...']);
    expect(weatherLines(undefined, -20, 'metric', 'en')).toEqual(['TEMP -20°C']);
  });
  it('compass and cloud codes', () => {
    expect(compassPoint(0, 'en')).toBe('N');
    expect(compassPoint(350, 'en')).toBe('N');
    expect(compassPoint(-90, 'ru')).toBe('З');
    expect([0, 10, 40, 80, 100].map(cloudCode)).toEqual(['SKC', 'FEW', 'SCT', 'BKN', 'OVC']);
  });
});
