import { describe, expect, it } from 'vitest';
import { RAMP, SNOW_FLAG } from '../src/engine/palette';
import { POINTS_FS, POINTS_VS, TREE_VS, WORLD_FS, WORLD_VS } from '../src/engine/shaders';

describe('logarithmic depth', () => {
  it('every world pass writes the same log depth, so drapes do not z-fight the terrain', () => {
    for (const vs of [WORLD_VS, TREE_VS, POINTS_VS]) expect(vs).toContain('vLogW = 1.0 + max(gl_Position.w, 0.0);');
    for (const fs of [WORLD_FS, POINTS_FS]) {
      expect(fs).toContain('gl_FragDepth = log2(vLogW) / log2(200000.0 + 1.0);');
      expect(fs).toMatch(/void main\(\) \{[\s\S]*writeLogDepth\(\);/);
    }
  });

  it('resolves a 0.3 m drape bias out to the far plane (24-bit depth)', () => {
    const step = (z: number) => (z + 1) * Math.log(200001) / 2 ** 24; // dz per depth unit
    expect(step(5000)).toBeLessThan(0.01);
    expect(step(60000)).toBeLessThan(0.3 / 4);
  });
});

describe('winter snow', () => {
  it('terrain, drapes, buildings and trees swap faces flagged for snow to the snow ramp', () => {
    for (const vs of [WORLD_VS, TREE_VS]) {
      expect(vs).toContain('uniform int uSnow;');
      expect(vs).toContain(`if (uSnow == 1 && (packedRamp & ${SNOW_FLAG}u) != 0u) ramp = ${RAMP.SNOW}u;`);
      // the snow flag must not leak into the glow level
      expect(vs).toMatch(/>> 12u\) & 7u/);
    }
  });
});
