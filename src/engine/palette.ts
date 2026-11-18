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
  /** the sunset glow round a low sun (SKY_FS): zenith → skyLow (step 4) → sunGlow (step 8); its rings use steps 5..8 */
  SKY_GLOW: 17,
} as const;

/**
 * Face colour of a mesh vertex, a packed uint32 (Uint32Array per vertex, `aRamp` in the shaders):
 *   bits 0..23   payload: an RGB colour 0xRRGGBB, or with MATERIAL_FLAG the id of a material ramp (MAT);
 *   bits 24..26  night glow level (GLOW_SHIFT);
 *   bit 27       SNOW_FLAG;
 *   bit 28       MATERIAL_FLAG;
 *   bit 29       SELF_LIT_FLAG: an RGB colour that is a light source (aircraft lights), drawn at full
 *                strength whatever the sun or night, and only half as hazed by the fog.
 * Any RGB colour is allowed: it is lit, fogged and tinted for the time of day in the shader by the
 * same stepped law as the material ramps (shadeColour), not snapped to a palette.
 */
export const PAYLOAD_MASK = 0xffffff;
export const GLOW_SHIFT = 24;
export const GLOW_LEVEL_MASK = 7;
export const SNOW_FLAG = 1 << 27;
export const MATERIAL_FLAG = 1 << 28;
export const SELF_LIT_FLAG = 1 << 29;

/** an RGB face colour that shines by itself (a light source) */
export function selfLit(packed: number): number {
  return ((packed & PAYLOAD_MASK) | SELF_LIT_FLAG) >>> 0;
}

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

/** material ramp rows reserved in the LUT (18 used) */
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
  { dark: [48, 84, 24], light: [140, 188, 80] }, // field
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
  /** the haze at the horizon: what fog runs into (and sky ramp step 15) */
  horizon: RGB;
  /** sky colour half-way down (band 4 of the 9 drawn sky bands) */
  skyMid: RGB;
  /** sky colour of the lowest drawn band, just above the horizon (band 8) */
  skyLow: RGB;
  /** colour of the sky right above a low sun (the lowest band of the SKY_GLOW ramp) */
  sunGlow: RGB;
  /** how strongly the sky glows toward the sun, 0..1 (0: no glow, the plain sky ramp all round) */
  glow: number;
  /** how much water mirrors the sky instead of its own blue, 0..1 */
  waterSky: number;
  lightMul: number;
  tint: RGB;
  /** colour saturation of lit surfaces (1 = as they are), applied before the light */
  saturation: number;
  /**
   * colour of the skylight that lights the faces turned away from the sun (any brightness: only
   * its hue counts, SUNLIGHT_GLSL): blue under a clear sky, violet at dusk, plain under cloud
   */
  ambient: RGB;
}

/**
 * A plain two-colour sky (day, night): the drawn bands run a straight line from the zenith toward
 * the horizon haze (band b at b/15 of the way, as the sky ramp always did), no glow toward the sun.
 * sunGlow is not drawn there (glow 0); it is the warm white of plain sunlight, which the rim light
 * (rim.ts) takes its colour from by day.
 */
function plainSky(zenith: RGB, horizon: RGB): Pick<PaletteParams, 'zenith' | 'horizon' | 'skyMid' | 'skyLow' | 'sunGlow' | 'glow' | 'waterSky'> {
  const low = lerpRGB(zenith, horizon, 8 / 15);
  return { zenith, horizon, skyMid: lerpRGB(zenith, horizon, 4 / 15), skyLow: low, sunGlow: DAYLIGHT_GLOW, glow: 0, waterSky: 0 };
}
/** plain sunlight's colour (plainSky sunGlow) */
const DAYLIGHT_GLOW: RGB = [255, 246, 224];

const NIGHT: PaletteParams = {
  ...plainSky([4, 6, 16], [12, 18, 36]),
  lightMul: 0.22,
  tint: [0.55, 0.65, 1.0],
  saturation: 1,
  ambient: [1, 1, 1],
};
/**
 * Sunset and sunrise (sun on the horizon): a violet zenith, magenta-pink half-way down, coral
 * orange above the horizon, gold around the sun; warm pink light on the ground, water mirroring the
 * violet and pink sky. The haze is a dusky mauve, darker than the bright sky above the horizon, so
 * fully fogged far ground (beyond the fog end, up to the true horizon from altitude) still reads as
 * ground and the horizon stays a line.
 */
const DUSK: PaletteParams = {
  zenith: [76, 36, 140],
  skyMid: [226, 48, 140],
  skyLow: [255, 112, 64],
  sunGlow: [255, 168, 72],
  horizon: [160, 72, 120],
  glow: 1,
  waterSky: 0.75,
  lightMul: 0.58,
  tint: [1.0, 0.66, 0.74],
  saturation: 1.15,
  ambient: [0.8, 0.78, 1.3],
};
/**
 * Sunrise (sun on the horizon, rising): the same glow as the sunset in the cool colours of a
 * morning — a deep blue zenith, azure half-way down, pale cyan above the horizon, pale gold round
 * the sun; cool light on the ground, water mirroring the blue sky. The haze is a dusky steel blue,
 * darker than the sky above the horizon, as DUSK's is.
 */
const DAWN: PaletteParams = {
  zenith: [20, 40, 128],
  skyMid: [48, 132, 220],
  skyLow: [150, 214, 240],
  sunGlow: [255, 220, 150],
  horizon: [84, 120, 168],
  glow: 1,
  waterSky: 0.75,
  lightMul: 0.62,
  tint: [0.82, 0.92, 1.06],
  saturation: 1.1,
  ambient: [0.82, 0.92, 1.25],
};
/** daylight under a cloudy sky: the plain, even light */
const DAY: PaletteParams = {
  ...plainSky([32, 72, 192], [168, 200, 232]),
  lightMul: 1.0,
  tint: [1, 1, 1],
  saturation: 1,
  ambient: [0.97, 0.99, 1.04],
};
/**
 * daylight in good weather (sunniness 1): a deep blue zenith over a bright clear horizon, warm
 * brighter sunlight and livelier colours on the ground
 */
const SUNNY_DAY: PaletteParams = {
  ...plainSky([16, 88, 232], [190, 222, 250]),
  lightMul: 1.12,
  tint: [1.0, 0.97, 0.88],
  saturation: 1.4,
  ambient: [0.86, 0.95, 1.18],
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
    skyMid: lerpRGB(a.skyMid, b.skyMid, t),
    skyLow: lerpRGB(a.skyLow, b.skyLow, t),
    sunGlow: lerpRGB(a.sunGlow, b.sunGlow, t),
    glow: lerp(a.glow, b.glow, t),
    waterSky: lerp(a.waterSky, b.waterSky, t),
    lightMul: lerp(a.lightMul, b.lightMul, t),
    tint: lerpRGB(a.tint, b.tint, t),
    saturation: lerp(a.saturation, b.saturation, t),
    ambient: lerpRGB(a.ambient, b.ambient, t),
  };
}

/** sun elevation from which the day palette is in full */
const DUSK_DAY_DEG = 12;
/** the haze's own dusk → day curve (the rest of the palette goes by k^1.5) */
const HAZE_EXP = 0.5;

/**
 * Palette keyframe for a sun elevation in degrees (Q7: day/dusk/night blend). `sunny` (0..1,
 * sunniness) moves the day keyframe from the plain cloudy daylight to SUNNY_DAY; it fades in with
 * the sun through dusk like the rest of the day, so nights and sunsets keep their look.
 * `morning` (the sun rising): the low-sun keyframe is the cool DAWN instead of the violet DUSK.
 */
export function paletteAt(sunElevationDeg: number, sunny = 0, morning = false): PaletteParams {
  const day = sunny > 0 ? lerpParams(DAY, SUNNY_DAY, Math.min(1, sunny)) : DAY;
  const low = morning ? DAWN : DUSK;
  if (sunElevationDeg <= -8) return NIGHT;
  if (sunElevationDeg < 0) return lerpParams(NIGHT, low, (sunElevationDeg + 8) / 8);
  // the low-sun colours hold while the sun is low and give way to the day faster as it climbs
  if (sunElevationDeg < DUSK_DAY_DEG) {
    const k = sunElevationDeg / DUSK_DAY_DEG;
    const p = lerpParams(low, day, k ** 1.5);
    // the haze turns to the day's earlier than the sky above it, so the two never meet in one
    // colour on the way (the dusk haze is darker than the sky band over it, the day's lighter)
    return { ...p, horizon: lerpRGB(low.horizon, day.horizon, k ** HAZE_EXP) };
  }
  return day;
}

/** saturation k about the colour's own luminance (k = 1: unchanged), clamped to 0..255 */
export function saturate(c: RGB, k: number): RGB {
  if (k === 1) return c;
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const f = (v: number) => Math.max(0, Math.min(255, y + (v - y) * k));
  return [f(c[0]), f(c[1]), f(c[2])];
}

/**
 * A filter colour over a base colour in soft-light mode (W3C compositing): each channel of the
 * filter above mid grey lightens the base, below it darkens, so the base keeps its own contrast.
 * `strength` 0..1 lerps from the base to the full blend.
 */
export function softLight(base: RGB, filter: RGB, strength = 1): RGB {
  const ch = (b255: number, s255: number): number => {
    const b = b255 / 255, s = s255 / 255;
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    const r = s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
    return (b + (r - b) * strength) * 255;
  };
  return [ch(base[0], filter[0]), ch(base[1], filter[1]), ch(base[2], filter[2])];
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
  /** sky glow toward the sun, 0..1 (PaletteParams.glow, SKY_FS) */
  sunGlow: number;
  /**
   * the water surface (GLITTER_GLSL, WATER_GLSL): [0] the dusk look's strength 0..1 (the sky glow:
   * the glitter path, the mirrored sky bands, the neon grid), [1..3] rgb 0..1 of the glitter's core
   * (next to the sun's line, also the glints' colour) and [4..6] of its edges, [7] 1 open water,
   * 0 frozen (no waves, glints or dusk look)
   */
  glitter: Float32Array;
  /** skylight (SUNLIGHT_GLSL uSky): rgb its hue (luminance 1), a its share of a face's light 0..1 */
  sky: Float32Array;
  /**
   * direct light (SUNLIGHT_GLSL uDirect): x the sun's strength through the weather 0..1, y the
   * moon's (its elevation and phase, set per frame by the caller, 0 by default), z how much the
   * light's colour tints faces 0..1, w unused
   */
  direct: Float32Array;
}

/** the skylight's share of a face's light under a clear sky and under overcast */
const AMBIENT_CLEAR = 0.3;
const AMBIENT_OVERCAST = 0.55;
/** how far the light's colour tints faces (1: the full colour of the sun and the sky) */
const LIGHT_TINT = 0.7;
const LUMA: RGB = [0.299, 0.587, 0.114];
const luma = (c: RGB): number => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/**
 * `sunny` (0..1, sunniness): a clear sky gives hard sunlight and dark shade, overcast soft even
 * light, mostly from the sky.
 */
export function lightUniforms(p: PaletteParams, sunny = 1): LightUniforms {
  const levels = new Float32Array((GLOW_LEVELS + 1) * 3);
  for (let k = 0; k <= GLOW_LEVELS; k++) {
    const q = k === 0 ? p : glowParams(p, k);
    for (let i = 0; i < 3; i++) levels[k * 3 + i] = q.lightMul * q.tint[i];
  }
  const clear = Math.max(0, Math.min(1, sunny));
  const y = luma(p.ambient);
  return {
    levels, haze: Float32Array.from(p.horizon, (v) => v / 255), saturation: p.saturation, sunGlow: p.glow, glitter: glitterOf(p),
    sky: Float32Array.from([p.ambient[0] / y, p.ambient[1] / y, p.ambient[2] / y, lerp(AMBIENT_OVERCAST, AMBIENT_CLEAR, clear)]),
    direct: Float32Array.from([0.5 + 0.5 * clear, 0, LIGHT_TINT, 0]),
  };
}

/**
 * Optical depth of the clear air toward the zenith from sea level at red, green and blue
 * (Rayleigh + a little haze): low sunlight crosses more air, loses its blue and green first and
 * turns yellow, orange, then red (SUNLIGHT_GLSL).
 */
export const SUN_TAU: RGB = [0.08, 0.14, 0.26];
/** scale height of the air, m: the air mass above a point falls off with its height */
const AIR_SCALE_H = 8000;
const EARTH_R = 6371000;

/**
 * Sunlight reaching a point `heightM` above sea level while the sun stands `sinElev` (sine of its
 * elevation over the sea-level horizon) — the CPU mirror of SUNLIGHT_GLSL sunlightAt. A raised
 * point sees over the curve of the Earth (the horizon dips by sqrt(2h/R)), so peaks and clouds
 * keep the low red sun a while after the ground below has lost it, and crosses less air.
 * rgb: its colour, 0..1, the strongest channel 1 (white with the sun high); strength 0..1.
 */
export function sunlight(sinElev: number, heightM = 0): { rgb: RGB; strength: number } {
  const h = Math.max(0, heightM);
  const e = Math.asin(Math.max(-1, Math.min(1, sinElev))) + Math.sqrt((2 * h) / EARTH_R);
  const vis = smoothstep(-0.01, 0.02, e);
  if (vis <= 0) return { rgb: [1, 1, 1], strength: 0 };
  const ed = Math.max((e * 180) / Math.PI, -0.5);
  // Kasten & Young (1989) air mass, thinned with the height
  const m = (1 / (Math.sin((ed * Math.PI) / 180) + 0.50572 * (ed + 6.07995) ** -1.6364)) * Math.exp(-h / AIR_SCALE_H);
  const t = SUN_TAU.map((tau) => Math.exp(-tau * Math.max(m - 1, 0))) as unknown as RGB;
  return { rgb: [1, t[1] / t[0], t[2] / t[0]], strength: vis * (0.8 + 0.2 * luma(t)) };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** glitter colours: a pale gold core lit by the sun's glow, edges between the glow and the mid sky */
function glitterOf(p: PaletteParams): Float32Array {
  const core = lerpRGB(p.sunGlow, [255, 246, 176], 0.6);
  const edge = lerpRGB(p.sunGlow, p.skyMid, 0.5);
  return Float32Array.from([p.glow, ...core.map((v) => v / 255), ...edge.map((v) => v / 255), 1]);
}

/** the crash flash: everything white */
export const FLASH_LIGHT: LightUniforms = {
  levels: new Float32Array((GLOW_LEVELS + 1) * 3).fill(1000),
  haze: new Float32Array([1, 1, 1]),
  saturation: 1,
  sunGlow: 0,
  glitter: new Float32Array(8),
  sky: new Float32Array([1, 1, 1, 1]),
  direct: new Float32Array(4),
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
  const writeMaterial = (ramp: number, m: MaterialRamp, mirror = 0): void => {
    let dark = scaleRGB(m.dark, p);
    let light = scaleRGB(m.light, p);
    if (mirror > 0) {
      // open water mirrors the sky: dark toward the zenith, light toward the pink half-way band
      dark = lerpRGB(dark, lerpRGB([0, 0, 0], p.zenith, WATER_MIRROR_DARK), mirror);
      light = lerpRGB(light, lerpRGB([0, 0, 0], p.skyMid, WATER_MIRROR_LIGHT), mirror);
    }
    for (let s = 0; s < RAMP_STEPS; s++) {
      const c =
        s < LIT_STEPS
          ? lerpRGB(dark, light, s / (LIT_STEPS - 1))
          : lerpRGB(light, haze, (s - LIT_STEPS + 1) / (RAMP_STEPS - LIT_STEPS));
      writeEntry(lut, ramp * RAMP_STEPS + s, c);
    }
  };

  for (let r = 0; r < MATERIALS.length; r++) {
    const water = r === WATER_INDEX && !surface.ice;
    writeMaterial(r, surface.ice && r === WATER_INDEX ? ICE : MATERIALS[r], water ? p.waterSky : 0);
  }

  for (let s = 0; s < RAMP_STEPS; s++) {
    writeEntry(lut, MAT.SKY * RAMP_STEPS + s, skyColour(p, s));
    writeEntry(lut, MAT.SKY_GLOW * RAMP_STEPS + s, skyGlowColour(p, s));
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
  writeMaterial(MAT.SEA, surface.ice ? SEA_STEEL : MATERIALS[WATER_INDEX], surface.ice ? 0 : p.waterSky);
}

/** water mirroring the sky: brightness of the mirrored zenith (dark end) and half-way band (light end) */
const WATER_MIRROR_DARK = 0.5;
const WATER_MIRROR_LIGHT = 0.85;

/** the drawn sky bands are steps 0..SKY_BANDS-1 of the sky ramps */
export const SKY_BANDS = 9;

/**
 * Sky ramp step s: the drawn bands 0..8 run zenith → skyMid (band 4) → skyLow (band 8); further
 * steps toward the horizon haze, which step 15 is (fog runs into it). Steps 9..14 are overwritten
 * by the fixed light colours (LIGHT).
 */
export function skyColour(p: PaletteParams, s: number): RGB {
  const mid = (SKY_BANDS - 1) / 2;
  if (s <= mid) return lerpRGB(p.zenith, p.skyMid, s / mid);
  if (s <= SKY_BANDS - 1) return lerpRGB(p.skyMid, p.skyLow, (s - mid) / mid);
  return lerpRGB(p.skyLow, p.horizon, (s - SKY_BANDS + 1) / (RAMP_STEPS - SKY_BANDS));
}

/** the sky toward a low sun, step s: zenith → skyLow (band 4) → sunGlow (band 8) */
export function skyGlowColour(p: PaletteParams, s: number): RGB {
  const mid = (SKY_BANDS - 1) / 2;
  if (s <= mid) return lerpRGB(p.zenith, p.skyLow, s / mid);
  return lerpRGB(p.skyLow, p.sunGlow, Math.min(1, (s - mid) / mid));
}

/**
 * Fixed light colours kept in the tail of the sky ramp (the sky shader uses steps 0..8 only).
 * They are written unscaled, so they glow the same by day and by night.
 */
export const LIGHT = {
  WINDOW_YELLOW: MAT.SKY * RAMP_STEPS + 10,
  WINDOW_WHITE: MAT.SKY * RAMP_STEPS + 11,
  RED: MAT.SKY * RAMP_STEPS + 12,
  /** the sun disc: white by day, yellow when low (applySunColors); step 13 is free */
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
const SUN_LOW: RGB = [255, 232, 72];
/** fully yellow up to this sun elevation, fully white from SUN_WHITE_DEG */
const SUN_YELLOW_DEG = 10;
const SUN_WHITE_DEG = 20;

/** sun disc colour: white by day, yellow in the morning and evening (low sun) */
export function sunColour(sunElevationDeg: number): RGB {
  const t = Math.max(0, Math.min(1, (sunElevationDeg - SUN_YELLOW_DEG) / (SUN_WHITE_DEG - SUN_YELLOW_DEG)));
  return lerpRGB(SUN_LOW, SUN_DAY, t);
}

export function applySunColors(lut: Uint8Array, sunElevationDeg: number): void {
  writeEntry(lut, LIGHT.SUN, sunColour(sunElevationDeg));
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
