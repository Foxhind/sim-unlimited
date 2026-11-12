import { describe, expect, it } from 'vitest';
import { buildLUT, LIGHT, LUT_ENTRIES, LUT_SIZE, LUT_TOTAL, OVERLAY_LUT_BASE, nearestVga, paletteAt, quantize6bit, RAMP, RAMP_STEPS, rampIndex, TERRAIN_RAMP_BASE, VGA_PALETTE } from '../src/engine/palette';
import { RESOLVE_FS } from '../src/engine/shaders';

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

  it('covers every entry (materials + VGA terrain ramps, plain and per glow level) with 6-bit channels', () => {
    expect(LUT_TOTAL % LUT_SIZE).toBe(0);
    expect(LUT_ENTRIES % 256).toBe(0);
    expect(lut.length).toBe(LUT_ENTRIES * 4);
    for (let i = 0; i < LUT_ENTRIES; i++) {
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

describe('VGA terrain colours', () => {
  it('is the default mode 13h palette', () => {
    expect(VGA_PALETTE).toHaveLength(256);
    expect(VGA_PALETTE[1]).toEqual([0, 0, 170]);
    expect(VGA_PALETTE[6]).toEqual([170, 85, 0]);
    expect(VGA_PALETTE[31]).toEqual([255, 255, 255]);
    expect(VGA_PALETTE[32]).toEqual([0, 0, 255]);
    expect(VGA_PALETTE[40]).toEqual([255, 0, 0]);
    expect(VGA_PALETTE[48]).toEqual([0, 255, 0]);
    expect(VGA_PALETTE[104]).toEqual([0, 0, 113]);
    expect(VGA_PALETTE[247]).toEqual([45, 49, 65]);
  });

  it('nearestVga picks exact entries and never the black filler', () => {
    for (const i of [2, 20, 77, 150, 200, 247]) expect(nearestVga(...VGA_PALETTE[i])).toBe(i);
    expect(nearestVga(0, 0, 0)).toBe(0);
  });

  it('each VGA ramp is lit dark → bright and fogs toward the horizon', () => {
    const day = buildLUT(paletteAt(60));
    const v = nearestVga(38, 58, 32);
    const at = (s: number) => entry(day, rampIndex(TERRAIN_RAMP_BASE + v, s));
    const lum = (c: number[]) => c[0] + c[1] + c[2];
    for (let s = 1; s < 12; s++) expect(lum(at(s))).toBeGreaterThanOrEqual(lum(at(s - 1)));
    const night = buildLUT(paletteAt(-30));
    expect(lum(entry(night, rampIndex(TERRAIN_RAMP_BASE + v, 9)))).toBeLessThan(lum(at(9)));
  });
});

describe('green and water VGA colours', () => {
  it('greenVga keeps greens and pulls other colours to the nearest green', async () => {
    const { greenVga, isGreenVga, isWaterVga } = await import('../src/engine/palette');
    expect(isGreenVga(48)).toBe(true); // (0,255,0)
    expect(greenVga(48)).toBe(48);
    for (const i of [7, 24, 40, 6, 114, 247]) {
      const g = greenVga(i);
      expect(isGreenVga(g), `VGA ${i} → ${g}`).toBe(true);
      const [r, gg, b] = VGA_PALETTE[g];
      expect(gg).toBeGreaterThan(Math.max(r, b));
    }
    expect(isWaterVga(1)).toBe(true); // EGA blue
    expect(isWaterVga(247)).toBe(false); // bluish grey
    expect(isWaterVga(24)).toBe(false); // grey
  });
});

describe('overlay LUT row', () => {
  it('maps keep their daytime colours at night; HUD and sky-coloured panels follow row 0', () => {
    const day = buildLUT(paletteAt(45));
    const night = buildLUT(paletteAt(-20));
    // the colours the minimap uses (water, grass, forest, rock, snow)
    for (const i of [rampIndex(RAMP.WATER, 7), rampIndex(RAMP.WATER, 11), rampIndex(RAMP.GRASS, 7), rampIndex(RAMP.FOREST, 8), rampIndex(RAMP.ROCK, 6), rampIndex(RAMP.SNOW, 10)]) {
      expect(entry(night, OVERLAY_LUT_BASE + i)).toEqual(entry(day, i));
      expect(luminance(entry(night, i))).toBeLessThan(luminance(entry(day, i))); // the world itself does darken
    }
    for (const i of [rampIndex(RAMP.HUD_GREEN, 13), rampIndex(RAMP.SKY, 2), rampIndex(RAMP.EMISSIVE, 13)]) {
      expect(entry(night, OVERLAY_LUT_BASE + i)).toEqual(entry(night, i));
    }
    expect(RESOLVE_FS).toContain(`ivec2(int(o), ${OVERLAY_LUT_BASE / 256})`);
  });
});

describe('winter surface (weather)', () => {
  const p = paletteAt(45);
  const plain = buildLUT(p);
  const frost = buildLUT(p, { snow: true, ice: false });
  const ice = buildLUT(p, { snow: true, ice: true });
  const lit = (lut: Uint8Array, ramp: number) => entry(lut, rampIndex(ramp, LIT_STEP));
  const LIT_STEP = 9;

  it('unfrozen seas look like any other water', () => {
    for (let s = 0; s < RAMP_STEPS; s++) expect(entry(plain, rampIndex(RAMP.SEA, s))).toEqual(entry(plain, rampIndex(RAMP.WATER, s)));
  });

  it('snow alone does not touch the palette (the shader swaps flagged faces to the snow ramp)', () => {
    expect(frost).toEqual(plain);
  });

  it('in hard frost inland water turns light grey and seas steel grey', () => {
    const [ir, ig, ib] = lit(ice, RAMP.WATER);
    expect(Math.max(ir, ig, ib) - Math.min(ir, ig, ib)).toBeLessThan(16); // grey, not blue
    expect(ir).toBeGreaterThan(140); // light
    const [sr, sg, sb] = lit(ice, RAMP.SEA);
    expect(sb).toBeGreaterThan(sr); // a cool steel grey
    expect(sb - sr).toBeLessThan(40); // ...not blue water any more
    expect(sr + sg + sb).toBeLessThan(ir + ig + ib); // darker than the ice
    const [wr, , wb] = lit(plain, RAMP.WATER);
    expect(wb - wr).toBeGreaterThan(60); // plain water was clearly blue
  });

  it('frost changes only the water ramps; the taxiway lights stay blue', () => {
    const changed = new Set<number>();
    for (let i = 0; i < LUT_SIZE; i++) {
      if (entry(ice, i).join() !== entry(plain, i).join()) changed.add(Math.floor(i / RAMP_STEPS));
    }
    expect([...changed].sort((a, b) => a - b)).toEqual([RAMP.WATER, RAMP.SEA]);
    const [r, , b] = entry(ice, LIGHT.TAXI_BLUE);
    expect(b - r).toBeGreaterThan(100);
  });

  it('the sea ramp is a VGA filler slot no imagery colour maps to', () => {
    expect(RAMP.SEA).toBe(TERRAIN_RAMP_BASE + 248);
    expect(nearestVga(0, 0, 0)).toBeLessThan(248);
  });
});
