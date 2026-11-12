export type RGB = readonly [number, number, number];

export const RAMP = {
  GRASS: 0,
  FOREST: 1,
  WATER: 2,
  CONCRETE: 3,
  BRICK: 4,
  ASPHALT: 5,
  SAND: 6,
  SNOW: 7,
  ROCK: 8,
  HULL_LIGHT: 9,
  HULL_DARK: 10,
  FIELD: 11,
  SKY: 12,
  EMISSIVE: 13,
  HUD_GREEN: 14,
  HUD_AMBER: 15,
} as const;

export const RAMP_COUNT = 16;
export const RAMP_STEPS = 16;
/**
 * Terrain colours: ramp TERRAIN_RAMP_BASE + i shades VGA palette entry i (0..255), so a face can
 * take any of the 256 default VGA colours and still get lighting, fog and night from the LUT.
 */
export const TERRAIN_RAMP_BASE = RAMP_COUNT;
/** LUT entries: 16 material ramps + 256 VGA ramps, 16 steps each (a 256-wide texture, 17 rows) */
export const LUT_SIZE = (RAMP_COUNT + 256) * RAMP_STEPS;
export const LIT_STEPS = 12; // steps 0..11: lighting range, 12..15: fog range toward haze

/**
 * Night glow: artificial light on the ground and on everything standing on it, in levels 1..7 by
 * how densely built the terrain triangle is (night-glow.ts). The level rides in the high bits of a
 * mesh ramp (ramp | level << GLOW_SHIFT); the LUT holds one full copy of all ramps per level,
 * lit by warm street light instead of the night sky, after the plain one (level 0).
 */
export const GLOW_LEVELS = 7;
export const GLOW_SHIFT = 12;
export const RAMP_MASK = (1 << GLOW_SHIFT) - 1;
/** entries in the LUT texture: the plain palette and one copy per glow level */
export const LUT_TOTAL = LUT_SIZE * (GLOW_LEVELS + 1);
/** a glowing face is shaded at least at lighting step GLOW_STEP_BASE + level (sun from below the horizon gives ~3) */
export const GLOW_STEP_BASE = 4;
/**
 * brightness of artificial light at level 1 and at the top level (the night sky is 0.22, day 1.0);
 * the lowest levels fall under the sky and keep its palette, lit only by the step boost
 */
const GLOW_MUL_MIN = 0.17;
const GLOW_MUL_MAX = 0.425;
/** warm sodium / LED mix */
const GLOW_TINT: RGB = [1.0, 0.86, 0.66];

export function withGlow(ramp: number, level: number): number {
  return (ramp & RAMP_MASK) | (Math.max(0, Math.min(GLOW_LEVELS, level)) << GLOW_SHIFT);
}

interface MaterialRamp {
  dark: RGB;
  light: RGB;
}

const MATERIALS: MaterialRamp[] = [
  { dark: [16, 56, 16], light: [64, 148, 60] }, // grass
  { dark: [8, 32, 12], light: [36, 92, 40] }, // forest
  { dark: [8, 20, 48], light: [36, 84, 148] }, // water
  { dark: [56, 56, 56], light: [172, 172, 172] }, // concrete
  { dark: [72, 28, 16], light: [168, 92, 56] }, // brick
  { dark: [24, 24, 24], light: [92, 92, 92] }, // asphalt
  { dark: [104, 92, 40], light: [208, 188, 120] }, // sand
  { dark: [104, 116, 132], light: [244, 248, 252] }, // snow
  { dark: [48, 40, 32], light: [148, 132, 112] }, // rock
  { dark: [56, 60, 64], light: [188, 192, 196] }, // hull light
  { dark: [20, 24, 28], light: [88, 96, 104] }, // hull dark
  { dark: [72, 64, 24], light: [164, 148, 72] }, // field
];

const EMISSIVE: MaterialRamp = { dark: [0, 0, 0], light: [255, 252, 216] };
const HUD_GREEN: MaterialRamp = { dark: [0, 40, 0], light: [64, 255, 64] };
const HUD_AMBER: MaterialRamp = { dark: [48, 32, 0], light: [255, 200, 72] };

export interface PaletteParams {
  zenith: RGB;
  horizon: RGB;
  lightMul: number;
  tint: RGB;
}

const NIGHT: PaletteParams = {
  zenith: [4, 6, 16],
  horizon: [12, 18, 36],
  lightMul: 0.22,
  tint: [0.55, 0.65, 1.0],
};
const DUSK: PaletteParams = {
  zenith: [24, 28, 80],
  horizon: [224, 120, 64],
  lightMul: 0.55,
  tint: [1.0, 0.72, 0.55],
};
const DAY: PaletteParams = {
  zenith: [32, 72, 192],
  horizon: [168, 200, 232],
  lightMul: 1.0,
  tint: [1, 1, 1],
};


/** The default 256-colour VGA (mode 13h) palette, 8-bit per channel. */
export const VGA_PALETTE: RGB[] = (() => {
  const six: number[][] = [];
  // 0..15: EGA colours
  for (const c of [
    [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42], [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
    [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63], [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
  ]) six.push(c);
  // 16..31: greys
  for (const g of [0, 5, 8, 11, 14, 17, 20, 24, 28, 32, 36, 40, 45, 50, 56, 63]) six.push([g, g, g]);
  // 32..247: 24 hues x 3 saturations x 3 intensities
  for (const [hi, lo, m1, m2, m3] of [
    [63, 0, 16, 31, 47], [63, 31, 39, 47, 55], [63, 45, 49, 54, 58],
    [28, 0, 7, 14, 21], [28, 14, 17, 21, 24], [28, 20, 22, 24, 26],
    [16, 0, 4, 8, 12], [16, 8, 10, 12, 14], [16, 11, 12, 13, 15],
  ]) {
    for (let k = 0; k < 24; k++) {
      // hue order: blue, magenta, red, yellow, green, cyan (as in the VGA BIOS table)
      const seg = Math.floor(k / 4), q = k % 4;
      const rise = [lo, m1, m2, m3][q], fall = [hi, m3, m2, m1][q];
      const rgb =
        seg === 0 ? [rise, lo, hi] : seg === 1 ? [hi, lo, fall] : seg === 2 ? [hi, rise, lo]
        : seg === 3 ? [fall, hi, lo] : seg === 4 ? [lo, hi, rise] : [lo, fall, hi];
      six.push(rgb);
    }
  }
  // 248..255: black
  while (six.length < 256) six.push([0, 0, 0]);
  return six.map(([r, g, b]) => [Math.round((r * 255) / 63), Math.round((g * 255) / 63), Math.round((b * 255) / 63)] as RGB);
})();

/** nearest VGA palette entry (0..247: the black filler 248..255 is never chosen) */
export function nearestVga(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 248; i++) {
    const [pr, pg, pb] = VGA_PALETTE[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function hsv([r, g, b]: RGB): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx / 255];
}

/** a VGA colour one would call green (hue 70°–170°, not grey, not black) */
export function isGreenVga(i: number): boolean {
  const [h, s, v] = hsv(VGA_PALETTE[i]);
  return h >= 70 && h <= 170 && s >= 0.2 && v >= 0.12;
}
const GREEN_VGA = Array.from({ length: 248 }, (_, i) => i).filter(isGreenVga);

/** the colour itself when green, else the nearest green VGA colour */
export function greenVga(i: number): number {
  if (isGreenVga(i)) return i;
  const [r, g, b] = VGA_PALETTE[i];
  let best = GREEN_VGA[0], bd = Infinity;
  for (const k of GREEN_VGA) {
    const [pr, pg, pb] = VGA_PALETTE[k];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** a VGA colour that reads as open water in the imagery (clearly blue, not a bluish grey) */
export function isWaterVga(i: number): boolean {
  const [r, g, b] = VGA_PALETTE[i];
  return b >= r + 40 && b >= g + 15;
}

/**
 * Shade of a VGA terrain colour at lighting step s (0..LIT_STEPS-1): the imagery colour is what
 * the ground looks like under ordinary daylight, so it sits at ~3/4 of the lighting range; full sun
 * brightens it a little, the shadow side darkens it to about 40 %.
 */
export function vgaShade(c: RGB, s: number): RGB {
  const k = 0.4 + (0.8 * s) / (LIT_STEPS - 1);
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function lerpParams(a: PaletteParams, b: PaletteParams, t: number): PaletteParams {
  return {
    zenith: lerpRGB(a.zenith, b.zenith, t),
    horizon: lerpRGB(a.horizon, b.horizon, t),
    lightMul: lerp(a.lightMul, b.lightMul, t),
    tint: lerpRGB(a.tint, b.tint, t),
  };
}

/** Palette keyframe for a sun elevation in degrees (Q7: day/dusk/night blend). */
export function paletteAt(sunElevationDeg: number): PaletteParams {
  if (sunElevationDeg <= -8) return NIGHT;
  if (sunElevationDeg < 0) return lerpParams(NIGHT, DUSK, (sunElevationDeg + 8) / 8);
  if (sunElevationDeg < 12) return lerpParams(DUSK, DAY, sunElevationDeg / 12);
  return DAY;
}

/** VGA DAC is 6 bits per channel: quantize then expand back to 8-bit values. */
export function quantize6bit(v: number): number {
  const q = Math.max(0, Math.min(63, Math.round((v / 255) * 63)));
  return Math.round((q * 255) / 63);
}

function scaleRGB(c: RGB, p: PaletteParams): RGB {
  return [
    quantize6bit(c[0] * p.lightMul * p.tint[0]),
    quantize6bit(c[1] * p.lightMul * p.tint[1]),
    quantize6bit(c[2] * p.lightMul * p.tint[2]),
  ];
}

function writeEntry(lut: Uint8Array, index: number, c: RGB): void {
  lut[index * 4 + 0] = quantize6bit(c[0]);
  lut[index * 4 + 1] = quantize6bit(c[1]);
  lut[index * 4 + 2] = quantize6bit(c[2]);
  lut[index * 4 + 3] = 255;
}

/**
 * Builds the RGBA LUT: the plain palette (LUT_SIZE entries), then one street-lit copy per glow level.
 * Material ramps: steps 0..11 dark→light (lighting), 12..15 light→haze (fog).
 * The haze end equals the sky horizon color so fogged geometry meets the sky.
 */
export function buildLUT(p: PaletteParams): Uint8Array {
  const lut = new Uint8Array(LUT_TOTAL * 4);
  buildPlainLUT(lut, p);
  for (let k = 1; k <= GLOW_LEVELS; k++) buildPlainLUT(lut.subarray(k * LUT_SIZE * 4, (k + 1) * LUT_SIZE * 4), glowParams(p, k));
  for (const [i, c] of LIGHT_COLORS) writeEntry(lut, i, c);
  return lut;
}

/** palette of glow level k: the scene under street light, never darker than the sky gives */
export function glowParams(p: PaletteParams, k: number): PaletteParams {
  const mul = GLOW_MUL_MIN + ((GLOW_MUL_MAX - GLOW_MUL_MIN) * (k - 1)) / (GLOW_LEVELS - 1);
  if (p.lightMul >= mul) return p;
  return { ...p, lightMul: mul, tint: lerpRGB(GLOW_TINT, p.tint, p.lightMul / mul) };
}

function buildPlainLUT(lut: Uint8Array, p: PaletteParams): void {
  const haze = p.horizon;

  for (let r = 0; r < MATERIALS.length; r++) {
    const dark = scaleRGB(MATERIALS[r].dark, p);
    const light = scaleRGB(MATERIALS[r].light, p);
    for (let s = 0; s < RAMP_STEPS; s++) {
      const c =
        s < LIT_STEPS
          ? lerpRGB(dark, light, s / (LIT_STEPS - 1))
          : lerpRGB(light, haze, (s - LIT_STEPS + 1) / (RAMP_STEPS - LIT_STEPS));
      writeEntry(lut, r * RAMP_STEPS + s, c);
    }
  }

  for (let s = 0; s < RAMP_STEPS; s++) {
    writeEntry(lut, RAMP.SKY * RAMP_STEPS + s, lerpRGB(p.zenith, p.horizon, s / (RAMP_STEPS - 1)));
  }
  for (const [ramp, m] of [
    [RAMP.EMISSIVE, EMISSIVE],
    [RAMP.HUD_GREEN, HUD_GREEN],
    [RAMP.HUD_AMBER, HUD_AMBER],
  ] as const) {
    for (let s = 0; s < RAMP_STEPS; s++) {
      writeEntry(lut, ramp * RAMP_STEPS + s, lerpRGB(m.dark, m.light, s / (RAMP_STEPS - 1)));
    }
  }
  for (let v = 0; v < 256; v++) {
    const base = (TERRAIN_RAMP_BASE + v) * RAMP_STEPS;
    const light = scaleRGB(vgaShade(VGA_PALETTE[v], LIT_STEPS - 1), p);
    for (let s = 0; s < RAMP_STEPS; s++) {
      const c = s < LIT_STEPS
        ? scaleRGB(vgaShade(VGA_PALETTE[v], s), p)
        : lerpRGB(light, haze, (s - LIT_STEPS + 1) / (RAMP_STEPS - LIT_STEPS));
      writeEntry(lut, base + s, c);
    }
  }
}

/**
 * Fixed light colours kept in the tail of the sky ramp (the sky shader uses steps 0..8 only).
 * They are written unscaled, so they glow the same by day and by night.
 */
export const LIGHT = {
  WINDOW_YELLOW: RAMP.SKY * RAMP_STEPS + 10,
  WINDOW_WHITE: RAMP.SKY * RAMP_STEPS + 11,
  RED: RAMP.SKY * RAMP_STEPS + 12,
  /** sun disc and its halo: white by day, yellow when low (applySunColors) */
  SUN_HALO: RAMP.SKY * RAMP_STEPS + 13,
  SUN: RAMP.SKY * RAMP_STEPS + 14,
} as const;
const LIGHT_COLORS: [number, RGB][] = [
  [LIGHT.WINDOW_YELLOW, [255, 204, 72]],
  [LIGHT.WINDOW_WHITE, [236, 240, 255]],
  [LIGHT.RED, [255, 24, 16]],
];

const SUN_DAY: RGB = [255, 255, 255];
const SUN_HALO_DAY: RGB = [212, 224, 240];
const SUN_LOW: RGB = [255, 224, 64];
const SUN_HALO_LOW: RGB = [255, 160, 32];
/** fully yellow up to this sun elevation, fully white from SUN_WHITE_DEG */
const SUN_YELLOW_DEG = 10;
const SUN_WHITE_DEG = 20;

/** sun disc and halo colours: yellow in the morning and evening (low sun), white by day */
export function sunColors(sunElevationDeg: number): { sun: RGB; halo: RGB } {
  const t = Math.max(0, Math.min(1, (sunElevationDeg - SUN_YELLOW_DEG) / (SUN_WHITE_DEG - SUN_YELLOW_DEG)));
  return { sun: lerpRGB(SUN_LOW, SUN_DAY, t), halo: lerpRGB(SUN_HALO_LOW, SUN_HALO_DAY, t) };
}

export function applySunColors(lut: Uint8Array, sunElevationDeg: number): void {
  const { sun, halo } = sunColors(sunElevationDeg);
  writeEntry(lut, LIGHT.SUN, sun);
  writeEntry(lut, LIGHT.SUN_HALO, halo);
}

export function rampIndex(ramp: number, step: number): number {
  return ramp * RAMP_STEPS + Math.max(0, Math.min(RAMP_STEPS - 1, step));
}

/** Quantize an arbitrary RGB to the closest material ramp (S3DB colours, Q4). */
export function nearestMaterialRamp(rgb: RGB): number {
  let best = 0;
  let bestD = Infinity;
  for (let r = 0; r < MATERIALS.length; r++) {
    const d0 = MATERIALS[r].dark;
    const l0 = MATERIALS[r].light;
    // compare against the ramp midpoint so mid-tone colours map sensibly
    const c = [(d0[0] + l0[0]) / 2, (d0[1] + l0[1]) / 2, (d0[2] + l0[2]) / 2];
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

const EGA_RED: RGB = [170, 0, 0];
const EGA_LIGHT_RED: RGB = [255, 85, 85];
const EGA_YELLOW: RGB = [255, 255, 85];
/** Flame ramp steps: outer plume (HUD_AMBER) and core (EMISSIVE); step 11 is unused elsewhere. */
export const FLAME_STEP = 11;
const FLAME_OUTER: RGB[] = [EGA_YELLOW, EGA_RED, EGA_YELLOW, EGA_LIGHT_RED];
const FLAME_CORE: RGB[] = [EGA_RED, EGA_YELLOW, EGA_LIGHT_RED, EGA_YELLOW];

/** Exhaust flicker: the plume and its core swap EGA red/yellow ~20 times a second. */
export function applyFlameColors(lut: Uint8Array, timeSec: number): void {
  const tick = Math.floor(timeSec * 20) & 3;
  writeEntry(lut, RAMP.HUD_AMBER * RAMP_STEPS + FLAME_STEP, FLAME_OUTER[tick]);
  writeEntry(lut, RAMP.EMISSIVE * RAMP_STEPS + FLAME_STEP, FLAME_CORE[tick]);
}
