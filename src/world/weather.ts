/**
 * Live weather at the aircraft from Open-Meteo (https://open-meteo.com): free, no API key, CORS
 * enabled, data under CC BY 4.0. Only the current conditions are asked for: temperature at 2 m,
 * total cloud cover, wind at 10 m. The temperature decides the winter look of the ground (surfaceFor).
 */
import type { Surface } from '../engine/palette';
import type { LatLon } from './geodesy';

export const WEATHER_ATTRIBUTION = 'Weather: Open-Meteo.com';
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

export interface Weather {
  /** air temperature at 2 m, °C */
  tempC: number;
  /** total cloud cover, % */
  cloudPct: number;
  /** wind at 10 m: direction it blows FROM (meteorological), degrees true */
  windFromDeg: number;
  windMs: number;
  gustMs: number;
  /** where and when the data is for */
  at: LatLon;
  /** observation time, ms since epoch (UTC) */
  time: number;
}

/** snow on the ground at this temperature and below */
export const SNOW_MAX_C = -4;
/** inland water freezes and seas turn steel grey at this temperature and below */
export const ICE_MAX_C = -15;

export function surfaceFor(tempC: number | undefined): Surface {
  if (tempC === undefined || !Number.isFinite(tempC)) return { snow: false, ice: false };
  return { snow: tempC <= SNOW_MAX_C, ice: tempC <= ICE_MAX_C };
}

export function weatherUrl(at: LatLon): string {
  const q = new URLSearchParams({
    latitude: at.lat.toFixed(3),
    longitude: at.lon.toFixed(3),
    current: 'temperature_2m,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'ms',
    timezone: 'GMT',
  });
  return `${ENDPOINT}?${q}`;
}

/** an Open-Meteo forecast response → Weather (undefined when the fields are missing) */
export function parseWeather(json: unknown, at: LatLon): Weather | undefined {
  const cur = (json as { current?: Record<string, unknown> } | null)?.current;
  if (!cur) return undefined;
  const num = (k: string): number | undefined => {
    const v = cur[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const tempC = num('temperature_2m');
  if (tempC === undefined) return undefined;
  const windMs = num('wind_speed_10m') ?? 0;
  const t = typeof cur.time === 'string' ? Date.parse(`${cur.time}Z`) : NaN;
  return {
    tempC,
    cloudPct: num('cloud_cover') ?? 0,
    windFromDeg: num('wind_direction_10m') ?? 0,
    windMs,
    gustMs: Math.max(windMs, num('wind_gusts_10m') ?? windMs),
    at,
    time: Number.isFinite(t) ? t : Date.now(),
  };
}

/** great-circle-ish distance in metres (equirectangular, fine for tens of km) */
function distanceM(a: LatLon, b: LatLon): number {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371000;
}

/** refetch when the data is this old (Open-Meteo updates current conditions every 15 min) */
export const WEATHER_MAX_AGE_MS = 15 * 60 * 1000;
/** or when the aircraft is this far from where it was fetched */
export const WEATHER_MAX_DIST_M = 25000;
const RETRY_MS = 60 * 1000;

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Keeps the weather for the current position fresh: one request at a time, a new one after
 * WEATHER_MAX_AGE_MS or WEATHER_MAX_DIST_M, failures retried after a minute. The last good data
 * stays in use meanwhile.
 */
export class WeatherService {
  current: Weather | undefined;
  /** forced temperature (URL ?temp=-20), for trying the winter looks anywhere */
  tempOverride: number | undefined;
  private pending = false;
  private fetchedAt = -Infinity;
  private fetchedFor: LatLon | undefined;
  private retryAt = 0;

  constructor(private readonly fetchFn: Fetch = (url) => fetch(url)) {}

  /** temperature in use: the override, else the live value */
  get tempC(): number | undefined {
    return this.tempOverride ?? this.current?.tempC;
  }

  get surface(): Surface {
    return surfaceFor(this.tempC);
  }

  /** call every frame with the position and performance.now(); starts a request when due */
  update(at: LatLon, nowMs: number): void {
    if (this.pending || nowMs < this.retryAt) return;
    const stale = nowMs - this.fetchedAt > WEATHER_MAX_AGE_MS;
    const moved = !this.fetchedFor || distanceM(this.fetchedFor, at) > WEATHER_MAX_DIST_M;
    if (!stale && !moved) return;
    this.pending = true;
    const where = { lat: at.lat, lon: at.lon };
    this.fetchFn(weatherUrl(where))
      .then(async (res) => {
        if (!res.ok) throw new Error(`open-meteo ${res.status}`);
        const w = parseWeather(await res.json(), where);
        if (!w) throw new Error('open-meteo: no current weather');
        this.current = w;
        this.fetchedAt = nowMs;
        this.fetchedFor = where;
      })
      .catch((err: unknown) => {
        this.retryAt = nowMs + RETRY_MS;
        console.warn('weather unavailable', err);
      })
      .finally(() => {
        this.pending = false;
      });
  }
}

const COMPASS_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_RU = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

export function compassPoint(deg: number, lang: 'ru' | 'en'): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return (lang === 'ru' ? COMPASS_RU : COMPASS_EN)[i];
}

/** cloud cover in oktas as pilots read it: SKC / FEW / SCT / BKN / OVC */
export function cloudCode(pct: number): string {
  const okta = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 8);
  if (okta === 0) return 'SKC';
  if (okta <= 2) return 'FEW';
  if (okta <= 4) return 'SCT';
  if (okta <= 7) return 'BKN';
  return 'OVC';
}
