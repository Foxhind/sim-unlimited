/**
 * Weather picked on the start screen (Q48): a preset replaces the clouds, the precipitation and the
 * thunderstorm of the live weather; its wind, pressure and winds aloft stay live. Without live
 * weather (offline) a preset stands on +15 °C and calm air.
 */
import type { LatLon } from './geodesy';
import type { PrecipKind, Weather } from './weather';

export const WEATHER_PRESETS = ['real', 'clear', 'cloudy', 'rain', 'snow', 'storm'] as const;
export type WeatherPreset = (typeof WEATHER_PRESETS)[number];

/** the preset named in the start link (#…, ninth field); anything unknown is the real weather */
export function parsePreset(raw: string | undefined): WeatherPreset {
  return (WEATHER_PRESETS as readonly string[]).includes(raw ?? '') ? (raw as WeatherPreset) : 'real';
}

interface PresetDef {
  low: number;
  mid: number;
  kind: PrecipKind;
  mmH: number;
  thunder: boolean;
  /** the surface temperature is kept at or above / at or below these, °C */
  tempMin?: number;
  tempMax?: number;
  /** gusts are at least the wind plus this, m/s */
  gustOver?: number;
}

const DEFS: Record<Exclude<WeatherPreset, 'real'>, PresetDef> = {
  clear: { low: 0, mid: 0, kind: 'none', mmH: 0, thunder: false },
  cloudy: { low: 60, mid: 30, kind: 'none', mmH: 0, thunder: false },
  rain: { low: 100, mid: 100, kind: 'rain', mmH: 4, thunder: false, tempMin: 3 },
  snow: { low: 100, mid: 60, kind: 'snow', mmH: 1.5, thunder: false, tempMax: -3 },
  storm: { low: 100, mid: 100, kind: 'rain', mmH: 12, thunder: true, tempMin: 10, gustOver: 12 },
};
/** under a precipitation preset the dew point sits this far below the temperature: a cloud base 500 m up */
const WET_SPREAD_C = 4;

/** the weather with a preset applied; 'real' is the live weather as it is (undefined until it arrives) */
export function applyPreset(w: Weather | undefined, preset: WeatherPreset, at: LatLon, nowMs: number): Weather | undefined {
  if (preset === 'real') return w;
  const d = DEFS[preset];
  const base: Weather = w ?? { tempC: 15, cloudPct: 0, windFromDeg: 0, windMs: 0, gustMs: 0, levels: [], at, time: nowMs };
  const tempC = Math.min(d.tempMax ?? Infinity, Math.max(d.tempMin ?? -Infinity, base.tempC));
  const shift = tempC - base.tempC;
  const levels = base.levels ?? [];
  const wet = d.kind !== 'none';
  return {
    ...base,
    tempC,
    // the shift of the surface temperature fades with height, as a forced temperature's does (airConditions)
    levels: shift === 0 ? levels : levels.map((l, i) => ({ ...l, tempC: l.tempC + shift * Math.max(0, 1 - i / levels.length) })),
    dewPointC: wet ? tempC - WET_SPREAD_C : base.dewPointC === undefined ? undefined : Math.min(base.dewPointC + shift, tempC),
    cloudPct: Math.max(d.low, d.mid),
    cloudLowPct: d.low,
    cloudMidPct: d.mid,
    cloudHighPct: 0,
    precipKind: d.kind,
    precipMmH: d.mmH,
    thunder: d.thunder,
    visibilityM: undefined,
    gustMs: d.gustOver === undefined ? base.gustMs : Math.max(base.gustMs, base.windMs + d.gustOver),
  };
}
