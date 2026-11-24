import { describe, expect, it } from 'vitest';
import { AIR_HAZE } from '../src/engine/shaders';
import { HAZE, hazeDensity } from '../src/world/haze';

describe('the air\'s haze from the weather', () => {
  it('is the aerosol column spread over the haze\'s scale height', () => {
    // the panorama's afternoon over Fethiye: CAMS aod 0.21, the haze matched by eye 1/6 km at sea level
    expect(1 / hazeDensity({ aod: 0.21 })).toBeGreaterThan(5500);
    expect(1 / hazeDensity({ aod: 0.21 })).toBeLessThan(6000);
    // clean Alpine air: some five times clearer
    expect(hazeDensity({ aod: 0.04 })).toBeCloseTo(0.04 / AIR_HAZE.SCALE_H, 10);
  });

  it('without data, the renderer\'s default', () => {
    expect(hazeDensity(undefined)).toBeCloseTo(AIR_HAZE.DEFAULT_DENSITY, 12);
    expect(hazeDensity({})).toBeCloseTo(HAZE.DEFAULT_AOD / AIR_HAZE.SCALE_H, 12);
  });

  it('keeps to the clearest and the dustiest columns', () => {
    expect(hazeDensity({ aod: 0 })).toBeCloseTo(HAZE.AOD_MIN / AIR_HAZE.SCALE_H, 12);
    expect(hazeDensity({ aod: 40 })).toBeCloseTo(HAZE.AOD_MAX / AIR_HAZE.SCALE_H, 12);
  });

  it('a misty visibility thickens it (Koschmieder), the models\' capped clear visibility and rain do not', () => {
    expect(hazeDensity({ aod: 0.1, visibilityM: 24140 })).toBe(hazeDensity({ aod: 0.1 }));
    expect(hazeDensity({ aod: 0.1, visibilityM: 5000 })).toBeCloseTo(3.912 / 5000, 10);
    expect(hazeDensity({ aod: 0.1, visibilityM: 5000, precipKind: 'rain' })).toBe(hazeDensity({ aod: 0.1 }));
    // a thick aerosol wins over a fair visibility
    expect(hazeDensity({ aod: 1.5, visibilityM: 15000 })).toBeCloseTo(1.5 / AIR_HAZE.SCALE_H, 10);
  });
});

describe('the haze turns far forest blue before pale', () => {
  it('blue takes the most of it, red the least; green is the aerosol\'s own 550 nm', () => {
    const [r, g, b] = AIR_HAZE.SPECTRUM;
    expect(g).toBe(1);
    expect(r).toBeLessThan(g);
    expect(b).toBeGreaterThan(1.5);
  });
});
