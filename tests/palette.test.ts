import { describe, expect, it } from 'vitest';
import { buildLUT, paletteAt, quantize6bit, RAMP, RAMP_STEPS } from '../src/engine/palette';

const VALID_6BIT = new Set(Array.from({ length: 64 }, (_, q) => Math.round((q * 255) / 63)));

function entry(lut: Uint8Array, index: number): [number, number, number] {
  return [lut[index * 4], lut[index * 4 + 1], lut[index * 4 + 2]];
}

function luminance(c: [number, number, number]): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

describe('quantize6bit', () => {
  it('maps to VGA DAC levels only', () => {
    for (let v = 0; v <= 255; v++) expect(VALID_6BIT.has(quantize6bit(v))).toBe(true);
  });
  it('pins endpoints', () => {
    expect(quantize6bit(0)).toBe(0);
    expect(quantize6bit(255)).toBe(255);
  });
});

describe('buildLUT', () => {
  const lut = buildLUT(paletteAt(45));

  it('covers all 256 entries with 6-bit channels', () => {
    expect(lut.length).toBe(256 * 4);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = entry(lut, i);
      expect(VALID_6BIT.has(r)).toBe(true);
      expect(VALID_6BIT.has(g)).toBe(true);
      expect(VALID_6BIT.has(b)).toBe(true);
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it('material lighting ramps are monotonic in brightness (steps 0..11)', () => {
    for (const ramp of [RAMP.GRASS, RAMP.WATER, RAMP.CONCRETE, RAMP.BRICK]) {
      let prev = -1;
      for (let s = 0; s < 12; s++) {
        const l = luminance(entry(lut, ramp * RAMP_STEPS + s));
        expect(l).toBeGreaterThan(prev);
        prev = l;
      }
    }
  });

  it('fog end of every material ramp equals the sky horizon color', () => {
    const horizon = entry(lut, RAMP.SKY * RAMP_STEPS + 15);
    for (let ramp = 0; ramp < 12; ramp++) {
      expect(entry(lut, ramp * RAMP_STEPS + 15)).toEqual(horizon);
    }
  });

  it('emissive and HUD ramps do not darken at night', () => {
    const day = buildLUT(paletteAt(45));
    const night = buildLUT(paletteAt(-20));
    for (const ramp of [RAMP.EMISSIVE, RAMP.HUD_GREEN, RAMP.HUD_AMBER]) {
      for (let s = 0; s < RAMP_STEPS; s++) {
        const i = ramp * RAMP_STEPS + s;
        expect(entry(night, i)).toEqual(entry(day, i));
      }
    }
    expect(luminance(entry(night, RAMP.GRASS * RAMP_STEPS + 8))).toBeLessThan(
      luminance(entry(day, RAMP.GRASS * RAMP_STEPS + 8)),
    );
  });
});

describe('paletteAt', () => {
  it('returns stable keyframes outside transition zones', () => {
    expect(paletteAt(-30)).toEqual(paletteAt(-8));
    expect(paletteAt(45)).toEqual(paletteAt(90));
  });
  it('interpolates continuously through dusk', () => {
    const a = paletteAt(-0.001);
    const b = paletteAt(0.001);
    expect(Math.abs(a.horizon[0] - b.horizon[0])).toBeLessThan(1);
  });
});