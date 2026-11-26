import { describe, expect, it } from 'vitest';
import { FACADE_ALL_NIGHT, litShare, solarHour, windowsOn, WINDOWS } from '../src/engine/palette';
import { sunPosition } from '../src/world/sun';
import { isAllNight } from '../src/world/building-mesher';
import { POINTS_VS, WORLD_FS } from '../src/engine/shaders';

describe('share of lit windows by the hour', () => {
  it('peaks 19-21 h, falls by 1 h and is least before dawn', () => {
    expect(litShare(19)).toBeCloseTo(WINDOWS.LIT_SHARE);
    expect(litShare(20)).toBeCloseTo(WINDOWS.LIT_SHARE);
    expect(litShare(21)).toBeCloseTo(WINDOWS.LIT_SHARE);
    expect(litShare(1)).toBeCloseTo(0.12);
    expect(litShare(4.5)).toBeCloseTo(0.03);
    for (let h = 0; h < 24; h += 0.25) {
      expect(litShare(h)).toBeGreaterThanOrEqual(0.03 - 1e-9);
      expect(litShare(h)).toBeLessThanOrEqual(WINDOWS.LIT_SHARE + 1e-9);
    }
  });
  it('changes smoothly, across midnight too', () => {
    for (let h = 0; h < 24; h += 0.05) expect(Math.abs(litShare(h + 0.05) - litShare(h))).toBeLessThan(0.015);
    expect(litShare(23.999)).toBeCloseTo(litShare(0), 2);
    expect(litShare(22)).toBeLessThan(litShare(21));
    expect(litShare(0)).toBeLessThan(litShare(22));
  });
  it('takes the solar hour from UTC and longitude', () => {
    expect(solarHour(new Date(Date.UTC(2026, 0, 1, 12, 0)), 0)).toBeCloseTo(12);
    expect(solarHour(new Date(Date.UTC(2026, 0, 1, 22, 30)), 37.5)).toBeCloseTo(1);
  });
});

describe('buildings lit all night', () => {
  it('hospitals and supermarkets, not flats', () => {
    expect(isAllNight({ building: 'hospital' })).toBe(true);
    expect(isAllNight({ building: 'yes', amenity: 'hospital' })).toBe(true);
    expect(isAllNight({ building: 'retail', shop: 'supermarket' })).toBe(true);
    expect(isAllNight({ building: 'supermarket' })).toBe(true);
    expect(isAllNight({ building: 'apartments' })).toBe(false);
    expect(isAllNight({ building: 'retail', shop: 'clothes' })).toBe(false);
  });
  it('their windows ignore the hourly share', () => {
    expect(WORLD_FS).toContain(`bool allNight = (code & ${FACADE_ALL_NIGHT}u) != 0u;`);
    expect(WORLD_FS).toContain('uniform float uLitShare;');
  });
});

describe('windows coming on round dusk and dawn', () => {
  const ON = WINDOWS.ON_ELEVATION_DEG;
  it('none an hour before the sun crosses the lamps\' elevation, half at it, all an hour after', () => {
    // setting at 10° an hour
    expect(windowsOn(ON + 10, -10)).toBe(0);
    expect(windowsOn(ON + 5, -10)).toBeGreaterThan(0);
    expect(windowsOn(ON + 5, -10)).toBeLessThan(0.5);
    expect(windowsOn(ON, -10)).toBeCloseTo(0.5);
    expect(windowsOn(ON - 5, -10)).toBeGreaterThan(0.5);
    expect(windowsOn(ON - 10, -10)).toBe(1);
    // rising: the same by the elevation, the other way round in time
    expect(windowsOn(ON - 5, 10)).toBeCloseTo(windowsOn(ON - 5, -10));
    expect(windowsOn(ON + 10, 10)).toBe(0);
  });
  it('lasts about an hour each side by the sun\'s rate, a skimming sun clamped', () => {
    expect(windowsOn(ON + 4, -4)).toBe(0);
    expect(windowsOn(ON + 3, -4)).toBeGreaterThan(0);
    expect(windowsOn(ON - 0.5, 0)).toBeCloseTo(windowsOn(ON - 0.5, -WINDOWS.ON_MIN_RATE_DEG_H));
  });
  it('changes smoothly over a Moscow dusk and dawn, never stepping', () => {
    const moscow = { lat: 55.75, lon: 37.62 };
    for (const day of [Date.UTC(2026, 11, 21), Date.UTC(2026, 2, 20), Date.UTC(2026, 5, 21)]) {
      let prev = -1;
      let seen0 = false, seen1 = false;
      for (let m = 0; m < 24 * 60; m += 2) {
        const t = new Date(day + m * 60000);
        const e = sunPosition(t, moscow).elevationDeg;
        const rate = (sunPosition(new Date(t.getTime() + 60000), moscow).elevationDeg - e) * 60;
        const f = windowsOn(e, rate);
        if (prev >= 0) expect(Math.abs(f - prev)).toBeLessThan(0.05);
        if (f === 0) seen0 = true;
        if (f === 1) seen1 = true;
        prev = f;
      }
      expect(seen0 && seen1).toBe(true);
    }
  });
  it('the all-night windows and the grow lamps follow it in the shaders', () => {
    expect(WORLD_FS).toContain('uniform float uLitFade;');
    expect(WORLD_FS).toContain(`${WINDOWS.ALL_NIGHT_SHARE.toFixed(2)} * uLitFade`);
    expect(POINTS_VS).toContain(`${WINDOWS.ALL_NIGHT_SHARE.toFixed(2)} * uLitFade`);
  });
});
