import type { PaletteParams, RGB } from './palette';

/**
 * Rim light (контровой свет): the edges of things standing between the eye and a low sun light up.
 * Per face, in the world vertex shaders (shaders.ts RIM_GLSL), the product of
 *   edge  = (1 - |n·v|)^edgePow        the face is seen edge-on (a silhouette edge),
 *   back  = max(-v·s, 0)^backPow       the eye looks toward the sun (the thing is backlit),
 *   side  = (n·s + sideBias) / (1 + sideBias), clamped   the face turns toward the sun,
 * times `strength`, stepped into `steps` levels (0: smooth), added in the rim colour and faded by fog.
 * n: face normal, v: from the face to the eye, s: toward the sun.
 */
export interface RimParams {
  on: boolean;
  /** by faces (the formula above) */
  strength: number;
  edgePow: number;
  backPow: number;
  sideBias: number;
  /** quantization levels of the rim (0: smooth) */
  steps: number;
  /** colour: 0 the sunset glow round the sun, 1 the sun disc's own colour */
  sunColour: number;
  /** only while the sun is low: scaled by the palette's sunset glow (0 by day and at night); else by day too */
  lowSunOnly: boolean;
  /**
   * by silhouette (screen space, renderer post pass WORLD_POST_FS): a band `outlinePx` pixels wide
   * along every edge that has sky or far ground behind it on the sun's side, `outline` its strength;
   * `outlineGap`: the jump in distance between neighbouring pixels that counts as an edge (0.2 = 20 %)
   */
  outline: number;
  outlinePx: number;
  outlineGap: number;
  /** weight per kind of geometry (by faces only) */
  terrain: number;
  objects: number;
  trees: number;
  aircraft: number;
}

export const DEFAULT_RIM: RimParams = {
  on: true,
  strength: 2,
  edgePow: 2,
  backPow: 2,
  sideBias: 0,
  steps: 5,
  sunColour: 0.35,
  lowSunOnly: false,
  outline: 1.5,
  outlinePx: 6,
  outlineGap: 0.34,
  terrain: 0,
  objects: 0,
  trees: 1,
  aircraft: 1,
};

/** the rim light in force (the tuning page rim.html changes it live) */
export const rim: RimParams = { ...DEFAULT_RIM };

/**
 * What the shaders get this frame: colour 0..1; shape (by faces: strength before the group weight,
 * edgePow, backPow, sideBias); outline (by silhouette: strength, width px, gap, backPow); steps.
 */
export interface RimFrame {
  colour: Float32Array;
  shape: Float32Array;
  outline: Float32Array;
  steps: number;
}

export const NO_RIM: RimFrame = { colour: new Float32Array(3), shape: new Float32Array([0, 1, 1, 0]), outline: new Float32Array([0, 1, 1, 1]), steps: 0 };

/** sun elevations over which the rim fades out as the sun sets (as the sunlight on the ground does, main.ts) */
const RIM_SUN_OFF_DEG = -4;
const RIM_SUN_ON_DEG = 2;

export function rimFrame(p: RimParams, palette: PaletteParams, sun: RGB, sunElevationDeg: number): RimFrame {
  // no rim from a sun under the horizon: it would light edges toward where the sun is at night
  const up = Math.max(0, Math.min(1, (sunElevationDeg - RIM_SUN_OFF_DEG) / (RIM_SUN_ON_DEG - RIM_SUN_OFF_DEG)));
  const low = !p.on ? 0 : (p.lowSunOnly ? palette.glow : 1) * up;
  const k = p.strength * low;
  const c = palette.sunGlow.map((g, i) => (g + (sun[i] - g) * p.sunColour) / 255);
  return {
    colour: Float32Array.from(c),
    shape: new Float32Array([k, Math.max(0.05, p.edgePow), Math.max(0, p.backPow), p.sideBias]),
    outline: new Float32Array([p.outline * low, Math.max(1, Math.min(32, Math.round(p.outlinePx))), Math.max(0.01, p.outlineGap), Math.max(0, p.backPow)]),
    steps: Math.max(0, Math.round(p.steps)),
  };
}

/** The rim tuning page (rim.html): it freezes the flight and drives the view; main.ts reads this. */
export const rimLab = {
  active: false,
  /** no physics, no clock: a still picture */
  frozen: false,
  hud: true,
  /** the sim clock to show instead (sun height slider); main.ts takes it and clears it */
  time: undefined as Date | undefined,
};
