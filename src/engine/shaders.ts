/**
 * Logarithmic depth for every world pass (terrain, OSM drape, aircraft, trees, lights).
 * A standard 24-bit depth buffer with near 0.5 m resolves only ~0.5 m at 2 km and ~3 m at 5 km,
 * so overlays draped 0.3-1.4 m above the terrain z-fought with it beyond a couple of km.
 * log2(1 + w) / log2(1 + far) keeps the relative resolution ~1e-6 (centimetres at 10 km).
 * Must match the far plane of the projection (main.ts / camera.ts).
 */
import { CLIMATE, SUN_TAU, GLOW_LEVEL_MASK, GLOW_LEVELS, GLOW_SHIFT, GLOW_STEP_BASE, LIGHT, LUT_SIZE, MAT, MATERIAL_FLAG, OVERLAY_LUT_BASE, PAYLOAD_MASK, POINT_STEP, SELF_LIT_FLAG, SKY_BANDS, SNOW_FLAG, TREE_TRUNK_RAMP, WINDOWS, FACADE_ALL_NIGHT, FACADE_BLIND, FACADE_RESIDENTIAL, FACADE_SEED_BITS, ROAD_EDGE, ROAD_MARK, ROAD_U_BASE, TRACK_EDGE, WINDOW_LIGHT, FAR_WINDOWS, FAR_WINDOW_LIT_FACTOR, type RGB } from './palette';

export const DEPTH_FAR = 200000;
/**
 * XDR: the brightest a light source's strongest channel gets, × SDR white in linear light (EMIT_GLSL).
 * Browsers don't tell the display's headroom; a MacBook Pro XDR panel has ~3× at its default
 * brightness, more when dimmer. Above the headroom the display clips each channel: white just stays
 * at the panel's peak, a saturated colour loses a little hue as its weak channels catch up. 12× keeps
 * lights bright up to the panel's full headroom (~16× when dimmed), at the cost of that wash on a
 * bright panel.
 */
export const HDR_PEAK = 12;
/** the projections' near plane, m (main.ts, camera.ts): reversed-Z depth is REVERSED_NEAR / w (LOG_DEPTH_FS) */
export const REVERSED_NEAR = 0.5;
/** sunset glow round the sun (SKY_FS): its radius in radians (~29°) and how many rings it steps in */
const GLOW_RADIUS = 0.5;
const GLOW_RINGS = 4;
/**
 * the sky on the side away from the sun (SKY_FS): how far it goes toward ANTISUN_TINT (a darker,
 * bluer copy of the band, the Earth's shadow) by day and at dusk, and in how many steps
 */
const ANTISUN_DAY = 0.25;
const ANTISUN_DUSK = 1.0;
const ANTISUN_STEPS = 4;
const ANTISUN_TINT = 'vec3(0.42, 0.48, 0.72)';

/** how far the dusk haze is lifted from the sky's colour toward white (hazeAt) */
const HAZE_LIFT = 0.3;
/** Earth radius of the curvature drop in the world shaders (wp.y -= d^2 / 2R) and the base ground */
const EARTH_R = 6371000;
/**
 * World colour (palette.ts): the world passes write RGB, not palette indices. A face colour is a
 * packed uint: an RGB colour, or (MATERIAL_FLAG) a material ramp looked up in the LUT; bits 24..26
 * the night glow level, SNOW_FLAG: snow can lie on the face.
 * Lighting stays stepped (12 lit steps, 4 fog steps toward the horizon haze) for both kinds: a
 * material takes its ramp's LUT entry at the step, an RGB colour is shaded by the same law in place
 * (palette.ts shadeColour) with the light of its glow level (uLight) — any colour, no palette snap.
 * With uGlow on, a glowing face is shaded at least at step GLOW_STEP_BASE + level, in that level's
 * street-lit light. The climate at the face (climateTemp, palette.ts CLIMATE) decides snow and ice:
 * a face flagged SNOW_FLAG is drawn in the snow ramp at CLIMATE.SNOW_C and below, inland water and
 * seas freeze to the ICE / SEA_ICE ramps at CLIMATE.ICE_C and below. A face flagged
 * SELF_LIT_FLAG (an aircraft light) is its own colour, unlit and unshaded.
 */
/**
 * XDR emission (renderer.ts HDR_EMISSION): a light source's colour scaled in linear light, so its
 * hue holds. Colours here are sRGB-encoded, and so is the half-float canvas (extended sRGB): scaling
 * the encoded value would raise the weak channels too (0x22ff55 × 4 is ~21× green but ~2× blue in
 * linear light), and once the display clips the strong one at its headroom a green light goes white.
 * The display clips channel by channel too, so the gain stops where the strongest channel reaches
 * HDR_PEAK: the whole colour scales together and keeps its hue.
 */
const EMIT_GLSL = `
vec3 emitLight(vec3 c, float g) {
  if (g == 1.0) return c;
  vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  float top = max(max(lin.r, lin.g), max(lin.b, 1e-4));
  lin *= clamp(${HDR_PEAK.toFixed(2)} / top, 1.0, g);
  return mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}
`;
const COLOUR_GLSL = `${EMIT_GLSL}
uniform sampler2D uLut;
uniform vec3 uLight[${GLOW_LEVELS + 1}];
uniform vec3 uHaze;
uniform float uSat;
vec3 lutColor(uint i) { return texelFetch(uLut, ivec2(int(i & 255u), int(i >> 8u)), 0).rgb; }
vec3 rgbOf(uint p) { return vec3(float((p >> 16u) & 255u), float((p >> 8u) & 255u), float(p & 255u)) / 255.0; }
vec3 vivid(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return clamp(vec3(y) + (c - vec3(y)) * uSat, 0.0, 1.0);
}
vec3 imageryShade(vec3 c, float s, uint lvl) { return vivid(min(c * (0.4 + 0.8 * s / 11.0), 1.0)) * uLight[lvl]; }
vec3 shadeRgb(vec3 c, uint s, uint lvl) {
  if (s < 12u) return imageryShade(c, float(s), lvl);
  return mix(imageryShade(c, 11.0, lvl), uHaze, float(s - 11u) / 4.0);
}
`;
/**
 * The light on a face (palette.ts sunlight, lightUniforms): skylight from every side in the sky's
 * hue, plus direct light from the sun and the moon by Lambert. The sunlight's colour comes from
 * the air it crosses (SUN_TAU, the Kasten & Young air mass) to the face's own height, over the
 * horizon as seen from there: a low sun lights the faces turned to it yellow to red while the
 * shade stays blue or violet, and peaks and clouds keep the red light after the ground lost it.
 * uSun / uMoon: the true directions; uSky rgb the skylight's hue, a its share; uDirect x the sun's
 * strength through the weather, y the moon's, z how strongly the colours tint the faces, w the gain
 * on the sun's direct light.
 * sceneLight → rgb the tint (luminance 1), a the brightness 0..1 (the lighting step / 11).
 */
const SUNLIGHT_GLSL = `
uniform vec3 uSun;
uniform vec3 uMoon;
uniform vec4 uSky;
uniform vec4 uDirect;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
vec4 sunlightAt(float height) {
  float h = max(height, 0.0);
  float e = asin(clamp(uSun.y, -1.0, 1.0)) + sqrt(2.0 * h / ${EARTH_R.toFixed(1)});
  float vis = smoothstep(-0.01, 0.02, e);
  if (vis <= 0.0) return vec4(1.0, 1.0, 1.0, 0.0);
  float ed = max(degrees(e), -0.5);
  float m = exp(-h / 8000.0) / (sin(radians(ed)) + 0.50572 * pow(ed + 6.07995, -1.6364));
  vec3 t = exp(-vec3(${SUN_TAU.map((v) => v.toFixed(3)).join(', ')}) * max(m - 1.0, 0.0));
  return vec4(t / t.r, vis * (0.8 + 0.2 * dot(t, LUMA)));
}
vec4 sceneLight(vec3 n, float height) {
  vec4 sun = sunlightAt(height);
  float a = uSky.a;
  float ds = (1.0 - a) * max(dot(n, uSun), 0.0) * sun.a * uDirect.x * uDirect.w;
  float dm = (1.0 - a) * max(dot(n, uMoon), 0.0) * uDirect.y;
  // the hue goes from the sky's (shade) to the direct light's as a face turns to it
  vec3 dir = (ds * sun.rgb + vec3(dm)) / max(ds + dm, 1e-4);
  dir /= max(dot(dir, LUMA), 1e-3);
  vec3 c = mix(uSky.rgb, dir, sqrt(clamp((ds + dm) / (1.0 - a), 0.0, 1.0)));
  return vec4(mix(vec3(1.0), c, uDirect.z), min(a + ds + dm, 1.0));
}
// the same face in a cast shadow (SHADOW_RECEIVE_VS): the sun blocked, the skylight (and the moon) left
vec4 sceneShade(vec3 n) {
  float a = uSky.a;
  float dm = (1.0 - a) * max(dot(n, uMoon), 0.0) * uDirect.y;
  vec3 c = mix(uSky.rgb, vec3(1.0), sqrt(clamp(dm / (1.0 - a), 0.0, 1.0)));
  return vec4(mix(vec3(1.0), c, uDirect.z), min(a + dm, 1.0));
}
`;
/**
 * The drawn sky in direction dir (SKY_FS), the sun toward sun: its bands, the sunset glow's rings
 * round the sun, the far side darker and bluer. uSunGlow: the glow's strength (palette.ts glow).
 */
const SKY_COLOUR_GLSL = `
uniform float uSunGlow;
vec3 skyAt(vec3 dir, vec3 sun) {
  float t = clamp(dir.y, 0.0, 1.0);
  float h = pow(1.0 - t, 1.6) * ${SKY_BANDS}.0;
  // Sunset glow: rings round the sun disc, by the angle from the sun (so they are circles centred
  // on it), in steps like the sky bands: coral outside, gold at the disc. The inner rings cover the
  // bands, the outer ones let them show through.
  float ang = acos(clamp(dot(dir, sun), -1.0, 1.0));
  float g = uSunGlow * clamp(1.0 - ang / ${GLOW_RADIUS.toFixed(2)}, 0.0, 1.0);
  g = floor(g * ${GLOW_RINGS}.0 + 0.5) / ${GLOW_RINGS}.0;
  uint band = uint(min(floor(h), ${SKY_BANDS - 1}.0));
  vec3 col = lutColor(${MAT.SKY * 16}u + band);
  if (g > 0.0) {
    uint ring = ${SKY_BANDS - 1 - GLOW_RINGS}u + uint(g * ${GLOW_RINGS}.0 + 0.5);
    col = mix(col, lutColor(${MAT.SKY_GLOW * 16}u + ring), min(1.0, g * 1.25));
  }
  // The far side: the sky turns darker and bluer the further round from the sun's azimuth, most
  // low down (the zenith stays as it is), strongest at dusk, in steps like the bands.
  vec2 dh = dir.xz, sh = sun.xz;
  if (dot(dh, dh) > 1e-8 && dot(sh, sh) > 1e-8) {
    float away = smoothstep(0.2, 1.0, 0.5 - 0.5 * dot(normalize(dh), normalize(sh)));
    float most = mix(${ANTISUN_DAY.toFixed(2)}, ${ANTISUN_DUSK.toFixed(2)}, uSunGlow) * clamp((sun.y + 0.1) / 0.1, 0.0, 1.0);
    float d = away * pow(1.0 - t, 0.8);
    d = floor(d * ${ANTISUN_STEPS}.0 + 0.5) / ${ANTISUN_STEPS}.0 * most;
    col = mix(col, col * ${ANTISUN_TINT}, d);
  }
  return col;
}
`;
/**
 * The haze fog runs into, seen along dir: the palette's horizon haze (uHaze), turning with the
 * sunset glow (uSunGlow) into the sky's own colour at the horizon in that direction, so far
 * terrain at dusk fades into the orange toward the sun, not into one lilac all round; lifted
 * HAZE_LIFT of the way to white, so the haze stands out lighter than the sky behind it.
 */
const GLOW_VS = `
uniform int uGlow;
// latitude of the world origin (chunks.origin), degrees: the world's z runs south from it
uniform float uOriginLat;
// season factor of the sim date (palette.ts seasonOf): 1 in the northern midwinter, -1 in its summer
uniform float uSeason;
${COLOUR_GLSL}${SUNLIGHT_GLSL}${SKY_COLOUR_GLSL}
vec3 hazeAt(vec3 dir) {
  if (uSunGlow <= 0.0) return uHaze;
  vec2 dh = dir.xz;
  if (dot(dh, dh) < 1e-10) return uHaze;
  vec3 sky = skyAt(vec3(normalize(dh), 0.0).xzy, uSun);
  // lighter than the sky behind it: the air in front glows
  sky += (1.0 - sky) * ${HAZE_LIFT.toFixed(2)};
  return mix(uHaze, sky, uSunGlow);
}
// tint: the colour of the light on the face (sceneLight), faded out with the fog; street-lit faces
// keep their own light; haze: the haze along the ray (hazeAt)
// mean daily temperature at a world point (x, altitude, z) on the sim date, °C: palette.ts CLIMATE
float climateTemp(vec3 p) {
  float lat = radians(clamp(uOriginLat - p.z / 111320.0, -90.0, 90.0));
  float k = lat < 0.0 ? ${CLIMATE.SEASON_SOUTH} : 1.0;
  return ${CLIMATE.T_POLE.toFixed(1)} + ${CLIMATE.T_AMP.toFixed(1)} * cos(lat) - ${CLIMATE.LAPSE} * max(p.y, 0.0)
    - ${CLIMATE.SEASON_AMP.toFixed(1)} * k * sin(lat) * uSeason;
}
// water frozen at this temperature
bool frozenWater(uint packedRamp, float tempC) {
  uint id = packedRamp & ${PAYLOAD_MASK}u;
  return (packedRamp & ${MATERIAL_FLAG}u) != 0u && (id == ${MAT.WATER}u || id == ${MAT.SEA}u) && tempC <= ${CLIMATE.ICE_C.toFixed(1)};
}
// tempC: the climate at the face (climateTemp); a high value for what never holds snow or ice
vec3 shadeColour(uint packedRamp, float litStep, float fog, vec3 tint, vec3 haze, float tempC) {
  // a light source: its own colour at full strength, seen through half the haze
  if ((packedRamp & ${SELF_LIT_FLAG}u) != 0u) return mix(rgbOf(packedRamp), haze, 0.5 * fog);
  uint lvl = uGlow == 1 ? (packedRamp >> ${GLOW_SHIFT}u) & ${GLOW_LEVEL_MASK}u : 0u;
  if (lvl > 0u) litStep = max(litStep, ${GLOW_STEP_BASE}.0 + float(lvl));
  uint s = uint(clamp(mix(litStep, 15.0, fog) + 0.5, 0.0, 15.0));
  vec3 k = lvl > 0u ? vec3(1.0) : mix(tint, vec3(1.0), clamp((float(s) - 11.0) / 4.0, 0.0, 1.0));
  uint id = packedRamp & ${PAYLOAD_MASK}u;
  bool water = (packedRamp & ${MATERIAL_FLAG}u) != 0u && (id == ${MAT.WATER}u || id == ${MAT.SEA}u);
  bool frozen = frozenWater(packedRamp, tempC);
  // open water never holds snow; ice does
  bool snow = (packedRamp & ${SNOW_FLAG}u) != 0u && tempC <= ${CLIMATE.SNOW_C.toFixed(1)} && (!water || frozen);
  // the fog steps 12..15 run from the lit step 11 into the haze (as the LUT ramps do into uHaze)
  float f = clamp((float(s) - 11.0) / 4.0, 0.0, 1.0);
  uint sl = min(s, 11u);
  vec3 lit;
  if (snow || (packedRamp & ${MATERIAL_FLAG}u) != 0u) {
    uint ramp = snow ? ${MAT.SNOW}u : frozen ? (id == ${MAT.SEA}u ? ${MAT.SEA_ICE}u : ${MAT.ICE}u) : id;
    lit = lutColor(lvl * ${LUT_SIZE}u + ramp * 16u + sl);
  } else {
    lit = shadeRgb(rgbOf(packedRamp), sl, lvl);
  }
  return min(mix(lit, haze, f) * k, 1.0);
}`;

/**
 * Rim light (rim.ts): the edges of faces seen edge-on, turned toward a sun the eye looks into,
 * light up in the rim colour. uRim: x strength (0: off), y edge power, z backlight power, w sun-side
 * bias; uRimSteps: quantization levels (0: smooth). Faded with the fog.
 */
const RIM_GLSL = `
uniform vec4 uRim;
uniform float uRimSteps;
uniform vec3 uRimColor;
vec3 rimLight(vec3 n, vec3 wp, float fog) {
  if (uRim.x <= 0.0) return vec3(0.0);
  vec3 v = normalize(uCamPos - wp);
  float edge = pow(1.0 - min(abs(dot(n, v)), 1.0), uRim.y);
  float back = pow(max(dot(-v, uSunDir), 0.0), uRim.z);
  float side = clamp((dot(n, uSunDir) + uRim.w) / (1.0 + uRim.w), 0.0, 1.0);
  float r = clamp(uRim.x * edge * back * side, 0.0, 1.0);
  if (uRimSteps > 0.0) r = floor(r * uRimSteps + 0.5) / uRimSteps;
  return uRimColor * r * (1.0 - fog);
}
`;

/**
 * Glitter path (synthwave): under a low sun the water below it breaks into horizontal stripes of
 * light, a column on the sun's azimuth that is a thin line at the horizon, widest a little nearer
 * and fades toward the eye. The stripes are spaced by the log of the depression angle (thinner
 * toward the horizon, as in perspective), creep toward the eye, and each flickers in width a few
 * times a second. Stepped: a near-white core and edges in the glow's colour, no blending.
 * uGlitter strength 0..1 (0: off), uGlitterSun the true sun direction (the world passes' uSunDir is
 * the terrain's light, which leans toward the moon at dusk), uGlitterCore / uGlitterEdge rgb (palette.ts LightUniforms.glitter), uTime s.
 */
const GLITTER_GLSL = `
uniform float uTime;
// x: the dusk glow 0..1 (glitter path, synthwave look), y: 1 open water, 0 frozen (no effects)
uniform vec2 uGlitter;
uniform vec3 uGlitterSun;
uniform vec3 uGlitterCore;
uniform vec3 uGlitterEdge;
float glitterHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// the glitter colour along the view ray d (unit, from the eye), alpha 1 where it lights the water
vec4 glitter(vec3 d) {
  if (uGlitter.x * uGlitter.y <= 0.0 || d.y >= 0.0) return vec4(0.0);
  vec3 sun = uGlitterSun;
  float k = uGlitter.x * uGlitter.y * clamp((sun.y + 0.02) / 0.03, 0.0, 1.0);
  if (k <= 0.0 || dot(d.xz, sun.xz) <= 0.0) return vec4(0.0);
  vec2 dh = normalize(d.xz), sh = normalize(sun.xz);
  float lat = abs(dh.x * sh.y - dh.y * sh.x);
  float e = -d.y;
  float fall = 1.0 - e / (0.24 + max(sun.y, 0.0));
  if (fall <= 0.0) return vec4(0.0);
  float w = k * (0.01 + 0.22 * e) * sqrt(fall);
  float u = log2(e + 0.04) * 16.0 + uTime * 1.5;
  // thin lines, never under a pixel: toward the horizon, where they crowd, they merge into one
  float duty = max(0.25, fwidth(u));
  if (fract(u) > duty) return vec4(0.0);
  float wi = w * (0.35 + 0.9 * glitterHash(vec2(floor(u), floor(uTime * 7.0))));
  if (lat > wi) return vec4(0.0);
  return vec4(lat < wi * 0.4 ? uGlitterCore : uGlitterEdge, 1.0);
}
`;


/**
 * The water surface (WORLD_FS water faces, SKY_FS base sea), over its flat lit colour:
 * - the sky mirrored by the flat surface: the haze (uHaze) lightening toward the horizon in 3 steps
 *   (Fresnel). Not by the wave normals: their stepped interference read as a wavy moiré.
 * - waves: a few swells and chop moving at their deep-water speed (sqrt(g/k)), each faded out once
 *   its wavelength nears a pixel, tilt the normal the glints mirror.
 * - glints: the sun (and the moon at night) mirrored by those normals: a stepped hot spot, and
 *   twinkling cells, world-anchored, each lit for a moment, densest round the mirrored sun, fainter
 *   than the hot spot. Under overcast the sun's glints dim but stay.
 * - dusk (uGlitter.x, the sky glow): synthwave: the sky's bands mirrored, then the glitter path.
 * d: unit ray from the eye; p: the point's world xz; fw: fwidth(p), taken by the caller outside any
 * branch; dist: the point's distance; c: the flat lit colour.
 * Needs uCamPos, uFogStart/End, uHaze, uMoon, uDirect, lutColor, uTime, uGlitter*.
 */
/** how far a water glint goes from the water's colour toward the glint colour, by step (WATER_GLSL) */
const GLINT_CORE = 0.6;
const GLINT_MID = 0.3;
const GLINT_SHEEN = 0.1;
/**
 * Speckles on the ground (WORLD_FS, renderer.speckle: terrain and OSM areas): world dots (worldDot)
 * in their face's colour, lighter: about one per SPECKLE_PER_PX dot pixels on screen, no more
 * than one per SPECKLE_BASE_M² of ground.
 */
const SPECKLE_PER_PX = 120;
const SPECKLE_BASE_M = 1;
const SPECKLE_LIFT = 1.3;
/** the water's twinkles: candidate dots (worldDot), one per TWINKLE_PER_PX dot pixels, each lit now and then */
const TWINKLE_PER_PX = 40;
const TWINKLE_BASE_M = 0.25;
/** the same for the twinkling cells: their brighter and dimmer step */
const TWINKLE_BRIGHT = 0.25;
const TWINKLE_DIM = 0.12;
const WATER_GLSL = `
// one dot pixel in device pixels: the device pixel ratio (rounded), × 2 with supersampling (worldDot)
uniform float uDotPx;
uint waterHash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float waterRand(vec2 cell, float salt) {
  return float(waterHash(uvec3(ivec3(ivec2(cell), int(salt)))) & 0xffffu) / 65535.0;
}
// a light integer hash (a few multiplies) of a cell and a salt (worldDot)
uint dotHash(ivec2 cell, int salt) {
  uvec2 q = uvec2(cell);
  uint h = (q.x * 0x8da6b343u) ^ (q.y * 0xd8163841u) ^ (uint(salt) << 24u);
  h ^= h >> 15u; h *= 0x2c1b3c6du; h ^= h >> 13u;
  return h;
}
/**
 * Which of its 4 children (bit 0: +x, bit 1: +y) a cell of level l (>= 1) hands its dot down to
 * (worldDot). The levels go in threes: one hash of the cell at the top of the three (level g, a
 * multiple of 3: dotTop) holds the choice of that cell (2 bits), of its 4 children (8 bits) and of
 * its 16 grandchildren (32 bits, the second word), so the descent takes three levels per hash.
 * words: dotWords(the top cell, g); n: the cell, d = g - l its depth below the top.
 */
// (no integer division: slow on a GPU)
int dotTop(int l) { return int(float(l + 2) * (1.0 / 3.0) + 0.01) * 3; }
uvec2 dotWords(ivec2 top, int g) {
  uint h = dotHash(top, g);
  uint h2 = h * 0x297a2d39u;
  return uvec2(h, h2 ^ (h2 >> 16u));
}
// the child of n (d levels below the top of words: 0, 1 or 2) by the bits of its choice: 0..1 for
// the top, 2..9 by its index under the top, the second word by its parent's and its own index
uint dotIndex(ivec2 n) { return uint((n.x & 1) | ((n.y & 1) << 1)); }
ivec2 dotTo(ivec2 n, uint ch) { return (n << 1) + ivec2(int(ch & 1u), int((ch >> 1u) & 1u)); }
ivec2 dotStep0(uvec2 w, ivec2 n) { return dotTo(n, w.x); }
ivec2 dotStep1(uvec2 w, ivec2 n) { return dotTo(n, w.x >> (2u + 2u * dotIndex(n))); }
ivec2 dotStep2(uvec2 w, ivec2 n) { return dotTo(n, w.y >> (2u * (4u * dotIndex(n >> 1) + dotIndex(n)))); }
// from cell n at level l down to the next multiple of 3 below (or 0): the rest of its three levels
ivec2 dotDescend(ivec2 n, int l, int g) {
  uvec2 w = dotWords(n >> (g - l), g);
  int d = g - l;
  if (d == 0) n = dotStep0(w, n);
  if (d <= 1) n = dotStep1(w, n);
  return dotStep2(w, n);
}
// the child a cell of level l hands its dot down to
ivec2 dotChild(ivec2 cell, int l) {
  int g = dotTop(l);
  uvec2 w = dotWords(cell >> (g - l), g);
  int d = g - l;
  return d == 0 ? dotStep0(w, cell) : d == 1 ? dotStep1(w, cell) : dotStep2(w, cell);
}
/**
 * World dots: one fixed set of points on the ground, each drawn as a square uDotPx device pixels
 * across (one CSS pixel, 2 or 3 on a dense screen), about one per perPx dot pixels on screen.
 * The set is nested by levels: a cell of level L (side base * 2^L) has one dot, that of one of its
 * 4 children (dotChild) and so down to level 0, where it sits at random in its cell. Farther (a
 * pixel covering more ground) the level rises smoothly: the dots of level L that are not also of
 * level L + 1 go out one by one, so the dots never jump with the scale.
 * The dot is always inside the child it is handed to: the descent (three levels a step) stops as
 * soon as that child is out of reach of the pixel, for most pixels after a step, not L levels.
 * p: the world xz; jac: (dFdx(p), dFdy(p)). In a dot: true, and id its level-0 cell (the dot's
 * identity at every level).
 */
bool worldDot(vec2 p, vec4 jac, float perPx, float base, out vec2 id) {
  id = vec2(0.0);
  float det = abs(jac.x * jac.w - jac.y * jac.z);
  if (det < 1e-10) return false;
  // the level whose cell holds about perPx dot pixels
  float lv = 0.5 * log2(det * uDotPx * uDotPx * perPx / (base * base));
  int L = int(max(floor(lv), 0.0));
  float f = lv < 0.0 ? 0.0 : fract(lv);
  float size = base * exp2(float(L));
  // the ground a dot under this pixel may sit in: within half a dot of it
  vec2 reach = (abs(jac.xy) + abs(jac.zw)) * uDotPx * 0.5;
  vec2 lo = p - reach, hi = p + reach;
  ivec2 c0 = ivec2(floor(lo / size));
  ivec2 c1 = min(ivec2(floor(hi / size)), c0 + 1);
  for (int cy = c0.y; cy <= c1.y; cy++) {
    for (int cx = c0.x; cx <= c1.x; cx++) {
      ivec2 cell = ivec2(cx, cy);
      // the level-0 cell of this cell's dot, while it can still be in reach
      ivec2 cc = cell;
      int l = L;
      bool lost = false;
      while (l >= 1) {
        int g = dotTop(l);
        cc = dotDescend(cc, l, g);
        l = g - 3;
        float side = base * exp2(float(l));
        vec2 a = vec2(cc) * side;
        if (any(greaterThan(a, hi)) || any(lessThan(a + side, lo))) { lost = true; break; }
      }
      if (lost) continue;
      uint hc = dotHash(cc, 1);
      vec2 q = (vec2(cc) + vec2(float(hc & 0xffffu), float(hc >> 16u)) / 65535.0) * base;
      vec2 s = inverse(mat2(jac.xy, jac.zw)) * (q - p);
      if (any(greaterThanEqual(abs(s), vec2(uDotPx * 0.5)))) continue;
      // fading out with the level's fraction, unless the dot is also its parent's
      if (f > 0.0 && dotChild(cell >> 1, L + 1) != cell && float(dotHash(cc, 5) & 0xffffu) / 65535.0 < f) continue;
      id = vec2(cc);
      return true;
    }
  }
  return false;
}
// slope (d height / d xz) of the waves at p, the swells' wavelengths over fp (m per pixel)
vec2 waterSlope(vec2 p, float fp) {
  const vec4 L = vec4(71.0, 29.0, 11.0, 4.3);
  const vec4 A = vec4(0.07, 0.06, 0.07, 0.08);
  vec2 dirs[4] = vec2[4](vec2(0.8, 0.6), vec2(-0.45, 0.89), vec2(0.97, -0.24), vec2(0.2, 0.98));
  vec2 g = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float k = 6.2832 / L[i];
    float fade = clamp(L[i] / (fp * 8.0) - 1.0, 0.0, 1.0);
    if (fade <= 0.0) continue;
    float ph = dot(dirs[i], p) * k - sqrt(9.81 * k) * uTime;
    g += dirs[i] * (A[i] * fade * cos(ph + 1.7 * float(i)));
  }
  return g;
}
vec3 waterSurface(vec3 d, vec2 p, vec4 jac, float dist, vec3 c) {
  vec2 fw = abs(jac.xy) + abs(jac.zw);
  if (uGlitter.y <= 0.0 || d.y >= 0.0) return c;
  float fog = clamp((dist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  float near = 1.0 - fog;
  if (near <= 0.0) return c;
  // metres per pixel along the ground here
  float fp = max(length(fw), 1e-3);
  vec2 g = waterSlope(p, fp);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 r = reflect(d, n);
  r.y = abs(r.y);
  float dusk = uGlitter.x * clamp((uGlitterSun.y + 0.12) / 0.1, 0.0, 1.0);

  // the sky mirrored by the flat surface: at dusk its bands (the synthwave gradient), by day the
  // haze in 3 steps
  float fres = pow(1.0 - clamp(-d.y, 0.0, 1.0), 4.0);
  float fq = floor(fres * 3.0 + 0.5) / 3.0;
  c = mix(c, uHaze, fq * 0.3 * near);
  if (dusk > 0.0) {
    float h = pow(1.0 - clamp(-d.y, 0.0, 1.0), 1.6) * ${SKY_BANDS}.0;
    vec3 sky = lutColor(${MAT.SKY * 16}u + uint(min(floor(h), ${SKY_BANDS - 1}.0)));
    c = mix(c, sky * 0.8, 0.75 * dusk);
  }

  // glints: the sun, else the moon, mirrored in the waves
  vec3 sun = uGlitterSun;
  float sunUp = clamp((sun.y + 0.01) / 0.05, 0.0, 1.0);
  float sunny = mix(0.35, 1.0, clamp((uDirect.x - 0.5) * 2.0, 0.0, 1.0)) * sunUp;
  vec3 src = sunUp > 0.0 ? sun : uMoon;
  float power = sunUp > 0.0 ? sunny : uDirect.y * 0.8;
  vec3 hot = sunUp > 0.0 ? uGlitterCore : vec3(0.82, 0.88, 1.0);
  if (power > 0.0 && src.y > -0.02) {
    float m = max(dot(r, src), 0.0);
    float spot = pow(m, 600.0) * power;
    float sheen = pow(m, 60.0) * power;
    // twinkles: world dots (worldDot), each lit for a moment now and then
    vec2 ci;
    float tw = 1.0;
    if (worldDot(p, jac, ${TWINKLE_PER_PX}.0, ${TWINKLE_BASE_M}, ci)) {
      float rate = 3.0 + 4.0 * waterRand(ci, 7.0);
      float tick = floor(uTime * rate + 13.0 * waterRand(ci, 3.0));
      tw = waterRand(ci + vec2(tick * 131.0, 0.0), 11.0);
    }
    // none near the horizon, where a pixel is many times longer than wide
    float chance = min(0.16 * near + 2.0 * sheen, 1.0) * smoothstep(0.06, 0.14, -d.y);
    // stepped, never the full glint colour: the hot spot ${GLINT_CORE}, then ${GLINT_MID}, ${GLINT_SHEEN};
    // the twinkles fainter, ${TWINKLE_BRIGHT} and ${TWINKLE_DIM}
    if (spot > 0.35) c = mix(c, hot, ${GLINT_CORE});
    else if (spot > 0.08) c = mix(c, hot, ${GLINT_MID});
    else if (tw < chance * 0.5) c = mix(c, hot, ${TWINKLE_BRIGHT});
    else if (sheen > 0.25) c = mix(c, hot, ${GLINT_SHEEN});
    else if (tw < chance) c = mix(c, hot, ${TWINKLE_DIM});
  }

  // dusk: the glitter path over it all
  if (dusk > 0.0) {
    vec4 gp = glitter(d);
    if (gp.a > 0.0) c = gp.rgb;
  }
  return c;
}
`;

/**
 * Depth. With REVERSED_Z (renderer: EXT_clip_control 0..1 clip depth, a float depth buffer cleared
 * to 0, GREATER) the vertex shader writes it (ORTHO_VS depthZ): REVERSED_NEAR / w in perspective,
 * as fine as the log depth from the near plane to the horizon, linear and reversed in orthographic
 * views; the fragment shader leaves it alone, so the GPU can skip hidden fragments (a shader that
 * writes gl_FragDepth turns that off: every covered pixel of every face was shaded). Without the
 * extension: a log depth written per fragment, as before.
 */
const LOG_DEPTH_FS = `
in float vLogW;
// orthographic views (see ORTHO_VS) are all far from the eye, where the logarithm is at its
// coarsest (decimetres): their depth is linear between the planes instead
uniform highp float uOrthoFar;
void writeLogDepth() {
#ifndef REVERSED_Z
  gl_FragDepth = uOrthoFar > 0.0 ? (vLogW - 1.0) / uOrthoFar : log2(vLogW) / log2(${DEPTH_FAR.toFixed(1)} + 1.0);
#endif
}
`;

/**
 * Tile placement: meshes are built in the ENU frame of their tile centre; uOffset.xyz is that
 * centre in the world (origin ENU) and uOffset.w the yaw of the tile frame in it (meridian
 * convergence, see frameYaw). Without the turn neighbouring tiles' edges drift apart.
 */
const PLACE_VS = `
vec3 toWorldDir(vec3 p) {
  float c = cos(uOffset.w), s = sin(uOffset.w);
  return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
}
vec3 toWorld(vec3 p) { return toWorldDir(p) + uOffset.xyz; }
`;

/**
 * Orthographic views (terrain overview tool): w is 1 there, so the depth comes from clip z of a
 * projection whose near plane is 0 and far plane uOrthoFar. 0 = perspective.
 */
const ORTHO_VS = `
uniform highp float uOrthoFar;
float logW(vec4 clip) { return 1.0 + (uOrthoFar > 0.0 ? (clip.z * 0.5 + 0.5) * uOrthoFar : max(clip.w, 0.0)); }
// clip z for the depth test (see LOG_DEPTH_FS): the projection's own without REVERSED_Z
float depthZ(vec4 clip) {
#ifdef REVERSED_Z
  return uOrthoFar > 0.0 ? 0.5 - 0.5 * clip.z : ${REVERSED_NEAR.toFixed(2)};
#else
  return clip.z;
#endif
}
`;

const glslRgb = (c: RGB) => `vec3(${c.map((v) => (v / 255).toFixed(3)).join(', ')})`;
/**
 * Lit window colours and their dimming with distance (palette.ts WINDOW_LIGHT, windowLightColour,
 * windowFade), for the near facades (WORLD_FS) and the far building dots (POINTS_VS).
 */
const WINDOW_LIGHT_GLSL = `
vec3 kelvinRgb(float k) {
  float t = k / 100.0;
  return vec3(1.0, clamp((99.4708025861 * log(t) - 161.1195681661) / 255.0, 0.0, 1.0),
    t <= 19.0 ? 0.0 : clamp((138.5177312231 * log(t - 10.0) - 305.0447927307) / 255.0, 0.0, 1.0));
}
vec3 windowLightColour(float t, float kMin) {
  float rare = ${WINDOW_LIGHT.RARE_SHARE.toFixed(4)};
  if (t < rare) return ${glslRgb(WINDOW_LIGHT.YELLOW)};
  if (t < 2.0 * rare) return ${glslRgb(WINDOW_LIGHT.ORANGE)};
  if (t < 3.0 * rare) return ${glslRgb(WINDOW_LIGHT.BLUE)};
  if (t < 4.0 * rare) return ${glslRgb(WINDOW_LIGHT.GREEN)};
  float u = (t - 4.0 * rare) / (1.0 - 4.0 * rare);
  return kelvinRgb(mix(kMin, ${WINDOW_LIGHT.KELVIN_MAX.toFixed(1)}, u));
}
float windowFade(float d) {
  return ${WINDOW_LIGHT.FADE_MIN.toFixed(3)} + ${(1 - WINDOW_LIGHT.FADE_MIN).toFixed(3)} / (1.0 + max(d, 0.0) / ${WINDOW_LIGHT.FADE_HALF_M.toFixed(1)});
}
`;

/**
 * Windows on the near building facades (WORLD_FS; building-mesher BuildingMeshData.windows). Each
 * wall edge is cut into slots every WINDOWS.SPACING_M and floors every WINDOWS.FLOOR_M (both
 * stretched to fit); a pane sits in each, a little above the middle of the floor. A pane never gets
 * smaller than about a pixel (fw: the metres one pixel spans along u and v), so far windows do not
 * flicker away. By day panes are dark glass in the wall's light; at night (uWindows 2) the slot's
 * hash lights uLitShare of them (palette.ts litShare by the hour; ALL_NIGHT_SHARE on hospitals and
 * supermarkets) in the WINDOW_LIGHT colours (mostly 2700-5000 K, rarely yellow, orange, pale blue or
 * green; 1 in 2000 a red-violet grow lamp lit all night), like the far building dots, dimmer the farther from the eye.
 *
 * The edge code (edge.z) carries a building-mesher FACADE style above its seed: on a balconied edge
 * some slot columns (by the slot's hash, the same on every floor) carry balconies from the first
 * floor up — glazed (a parapet panel under a lighter glazing with mullions) or open (a railing in
 * front of a dark recess with the balcony door, which lights like a window). Returns true on a lit pane.
 */
const WINDOW_GLSL = `${WINDOW_LIGHT_GLSL}
uint winHash(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float winRand(uint x) { return float(winHash(x)) / 4294967296.0; }
// the facade at this fragment (WORLD_FS main): unit view ray from the eye, the face's normal toward the eye
vec3 gWinD;
vec3 gWinN;
// an edge's glass tint: cool blue, neutral grey, green, bronze or dark
vec3 glassTint(uint seed) {
  uint t = winHash(seed * 17u + 9u) % 5u;
  return t == 0u ? vec3(0.38, 0.44, 0.56) : t == 1u ? vec3(0.42, 0.44, 0.47) : t == 2u ? vec3(0.37, 0.46, 0.45)
    : t == 3u ? vec3(0.46, 0.41, 0.36) : vec3(0.3, 0.33, 0.38);
}
// glass mirrors: the haze at a grazing look, and by day the sun as a stepped glint. Each pane leans a
// little its own way (by r), so a facade flashes window by window, not all at once
vec3 glassShine(vec3 g, float r, float fog) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 t = cross(up, gWinN);
  t = dot(t, t) > 1e-6 ? normalize(t) : vec3(1.0, 0.0, 0.0);
  vec3 n = normalize(gWinN + t * (fract(r * 31.0) - 0.5) * 0.06 + up * (fract(r * 53.0) - 0.5) * 0.06);
  float fres = pow(1.0 - clamp(dot(-gWinD, n), 0.0, 1.0), 4.0);
  g = mix(g, uHaze, (floor(fres * 3.0 + 0.5) / 3.0) * 0.35 * (1.0 - fog));
  float sunUp = clamp((uGlitterSun.y + 0.01) / 0.05, 0.0, 1.0);
  float power = sunUp * mix(0.25, 1.0, clamp((uDirect.x - 0.5) * 2.0, 0.0, 1.0)) * (1.0 - fog);
  if (power > 0.0) {
    float m = max(dot(reflect(gWinD, n), uGlitterSun), 0.0);
    float spot = pow(m, 300.0) * power;
    float sheen = pow(m, 30.0) * power;
    if (spot > 0.35) g = mix(g, uGlitterCore, ${GLINT_CORE});
    else if (spot > 0.08) g = mix(g, uGlitterCore, ${GLINT_MID});
    else if (sheen > 0.25) g = mix(g, uGlitterCore, ${GLINT_SHEEN});
  }
  return g;
}
// a pane's glass: the lit white of the wall's light in the edge's tint, a little lighter or darker per
// pane, with its reflections; into the wall's colour with the fog
vec3 paneGlass(vec3 wall, uint seed, float r, float fog) {
  vec3 g = vRef * glassTint(seed) * (0.92 + 0.16 * fract(r * 97.0));
  return mix(glassShine(g, r, fog), wall, fog);
}
// an edge's window frames: colour (white, anthracite, brown, wood, silver), bar width, and the bars
// across the pane (none, a mullion, a mullion and a transom)
vec3 frameColour(uint fs) {
  uint t = (fs >> 2u) % 5u;
  return t == 0u ? vec3(0.92) : t == 1u ? vec3(0.25, 0.26, 0.28) : t == 2u ? vec3(0.36, 0.25, 0.17)
    : t == 3u ? vec3(0.56, 0.39, 0.23) : vec3(0.64, 0.65, 0.67);
}
// the ground floor of a building of two floors and more (windowAt)
bool groundFloorAt(inout vec3 c, float du, float dv, float k, float cw, float fh, vec2 uv, vec3 edge, uint seed, bool resid, bool allNight, float r, vec2 fw, float fog) {
  // rare pastel signs over the shop windows of residential buildings
  if (resid && winRand(seed ^ winHash(uint(k) + 0x51u)) < 0.14) {
    float sw = max(min(0.36 * cw, 1.6), 0.6 * fw.x);
    if (abs(du) < sw && dv > 0.86 * fh && dv < 0.97 * fh) {
      vec3 pastel = 0.74 + 0.26 * cos(6.2832 * (winRand(seed + uint(k) * 13u) + vec3(0.0, 0.33, 0.67)));
      c = vRef * mix(pastel, vec3(1.0), fog);
      return false;
    }
  }
  // shops are lit more often than flats, mostly white; they close at night with the flats going dark
  float open = allNight ? 0.85 : 0.5 * uLitShare / ${WINDOWS.LIT_SHARE.toFixed(2)};
  bool lit = uWindows == 2 && r < open;
  vec3 shop = emitLight(mix(windowLightColour(r / max(open, 1e-6), ${WINDOW_LIGHT.KELVIN_COOL_MIN.toFixed(1)}), uHaze, 0.5 * fog), uWinEmit) * windowFade(length(vRay));
  vec3 glass = paneGlass(c, seed, r, fog);
  if (winRand(seed * 5u + 11u) < (resid ? 0.15 : 0.4)) {
    // the whole floor glazed along the edge, mullions every half slot
    if (dv < 0.06 * fh || dv > 0.84 * fh || uv.x < 0.25 || uv.x > edge.x - 0.25) return false;
    float m = abs(fract(uv.x / (0.5 * cw) + 0.5) - 0.5) * 0.5 * cw;
    if (fw.x < 0.25 && m < 0.05) { c *= mix(vec3(0.6), vec3(1.0), fog); return false; }
    if (lit) { c = shop; return true; }
    c = glass;
    return false;
  }
  // shop windows: wider and taller than the windows above
  float hw = min(max(min(1.25, 0.4 * cw), 0.6 * fw.x), 0.46 * cw);
  if (abs(du) > hw || dv < 0.12 * fh || dv > 0.8 * fh) return false;
  if (lit) { c = shop; return true; }
  c = glass;
  return false;
}
bool windowAt(inout vec3 c, vec2 uv, vec3 edge, vec2 fw, float fog) {
  float floors = max(1.0, floor(edge.y / ${WINDOWS.FLOOR_M.toFixed(1)}));
  float fh = edge.y / floors;
  float f = floor(uv.y / fh);
  if (uv.y < 0.0 || f >= floors) return false;
  float slots = max(1.0, floor(edge.x / ${WINDOWS.SPACING_M.toFixed(1)}));
  float cw = edge.x / slots;
  float k = clamp(floor(uv.x / cw), 0.0, slots - 1.0);
  uint code = uint(edge.z);
  uint seed = code & ${(1 << FACADE_SEED_BITS) - 1}u;
  uint style = (code >> ${FACADE_SEED_BITS}u) & 3u;
  bool resid = (code & ${FACADE_RESIDENTIAL}u) != 0u;
  bool blind = (code & ${FACADE_BLIND}u) != 0u;
  bool allNight = (code & ${FACADE_ALL_NIGHT}u) != 0u;
  float du = uv.x - (k + 0.5) * cw;
  float dv = uv.y - f * fh;
  float r = winRand(seed ^ winHash(uint(k) + winHash(uint(f) * 7919u)));
  bool ground = f == 0.0 && floors >= 2.0;
  if (ground) {
    // the ground floor in its own shade, per edge: darker, warm stone, lighter or cool grey
    uint gt = winHash(seed * 7u + 3u) & 3u;
    vec3 tint = gt == 0u ? vec3(0.74) : gt == 1u ? vec3(0.86, 0.8, 0.72) : gt == 2u ? vec3(1.14) : vec3(0.7, 0.73, 0.8);
    c = min(c * mix(tint, vec3(1.0), fog), 1.0);
  }
  // the wall round a door: no openings
  if (blind) return false;
  if (ground) return groundFloorAt(c, du, dv, k, cw, fh, uv, edge, seed, resid, allNight, r, fw, fog);
  float share = allNight ? ${WINDOWS.ALL_NIGHT_SHARE.toFixed(2)} : uLitShare;
  // grow lamps: a window in 2000, on all night whatever the hour
  bool grow = winRand(seed * 0x2c1b3c6du ^ winHash(uint(k) * 0x297a2d39u + uint(f) * 0x6c8e9cf5u + 101u)) < ${WINDOW_LIGHT.GROW_SHARE};
  bool lit = uWindows == 2 && (r < share || grow);
  vec3 lc = grow ? ${glslRgb(WINDOW_LIGHT.GROW)} : windowLightColour(r / max(share, 1e-6), allNight ? ${WINDOW_LIGHT.KELVIN_COOL_MIN.toFixed(1)} : ${WINDOW_LIGHT.KELVIN_MIN.toFixed(1)});
  vec3 light = emitLight(mix(lc, uHaze, 0.5 * fog), uWinEmit) * windowFade(length(vRay));
  // the window's own style: the wall's, a whole floor refitted alike (any building), or one window
  // changed by its owner (residential only), so frames and glass vary up a wall and along it
  uint ws = seed;
  if (winRand(seed ^ winHash(uint(f) * 0x2545u + 77u)) < 0.25) ws = winHash(seed + uint(f) * 0x632be5abu);
  if (resid && winRand(seed ^ winHash(uint(k) * 0x27d4eb2du + uint(f) * 0x165667b1u + 3u)) < 0.75)
    ws = winHash(ws ^ (uint(k) * 0x9e3779b9u + uint(f) * 0x85ebca6bu));
  vec3 glass = paneGlass(c, ws, r, fog);
  if (style > 0u && f >= 1.0 && winRand(seed * 31u + uint(k) * 0x9e3779b9u) < 0.6) {
    float bw = min(max(min(1.5, 0.42 * cw), 0.6 * fw.x), 0.47 * cw);
    if (abs(du) > bw || dv < 0.04 * fh || dv > 0.92 * fh) return false;
    float rail = 0.04 * fh + 0.36 * fh;
    if (dv < rail) {
      // the parapet: a lighter panel under glazing, a darker railing on an open balcony
      c *= mix(style == 1u ? vec3(1.12) : vec3(0.72), vec3(1.0), fog);
      return false;
    }
    if (style == 1u) {
      if (lit) { c = light; return true; }
      // glazing lighter than a window, with mullions where they are wider than a pixel
      c = mix(glassShine(c * mix(vec3(0.58, 0.64, 0.74), vec3(1.0), fog), r, fog), c, fog);
      float m = abs(fract((du + bw) / 0.75 + 0.5) - 0.5) * 0.75;
      if (fw.x < 0.25 && (m < 0.04 || dv < rail + 0.05)) c *= 0.8;
      return false;
    }
    // open: the balcony door in the dark recess
    if (abs(du) < min(0.45, 0.35 * bw) + 0.3 * fw.x && dv > rail + 0.02 * fh) {
      if (lit) { c = light; return true; }
      c = glass;
      return false;
    }
    c *= mix(vec3(0.32), vec3(1.0), fog);
    return false;
  }
  float hw = min(max(min(0.7, 0.3 * cw), 0.6 * fw.x), 0.45 * cw);
  float hh = min(max(min(0.75, 0.27 * fh), 0.6 * fw.y), 0.4 * fh);
  float dy = dv - 0.55 * fh;
  if (abs(du) > hw || abs(dy) > hh) return false;
  // the frame: its true width where that is about a pixel or more, else a pixel wide round a pane of
  // 6 pixels or more; the bars across the pane only where they are wider than about a pixel
  uint fs = winHash(ws * 13u + 5u);
  float bar = 0.04 + 0.03 * float(fs & 3u);
  bool real = bar > 0.7 * max(fw.x, fw.y);
  bool outline = hw > 3.0 * fw.x && hh > 3.0 * fw.y;
  if (real || outline) {
    uint bars = (fs >> 5u) % 3u;
    bool inFrame = hw - abs(du) < max(bar, fw.x) || hh - abs(dy) < max(bar, fw.y)
      || (real && bars >= 1u && hw > 0.45 && abs(du) < 0.5 * bar)
      || (real && bars == 2u && abs(dy - 0.33 * hh) < 0.5 * bar);
    if (inFrame) { c = mix(vRef * frameColour(fs), c, fog); return false; }
  }
  if (lit) { c = light; return true; }
  c = glass;
  return false;
}
`;

/**
 * A railway track on its ballast (osm-mesher rail ribbons in the road mesh, aWinEdge.x TRACK_EDGE):
 * uv is metres along and across the line. Concrete sleepers every 0.55 m, 2.7 m long, faded to their
 * mean share where they would be under about 2 pixels; two steel rails 1.52 m apart, at least a pixel
 * wide (thinner ones blended by their coverage); the ballast darker down the slopes of its prism.
 */
const TRACK_GLSL = `
vec3 trackAt(vec3 c, vec2 uv, vec2 fw, float fog) {
  float v = abs(uv.y);
  float k = 1.0 - fog;
  c *= mix(1.0, 0.8, smoothstep(1.7, 3.0, v) * k);
  float fade = clamp(2.0 - 4.0 * fw.x / 0.55, 0.0, 1.0);
  float sleeper = mix(0.4, step(fract(uv.x / 0.55), 0.4), fade);
  if (v < 1.35) c = min(mix(c, c * 1.4, sleeper * k), 1.0);
  float hw = max(0.035, 0.5 * fw.y);
  if (abs(v - 0.76) < hw) {
    vec3 steel = min(vec3(dot(c, vec3(0.3, 0.4, 0.3))) * 1.8, 1.0);
    c = mix(c, steel, min(1.0, 0.07 / (2.0 * hw)) * k);
  }
  return c;
}
`;

/**
 * Road paint (osm-mesher paintedRibbon, aWinEdge.x ROAD_EDGE and below; the packing is there): lines
 * 15 cm wide, at least a pixel (thinner ones blended by their coverage); dashes 3 m in 12, faded to
 * their mean where the pattern would be under a few pixels. The width narrows towards an end with a
 * taper; lane lines are measured from the left edge, so a dropped lane closes on the right. No paint
 * within the end's gap (a junction where the road yields).
 */
const ROAD_MARK_GLSL = `
float paintLine(float d, float fw) {
  float hw = max(0.075, 0.5 * fw);
  return abs(d) < hw ? min(1.0, 0.075 / hw) : 0.0;
}
float roadDash(float u, float fwu) {
  return mix(0.25, step(fract(u / 12.0), 0.25), clamp(2.0 - fwu / 1.5, 0.0, 1.0));
}
vec3 roadMarkAt(vec3 c, vec2 uv, vec3 edge, vec2 fw, float fog) {
  bool atEnd = uv.x < 0.0;
  float d = abs(uv.x) - ${ROAD_U_BASE.toFixed(1)};
  uint code = uint(edge.z + 0.5), wp = uint(edge.y + 0.5), tp = uint(${ROAD_EDGE}.0 - edge.x + 0.5);
  float gap = float(atEnd ? (code >> 13u) & 63u : (code >> 7u) & 63u) * 0.5;
  if (d < gap) return c;
  float full = float(wp & 1023u) * 0.25;
  float narrow = float(atEnd ? (wp >> 15u) & 31u : (wp >> 10u) & 31u) * 0.5;
  float taper = float(atEnd ? tp & 63u : tp >> 6u) * 2.0;
  float w = taper > 0.0 ? full - narrow * (1.0 - min(1.0, d / taper)) : full;
  float vl = uv.y, a = 0.0;
  float lanes = float(code & ${ROAD_MARK.LANES}u);
  float lw = full / max(lanes, 1.0);
  float dash = roadDash(d, fw.x);
  if ((code & ${ROAD_MARK.EDGES}u) != 0u) a = max(paintLine(vl - 0.35, fw.y), paintLine(w - 0.35 - vl, fw.y));
  if ((code & ${ROAD_MARK.ONEWAY}u) != 0u) {
    for (float k = 1.0; k < 15.0; k++) {
      if (k >= lanes || k * lw > w - 0.5) break;
      a = max(a, paintLine(vl - k * lw, fw.y) * dash);
    }
  } else if (lanes >= 2.0) {
    float mid = 0.5 * w;
    if ((code & ${ROAD_MARK.DOUBLE}u) != 0u) a = max(a, max(paintLine(vl - mid - 0.15, fw.y), paintLine(vl - mid + 0.15, fw.y)));
    else a = max(a, paintLine(vl - mid, fw.y) * dash);
    for (float k = 1.0; k < 8.0; k++) {
      if (k >= floor(lanes * 0.5)) break;
      a = max(a, max(paintLine(vl - mid - k * lw, fw.y), paintLine(vl - mid + k * lw, fw.y)) * dash);
    }
  }
  return mix(c, min(c * 3.0, vec3(0.92)), a * (1.0 - fog));
}
`;

/** the shadows fade out from this share of the shadow map's half-width to its edge */
const SHADOW_FADE = 0.8;
/**
 * Sun shadows (renderer.ts beginShadows): a depth map of the casters seen from the sun, an
 * orthographic box round the ground near the camera. uShadowMat takes a world point (the
 * curvature drop applied, as everywhere) to its clip space there: xy −1..1 across the map, z −1..1
 * from the sun's side of the box to the far side. With REVERSED_Z the map stores 1 − depth
 * (cleared to 0, GREATER), as the world's own depth buffer does.
 */
const SHADOW_CLIP_GLSL = `
uniform mat4 uShadowMat;
vec4 shadowClip(vec3 wp) {
  vec4 c = uShadowMat * vec4(wp, 1.0);
#ifdef REVERSED_Z
  c.z = 0.5 - 0.5 * c.z;
#endif
  return c;
}
`;
/**
 * A face that takes shadows: its colour in shade (vShade: lit by the sky alone, sceneShade; the
 * same as vColor when the sun does not reach it anyway) and where it falls in the shadow map
 * (vShadow, nudged uShadowNormal metres off the face along its normal against shadow acne).
 * uShadowOn 0: no shadows for this draw.
 */
const SHADOW_RECEIVE_VS = `
uniform mat4 uShadowMat;
uniform float uShadowOn;
uniform float uShadowNormal;
flat out vec3 vShade;
out vec3 vShadow;
void shadowCoord(vec3 wp, vec3 n) {
  // the more a face slants from the sun, the further its texels reach in depth: nudged further
  float slant = 1.0 - clamp(dot(n, uSun), 0.0, 1.0);
  vShadow = (uShadowMat * vec4(wp + n * uShadowNormal * (0.5 + slant), 1.0)).xyz * 0.5 + 0.5;
}
`;
/** see SHADOW_RECEIVE_VS: 1 where the sun reaches the fragment, 0 in a cast shadow */
const SHADOW_RECEIVE_FS = `
uniform highp sampler2DShadow uShadowMap;
uniform float uShadowOn;
uniform float uShadowBias;
flat in vec3 vShade;
in vec3 vShadow;
const float SHADOW_BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float sunLit() {
  if (uShadowOn < 0.5 || vShade == vColor) return 1.0;
  vec2 e2 = abs(vShadow.xy * 2.0 - 1.0);
  float edge = max(e2.x, e2.y);
  if (edge >= 1.0 || vShadow.z <= 0.0 || vShadow.z >= 1.0) return 1.0;
#ifdef REVERSED_Z
  float ref = 1.0 - vShadow.z + uShadowBias;
#else
  float ref = vShadow.z - uShadowBias;
#endif
  // hard edges, like the palette's own steps: the 2×2 filtered test cut at half
  float lit = step(0.5, texture(uShadowMap, vec3(vShadow.xy, ref)));
  // the shadows fade out toward the map's edge in a dither, not along a line
  ivec2 q = ivec2(gl_FragCoord.xy) & 3;
  if (smoothstep(${SHADOW_FADE.toFixed(2)}, 1.0, edge) > (SHADOW_BAYER[q.y * 4 + q.x] + 0.5) / 16.0) lit = 1.0;
  return lit;
}
`;
/** a caster in the shadow map: the world's faces (terrain with its stitched edges, objects, clouds) */
export const SHADOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=5) in vec2 aMorph;
uniform int uCoarse;
uniform vec4 uOffset;
uniform vec3 uCamPos;
${PLACE_VS}${SHADOW_CLIP_GLSL}
void main() {
  vec3 wp = toWorld(aPos);
  if ((int(aMorph.y) & uCoarse) != 0) wp.y += aMorph.x;
  vec2 r = wp.xz - uCamPos.xz;
  wp.y -= dot(r, r) / (2.0 * 6371000.0);
  gl_Position = shadowClip(wp);
}
`;
/** a caster in the shadow map: instanced trees (TREE_VS) */
export const SHADOW_TREE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=3) in vec3 aInstPos;
layout(location=4) in vec2 aInstSR;
layout(location=6) in float aInstYaw;
uniform vec4 uOffset;
uniform vec3 uCamPos;
${PLACE_VS}${SHADOW_CLIP_GLSL}
void main() {
  float cy = cos(aInstYaw), sy = sin(aInstYaw);
  vec3 lp = vec3(cy * aPos.x - sy * aPos.z, aPos.y, sy * aPos.x + cy * aPos.z);
  vec3 wp = toWorld(lp * aInstSR.x + aInstPos);
  vec2 r = wp.xz - uCamPos.xz;
  wp.y -= dot(r, r) / (2.0 * 6371000.0);
  gl_Position = shadowClip(wp);
}
`;
/** the shadow map keeps depth only */
export const SHADOW_FS = `#version 300 es
precision mediump float;
void main() {}
`;

export const WORLD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aRamp;
// buildings only (zero elsewhere): where the vertex is on a windowed facade (building-mesher
// BuildingMeshData.windows): u along the wall edge, v above the wall base; the edge's length, the
// wall height (0: no windows) and the edge's seed
layout(location=3) in vec2 aWinUV;
layout(location=4) in vec3 aWinEdge;
// terrain tiles only (zero elsewhere): x metres up to the border line of a coarser neighbour,
// y the tile edges (bits) it applies to; uCoarse: the edges whose neighbour is coarser now
layout(location=5) in vec2 aMorph;
uniform int uCoarse;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uOffset;
${PLACE_VS}${ORTHO_VS}
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uFogStart;
uniform float uFogEnd;
uniform int uTwoSided;
flat out vec3 vColor;
out float vLogW;
// water (WATER, SEA material ramps, not snowed over) and the ray from the eye: the glitter path
flat out float vWater;
out vec3 vRay;
out vec2 vWinUV;
flat out vec3 vWinEdge;
// buildings with windows: a near-white RGB face shaded in this face's light (glow level kept), for
// what the facade paints in its own colours (WORLD_FS windowAt: the signs)
flat out vec3 vRef;
uniform highp int uWindows;
${GLOW_VS}${RIM_GLSL}${SHADOW_RECEIVE_VS}
void main() {
  vWinUV = aWinUV;
  vWinEdge = aWinEdge;
  vec3 wp = toWorld(aPos);
  if ((int(aMorph.y) & uCoarse) != 0) wp.y += aMorph.x;
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  vec3 n = normalize(toWorldDir(aNormal));
  // two-sided lighting: a face seen from its back (thin plates such as fins, open meshes) is lit
  // by the normal of the side the eye sees, not the other side's
  if (uTwoSided == 1 && dot(n, uCamPos - wp) < 0.0) n = -n;
  vec4 light = sceneLight(n, wp.y + (d * d) / (2.0 * 6371000.0));
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  float tempC = climateTemp(vec3(wp.x, wp.y + (d * d) / (2.0 * 6371000.0), wp.z));
  vColor = min(shadeColour(aRamp, light.a * 11.0, fog, light.rgb, hazeAt(rel), tempC) + rimLight(n, wp, fog), 1.0);
  vec4 shade = sceneShade(n);
  vShade = uShadowOn > 0.5 && light.a > shade.a ? shadeColour(aRamp, shade.a * 11.0, fog, shade.rgb, hazeAt(rel), tempC) : vColor;
  shadowCoord(wp, n);
  vRef = uWindows > 0 && aWinEdge.y > 0.0
    ? shadeColour((aRamp & ${GLOW_LEVEL_MASK << GLOW_SHIFT}u) | 0xf0f0f0u, light.a * 11.0, fog, light.rgb, hazeAt(rel), 99.0)
    : vec3(0.0);
  uint id = aRamp & ${PAYLOAD_MASK}u;
  bool water = (aRamp & ${MATERIAL_FLAG}u) != 0u && (id == ${MAT.WATER}u || id == ${MAT.SEA}u);
  vWater = water && !frozenWater(aRamp, tempC) ? 1.0 : 0.0;
  vRay = wp - uCamPos;
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
  gl_Position.z = depthZ(gl_Position);
}
`;

/**
 * The world's faces. One source, compiled in variants (renderer WorldVariant) that leave out what a
 * kind of face never has (NO_WATER, NO_SPECKLE, NO_ROADS, NO_WINDOWS): a lighter shader runs
 * faster for every face it draws, the code it never runs included.
 */
export const WORLD_FS = `#version 300 es
precision highp float;
flat in vec3 vColor;
flat in float vWater;
in vec3 vRay;
in vec2 vWinUV;
flat in vec3 vWinEdge;
flat in vec3 vRef;
uniform vec3 uSunDir;
// windows on building facades (renderer.windows): 0 none, 1 glass, 2 glass with some lit (night)
uniform highp int uWindows;
// brightness of a lit window × SDR white (renderer.ts HDR_EMISSION cityLights)
uniform float uWinEmit;
// the share of windows lit now (renderer.litShare, palette.ts litShare by the local hour)
uniform float uLitShare;
// 1: self-lit (flame, aircraft lights): alpha 0 tells the silhouette rim pass to leave it alone
uniform float uSelfLit;
// brightness of a self-lit face × SDR white (> 1 on an XDR canvas, renderer.ts HDR_EMISSION)
uniform float uEmit;
// > 0: see-through (1 - renderer.opacity; 0, the default, in every other pass), the blend's source alpha
uniform float uClear;
// 1: rare lighter dots on the ground (renderer.speckle: terrain and OSM areas)
uniform int uSpeckle;
// the water surface's inputs (WATER_GLSL), shared with WORLD_VS
uniform vec3 uCamPos;
uniform float uFogStart;
uniform float uFogEnd;
uniform vec3 uHaze;
uniform vec3 uMoon;
uniform vec4 uDirect;
uniform sampler2D uLut;
vec3 lutColor(uint i) { return texelFetch(uLut, ivec2(int(i & 255u), int(i >> 8u)), 0).rgb; }
out vec4 oColor;
${LOG_DEPTH_FS}${GLITTER_GLSL}${WATER_GLSL}${EMIT_GLSL}${WINDOW_GLSL}${TRACK_GLSL}${ROAD_MARK_GLSL}${SHADOW_RECEIVE_FS}
void main() {
  writeLogDepth();
  // in a cast shadow the face keeps only the sky's light (vShade)
  vec3 c = sunLit() > 0.5 ? vColor : vShade;
  // the derivative is taken on every fragment: fwidth is undefined in non-uniform control flow
  vec2 wxz = uCamPos.xz + vRay.xz;
  vec2 fw = fwidth(wxz);
  vec4 jac = vec4(dFdx(wxz), dFdy(wxz));
  vec2 winFw = fwidth(vWinUV);
  // the face's normal from the ray's derivatives (faces are flat), toward the eye; for the windows
  vec3 faceN = cross(dFdx(vRay), dFdy(vRay));
  gWinD = vRay / max(length(vRay), 1e-4);
  gWinN = dot(faceN, faceN) > 1e-12 ? normalize(faceN) : -gWinD;
  if (dot(gWinN, gWinD) > 0.0) gWinN = -gWinN;
#ifndef NO_WATER
  if (vWater > 0.5) {
    float dist = length(vRay);
    c = waterSurface(vRay / max(dist, 1e-4), wxz, jac, dist, c);
  }
#endif
#ifndef NO_SPECKLE
  if (vWater <= 0.5 && uSpeckle == 1) {
    // speckles: world dots in the face's colour, lighter; fewer into the haze
    float fog = clamp((length(vRay) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    vec2 id;
    if (fog < 1.0 && worldDot(wxz, jac, ${SPECKLE_PER_PX}.0, ${SPECKLE_BASE_M}.0, id) && waterRand(id, 23.0) >= fog) {
      c = min(c * ${SPECKLE_LIFT.toFixed(2)} + 0.02, 1.0);
    }
  }
#endif
  float alpha = 1.0 - uSelfLit;
#ifndef NO_ROADS
  // TRACK_EDGE, ROAD_EDGE: negative; a facade's edge length is positive
  if (vWinEdge.x < ${TRACK_EDGE + 0.5}) {
    float fog = clamp((length(vRay) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    fog = floor(fog * 12.0) / 12.0;
    c = vWinEdge.x < ${ROAD_EDGE + 0.5} ? roadMarkAt(c, vWinUV, vWinEdge, winFw, fog) : trackAt(c, vWinUV, winFw, fog);
  }
#endif
#ifndef NO_WINDOWS
  if (uWindows > 0 && vWinEdge.y > 0.0) {
    float fog = clamp((length(vRay) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    fog = floor(fog * 12.0) / 12.0;
    // a lit window is a light source: alpha 0 keeps the silhouette rim pass off it
    if (windowAt(c, vWinUV, vWinEdge, winFw, fog)) alpha = 0.0;
  }
#endif
  if (uSelfLit > 0.5) c = emitLight(c, uEmit);
  // see-through: the blend's source alpha (the target's own alpha is kept, renderer.drawWorld)
  if (uClear > 0.0) alpha = 1.0 - uClear;
  oColor = vec4(c, alpha);
}
`;

export const TREE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
// 0 crown (the instance's foliage ramp), 1 trunk (bark, keeping the instance's glow level)
layout(location=2) in float aPart;
layout(location=3) in vec3 aInstPos;
// x: height, y: the face colour's payload (RGB or material id), exact in a float
layout(location=4) in vec2 aInstSR;
// the face colour's bits 24..31 (glow level, snow, material)
layout(location=5) in float aInstFlags;
// yaw: the mesh's +x turns towards (cos, sin) in x, z
layout(location=6) in float aInstYaw;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uOffset;
${PLACE_VS}${ORTHO_VS}
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uFogStart;
uniform float uFogEnd;
uniform int uTwoSided;
flat out vec3 vColor;
out float vLogW;
flat out float vWater;
out vec3 vRay;
// no windows on trees (WORLD_FS reads them)
out vec2 vWinUV;
flat out vec3 vWinEdge;
flat out vec3 vRef;
${GLOW_VS}${RIM_GLSL}${SHADOW_RECEIVE_VS}
void main() {
  vWinUV = vec2(0.0);
  vWinEdge = vec3(0.0);
  vRef = vec3(0.0);
  float cy = cos(aInstYaw), sy = sin(aInstYaw);
  vec3 lp = vec3(cy * aPos.x - sy * aPos.z, aPos.y, sy * aPos.x + cy * aPos.z);
  vec3 ln = vec3(cy * aNormal.x - sy * aNormal.z, aNormal.y, sy * aNormal.x + cy * aNormal.z);
  vec3 wp = toWorld(lp * aInstSR.x + aInstPos);
  vWater = 0.0;
  vRay = vec3(0.0, 1.0, 0.0);
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  vec3 n = normalize(toWorldDir(ln));
  // two-sided lighting: a face seen from its back (thin plates such as fins, open meshes) is lit
  // by the normal of the side the eye sees, not the other side's
  if (uTwoSided == 1 && dot(n, uCamPos - wp) < 0.0) n = -n;
  vec4 light = sceneLight(n, wp.y + (d * d) / (2.0 * 6371000.0));
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  uint packed = (uint(aInstFlags) << 24u) | uint(aInstSR.y);
  if (aPart > 0.5) packed = (packed & ${GLOW_LEVEL_MASK << GLOW_SHIFT}u) | ${TREE_TRUNK_RAMP}u;
  float tempC = climateTemp(vec3(wp.x, wp.y + (d * d) / (2.0 * 6371000.0), wp.z));
  vColor = min(shadeColour(packed, light.a * 11.0, fog, light.rgb, hazeAt(rel), tempC) + rimLight(n, wp, fog), 1.0);
  vec4 shade = sceneShade(n);
  vShade = uShadowOn > 0.5 && light.a > shade.a ? shadeColour(packed, shade.a * 11.0, fog, shade.rgb, hazeAt(rel), tempC) : vColor;
  shadowCoord(wp, n);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
  gl_Position.z = depthZ(gl_Position);
}
`;

export const POINTS_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aIndex;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uOffset;
${PLACE_VS}${ORTHO_VS}
uniform vec3 uCamPos;
uniform float uPointSize;
/**
 * Far building dots (wall + roof pairs) when > 0: the framebuffer height. Odd vertices (roofs) are
 * lifted on screen by one point size, onto the even one (walls) before them.
 */
uniform float uStackH;
/**
 * Pull toward the eye along the view ray, metres: x + y × distance. The point stays where it is on
 * screen; only its depth comes nearer, so terrain a little above it (the far OSM ring's heights are
 * from the DEM, the coarse terrain under it is a simplified TIN) no longer hides it.
 */
uniform vec2 uPull;
// brightness of the fixed light colours × SDR white (> 1 on an XDR canvas, renderer.ts HDR_EMISSION)
uniform float uEmit;
// the share of windows lit now (renderer.litShare): far building window dots go dark with it
uniform float uLitShare;
// far window dots: the framebuffer height (pixels) and the width of a dot's facade cell (metres)
uniform float uFbH;
uniform float uCell;
// and the fog they run into the haze with, like the near panes (renderer.pointFog)
uniform float uFogStart;
uniform float uFogEnd;
flat out vec3 vColor;
out float vLogW;
${COLOUR_GLSL}${WINDOW_LIGHT_GLSL}
void main() {
  vec3 wp = toWorld(aPos);
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  if (uPull.x + uPull.y > 0.0) {
    vec3 ray = wp - uCamPos;
    float len = length(ray);
    wp = uCamPos + ray * max(0.0, 1.0 - (uPull.x + uPull.y * len) / max(len, 1.0));
  }
  // >= 0: a LUT index; < 0: -(RGB + 1), shaded like a lit face by daylight (palette.ts pointValue)
  vColor = aIndex >= 0.0 ? lutColor(uint(aIndex)) : shadeRgb(rgbOf(uint(-aIndex - 1.0)), ${POINT_STEP}u, 0u);
  // light sources (windows, street lamps, beacons, runway lights) shine above white on XDR
  if (aIndex >= 0.0) {
    uint li = uint(aIndex);
    if ((li >= ${LIGHT.TAXI_BLUE}u && li <= ${LIGHT.RED}u) || li == ${LIGHT.STREET}u) vColor = emitLight(vColor, uEmit);
  }
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
  gl_Position.z = depthZ(gl_Position);
  gl_PointSize = uPointSize;
  // a far facade cell of windows (palette.ts FAR_WINDOWS): the cell's size on screen; under a pixel
  // only about one cell per pixel is kept, and a kept cell is lit with the near facades' mean light
  if (aIndex == ${LIGHT.WINDOW_YELLOW}.0 || aIndex == ${LIGHT.WINDOW_WHITE}.0) {
    bool allNight = aIndex == ${LIGHT.WINDOW_WHITE}.0;
    uvec3 q = uvec3(ivec3(floor(aPos * 4.0)) + 1048576);
    uint hx = q.x * 0x8da6b343u ^ q.y * 0xd8163841u ^ q.z * 0xcb1ab31fu;
    hx ^= hx >> 16u; hx *= 0x7feb352du; hx ^= hx >> 15u; hx *= 0x846ca68bu; hx ^= hx >> 16u;
    float hLit = float(hx & 0xffffu) / 65536.0;
    float hKeep = float((hx >> 16u) & 0xffu) / 256.0 + 0.5 / 256.0;
    float hCol = float(((hx * 0x9e3779b9u) >> 8u) & 0xffffu) / 65536.0;
    float share = allNight ? ${WINDOWS.ALL_NIGHT_SHARE.toFixed(2)} : uLitShare;
    float cellPx = uCell * uProj[1][1] * 0.5 * uFbH / max(gl_Position.w, 1e-3);
    bool keep = cellPx >= 1.0 || hKeep < cellPx * cellPx;
    // the buildings likely in front of it along the view ray (FAR_WINDOWS.CANOPY_M, FREE_PATH_M)
    float slope = max(uCamPos.y - wp.y, 1.0) / max(d, 1.0);
    float run = min(d, ${FAR_WINDOWS.CANOPY_M.toFixed(1)} / slope);
    float seen = 1.0 / (1.0 + run / ${FAR_WINDOWS.FREE_PATH_M.toFixed(1)});
    if (!keep || hLit >= ${FAR_WINDOW_LIT_FACTOR.toFixed(3)} * share * seen) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }
    // at least one framebuffer pixel, as small as a near pane: on a supersampled frame it averages
    // into the screen pixel like the panes do, rather than a whole over-bright pixel clipped to yellow
    else gl_PointSize = clamp(cellPx, 1.0, ${FAR_WINDOWS.MAX_PX.toFixed(1)});
    // its colour (the WINDOW_LIGHT mix), above white on XDR like the near panes, dimmer the farther from the eye
    vec3 lc = windowLightColour(hCol, allNight ? ${WINDOW_LIGHT.KELVIN_COOL_MIN.toFixed(1)} : ${WINDOW_LIGHT.KELVIN_MIN.toFixed(1)});
    // half-way into the haze with the fog, in its 12 steps (WORLD_FS windowAt)
    float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
    fog = floor(fog * 12.0) / 12.0;
    vColor = emitLight(mix(lc, uHaze, 0.5 * fog), uEmit) * windowFade(length(rel));
  }
  if (uStackH > 0.0 && (gl_VertexID & 1) == 1) gl_Position.y += uPointSize * 2.0 / uStackH * gl_Position.w;
}
`;

export const POINTS_FS = `#version 300 es
precision highp float;
flat in vec3 vColor;
uniform int uOn;
/** 1: round points; 0: GL lines (gl_PointCoord is undefined for lines) */
uniform int uRound;
out vec4 oColor;
${LOG_DEPTH_FS}
void main() {
  if (uOn == 0) discard;
  writeLogDepth();
  if (uRound == 1) {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
  }
  oColor = vec4(vColor, 1.0);
}
`;

export const FULLSCREEN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/**
 * Cloud veil (Q46): inside a cloud the view whites out in the cloud's colour, a screen-door dither
 * (4×4 Bayer) whose density steps with how deep in the cloud the eye is — no blending (§7). The
 * pattern is in screen pixels (uScale: the supersampling of the world pass) so it stays crisp.
 * Alpha 0 keeps the silhouette rim pass off its pixels.
 */
export const VEIL_FS = `#version 300 es
precision highp float;
uniform float uDensity;
uniform vec3 uColor;
uniform float uScale;
out vec4 oColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  ivec2 p = ivec2(floor(gl_FragCoord.xy / uScale)) & 3;
  if ((BAYER[p.y * 4 + p.x] + 0.5) / 16.0 >= uDensity) discard;
  oColor = vec4(uColor, 0.0);
}
`;

/** the moon disc's lit side: step 13 of the sky ramp (208 + 13) */
const MOON_LIT_INDEX = 208 + 13;

export const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
// base ground (horizon): camera height above it in m, its face colour and fog
uniform float uGroundH;
uniform uint uGroundRamp;
uniform float uFogStart;
uniform float uFogEnd;
// brightness of the sun disc × SDR white (> 1 on an XDR canvas, renderer.ts HDR_EMISSION)
uniform float uSunEmit;
// the moon's lit side glows like the windows on XDR (renderer HDR_EMISSION.cityLights), far below the sun
uniform float uMoonEmit;
// an overcast deck (Q46): how far its base is above the camera / the camera above its top, m (0: none),
// and its face colour. Like the base ground, it goes on to the horizon under the deck's tiles.
uniform float uDeckUp;
uniform float uDeckDown;
uniform uint uDeckColour;
out vec4 oColor;
${GLOW_VS}${GLITTER_GLSL}${WATER_GLSL}
void main() {
  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w - uCamPos);
  // the curvature of the Earth along the ray: height gained at distance t is t·dir.y - t²·a/2
  float ca = max(1.0 - dir.y * dir.y, 0.0) / ${EARTH_R.toFixed(1)};
  if (uDeckDown > 0.0 && dir.y < 0.0) {
    float disc = dir.y * dir.y - 2.0 * ca * uDeckDown;
    if (disc >= 0.0) {
      float t = ca > 1e-12 ? (-dir.y - sqrt(disc)) / ca : uDeckDown / -dir.y;
      float fog = floor(clamp((t - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0) * 12.0) / 12.0;
      vec4 lit = sceneLight(vec3(0.0, 1.0, 0.0), uCamPos.y - uDeckDown);
      oColor = vec4(shadeColour(uDeckColour, lit.a * 11.0, fog, lit.rgb, hazeAt(dir), 99.0), 1.0);
      return;
    }
  }
  if (uDeckUp > 0.0 && dir.y > 0.0) {
    // the underside, unlit (its faces look down); a ray that passes under it sees the far haze
    float disc = dir.y * dir.y - 2.0 * ca * uDeckUp;
    float fog = 1.0;
    if (disc >= 0.0) {
      float t = ca > 1e-12 ? (dir.y - sqrt(disc)) / ca : uDeckUp / dir.y;
      fog = floor(clamp((t - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0) * 12.0) / 12.0;
    }
    vec4 lit = sceneLight(vec3(0.0, -1.0, 0.0), uCamPos.y + uDeckUp);
    oColor = vec4(shadeColour(uDeckColour, lit.a * 11.0, fog, lit.rgb, hazeAt(dir), 99.0), 1.0);
    return;
  }
  // the base sea's point in world xz and its footprint, taken here where every fragment runs
  // (fwidth is undefined in non-uniform control flow); a ray over the horizon gets a far point
  vec2 seaXZ;
  {
    float a = max(1.0 - dir.y * dir.y, 0.0) / ${EARTH_R.toFixed(1)};
    float disc = dir.y * dir.y - 2.0 * a * uGroundH;
    float t = dir.y < 0.0 && disc >= 0.0 ? (a > 1e-12 ? (-dir.y - sqrt(disc)) / a : uGroundH / -dir.y) : uFogEnd;
    seaXZ = uCamPos.xz + dir.xz * t;
  }
  vec4 seaJac = vec4(dFdx(seaXZ), dFdy(seaXZ));
  // Base ground: a flat face colour on the curved Earth below the camera (the world shader's
  // d^2 / 2R drop), out to the true horizon. Drawn here, under every tile, so the horizon and the
  // ground are there before (and between) the terrain tiles; loaded terrain simply covers it.
  if (dir.y < 0.0) {
    float a = max(1.0 - dir.y * dir.y, 0.0) / ${EARTH_R.toFixed(1)};
    float disc = dir.y * dir.y - 2.0 * a * uGroundH;
    if (disc >= 0.0) {
      float t = a > 1e-12 ? (-dir.y - sqrt(disc)) / a : uGroundH / -dir.y;
      float fog = clamp((t - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
      fog = floor(fog * 12.0) / 12.0;
      vec4 lit = sceneLight(vec3(0.0, 1.0, 0.0), uCamPos.y - uGroundH);
      // the base ground's climate: at the camera's latitude, at the ground's height
      float tempC = climateTemp(vec3(uCamPos.x, uCamPos.y - uGroundH, uCamPos.z));
      oColor = vec4(shadeColour(uGroundRamp, lit.a * 11.0, fog, lit.rgb, hazeAt(dir), tempC), 1.0);
      if (uGroundRamp == ${MATERIAL_FLAG | MAT.SEA}u && !frozenWater(uGroundRamp, tempC)) oColor.rgb = waterSurface(dir, seaXZ, seaJac, t, oColor.rgb);
      return;
    }
  }
  vec3 col = skyAt(dir, uSunDir);
  float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  uint idx = 0u;
  // moon: disc (exaggerated ~1.8 deg radius) lit by the sun; the dark limb stays sky-coloured
  float md = dot(dir, uMoonDir);
  if (md > 0.0) {
    vec3 o = dir - uMoonDir * md;
    float moonR = 0.031;
    if (length(o) < moonR) {
      vec3 s = uSunDir - uMoonDir * dot(uSunDir, uMoonDir);
      float sl = length(s);
      vec3 a = sl > 1e-5 ? s / sl : normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 b = cross(uMoonDir, a);
      vec2 xy = vec2(dot(o, a), dot(o, b)) / moonR;
      float z = sqrt(max(1.0 - dot(xy, xy), 0.0));
      vec3 n = xy.x * a + xy.y * b - z * uMoonDir;
      if (dot(n, uSunDir) > 0.0) idx = ${MOON_LIT_INDEX}u;
    }
  }
  // the sun: one plain disc (~1.7 deg radius), white by day, yellow when low (applySunColors)
  if (ang < 0.03) idx = ${LIGHT.SUN}u;
  oColor = vec4(idx > 0u ? emitLight(lutColor(idx), idx == ${LIGHT.SUN}u ? uSunEmit : uMoonEmit) : col, 1.0);
}
`;

/**
 * The night sky (sky.ts): catalogue stars and planets as points, drawn after SKY_FS with additive
 * blending, so they fade into the twilight sky by themselves. aDir is a J2000 equatorial unit vector,
 * uSky turns it into a world direction. A point is dropped when it is fainter than uLimit (the
 * limiting magnitude, after extinction toward the horizon), behind the sun or moon disc, or where
 * SKY_FS drew the base ground or an overcast deck instead of sky. Brightness in quarter steps;
 * size 1–3 px by magnitude, × uPx.
 */
export const STARS_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aDir;
layout(location=1) in float aMag;
layout(location=2) in vec3 aRgb;
uniform mat3 uSky;
uniform mat4 uViewProj;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uLimit;
uniform float uPx;
uniform float uGroundH;
uniform float uDeckUp;
uniform float uDeckDown;
flat out vec3 vColor;
// the ray meets a surface uH below the eye on the curved Earth (SKY_FS)
bool hits(vec3 d, float uH) {
  float a = max(1.0 - d.y * d.y, 0.0) / ${EARTH_R.toFixed(1)};
  return d.y < 0.0 && d.y * d.y - 2.0 * a * uH >= 0.0;
}
void main() {
  vec3 d = normalize(uSky * aDir);
  // extinction: 0.2 mag per air mass (Kasten & Young air mass)
  float h = max(d.y, 0.0);
  float airmass = 1.0 / (h + 0.025 * exp(-11.0 * h));
  float m = aMag + 0.2 * (airmass - 1.0);
  bool hidden = m > uLimit || hits(d, uGroundH) || (uDeckDown > 0.0 && hits(d, uDeckDown))
    || (uDeckUp > 0.0 && d.y > 0.0) || dot(d, uSunDir) > 0.99955 || dot(d, uMoonDir) > 0.99952;
  if (hidden) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }
  float vis = ceil(clamp((uLimit - m) / 2.0 + 0.25, 0.0, 1.0) * 4.0) / 4.0;
  vColor = aRgb * vis;
  gl_Position = uViewProj * vec4(d, 0.0);
  gl_Position.z = 0.0;
  gl_PointSize = (aMag < -1.0 ? 3.0 : aMag < 1.5 ? 2.0 : 1.0) * uPx;
}
`;

export const STARS_FS = `#version 300 es
precision highp float;
flat in vec3 vColor;
out vec4 oColor;
void main() {
  oColor = vec4(vColor, 0.0);
}
`;

/**
 * World → screen-sized colour (colorTex), run when the world needs a pass of its own: 2x
 * supersampling (uScale 2: the mean of each 2×2 block) and/or the silhouette rim light.
 *
 * Silhouette rim (rim.ts, контровой свет по силуэту): a pixel lights up when, walking from it on
 * the screen toward the sun, the depth jumps away within uOutline.y pixels (an edge with sky or far
 * ground behind it on the sun's side); nearer the edge, brighter. uOutline: x strength (0: off),
 * y width in world pixels, z the depth jump between neighbouring pixels that makes an edge (ratio),
 * w backlight power (how much it needs the eye to look into the sun). Faded with the fog.
 */
export const WORLD_POST_FS = `#version 300 es
precision highp float;
uniform sampler2D uWorldTex;
uniform highp sampler2D uDepthTex;
uniform int uScale;
uniform vec4 uOutline;
uniform float uRimSteps;
uniform vec3 uRimColor;
uniform vec3 uSunDir;
uniform mat4 uViewProj;
uniform mat4 uInvViewProj;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 oColor;
const float LOG_FAR = ${Math.log2(DEPTH_FAR + 1).toFixed(8)};
ivec2 worldSize;
// distance to the eye from the log depth (LOG_DEPTH_FS); nothing drawn (sky) is far away
float dist(ivec2 q) {
  float d = texelFetch(uDepthTex, clamp(q, ivec2(0), worldSize - 1), 0).r;
#ifdef REVERSED_Z
  return d <= 0.0 ? 1e9 : ${REVERSED_NEAR.toFixed(2)} / d;
#else
  return d >= 1.0 ? 1e9 : exp2(d * LOG_FAR) - 1.0;
#endif
}
vec3 outline(ivec2 p) {
  float d0 = dist(p);
  if (d0 >= 1e8) return vec3(0.0);
  vec4 sc = uViewProj * vec4(uSunDir, 0.0);
  if (sc.w <= 1e-4) return vec3(0.0); // the sun is behind the eye
  vec2 size = vec2(worldSize);
  vec2 here = vec2(p) + 0.5;
  vec2 dir = (sc.xy / sc.w * 0.5 + 0.5) * size - here;
  float len = length(dir);
  if (len < 1.0) return vec3(0.0);
  dir /= len;
  vec2 ndc = here / size * 2.0 - 1.0;
  vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ray = normalize(b.xyz / b.w - a.xyz / a.w);
  float back = max(dot(ray, uSunDir), 0.0);
  back = uOutline.w > 0.0 ? pow(back, uOutline.w) : 1.0;
  if (back <= 0.0) return vec3(0.0);
  float w = uOutline.y * float(uScale);
  float prev = d0;
  float hit = 0.0;
  for (int k = 1; k <= 32; k++) {
    if (float(k) > w) break;
    float dk = dist(ivec2(here + dir * float(k)));
    if (dk > prev * (1.0 + uOutline.z)) { hit = 1.0 - float(k - 1) / w; break; }
    prev = dk;
  }
  float r = clamp(uOutline.x * hit * back, 0.0, 1.0);
  if (uRimSteps > 0.0) r = floor(r * uRimSteps + 0.5) / uRimSteps;
  float fog = clamp((d0 - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  return uRimColor * r * (1.0 - fog);
}
vec3 px(ivec2 q) {
  vec4 t = texelFetch(uWorldTex, q, 0);
  // alpha 0: a self-lit face (WORLD_FS uSelfLit), no rim on it
  // (the clamp to white keeps what an XDR light source already has above it)
  if (uOutline.x > 0.0 && t.a > 0.5) return max(t.rgb, min(t.rgb + outline(q), 1.0));
  return t.rgb;
}
void main() {
  worldSize = textureSize(uWorldTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) * uScale;
  vec3 c = px(p);
  if (uScale == 2) c = (c + px(p + ivec2(1, 0)) + px(p + ivec2(0, 1)) + px(p + ivec2(1, 1))) * 0.25;
  oColor = vec4(c, 1.0);
}
`;

export const RESOLVE_FS = `#version 300 es
precision highp float;
uniform sampler2D uWorldTex;
uniform highp usampler2D uOverlayTex;
uniform sampler2D uColorTex;
uniform sampler2D uLut;
// 1: the world went through WORLD_POST_FS into uColorTex (supersampling or the silhouette rim)
uniform int uMsaa;
out vec4 oColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uint o = texelFetch(uOverlayTex, p, 0).r;
  if (o > 0u) {
    oColor = vec4(texelFetch(uLut, ivec2(int(o), ${OVERLAY_LUT_BASE / 256}), 0).rgb, 1.0); // overlay: its own row (palette.ts)
  } else if (uMsaa == 1) {
    oColor = vec4(texelFetch(uColorTex, p, 0).rgb, 1.0);
  } else {
    oColor = vec4(texelFetch(uWorldTex, p, 0).rgb, 1.0);
  }
}
`;

export const FONT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
uniform vec2 uScreen;
out vec2 vUV;
void main() {
  vec2 ndc = (aPos / uScreen) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUV = aUV;
}
`;

export const FONT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform highp usampler2D uAtlas;
uniform uint uIndex;
out uint oIndex;
void main() {
  uint coverage = texelFetch(uAtlas, ivec2(floor(vUV)), 0).r;
  if (coverage == 0u) discard;
  oIndex = uIndex;
}
`;