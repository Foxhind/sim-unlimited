import { describe, expect, it } from 'vitest';
import { FACADE_ALL_NIGHT, litShare, solarHour, WINDOWS } from '../src/engine/palette';
import { isAllNight } from '../src/world/building-mesher';
import { WORLD_FS } from '../src/engine/shaders';

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
