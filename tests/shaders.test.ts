import { describe, expect, it } from 'vitest';
import { CLIMATE, MAT, SELF_LIT_FLAG, selfLit, SNOW_FLAG } from '../src/engine/palette';
import { seaLevelTemperature } from '../src/world/climate-colour';
import { POINTS_FS, POINTS_VS, TREE_VS, WORLD_FS, WORLD_VS } from '../src/engine/shaders';

describe('logarithmic depth', () => {
  it('every world pass writes the same log depth, so drapes do not z-fight the terrain', () => {
    for (const vs of [WORLD_VS, TREE_VS, POINTS_VS]) expect(vs).toContain('vLogW = logW(gl_Position);');
    for (const fs of [WORLD_FS, POINTS_FS]) {
      expect(fs).toContain('log2(vLogW) / log2(200000.0 + 1.0);');
      expect(fs).toMatch(/void main\(\) \{[\s\S]*writeLogDepth\(\);/);
    }
  });

  it('resolves a 0.3 m drape bias out to the far plane (24-bit depth)', () => {
    const step = (z: number) => (z + 1) * Math.log(200001) / 2 ** 24; // dz per depth unit
    expect(step(5000)).toBeLessThan(0.01);
    expect(step(60000)).toBeLessThan(0.3 / 4);
  });
});

describe('snow and ice by climate', () => {
  it('terrain, drapes, buildings and trees take snow where the climate at the face is cold enough', () => {
    for (const vs of [WORLD_VS, TREE_VS]) {
      expect(vs).toContain('uniform float uOriginLat;');
      expect(vs).not.toContain('uSnow');
      expect(vs).toContain(`bool snow = (packedRamp & ${SNOW_FLAG}u) != 0u && tempC <= ${CLIMATE.SNOW_C.toFixed(1)} && (!water || frozen);`);
      expect(vs).toContain(`uint ramp = snow ? ${MAT.SNOW}u : frozen ? (id == ${MAT.SEA}u ? ${MAT.SEA_ICE}u : ${MAT.ICE}u) : id;`);
      expect(vs).toContain('float tempC = climateTemp(vec3(wp.x, wp.y + (d * d) / (2.0 * 6371000.0), wp.z));');
      // the snow flag must not leak into the glow level
      expect(vs).toMatch(/>> 24u\) & 7u/);
    }
    // frozen water is not drawn as water (no waves, glints, glitter)
    expect(WORLD_VS).toContain('vWater = water && !frozenWater(aRamp, tempC) ? 1.0 : 0.0;');
  });

  it('the shader climate is the same formula as the terrain colours', () => {
    expect(WORLD_VS).toContain(`${CLIMATE.T_POLE.toFixed(1)} + ${CLIMATE.T_AMP.toFixed(1)} * cos(lat) - ${CLIMATE.LAPSE} * max(p.y, 0.0)`);
    expect(WORLD_VS).toContain(`- ${CLIMATE.SEASON_AMP.toFixed(1)} * k * sin(lat) * uSeason;`);
    expect(WORLD_VS).toContain(`float k = lat < 0.0 ? ${CLIMATE.SEASON_SOUTH} : 1.0;`);
    expect(WORLD_VS).toContain('uniform float uSeason;');
    expect(seaLevelTemperature(60)).toBeCloseTo(CLIMATE.T_POLE + CLIMATE.T_AMP * 0.5, 6);
  });
});

describe('base ground (horizon without tiles)', () => {
  it('the sky pass draws a ground on the same curved Earth as the world shaders, fogged like terrain', async () => {
    const { SKY_FS } = await import('../src/engine/shaders');
    expect(WORLD_VS).toContain('wp.y -= (d * d) / (2.0 * 6371000.0);');
    expect(SKY_FS).toContain('max(1.0 - dir.y * dir.y, 0.0) / 6371000.0');
    expect(SKY_FS).toContain('shadeColour(uGroundRamp, lit.a * 11.0, fog, lit.rgb, hazeAt(dir), tempC)');
    expect(SKY_FS).toContain('fog = floor(fog * 12.0) / 12.0;');
  });

  it('a ray hits the ground below the true horizon only (dip = sqrt(2h/R))', () => {
    // mirror of SKY_FS: (a/2) t^2 + dir.y t + h = 0, a = (1 - dir.y^2) / R
    const R = 6371000;
    const hit = (dy: number, h: number) => {
      const a = (1 - dy * dy) / R, disc = dy * dy - 2 * a * h;
      if (dy >= 0 || disc < 0) return undefined;
      return a > 1e-12 ? (-dy - Math.sqrt(disc)) / a : h / -dy;
    };
    const h = 6000, dip = Math.sqrt((2 * h) / R);
    expect(hit(-dip * 1.01, h)).toBeDefined();
    expect(hit(-dip * 0.99, h)).toBeUndefined();
    // just below the horizon the ground lies near the horizon distance, ~277 km
    expect(Math.abs(hit(-dip * 1.0001, h)! / Math.sqrt(2 * h * R) - 1)).toBeLessThan(0.05);
    expect(hit(-1, h)!).toBeCloseTo(h); // straight down
    expect(hit(0.1, h)).toBeUndefined();
  });
});

describe('aircraft lights', () => {
  it('a self-lit colour skips the sun, the night and the street glow, and is only half hazed', () => {
    const c = selfLit(0xff2a1a);
    expect(c & 0xffffff).toBe(0xff2a1a);
    expect(c & SELF_LIT_FLAG).not.toBe(0);
    expect(new Uint32Array([c])[0]).toBe(c);
    expect(WORLD_VS).toContain(`if ((packedRamp & ${SELF_LIT_FLAG}u) != 0u) return mix(rgbOf(packedRamp), haze, 0.5 * fog);`);
    // checked before the glow level and the lit step are applied
    expect(WORLD_VS.indexOf(`${SELF_LIT_FLAG}u`)).toBeLessThan(WORLD_VS.indexOf('litStep = max(litStep'));
  });
});
