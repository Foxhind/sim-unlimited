import { describe, expect, it } from 'vitest';
import { paletteAt, sunColour } from '../src/engine/palette';
import { DEFAULT_RIM, rimFrame } from '../src/engine/rim';
import { DEPTH_FAR, TREE_VS, WORLD_FS, WORLD_POST_FS, WORLD_VS } from '../src/engine/shaders';

describe('rim light', () => {
  const at = (el: number, p = DEFAULT_RIM) => rimFrame(p, paletteAt(el), sunColour(el), el);
  const lowOnly = { ...DEFAULT_RIM, lowSunOnly: true };

  it('in the game: by day and at sunset, the values chosen in the rim lab', () => {
    expect(DEFAULT_RIM).toMatchObject({
      on: true, lowSunOnly: false, backPow: 2, steps: 5, sunColour: 0.35, strength: 2, edgePow: 2, sideBias: 0,
      terrain: 0, objects: 0, trees: 0, aircraft: 1, outline: 1.5, outlineCss: 3, outlineGap: 0.34,
    });
    for (const el of [2, 45]) {
      expect(at(el).shape[0]).toBe(DEFAULT_RIM.strength);
      expect(at(el).outline[0]).toBe(DEFAULT_RIM.outline);
    }
  });

  it('goes out with the sun: none from a sun under the horizon', () => {
    for (const p of [DEFAULT_RIM, lowOnly]) {
      expect(at(-20, p).shape[0]).toBe(0);
      expect(at(-4, p).outline[0]).toBe(0);
      expect(at(-1, p).shape[0]).toBeGreaterThan(0);
      expect(at(-1, p).shape[0]).toBeLessThan(at(2, p).shape[0]);
    }
  });

  it('only for a low sun when asked: at sunset, not by day', () => {
    expect(at(1, lowOnly).shape[0]).toBeGreaterThan(0);
    expect(at(45, lowOnly).shape[0]).toBe(0);
    expect(at(45, lowOnly).outline[0]).toBe(0);
  });

  it('by day it is warm white sunlight, not the blue of the sky', () => {
    const [r, g, b] = at(45).colour;
    expect(r).toBeGreaterThanOrEqual(g);
    expect(g).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThan(0.85);
  });

  it('switches off as a whole', () => {
    const off = at(45, { ...DEFAULT_RIM, on: false });
    expect(off.shape[0]).toBe(0);
    expect(off.outline[0]).toBe(0);
  });

  it('takes its colour between the sunset glow and the sun disc', () => {
    const glow = at(0, { ...DEFAULT_RIM, sunColour: 0 }).colour;
    expect(Array.from(glow, (v) => Math.round(v * 255))).toEqual([...paletteAt(0).sunGlow].map(Math.round));
    const sun = at(0, { ...DEFAULT_RIM, sunColour: 1 }).colour;
    expect(Array.from(sun, (v) => Math.round(v * 255))).toEqual([...sunColour(0)].map(Math.round));
  });

  it('is added in the world and tree shaders, and the silhouette pass decodes the log depth they write', () => {
    for (const vs of [WORLD_VS, TREE_VS]) {
      expect(vs).toContain('+ rimLight(n, wp, fog)');
      // lit, and rim-lit, by the side the eye sees: the far side of a thin fin does not light this one
      expect(vs).toContain('if (uTwoSided == 1 && dot(n, toEye(wp)) < 0.0) n = -n;');
      // the eye: the camera in perspective; in an orthographic view (relief inspector) the one direction it
      // looks from, as uCamPos there is the simulator camera and faces above it would be lit from below
      expect(vs).toContain('return uOrthoFar > 0.0 ? vec3(uView[0][2], uView[1][2] / length(uView[1].xyz), uView[2][2]) : uCamPos - wp;');
      expect(vs).toContain('vec3 v = normalize(toEye(wp));');
      expect(vs.indexOf('n = -n;')).toBeLessThan(vs.indexOf('vec4 light = sceneLight(n'));
    }
    expect(WORLD_POST_FS).toContain(`const float LOG_FAR = ${Math.log2(DEPTH_FAR + 1).toFixed(8)};`);
    expect(WORLD_POST_FS).toContain('exp2(d * LOG_FAR) - 1.0');
  });

  it('leaves self-lit faces (exhaust flame, aircraft lights) and all but buildings and aircraft without the silhouette rim', () => {
    expect(WORLD_FS).toContain('float alpha = uOutlined * (1.0 - uSelfLit);');
    expect(WORLD_FS).toContain('if (windowAt(c, vWinUV, vWinEdge, winFw, fog)) alpha = 0.0;');
    expect(WORLD_FS).toContain('oColor = vec4(c, alpha);');
    expect(WORLD_POST_FS).toContain('if (uOutline.x > 0.0 && t.a > 0.5) return max(t.rgb, min(t.rgb + outline(q), 1.0));');
  });
});
