import { describe, expect, it } from 'vitest';
import { blend, BLEND_MODES, softLight, type RGB } from '../src/engine/palette';
import { AREA_KINDS, DEFAULT_AREA_STYLES, filterColour, isDefaultAreaStyles } from '../src/world/area-styles';

const BASE: RGB = [90, 120, 60];
const TOP: RGB = [200, 80, 160];

describe('blend', () => {
  it('soft-light is the existing softLight exactly (default styles unchanged)', () => {
    expect(blend(BASE, TOP, 'soft-light', 0.7)).toEqual(softLight(BASE, TOP, 0.7));
    for (const { kind } of AREA_KINDS) {
      const f = DEFAULT_AREA_STYLES[kind];
      expect(filterColour(BASE, f)).toEqual(softLight(BASE, f.colour));
    }
  });

  it('known modes give the W3C results', () => {
    const near = (a: RGB, b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
    near(blend(BASE, TOP, 'normal'), TOP);
    near(blend(BASE, TOP, 'multiply'), BASE.map((b, i) => (b * TOP[i]) / 255));
    near(blend(BASE, TOP, 'screen'), BASE.map((b, i) => 255 - ((255 - b) * (255 - TOP[i])) / 255));
    near(blend(BASE, TOP, 'darken'), BASE.map((b, i) => Math.min(b, TOP[i])));
    near(blend(BASE, TOP, 'difference'), BASE.map((b, i) => Math.abs(b - TOP[i])));
  });

  it('strength 0 keeps the base, every mode stays in 0..255', () => {
    for (const mode of BLEND_MODES) {
      expect(blend(BASE, TOP, mode, 0).map((v) => Math.round(v))).toEqual([...BASE]);
      for (const v of blend(BASE, TOP, mode)) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(255 + 1e-9);
      }
    }
  });

  it('luminosity keeps the hue of the base and takes the luminance of the top', () => {
    const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    expect(lum(blend(BASE, TOP, 'luminosity'))).toBeCloseTo(lum(TOP), 4);
    expect(lum(blend(BASE, TOP, 'color'))).toBeCloseTo(lum(BASE), 4);
  });
});

describe('area styles', () => {
  it('a changed style is not the default (the worker skips its cache)', () => {
    expect(isDefaultAreaStyles(DEFAULT_AREA_STYLES)).toBe(true);
    expect(isDefaultAreaStyles({ ...DEFAULT_AREA_STYLES, park: { ...DEFAULT_AREA_STYLES.park, mode: 'multiply' } })).toBe(false);
  });
});
