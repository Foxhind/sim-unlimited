import { LAND_PALETTE_6BIT } from './land-palette';

export type RGB = readonly [number, number, number];

/**
 * Material ramps: hand-made dark → light colour ramps kept in the LUT (lit, fogged and night-tinted
 * copies of each), for the generic surfaces, the sky, lights and the HUD. Ids, as LUT rows of 16 steps.
 */
export const MAT = {
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
  /** seas and oceans (terrain at or below sea level), apart from inland water (WATER): it freezes to another colour */
  SEA: 16,
} as const;

/**
 * Face colour of a mesh vertex, a packed uint32 (Uint32Array per vertex, `aRamp` in the shaders):
 *   bits 0..23   payload: an RGB colour 0xRRGGBB, or with MATERIAL_FLAG the id of a material ramp (MAT);
 *   bits 24..26  night glow level (GLOW_SHIFT);
 *   bit 27       SNOW_FLAG;
 *   bit 28       MATERIAL_FLAG.
 * Any RGB colour is allowed: it is lit, fogged and tinted for the time of day in the shader by the
 * same stepped law as the material ramps (shadeColour), not snapped to a palette.
 */
export const PAYLOAD_MASK = 0xffffff;
export const GLOW_SHIFT = 24;
export const GLOW_LEVEL_MASK = 7;
export const SNOW_FLAG = 1 << 27;
export const MATERIAL_FLAG = 1 << 28;

/** a material ramp as a face colour */
export function material(id: number): number {
  return (MATERIAL_FLAG | id) >>> 0;
}

/** an RGB colour (0..255 per channel, rounded and clamped) as a face colour */
export function colour(r: number, g: number, b: number): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return ((q(r) << 16) | (q(g) << 8) | q(b)) >>> 0;
}

/** the face colour of an RGB triple */
export function colourOf(c: RGB): number {
  return colour(c[0], c[1], c[2]);
}

/** a face colour that names a material ramp */
export function isMaterial(packed: number): boolean {
  return (packed & MATERIAL_FLAG) !== 0;
}

/** the RGB of a face colour that is not a material (glow and snow bits ignored) */
export function rgbOf(packed: number): RGB {
  return [(packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255];
}

/** the face colours of the material ramps */
export const RAMP = {
  GRASS: material(MAT.GRASS),
  FOREST: material(MAT.FOREST),
  WATER: material(MAT.WATER),
  CONCRETE: material(MAT.CONCRETE),
  BRICK: material(MAT.BRICK),
  ASPHALT: material(MAT.ASPHALT),
  SAND: material(MAT.SAND),
  SNOW: material(MAT.SNOW),
  ROCK: material(MAT.ROCK),
  HULL_LIGHT: material(MAT.HULL_LIGHT),
  HULL_DARK: material(MAT.HULL_DARK),
  FIELD: material(MAT.FIELD),
  SKY: material(MAT.SKY),
  EMISSIVE: material(MAT.EMISSIVE),
  HUD_GREEN: material(MAT.HUD_GREEN),
  HUD_AMBER: material(MAT.HUD_AMBER),
  SEA: material(MAT.SEA),
} as const;

/** material ramp rows reserved in the LUT (17 used) */
export const RAMP_COUNT = 32;
export const RAMP_STEPS = 16;
/** LUT entries of one world palette: the material ramps, 16 steps each (256-wide rows) */
export const LUT_SIZE = RAMP_COUNT * RAMP_STEPS;
export const LIT_STEPS = 12; // steps 0..11: lighting range, 12..15: fog range toward haze

/**
 * Night glow: artificial light on the ground and on everything standing on it, in levels 1..7 by
 * how densely built the terrain triangle is (night-glow.ts). The level rides in bits 24..26 of a
 * face colour; the LUT holds one full copy of the material ramps per level, and the shader lights
 * RGB colours by that level's light (lightUniforms), warm street light instead of the night sky.
 */
export const GLOW_LEVELS = 7;
/** entries of the world palettes: the plain palette and one copy per glow level */
export const LUT_TOTAL = LUT_SIZE * (GLOW_LEVELS + 1);
/**
 * The 2D overlay (HUD, menu, maps) is an 8-bit index image looked up in one LUT row of its own
 * after the world palettes: row 0 with the material ramps in daylight, so maps stay readable at night.
 */
export const OVERLAY_LUT_BASE = LUT_TOTAL;
/** entries in the LUT texture (256 per row) */
export const LUT_ENTRIES = LUT_TOTAL + 256;
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

export function withGlow(packed: number, level: number): number {
  return ((packed & ~(GLOW_LEVEL_MASK << GLOW_SHIFT)) | (Math.max(0, Math.min(GLOW_LEVELS, level)) << GLOW_SHIFT)) >>> 0;
}

/**
 * Winter: a face that snow can lie on (open ground, trees, flat roofs) carries SNOW_FLAG;
 * with snow on, the shader draws it in the snow ramp.
 */
export function snowy(packed: number): number {
  return (packed | SNOW_FLAG) >>> 0;
}

/** the night glow level of a face colour */
export function rampGlowLevel(packed: number): number {
  return (packed >>> GLOW_SHIFT) & GLOW_LEVEL_MASK;
}

/** what the weather does to the ground (weather.ts) */
export interface Surface {
  /** snow on open ground, trees and flat roofs */
  snow: boolean;
  /** frozen inland water (light grey ice), steel-grey seas */
  ice: boolean;
}
export const NO_WINTER: Surface = { snow: false, ice: false };

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

/** frozen inland water: light grey ice */
const ICE: MaterialRamp = { dark: [92, 96, 104], light: [200, 204, 210] };
/** a sea in hard frost: steel grey instead of blue */
const SEA_STEEL: MaterialRamp = { dark: [36, 44, 54], light: [104, 118, 132] };
const WATER_INDEX = 2;

const EMISSIVE: MaterialRamp = { dark: [0, 0, 0], light: [255, 252, 216] };
const HUD_GREEN: MaterialRamp = { dark: [0, 40, 0], light: [64, 255, 64] };
const HUD_AMBER: MaterialRamp = { dark: [48, 32, 0], light: [255, 200, 72] };

export interface PaletteParams {
  zenith: RGB;
  horizon: RGB;
  lightMul: number;
  tint: RGB;
  /** colour saturation of lit surfaces (1 = as they are), applied before the light */
  saturation: number;
}

const NIGHT: PaletteParams = {
  zenith: [4, 6, 16],
  horizon: [12, 18, 36],
  lightMul: 0.22,
  tint: [0.55, 0.65, 1.0],
  saturation: 1,
};
const DUSK: PaletteParams = {
  zenith: [24, 28, 80],
  horizon: [224, 120, 64],
  lightMul: 0.55,
  tint: [1.0, 0.72, 0.55],
  saturation: 1,
};
/** daylight under a cloudy sky: the plain, even light */
const DAY: PaletteParams = {
  zenith: [32, 72, 192],
  horizon: [168, 200, 232],
  lightMul: 1.0,
  tint: [1, 1, 1],
  saturation: 1,
};
/**
 * daylight in good weather (sunniness 1): a deep blue zenith over a bright clear horizon, warm
 * brighter sunlight and livelier colours on the ground
 */
const SUNNY_DAY: PaletteParams = {
  zenith: [16, 88, 232],
  horizon: [190, 222, 250],
  lightMul: 1.12,
  tint: [1.0, 0.97, 0.88],
  saturation: 1.4,
};

/** total cloud cover up to this is fully sunny weather, from SUNNY_OVERCAST_PCT on none */
const SUNNY_CLEAR_PCT = 30;
const SUNNY_OVERCAST_PCT = 90;

/**
 * How sunny the weather is, 0..1, from the total cloud cover in % (weather.ts): clear and few
 * clouds give 1, overcast 0. Unknown weather counts as clear (the same default the HUD shows).
 */
export function sunniness(cloudPct: number | undefined): number {
  if (cloudPct === undefined || !Number.isFinite(cloudPct)) return 1;
  return Math.max(0, Math.min(1, (SUNNY_OVERCAST_PCT - cloudPct) / (SUNNY_OVERCAST_PCT - SUNNY_CLEAR_PCT)));
}


/** the base ground's land (renderer drawSky): a muted green-olive, the common tone of Landsat land */
export const BASE_LAND = colour(88, 100, 64);

/** tree trunks: a bark brown */
export const TREE_TRUNK_RAMP = colour(96, 68, 44);

/**
 * The land palette in 8 bits per channel: the colours a Landsat-coloured terrain face is quantized
 * to (landsat-process.ts), so neighbouring tiles agree on colours at their seams. Not a hardware
 * limit: any colour may be drawn, this is only the terrain's own colour set.
 */
export const LAND_PALETTE_SIZE = 240;
export const LAND_PALETTE: RGB[] = LAND_PALETTE_6BIT.map(([r, g, b]) => [Math.round((r * 255) / 63), Math.round((g * 255) / 63), Math.round((b * 255) / 63)] as RGB);
if (LAND_PALETTE.length !== LAND_PALETTE_SIZE) throw new Error(`land palette: ${LAND_PALETTE.length} colours, expected ${LAND_PALETTE_SIZE}`);

/** nearest land palette entry */
export function nearestLand(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < LAND_PALETTE_SIZE; i++) {
    const [pr, pg, pb] = LAND_PALETTE[i];
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

/** a colour one would call green (hue 70°–170°, not grey, not black) */
export function isGreen(c: RGB): boolean {
  const [h, s, v] = hsv(c);
  return h >= 70 && h <= 170 && s >= 0.2 && v >= 0.12;
}

/** a colour that reads as open water in the imagery (clearly blue, not a bluish grey) */
export function isWater([r, g, b]: RGB): boolean {
  return b >= r + 40 && b >= g + 15;
}

/** a land palette colour that reads as open water */
export function isWaterLand(i: number): boolean {
  return isWater(LAND_PALETTE[i]);
}

/** a land palette colour one would call green */
export function isGreenLand(i: number): boolean {
  return isGreen(LAND_PALETTE[i]);
}
const GREEN_LAND = Array.from({ length: LAND_PALETTE_SIZE }, (_, i) => i).filter(isGreenLand);

/**
 * Foliage over the ground of a face colour: the colour itself when green, else the nearest green
 * land colour; glow and snow bits are kept. A material ramp stays as it is.
 */
export function greenColour(packed: number): number {
  if (isMaterial(packed)) return packed;
  const c = rgbOf(packed);
  if (isGreen(c)) return packed;
  let best = GREEN_LAND[0], bd = Infinity;
  for (const k of GREEN_LAND) {
    const [pr, pg, pb] = LAND_PALETTE[k];
    const d = (c[0] - pr) ** 2 + (c[1] - pg) ** 2 + (c[2] - pb) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return ((packed & ~PAYLOAD_MASK) | colourOf(LAND_PALETTE[best])) >>> 0;
}

/**
 * Shade of an RGB face colour at lighting step s (0..LIT_STEPS-1) before the time of day: the colour
 * is what the surface looks like under ordinary daylight, so it sits at ~3/4 of the lighting range;
 * full sun brightens it a little, the shadow side darkens it to about 40 %. The shader does the same.
 */
export function imageryShade(c: RGB, s: number): RGB {
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
    saturation: lerp(a.saturation, b.saturation, t),
  };
}

/**
 * Palette keyframe for a sun elevation in degrees (Q7: day/dusk/night blend). `sunny` (0..1,
 * sunniness) moves the day keyframe from the plain cloudy daylight to SUNNY_DAY; it fades in with
 * the sun through dusk like the rest of the day, so nights and sunsets keep their look.
 */
export function paletteAt(sunElevationDeg: number, sunny = 0): PaletteParams {
  const day = sunny > 0 ? lerpParams(DAY, SUNNY_DAY, Math.min(1, sunny)) : DAY;
  if (sunElevationDeg <= -8) return NIGHT;
  if (sunElevationDeg < 0) return lerpParams(NIGHT, DUSK, (sunElevationDeg + 8) / 8);
  if (sunElevationDeg < 12) return lerpParams(DUSK, day, sunElevationDeg / 12);
  return day;
}

/** saturation k about the colour's own luminance (k = 1: unchanged), clamped to 0..255 */
export function saturate(c: RGB, k: number): RGB {
  if (k === 1) return c;
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const f = (v: number) => Math.max(0, Math.min(255, y + (v - y) * k));
  return [f(c[0]), f(c[1]), f(c[2])];
}

function scaleRGB(c: RGB, p: PaletteParams): RGB {
  const s = saturate(c, p.saturation);
  return [s[0] * p.lightMul * p.tint[0], s[1] * p.lightMul * p.tint[1], s[2] * p.lightMul * p.tint[2]];
}

function writeEntry(lut: Uint8Array, index: number, c: RGB): void {
  lut[index * 4 + 0] = Math.max(0, Math.min(255, Math.round(c[0])));
  lut[index * 4 + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
  lut[index * 4 + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
  lut[index * 4 + 3] = 255;
}

/**
 * Lighting of RGB face colours, as shader uniforms (renderer.beginFrame): per glow level 0..7 the
 * light multiplier (lightMul × tint of that level's palette), and the haze colour fog runs into.
 */
export interface LightUniforms {
  /** 8 × rgb */
  levels: Float32Array;
  /** rgb 0..1 */
  haze: Float32Array;
  /** colour saturation of lit surfaces (PaletteParams.saturation) */
  saturation: number;
}

export function lightUniforms(p: PaletteParams): LightUniforms {
  const levels = new Float32Array((GLOW_LEVELS + 1) * 3);
  for (let k = 0; k <= GLOW_LEVELS; k++) {
    const q = k === 0 ? p : glowParams(p, k);
    for (let i = 0; i < 3; i++) levels[k * 3 + i] = q.lightMul * q.tint[i];
  }
  return { levels, haze: Float32Array.from(p.horizon, (v) => v / 255), saturation: p.saturation };
}

/** the crash flash: everything white */
export const FLASH_LIGHT: LightUniforms = {
  levels: new Float32Array((GLOW_LEVELS + 1) * 3).fill(1000),
  haze: new Float32Array([1, 1, 1]),
  saturation: 1,
};

/**
 * Colour of an RGB face colour at step s (0..15: lighting 0..11, fog 12..15) and glow level k,
 * 0..255 per channel: the CPU mirror of shadeColour in the shaders.
 */
export function shadeColour(c: RGB, s: number, p: PaletteParams, k = 0): RGB {
  const q = k === 0 ? p : glowParams(p, k);
  const lit = (t: number) => scaleRGB(imageryShade(c, t), q);
  if (s < LIT_STEPS) return lit(s);
  return lerpRGB(lit(LIT_STEPS - 1), p.horizon, (s - LIT_STEPS + 1) / (RAMP_STEPS - LIT_STEPS));
}

/**
 * Builds the RGBA LUT: the plain palette (LUT_SIZE entries), then one street-lit copy per glow level.
 * Material ramps: steps 0..11 dark→light (lighting), 12..15 light→haze (fog).
 * The haze end equals the sky horizon color so fogged geometry meets the sky.
 */
export function buildLUT(p: PaletteParams, surface: Surface = NO_WINTER): Uint8Array {
  const lut = new Uint8Array(LUT_ENTRIES * 4);
  buildPlainLUT(lut, p, surface);
  for (let k = 1; k <= GLOW_LEVELS; k++) buildPlainLUT(lut.subarray(k * LUT_SIZE * 4, (k + 1) * LUT_SIZE * 4), glowParams(p, k), surface);
  for (const [i, c] of LIGHT_COLORS) writeEntry(lut, i, c);
  // overlay row: row 0 as it is (sky-coloured panels, HUD), material ramps (map colours) by day
  const overlay = lut.subarray(OVERLAY_LUT_BASE * 4);
  overlay.set(lut.subarray(0, 256 * 4));
  const day = new Uint8Array(LUT_SIZE * 4);
  buildPlainLUT(day, DAY);
  overlay.set(day.subarray(0, MATERIALS.length * RAMP_STEPS * 4));
  return lut;
}

/** palette of glow level k: the scene under street light, never darker than the sky gives */
export function glowParams(p: PaletteParams, k: number): PaletteParams {
  const mul = GLOW_MUL_MIN + ((GLOW_MUL_MAX - GLOW_MUL_MIN) * (k - 1)) / (GLOW_LEVELS - 1);
  if (p.lightMul >= mul) return p;
  return { ...p, lightMul: mul, tint: lerpRGB(GLOW_TINT, p.tint, p.lightMul / mul) };
}

function buildPlainLUT(lut: Uint8Array, p: PaletteParams, surface: Surface = NO_WINTER): void {
  const haze = p.horizon;
  const writeMaterial = (ramp: number, m: MaterialRamp): void => {
    const dark = scaleRGB(m.dark, p);
    const light = scaleRGB(m.light, p);
    for (let s = 0; s < RAMP_STEPS; s++) {
      const c =
        s < LIT_STEPS
          ? lerpRGB(dark, light, s / (LIT_STEPS - 1))
          : lerpRGB(light, haze, (s - LIT_STEPS + 1) / (RAMP_STEPS - LIT_STEPS));
      writeEntry(lut, ramp * RAMP_STEPS + s, c);
    }
  };

  for (let r = 0; r < MATERIALS.length; r++) {
    writeMaterial(r, surface.ice && r === WATER_INDEX ? ICE : MATERIALS[r]);
  }

  for (let s = 0; s < RAMP_STEPS; s++) {
    writeEntry(lut, MAT.SKY * RAMP_STEPS + s, lerpRGB(p.zenith, p.horizon, s / (RAMP_STEPS - 1)));
  }
  for (const [ramp, m] of [
    [MAT.EMISSIVE, EMISSIVE],
    [MAT.HUD_GREEN, HUD_GREEN],
    [MAT.HUD_AMBER, HUD_AMBER],
  ] as const) {
    for (let s = 0; s < RAMP_STEPS; s++) {
      writeEntry(lut, ramp * RAMP_STEPS + s, lerpRGB(m.dark, m.light, s / (RAMP_STEPS - 1)));
    }
  }
  writeMaterial(MAT.SEA, surface.ice ? SEA_STEEL : MATERIALS[WATER_INDEX]);
}

/**
 * Fixed light colours kept in the tail of the sky ramp (the sky shader uses steps 0..8 only).
 * They are written unscaled, so they glow the same by day and by night.
 */
export const LIGHT = {
  WINDOW_YELLOW: MAT.SKY * RAMP_STEPS + 10,
  WINDOW_WHITE: MAT.SKY * RAMP_STEPS + 11,
  RED: MAT.SKY * RAMP_STEPS + 12,
  /** sun disc and its halo: white by day, yellow when low (applySunColors) */
  SUN_HALO: MAT.SKY * RAMP_STEPS + 13,
  SUN: MAT.SKY * RAMP_STEPS + 14,
  /** blue taxiway edge lights (kept apart from the water ramp, which turns to ice in frost) */
  TAXI_BLUE: MAT.SKY * RAMP_STEPS + 9,
  /** street lighting: lamp heads and far lit roads at night (sodium orange); a free step of the HUD amber ramp (3, 11, 13 are used) */
  STREET: MAT.HUD_AMBER * RAMP_STEPS + 14,
} as const;
const LIGHT_COLORS: [number, RGB][] = [
  [LIGHT.TAXI_BLUE, [64, 128, 255]],
  [LIGHT.WINDOW_YELLOW, [255, 204, 72]],
  [LIGHT.WINDOW_WHITE, [236, 240, 255]],
  [LIGHT.RED, [255, 24, 16]],
  [LIGHT.STREET, [255, 176, 80]],
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

/** LUT index of a material ramp (MAT id, or its face colour RAMP.*) at a step */
export function rampIndex(ramp: number, step: number): number {
  return (ramp & PAYLOAD_MASK) * RAMP_STEPS + Math.max(0, Math.min(RAMP_STEPS - 1, step));
}

/** RGB point colours (pointValue) are shaded at this lighting step, like a lit face */
export const POINT_STEP = 9;

/**
 * The colour value of a point or line vertex (props, dots: x, y, z, value): a LUT index (>= 0) as
 * it is; an RGB face colour as -(0xRRGGBB + 1), shaded at POINT_STEP by daylight. Floats hold both exactly.
 */
export function pointValue(packed: number, step = POINT_STEP): number {
  return isMaterial(packed) ? rampIndex(packed, step) : -((packed & PAYLOAD_MASK) + 1);
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
  writeEntry(lut, MAT.HUD_AMBER * RAMP_STEPS + FLAME_STEP, FLAME_OUTER[tick]);
  writeEntry(lut, MAT.EMISSIVE * RAMP_STEPS + FLAME_STEP, FLAME_CORE[tick]);
}
