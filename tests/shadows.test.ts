import { describe, expect, it } from 'vitest';
import { lightUniforms, paletteAt, skylightHue } from '../src/engine/palette';
import { SHADOW_TREE_VS, SHADOW_VS, TREE_VS, WORLD_FS, WORLD_VS } from '../src/engine/shaders';

const luma = (c: ArrayLike<number>) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

describe('skylight in the shade', () => {
  it('takes the clear sky\'s blue by day', () => {
    const h = skylightHue(paletteAt(45, 1), 0);
    expect(luma(h)).toBeCloseTo(1, 5);
    expect(h[2]).toBeGreaterThan(h[1]);
    expect(h[1]).toBeGreaterThan(h[0]);
    // the clear sky is a cyan blue (palette.ts SUNNY_DAY): the shade is clearly bluer than the light, if less than under a violet-blue sky
    expect(h[2] - h[0]).toBeGreaterThan(0.25);
  });

  it('turns to the cloud deck\'s plain grey under overcast', () => {
    const h = skylightHue(paletteAt(45, 0), 1, [242, 244, 247]);
    for (const v of h) expect(Math.abs(v - 1)).toBeLessThan(0.02);
    // and the light uniforms carry it, from the sunniness
    const sky = lightUniforms(paletteAt(45, 0), 0).sky;
    expect(Math.abs(sky[2] - sky[0])).toBeLessThan(0.03);
    expect(lightUniforms(paletteAt(45, 1), 1).sky[2] - lightUniforms(paletteAt(45, 1), 1).sky[0]).toBeGreaterThan(0.25);
  });

  it('goes violet under the dusk sky', () => {
    const h = skylightHue(paletteAt(0, 1), 0);
    expect(h[0]).toBeGreaterThan(h[1]);
    expect(h[2]).toBeGreaterThan(h[1]);
  });
});

describe('sun shadows', () => {
  it('world faces and trees carry their colour in shade and their place in the shadow map', () => {
    for (const vs of [WORLD_VS, TREE_VS]) {
      expect(vs).toContain('vec4 shade = sceneShade(n);');
      expect(vs).toContain('shadowCoord(wp, n);');
    }
    expect(WORLD_FS).toContain('vec3 c = sunLit() > 0.5 ? vColor : vShade;');
  });

  it('casters drop with the curvature as the world pass does, so a face never shadows itself', () => {
    for (const vs of [SHADOW_VS, SHADOW_TREE_VS]) expect(vs).toContain('wp.y -= dot(r, r) / (2.0 * 6371000.0);');
    expect(WORLD_VS).toContain('wp.y -= (d * d) / (2.0 * 6371000.0);');
  });
});
