import { describe, expect, it } from 'vitest';
import { clockLine, weatherLines } from '../src/flight/hud';
import {
  cloudCode, compassPoint, parseAod, parseWeather, precipitationOf, WEATHER_MAX_AGE_MS, WeatherService, weatherUrl, type Weather,
} from '../src/world/weather';

const AT = { lat: 55.75, lon: 37.62 };
const SAMPLE = {
  current: {
    time: '2026-11-12T17:00', interval: 900, temperature_2m: -16.4, cloud_cover: 75,
    wind_speed_10m: 5.2, wind_direction_10m: 225, wind_gusts_10m: 11.0,
  },
};

describe('Open-Meteo', () => {
  it('asks only for current conditions: surface temperature, clouds, wind in m/s, pressure, and the air aloft', () => {
    const u = new URL(weatherUrl(AT));
    expect(u.origin).toBe('https://api.open-meteo.com');
    expect(u.searchParams.get('latitude')).toBe('55.750');
    const fields = u.searchParams.get('current')!.split(',');
    expect(fields.slice(0, 6)).toEqual(['temperature_2m', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'surface_pressure']);
    // the dew point and the cover of each cloud layer
    expect(fields.slice(6, 10)).toEqual(['dew_point_2m', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high']);
    // five pressure levels, four values each: temperature, wind speed and direction, height
    // what falls, the WMO code (thunderstorms) and the visibility
    expect(fields.slice(10, 16)).toEqual(['precipitation', 'rain', 'showers', 'snowfall', 'weather_code', 'visibility']);
    expect(fields).toHaveLength(16 + 5 * 4);
    for (const p of [850, 700, 500, 300, 200]) {
      for (const k of ['temperature', 'wind_speed', 'wind_direction', 'geopotential_height']) expect(fields).toContain(`${k}_${p}hPa`);
    }
    expect(u.searchParams.has('hourly')).toBe(false);
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

describe('precipitation', () => {
  it('rate in mm/h from the interval sum; kind and thunder from the WMO code', () => {
    expect(precipitationOf(61, 0.6, 0.6, 0, 900)).toEqual({ kind: 'rain', mmH: 2.4, thunder: false });
    expect(precipitationOf(73, 0.3, 0, 0.21, 900)).toEqual({ kind: 'snow', mmH: 2, thunder: false });
    expect(precipitationOf(71, 0.3, 0, 0.21, 900)).toEqual({ kind: 'snow', mmH: 1.2, thunder: false });
    expect(precipitationOf(95, 3, 3, 0, 900)).toEqual({ kind: 'rain', mmH: 12, thunder: true });
    expect(precipitationOf(undefined, 0, 0, 0, 900)).toEqual({ kind: 'none', mmH: 0, thunder: false });
    expect(precipitationOf(0, 0, 0, 0, 900)).toEqual({ kind: 'none', mmH: 0, thunder: false });
  });
  it('a code that says rain while the sum is zero gives the least rate of that code', () => {
    expect(precipitationOf(63, 0, 0, 0, 900)).toEqual({ kind: 'rain', mmH: 2, thunder: false });
    expect(precipitationOf(86, 0, 0, 0, 900)).toEqual({ kind: 'snow', mmH: 8, thunder: false });
  });
  it('a code that is not precipitation: the kind follows the sums', () => {
    expect(precipitationOf(3, 0.2, 0, 0.14, 900).kind).toBe('snow');
    expect(precipitationOf(3, 0.2, 0.2, 0, 900).kind).toBe('rain');
    expect(precipitationOf(3, 0.2, 0.1, 0.07, 3600)).toEqual({ kind: 'rain', mmH: 0.2, thunder: false });
  });
  it('parses the fields of the current block, and their absence as dry weather', () => {
    expect(parseWeather(SAMPLE, AT)).toMatchObject({ precipKind: 'none', precipMmH: 0, thunder: false });
    expect(parseWeather(SAMPLE, AT)!.visibilityM).toBeUndefined();
    const wet = { current: { ...SAMPLE.current, precipitation: 1.5, rain: 0, showers: 1.5, snowfall: 0, weather_code: 96, visibility: 4200 } };
    expect(parseWeather(wet, AT)).toMatchObject({ precipKind: 'rain', precipMmH: 8, thunder: true, visibilityM: 4200 });
  });
});

describe('WeatherService', () => {
  /** the forecast requests made (each goes with one to the air quality service) */
  const okFetch = (aod: unknown = { current: { aerosol_optical_depth: 0.21 } }) => {
    const calls: string[] = [];
    const air: string[] = [];
    const fn = (url: string) => {
      const quality = url.startsWith('https://air-quality-api.');
      (quality ? air : calls).push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(quality ? aod : SAMPLE) });
    };
    return { calls, air, fn };
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
    s.update({ lat: AT.lat + 0.1, lon: AT.lon }, 1000); // ~11 km
    expect(f.calls).toHaveLength(1);
    s.update({ lat: AT.lat + 0.3, lon: AT.lon }, 2000); // ~33 km
    await flush();
    expect(f.calls).toHaveLength(2);
    s.update({ lat: AT.lat + 0.3, lon: AT.lon }, 2000 + WEATHER_MAX_AGE_MS + 1);
    await flush();
    expect(f.calls).toHaveLength(3);
  });

  it('asks the air quality service for the haze with each forecast; the weather stands without it', async () => {
    const f = okFetch();
    const s = new WeatherService(f.fn);
    s.update(AT, 0);
    await flush();
    expect(f.air).toHaveLength(1);
    expect(f.air[0]).toContain('current=aerosol_optical_depth');
    expect(s.current?.aod).toBe(0.21);
    const none = new WeatherService((url) => url.startsWith('https://air-quality-api.')
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) }));
    none.update(AT, 0);
    await flush();
    expect(none.current?.tempC).toBe(-16.4);
    expect(none.current?.aod).toBeUndefined();
    expect(parseAod({ current: { aerosol_optical_depth: null } })).toBeUndefined();
  });

  it('keeps going after a failure, retrying a minute later', async () => {
    let n = 0;
    const s = new WeatherService((url) => {
      if (!url.startsWith('https://air-quality-api.')) n++;
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
  it('a fourth line for what falls: rain, snow, thunderstorm', () => {
    const line = (o: Partial<Weather>, units: 'metric' | 'imperial', lang: 'ru' | 'en') => weatherLines({ ...w, ...o }, w.tempC, units, lang)[3];
    expect(weatherLines(w, w.tempC, 'metric', 'ru')).toHaveLength(3);
    expect(line({ precipKind: 'rain', precipMmH: 2.4 }, 'metric', 'ru')).toBe('ДОЖДЬ 2.4 ММ/Ч');
    expect(line({ precipKind: 'rain', precipMmH: 12, thunder: true }, 'metric', 'en')).toBe('TSTM 12 MM/H');
    expect(line({ precipKind: 'snow', precipMmH: 1.5 }, 'imperial', 'en')).toBe('SNOW 0.06 IN/H');
    expect(line({ precipKind: 'snow', precipMmH: 1.5 }, 'metric', 'ru')).toBe('СНЕГ 1.5 ММ/Ч');
    expect(line({ precipKind: 'none', precipMmH: 0, thunder: true }, 'metric', 'ru')).toBe('ГРОЗА');
  });
  it('compass and cloud codes', () => {
    expect(compassPoint(0, 'en')).toBe('N');
    expect(compassPoint(350, 'en')).toBe('N');
    expect(compassPoint(-90, 'ru')).toBe('З');
    expect([0, 10, 40, 80, 100].map(cloudCode)).toEqual(['SKC', 'FEW', 'SCT', 'BKN', 'OVC']);
  });
});

describe('HUD clock', () => {
  it('shows the sim date and time in UTC', () => {
    expect(clockLine(new Date(Date.UTC(2026, 10, 21, 8, 5, 59)))).toBe('21.11.2026 08:05:59Z');
    expect(clockLine(new Date(Date.UTC(2027, 0, 1, 23, 59)))).toBe('01.01.2027 23:59:00Z');
  });
});
