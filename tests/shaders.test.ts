import { describe, expect, it } from 'vitest';
import { CLIMATE, FLAME_STEP, MAT, SELF_LIT_FLAG, selfLit, SNOW_FLAG } from '../src/engine/palette';
import { seaLevelTemperature } from '../src/world/climate-colour';
import { DEPTH_FAR, DEPTH_PULL, depthPull, POINTS_FS, POINTS_VS, REVERSED_NEAR, TREE_VS, WORLD_FS, WORLD_VS } from '../src/engine/shaders';

describe('logarithmic depth', () => {
  it('every world pass writes the same log depth, so drapes do not z-fight the terrain', () => {
    for (const vs of [WORLD_VS, TREE_VS, POINTS_VS]) expect(vs).toContain('vLogW = logW(gl_Position);');
    for (const fs of [WORLD_FS, POINTS_FS]) {
      expect(fs).toContain('log2(vLogW) / log2(200000.0 + 1.0);');
      expect(fs).toMatch(/void main\(\) \{[\s\S]*writeLogDepth\(\);/);
    }
  });

  it('pulls a loose ribbon toward the eye by its depth level, along its own ray (WORLD_VS aDepthLevel)', () => {
    expect(WORLD_VS).toContain('layout(location=6) in float aDepthLevel;');
    // the pulled point drawn, the true one lit, fogged and shadowed
    expect(WORLD_VS).toContain('gl_Position = uProj * uView * vec4(drawn, 1.0);');
    expect(WORLD_VS).toContain(`float unit = uOrthoFar > 0.0 ? max(${DEPTH_PULL.M.toFixed(4)}, uOrthoFar * ${DEPTH_PULL.ORTHO.toExponential(6)}) : ${DEPTH_PULL.M.toFixed(4)} + ${DEPTH_PULL.PER_M.toExponential(1)} * length(e);`);
    expect(WORLD_VS).toContain(`return aDepthLevel * unit / max(abs(dot(n, e / max(length(e), 1e-6))), ${DEPTH_PULL.SIN_MIN.toFixed(3)});`);
    // orthographic: the clip depth itself (linear there), whatever the vertical exaggeration
    expect(WORLD_VS).toContain('if (uOrthoFar > 0.0) gl_Position.z -= 2.0 * pull / uOrthoFar;');
    expect(depthPull(0, 3500, 1)).toBe(0);
    expect(depthPull(2, 3500, 0.5)).toBeCloseTo(2 * (DEPTH_PULL.M + DEPTH_PULL.PER_M * 3500) / 0.5, 9);
    expect(depthPull(1, 100, 0.001)).toBeCloseTo(depthPull(1, 100, DEPTH_PULL.SIN_MIN), 9);
  });

  it('a level apart, overlapping ribbons do not z-fight out to the roads’ radius (3.5 km) in either depth', () => {
    const f32ulp = (x: number) => { const e = Math.floor(Math.log2(Math.abs(x))); return 2 ** (e - 23); };
    for (const t of [1, 10, 100, 1000, 3500]) {
      for (const sin of [1, 0.3, 0.05, 0.01]) {
        const step = depthPull(1, t, sin);
        // reversed Z (float depth REVERSED_NEAR / w): at least 8 float steps apart, after the error of
        // the rasteriser's depth (1e-6 of it) and of the vertex positions (1 mm in w within the rebase
        // distance, 0.5 mm of height along a ray this steep)
        const err = 1e-6 * t + 1e-3 + 5e-4 / sin;
        const near = REVERSED_NEAR / (t - (step - err)), far = REVERSED_NEAR / t;
        expect((near - far) / f32ulp(far)).toBeGreaterThan(8);
        // without the extension: the 24-bit log depth (LOG_DEPTH_FS), at least 4 units apart
        const log = (w: number) => Math.log2(w + 1) / Math.log2(DEPTH_FAR + 1) * 2 ** 24;
        expect(log(t) - log(t - (step - err))).toBeGreaterThan(4);
      }
    }
    // orthographic (the relief inspector: its far plane 2 × 90 km, the ground about half way):
    // linear depth, reversed (1 − d / far, a float) or 24-bit; the clip z of a point 90 km off in
    // float32 is good to 1 cm
    const far = 2 * 90000;
    for (const d of [30000, 60000, 90000, 120000]) {
      for (const sin of [1, 0.3, 0.05]) {
        const step = depthPull(1, d, sin, far), err = 0.02;
        const near = 1 - (d - (step - err)) / far, at = 1 - d / far;
        expect((near - at) / f32ulp(at)).toBeGreaterThan(8);
        expect(((step - err) / far) * 2 ** 24).toBeGreaterThan(4);
      }
    }
    expect(depthPull(1, 90000, 1, 5000)).toBe(DEPTH_PULL.M);
    // and the highest level of a dense tile (11, Innsbruck) seen across at 3.5 km is no more in the
    // way of what stands on the ground than half a metre of height
    expect(11 * depthPull(1, 3500, 1)).toBeLessThan(0.5);
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
      // the snow flag must not leak into the glow level
      expect(vs).toMatch(/>> 24u\) & 7u/);
    }
    // the climate at the foot: a tree's, a building face's over its ground (building-mesher windows v)
    expect(TREE_VS).toContain('float tempC = climateTemp(toWorld(aInstPos));');
    expect(WORLD_VS).toContain('float footY = aWinEdge == vec3(0.0) ? wp.y - aWinUV.y : wp.y;');
    expect(WORLD_VS).toContain('float tempC = climateTemp(vec3(wp.x, footY + (d * d) / (2.0 * 6371000.0), wp.z));');
    // frozen water is not drawn as water (no waves, glints, glitter)
    expect(WORLD_VS).toContain('bool open = water && !frozenWater(aRamp, tempC);');
    expect(WORLD_VS).toContain('vWater = open ? 1.0 : 0.0;');
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
    // the haze is smooth, as over the world's faces (no 12 steps: a face's haze would jump as the eye moves)
    expect(SKY_FS).toContain('float fog = fogAt(dir * t, uCamPos.y);');
    expect(SKY_FS).not.toContain('floor(fog');
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

describe('the exhaust flame is a light source', () => {
  it('its ramps take their flame step whatever the light, weather or hour, untinted, half hazed', () => {
    for (const vs of [WORLD_VS, TREE_VS]) {
      expect(vs).toContain(`(fid == ${MAT.EMISSIVE}u || fid == ${MAT.HUD_AMBER}u))`);
      expect(vs).toContain(`return mix(lutColor(fid * 16u + ${FLAME_STEP}u), haze, 0.5 * fog);`);
      // before the light step, the glow level or the tint can touch it
      expect(vs.indexOf('fid * 16u')).toBeLessThan(vs.indexOf('uint lvl = uGlow'));
    }
  });
});
