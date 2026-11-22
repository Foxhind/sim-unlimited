import { describe, expect, it } from 'vitest';
import { cloudLayers } from '../src/world/clouds';
import type { Weather } from '../src/world/weather';
import { applyPreset, parsePreset, WEATHER_PRESETS } from '../src/world/weather-preset';

const AT = { lat: 47.26, lon: 11.34 };
const LIVE: Weather = {
  tempC: -8, dewPointC: -12, cloudPct: 20, cloudLowPct: 10, cloudMidPct: 15, cloudHighPct: 5,
  windFromDeg: 250, windMs: 4, gustMs: 6, pressureHpa: 940, elevation: 578, visibilityM: 30000,
  precipKind: 'none', precipMmH: 0, thunder: false,
  levels: [
    { alt: 1500, tempC: -10, windFromDeg: 260, windMs: 9 },
    { alt: 3000, tempC: -18, windFromDeg: 270, windMs: 14 },
  ],
  at: AT, time: 1,
};

describe('weather presets', () => {
  it('the real weather is the live weather as it is', () => {
    expect(applyPreset(LIVE, 'real', AT, 0)).toBe(LIVE);
    expect(applyPreset(undefined, 'real', AT, 0)).toBeUndefined();
  });
  it('clear and cloudy: clouds only, no precipitation', () => {
    expect(applyPreset(LIVE, 'clear', AT, 0)).toMatchObject({ cloudPct: 0, cloudLowPct: 0, cloudMidPct: 0, precipKind: 'none', precipMmH: 0, thunder: false, tempC: -8 });
    expect(applyPreset(LIVE, 'cloudy', AT, 0)).toMatchObject({ cloudPct: 60, cloudLowPct: 60, cloudMidPct: 30, precipKind: 'none' });
  });
  it('rain: overcast, 4 mm/h, not colder than +3 °C, cloud base 500 m up', () => {
    const w = applyPreset(LIVE, 'rain', AT, 0)!;
    expect(w).toMatchObject({ cloudPct: 100, cloudLowPct: 100, cloudMidPct: 100, precipKind: 'rain', precipMmH: 4, thunder: false, tempC: 3, dewPointC: -1 });
    const low = cloudLayers({ ...w, elevation: 578 }).find((l) => l.id === 'low')!;
    expect(low.kind).toBe('deck');
    expect(Math.abs(low.base - (578 + 500))).toBeLessThanOrEqual(50); // bases are stepped
    // the surface shift (+11) fades with height
    expect(w.levels!.map((l) => l.tempC)).toEqual([1, -12.5]);
    expect(applyPreset({ ...LIVE, tempC: 14 }, 'rain', AT, 0)!.tempC).toBe(14);
  });
  it('snow: 1.5 mm/h, not warmer than −3 °C', () => {
    expect(applyPreset({ ...LIVE, tempC: 12 }, 'snow', AT, 0)).toMatchObject({ cloudLowPct: 100, cloudMidPct: 60, precipKind: 'snow', precipMmH: 1.5, tempC: -3, dewPointC: -7 });
    expect(applyPreset(LIVE, 'snow', AT, 0)!.tempC).toBe(-8);
  });
  it('storm: 12 mm/h with thunder, +10 °C or more, gusts of the wind + 12 m/s or more', () => {
    expect(applyPreset(LIVE, 'storm', AT, 0)).toMatchObject({ precipKind: 'rain', precipMmH: 12, thunder: true, tempC: 10, gustMs: 16 });
    expect(applyPreset({ ...LIVE, gustMs: 25 }, 'storm', AT, 0)!.gustMs).toBe(25);
  });
  it('the wind, the pressure and the place stay live; the reported visibility goes', () => {
    for (const p of WEATHER_PRESETS.filter((k) => k !== 'real')) {
      const w = applyPreset(LIVE, p, AT, 0)!;
      expect(w).toMatchObject({ windFromDeg: 250, windMs: 4, pressureHpa: 940, elevation: 578, at: AT, time: 1 });
      expect(w.visibilityM).toBeUndefined();
      expect(w.levels!.map((l) => l.windMs)).toEqual([9, 14]);
    }
  });
  it('without live weather a preset stands on +15 °C and calm air', () => {
    expect(applyPreset(undefined, 'rain', AT, 7)).toMatchObject({ tempC: 15, cloudPct: 100, precipKind: 'rain', precipMmH: 4, windMs: 0, at: AT, time: 7 });
    expect(applyPreset(undefined, 'snow', AT, 7)!.tempC).toBe(-3);
  });
  it('parses the name in the start link; anything else is the real weather', () => {
    expect(parsePreset('storm')).toBe('storm');
    expect(parsePreset('hail')).toBe('real');
    expect(parsePreset('')).toBe('real');
    expect(parsePreset(undefined)).toBe('real');
  });
});
