import { describe, expect, it } from 'vitest';
import {
  buildLUT, colour, FLASH_LIGHT, glowParams, greenColour, isGreen, isMaterial, isWater, LIGHT, lightUniforms, LUT_ENTRIES, LUT_SIZE, LUT_TOTAL, MAT,
  material, OVERLAY_LUT_BASE, paletteAt, saturate, sunniness, pointValue, RAMP, RAMP_STEPS, rampGlowLevel, rampIndex, rgbOf, shadeColour, snowy, SNOW_FLAG, withGlow,
} from '../src/engine/palette';
import { RESOLVE_FS } from '../src/engine/shaders';

function entry(lut: Uint8Array, index: number): [number, number, number] {
  return [lut[index * 4], lut[index * 4 + 1], lut[index * 4 + 2]];
}

function luminance(c: [number, number, number]): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

describe('buildLUT', () => {
  const lut = buildLUT(paletteAt(45));

  it('holds the material ramps, plain and per glow level, in whole 256-entry rows', () => {
    expect(LUT_TOTAL % LUT_SIZE).toBe(0);
    expect(LUT_SIZE % 256).toBe(0);
    expect(LUT_ENTRIES % 256).toBe(0);
    expect(lut.length).toBe(LUT_ENTRIES * 4);
    expect(MAT.SEA * RAMP_STEPS).toBeLessThan(LUT_SIZE);
    for (let i = 0; i <= MAT.SEA * RAMP_STEPS + 15; i++) expect(lut[i * 4 + 3]).toBe(255);
  });

  it('is not limited to 6-bit DAC levels any more', () => {
    const levels = new Set<number>();
    for (let i = 0; i < LUT_SIZE * 4; i++) if (i % 4 !== 3) levels.add(lut[i]);
    const sixBit = new Set(Array.from({ length: 64 }, (_, q) => Math.round((q * 255) / 63)));
    expect([...levels].some((v) => !sixBit.has(v))).toBe(true);
  });

  it('material lighting ramps are monotonic in brightness (steps 0..11)', () => {
    for (const ramp of [RAMP.GRASS, RAMP.WATER, RAMP.CONCRETE, RAMP.BRICK]) {
      let prev = -1;
      for (let s = 0; s < 12; s++) {
        const l = luminance(entry(lut, rampIndex(ramp, s)));
        expect(l).toBeGreaterThan(prev);
        prev = l;
      }
    }
  });

  it('fog end of every material ramp equals the sky horizon color', () => {
    const horizon = entry(lut, rampIndex(RAMP.SKY, 15));
    for (let ramp = 0; ramp < 12; ramp++) {
      expect(entry(lut, ramp * RAMP_STEPS + 15)).toEqual(horizon);
    }
  });

  it('emissive and HUD ramps do not darken at night', () => {
    const day = buildLUT(paletteAt(45));
    const night = buildLUT(paletteAt(-20));
    for (const ramp of [RAMP.EMISSIVE, RAMP.HUD_GREEN, RAMP.HUD_AMBER]) {
      for (let s = 0; s < RAMP_STEPS; s++) {
        const i = rampIndex(ramp, s);
        expect(entry(night, i)).toEqual(entry(day, i));
      }
    }
    expect(luminance(entry(night, rampIndex(RAMP.GRASS, 8)))).toBeLessThan(
      luminance(entry(day, rampIndex(RAMP.GRASS, 8))),
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

describe('sunset sky', () => {
  const hue = ([r, g, b]: readonly number[]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  it('runs violet at the zenith, magenta half-way down, orange above the horizon, gold toward the sun', () => {
    const lut = buildLUT(paletteAt(0));
    const zenith = hue(entry(lut, rampIndex(RAMP.SKY, 0)));
    const mid = hue(entry(lut, rampIndex(RAMP.SKY, 4)));
    const low = hue(entry(lut, rampIndex(RAMP.SKY, 8)));
    const glow = entry(lut, MAT.SKY_GLOW * RAMP_STEPS + 8);
    expect(zenith).toBeGreaterThan(250);
    expect(zenith).toBeLessThan(290);
    expect(mid).toBeGreaterThan(310);
    expect(low).toBeGreaterThan(10);
    expect(low).toBeLessThan(30);
    expect(hue(glow)).toBeGreaterThan(25);
    expect(hue(glow)).toBeLessThan(55);
    expect(lightUniforms(paletteAt(0)).sunGlow).toBe(1);
  });

  it('keeps the horizon a line: the haze (fully fogged ground) stands apart from the lowest sky band', () => {
    // from civil twilight on (at night everything is dark anyway), cloudy and sunny
    for (const sunny of [0, 1]) {
      for (let el = -4; el <= 20; el += 0.5) {
        const lut = buildLUT(paletteAt(el, sunny));
        const sky = entry(lut, rampIndex(RAMP.SKY, 8)), haze = entry(lut, rampIndex(RAMP.SKY, 15));
        expect(Math.hypot(sky[0] - haze[0], sky[1] - haze[1], sky[2] - haze[2]), `sun ${el}°, sunny ${sunny}`).toBeGreaterThan(40);
      }
    }
  });

  it('keeps the day and night skies as they were: a straight line from zenith to haze, no glow', () => {
    for (const el of [45, -20]) {
      const p = paletteAt(el, 1);
      const lut = buildLUT(p);
      for (let s = 0; s < 9; s++) {
        const want = p.zenith.map((z, i) => Math.round(z + (p.horizon[i] - z) * (s / 15)));
        expect(entry(lut, rampIndex(RAMP.SKY, s))).toEqual(want);
      }
      expect(lightUniforms(p).sunGlow).toBe(0);
    }
  });

  it('water mirrors the violet-pink sky at sunset, and is plain blue by day', () => {
    const blueish = (c: readonly number[]) => c[2] > c[0] && c[2] > c[1];
    const dusk = buildLUT(paletteAt(0)), day = buildLUT(paletteAt(45));
    const w = entry(dusk, rampIndex(RAMP.WATER, 9));
    expect(w[0]).toBeGreaterThan(w[1]); // red over green: purple-pink, not blue-grey
    expect(entry(dusk, rampIndex(RAMP.SEA, 9))).toEqual(w);
    expect(blueish(entry(day, rampIndex(RAMP.WATER, 9)))).toBe(true);
    // frozen water stays ice: it does not mirror the sky
    const frost = { snow: true, ice: true };
    for (const ramp of [RAMP.WATER, RAMP.SEA]) {
      const ice = entry(buildLUT(paletteAt(0), frost), rampIndex(ramp, 9));
      expect(ice).toEqual(entry(buildLUT({ ...paletteAt(0), waterSky: 0 }, frost), rampIndex(ramp, 9)));
    }
  });
});

describe('sunny weather', () => {
  const sat = (c: readonly number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
  const lum = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  it('sunniness: clear and few clouds are fully sunny, overcast not at all', () => {
    expect(sunniness(0)).toBe(1);
    expect(sunniness(30)).toBe(1);
    expect(sunniness(60)).toBeCloseTo(0.5);
    expect(sunniness(90)).toBe(0);
    expect(sunniness(100)).toBe(0);
    expect(sunniness(undefined)).toBe(1);
  });

  it('a sunny day: deeper blue sky, brighter warm light, livelier colours; a cloudy day as before', () => {
    const cloudy = paletteAt(45, 0), sunny = paletteAt(45, 1);
    expect(cloudy).toEqual(paletteAt(45));
    expect(cloudy.saturation).toBe(1);
    expect(sunny.saturation).toBeGreaterThan(1.2);
    expect(sunny.lightMul).toBeGreaterThan(cloudy.lightMul);
    expect(sat(sunny.zenith)).toBeGreaterThan(sat(cloudy.zenith));
    expect(lum(sunny.horizon)).toBeGreaterThan(lum(cloudy.horizon));
    const grass = [70, 110, 60] as const;
    const a = shadeColour(grass, 9, cloudy), b = shadeColour(grass, 9, sunny);
    expect(sat(b)).toBeGreaterThan(sat(a));
    expect(lum(b)).toBeGreaterThan(lum(a));
    // material ramps in the LUT get the same treatment
    const l0 = buildLUT(cloudy), l1 = buildLUT(sunny);
    expect(sat(entry(l1, rampIndex(RAMP.GRASS, 9)))).toBeGreaterThan(sat(entry(l0, rampIndex(RAMP.GRASS, 9))));
    expect(lightUniforms(sunny).saturation).toBe(sunny.saturation);
  });

  it('nights stay as they are, sunsets get only their daylight share', () => {
    expect(paletteAt(-30, 1)).toEqual(paletteAt(-30, 0));
    expect(paletteAt(-4, 1)).toEqual(paletteAt(-4, 0));
    const s = paletteAt(3, 1).saturation;
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThan(paletteAt(45, 1).saturation);
  });

  it('saturate keeps greys and the luminance, clamps to 0..255', () => {
    expect(saturate([100, 100, 100], 2)).toEqual([100, 100, 100]);
    const c = saturate([200, 120, 60], 1.4);
    expect(lum(c)).toBeCloseTo(lum([200, 120, 60]), 0);
    expect(Math.max(...saturate([250, 20, 20], 3))).toBe(255);
  });
});

describe('face colours', () => {
  it('pack any RGB colour exactly, apart from material ramps, glow levels and the snow flag', () => {
    const c = colour(123, 45, 67);
    expect(rgbOf(c)).toEqual([123, 45, 67]);
    expect(isMaterial(c)).toBe(false);
    expect(isMaterial(RAMP.GRASS)).toBe(true);
    expect(RAMP.SEA).toBe(material(MAT.SEA));
    const g = withGlow(snowy(c), 5);
    expect(rampGlowLevel(g)).toBe(5);
    expect(g & SNOW_FLAG).not.toBe(0);
    expect(rgbOf(g)).toEqual([123, 45, 67]);
    expect(rampGlowLevel(withGlow(g, 2))).toBe(2);
    expect(g).toBeGreaterThan(0); // unsigned: fits a Uint32Array as it is
    expect(new Uint32Array([g])[0]).toBe(g);
  });

  it('an RGB colour is lit dark → bright, fogs toward the horizon and darkens at night', () => {
    const day = paletteAt(60), night = paletteAt(-30);
    const c = [38, 58, 32] as const;
    const lum = (v: readonly number[]) => v[0] + v[1] + v[2];
    for (let s = 1; s < 12; s++) expect(lum(shadeColour(c, s, day))).toBeGreaterThan(lum(shadeColour(c, s - 1, day)));
    expect(shadeColour(c, 15, day)).toEqual(day.horizon);
    expect(lum(shadeColour(c, 9, night))).toBeLessThan(lum(shadeColour(c, 9, day)));
    // a street-lit level lights it better than the night sky does
    expect(lum(shadeColour(c, 9, night, 7))).toBeGreaterThan(lum(shadeColour(c, 9, night)));
  });

  it('the shader gets the light of every glow level and the haze as uniforms', () => {
    const night = paletteAt(-30);
    const u = lightUniforms(night);
    expect(u.levels).toHaveLength(24);
    expect(u.levels[0]).toBeCloseTo(night.lightMul * night.tint[0]);
    const g7 = glowParams(night, 7);
    expect(u.levels[21 + 1]).toBeCloseTo(g7.lightMul * g7.tint[1]);
    expect([...u.haze].map((v) => Math.round(v * 255))).toEqual(night.horizon.map(Math.round));
    expect(FLASH_LIGHT.levels.every((v) => v > 1)).toBe(true);
  });

  it('points carry a LUT index, or an RGB colour as a negative float', () => {
    expect(pointValue(RAMP.EMISSIVE, 13)).toBe(rampIndex(RAMP.EMISSIVE, 13));
    const v = pointValue(colour(255, 255, 255));
    expect(v).toBe(-0x1000000);
    expect(Math.fround(v)).toBe(v);
  });
});

describe('green and water colours', () => {
  it('greenColour keeps greens and pulls other colours to the nearest green land colour', () => {
    const green = colour(0, 255, 0);
    expect(greenColour(green)).toBe(green);
    for (const c of [colour(170, 170, 170), colour(255, 0, 0), colour(170, 85, 0), colour(45, 49, 65)]) {
      const g = greenColour(withGlow(c, 3));
      expect(isGreen(rgbOf(g))).toBe(true);
      expect(rampGlowLevel(g)).toBe(3);
    }
    expect(greenColour(RAMP.FOREST)).toBe(RAMP.FOREST);
    expect(isWater([0, 0, 170])).toBe(true);
    expect(isWater([45, 49, 65])).toBe(false); // bluish grey
    expect(isWater([100, 100, 100])).toBe(false);
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
    expect([...changed].sort((a, b) => a - b)).toEqual([MAT.WATER, MAT.SEA]);
    const [r, , b] = entry(ice, LIGHT.TAXI_BLUE);
    expect(b - r).toBeGreaterThan(100);
  });

});

describe('land palette', () => {
  it('has 240 distinct colours', async () => {
    const { LAND_PALETTE, LAND_PALETTE_SIZE } = await import('../src/engine/palette');
    const { LAND_PALETTE_6BIT } = await import('../src/engine/land-palette');
    expect(LAND_PALETTE).toHaveLength(LAND_PALETTE_SIZE);
    expect(new Set(LAND_PALETTE_6BIT.map((c) => c.join(','))).size).toBe(LAND_PALETTE_SIZE);
    for (const c of LAND_PALETTE_6BIT) for (const v of c) expect(v >= 0 && v <= 63 && Number.isInteger(v)).toBe(true);
  });

  it('keeps muted warm colours (Grand Canyon sand)', async () => {
    const { LAND_PALETTE, nearestLand } = await import('../src/engine/palette');
    const sat = ([r, g, b]: readonly number[]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
    for (const sand of [[136, 119, 98], [151, 132, 109], [176, 157, 131]]) {
      const [r, g, b] = sand;
      const c = LAND_PALETTE[nearestLand(r, g, b)];
      expect(sat(c)).toBeGreaterThan(0.15);
      expect(Math.hypot(c[0] - sand[0], c[1] - sand[1], c[2] - sand[2])).toBeLessThan(15);
    }
  });

  it('foliage over any land colour is green', async () => {
    const { greenColour, isGreen, LAND_PALETTE, LAND_PALETTE_SIZE, colourOf, rgbOf } = await import('../src/engine/palette');
    for (let k = 0; k < LAND_PALETTE_SIZE; k++) expect(isGreen(rgbOf(greenColour(colourOf(LAND_PALETTE[k]))))).toBe(true);
  });
});

describe('land palette generator', () => {
  it('builds distinct 6-bit colours: the greys plus the imagery colours', async () => {
    const { addToHistogram, buildLandPalette } = await import('../src/tools/land-palette-gen');
    const h = new Map<number, number>();
    const px: number[] = [];
    for (let i = 0; i < 400; i++) px.push(120 + (i % 40), 100 + (i % 30), 80 + (i % 20), 255); // sand
    for (let i = 0; i < 100; i++) px.push(30 + (i % 10), 70 + (i % 20), 30, 255); // forest
    addToHistogram(h, px);
    const p = buildLandPalette(h, 40);
    expect(p).toHaveLength(40);
    expect(new Set(p.map((c) => c.join(','))).size).toBe(40);
    expect(p.filter(([r, g, b]) => r === g && g === b).length).toBeGreaterThanOrEqual(16);
    expect(p.some(([r, g, b]) => r > b + 5 && r >= g)).toBe(true); // a warm one
    expect(p.some(([r, g, b]) => g > r + 5 && g > b + 5)).toBe(true); // a green one
  });
});
