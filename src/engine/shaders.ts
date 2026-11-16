/**
 * Logarithmic depth for every world pass (terrain, OSM drape, aircraft, trees, lights).
 * A standard 24-bit depth buffer with near 0.5 m resolves only ~0.5 m at 2 km and ~3 m at 5 km,
 * so overlays draped 0.3-1.4 m above the terrain z-fought with it beyond a couple of km.
 * log2(1 + w) / log2(1 + far) keeps the relative resolution ~1e-6 (centimetres at 10 km).
 * Must match the far plane of the projection (main.ts / camera.ts).
 */
import { GLOW_LEVEL_MASK, GLOW_LEVELS, GLOW_SHIFT, GLOW_STEP_BASE, LIGHT, LUT_SIZE, MAT, MATERIAL_FLAG, OVERLAY_LUT_BASE, PAYLOAD_MASK, POINT_STEP, SKY_BANDS, SNOW_FLAG, TREE_TRUNK_RAMP } from './palette';

export const DEPTH_FAR = 200000;
/** Earth radius of the curvature drop in the world shaders (wp.y -= d^2 / 2R) and the base ground */
const EARTH_R = 6371000;
/**
 * World colour (palette.ts): the world passes write RGB, not palette indices. A face colour is a
 * packed uint: an RGB colour, or (MATERIAL_FLAG) a material ramp looked up in the LUT; bits 24..26
 * the night glow level, SNOW_FLAG the winter flag.
 * Lighting stays stepped (12 lit steps, 4 fog steps toward the horizon haze) for both kinds: a
 * material takes its ramp's LUT entry at the step, an RGB colour is shaded by the same law in place
 * (palette.ts shadeColour) with the light of its glow level (uLight) — any colour, no palette snap.
 * With uGlow on, a glowing face is shaded at least at step GLOW_STEP_BASE + level, in that level's
 * street-lit light. With uSnow on, a face flagged SNOW_FLAG is drawn in the snow ramp.
 */
const COLOUR_GLSL = `
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
const GLOW_VS = `
uniform int uGlow;
uniform int uSnow;
${COLOUR_GLSL}
vec3 shadeColour(uint packedRamp, float litStep, float fog) {
  uint lvl = uGlow == 1 ? (packedRamp >> ${GLOW_SHIFT}u) & ${GLOW_LEVEL_MASK}u : 0u;
  if (lvl > 0u) litStep = max(litStep, ${GLOW_STEP_BASE}.0 + float(lvl));
  uint s = uint(clamp(mix(litStep, 15.0, fog) + 0.5, 0.0, 15.0));
  bool snow = uSnow == 1 && (packedRamp & ${SNOW_FLAG}u) != 0u;
  if (snow || (packedRamp & ${MATERIAL_FLAG}u) != 0u) {
    uint ramp = snow ? ${MAT.SNOW}u : packedRamp & ${PAYLOAD_MASK}u;
    return lutColor(lvl * ${LUT_SIZE}u + ramp * 16u + s);
  }
  return shadeRgb(rgbOf(packedRamp), s, lvl);
}
`;

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
uniform float uGlitter;
uniform vec3 uGlitterSun;
uniform vec3 uGlitterCore;
uniform vec3 uGlitterEdge;
float glitterHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// the glitter colour along the view ray d (unit, from the eye), alpha 1 where it lights the water
vec4 glitter(vec3 d) {
  if (uGlitter <= 0.0 || d.y >= 0.0) return vec4(0.0);
  vec3 sun = uGlitterSun;
  float k = uGlitter * clamp((sun.y + 0.02) / 0.03, 0.0, 1.0);
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

const LOG_DEPTH_FS = `
in float vLogW;
// orthographic views (see ORTHO_VS) are all far from the eye, where the logarithm is at its
// coarsest (decimetres): their depth is linear between the planes instead
uniform highp float uOrthoFar;
void writeLogDepth() {
  gl_FragDepth = uOrthoFar > 0.0 ? (vLogW - 1.0) / uOrthoFar : log2(vLogW) / log2(${DEPTH_FAR.toFixed(1)} + 1.0);
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
`;

export const WORLD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aRamp;
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
${GLOW_VS}${RIM_GLSL}
void main() {
  vec3 wp = toWorld(aPos);
  if ((int(aMorph.y) & uCoarse) != 0) wp.y += aMorph.x;
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  vec3 n = normalize(toWorldDir(aNormal));
  // two-sided lighting: a face seen from its back (thin plates such as fins, open meshes) is lit
  // by the normal of the side the eye sees, not the other side's
  if (uTwoSided == 1 && dot(n, uCamPos - wp) < 0.0) n = -n;
  float diff = max(dot(n, uSunDir), 0.0);
  float lit = 0.30 + 0.70 * diff;
  float litStep = lit * 11.0;
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  vColor = min(shadeColour(aRamp, litStep, fog) + rimLight(n, wp, fog), 1.0);
  uint id = aRamp & ${PAYLOAD_MASK}u;
  bool water = (aRamp & ${MATERIAL_FLAG}u) != 0u && (id == ${MAT.WATER}u || id == ${MAT.SEA}u);
  vWater = water && !(uSnow == 1 && (aRamp & ${SNOW_FLAG}u) != 0u) ? 1.0 : 0.0;
  vRay = wp - uCamPos;
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
}
`;

export const WORLD_FS = `#version 300 es
precision highp float;
flat in vec3 vColor;
flat in float vWater;
in vec3 vRay;
uniform vec3 uSunDir;
out vec4 oColor;
${LOG_DEPTH_FS}${GLITTER_GLSL}
void main() {
  writeLogDepth();
  vec3 c = vColor;
  if (vWater > 0.5) {
    vec4 g = glitter(normalize(vRay));
    if (g.a > 0.0) c = g.rgb;
  }
  oColor = vec4(c, 1.0);
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
${GLOW_VS}${RIM_GLSL}
void main() {
  vec3 wp = toWorld(aPos * aInstSR.x + aInstPos);
  vWater = 0.0;
  vRay = vec3(0.0, 1.0, 0.0);
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  vec3 n = normalize(toWorldDir(aNormal));
  // two-sided lighting: a face seen from its back (thin plates such as fins, open meshes) is lit
  // by the normal of the side the eye sees, not the other side's
  if (uTwoSided == 1 && dot(n, uCamPos - wp) < 0.0) n = -n;
  float diff = max(dot(n, uSunDir), 0.0);
  float lit = 0.30 + 0.70 * diff;
  float litStep = lit * 11.0;
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  uint packed = (uint(aInstFlags) << 24u) | uint(aInstSR.y);
  if (aPart > 0.5) packed = (packed & ${GLOW_LEVEL_MASK << GLOW_SHIFT}u) | ${TREE_TRUNK_RAMP}u;
  vColor = min(shadeColour(packed, litStep, fog) + rimLight(n, wp, fog), 1.0);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
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
flat out vec3 vColor;
out float vLogW;
${COLOUR_GLSL}
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
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
  gl_PointSize = uPointSize;
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

export const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
// base ground (horizon): camera height above it in m, its face colour, the terrain's light and fog
uniform float uGroundH;
uniform uint uGroundRamp;
uniform vec3 uLightDir;
uniform float uFogStart;
uniform float uFogEnd;
// sky glow toward a low sun, 0..1 (palette.ts PaletteParams.glow)
uniform float uSunGlow;
out vec4 oColor;
${GLOW_VS}${GLITTER_GLSL}
void main() {
  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w - uCamPos);
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
      float lit = 0.30 + 0.70 * max(uLightDir.y, 0.0);
      oColor = vec4(shadeColour(uGroundRamp, lit * 11.0, fog), 1.0);
      if (uGroundRamp == ${MATERIAL_FLAG | MAT.SEA}u) {
        vec4 g = glitter(dir);
        if (g.a > 0.0) oColor = vec4(g.rgb, 1.0);
      }
      return;
    }
  }
  float t = clamp(dir.y, 0.0, 1.0);
  float h = pow(1.0 - t, 1.6) * ${SKY_BANDS}.0;
  // Sunset glow: rings round the sun disc, by the angle from the sun (so they are circles centred
  // on it), in steps like the sky bands: coral outside, gold at the disc. The inner rings cover the
  // bands, the outer ones let them show through.
  float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
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
  vec2 dh = dir.xz, sh = uSunDir.xz;
  if (dot(dh, dh) > 1e-8 && dot(sh, sh) > 1e-8) {
    float away = smoothstep(0.2, 1.0, 0.5 - 0.5 * dot(normalize(dh), normalize(sh)));
    float most = mix(${ANTISUN_DAY.toFixed(2)}, ${ANTISUN_DUSK.toFixed(2)}, uSunGlow) * clamp((uSunDir.y + 0.1) / 0.1, 0.0, 1.0);
    float d = away * pow(1.0 - t, 0.8);
    d = floor(d * ${ANTISUN_STEPS}.0 + 0.5) / ${ANTISUN_STEPS}.0 * most;
    col = mix(col, col * ${ANTISUN_TINT}, d);
  }
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
      if (dot(n, uSunDir) > 0.0) idx = 208u + 13u;
    }
  }
  // the sun: one plain disc (~1.7 deg radius), white by day, yellow when low (applySunColors)
  if (ang < 0.03) idx = ${LIGHT.SUN}u;
  oColor = vec4(idx > 0u ? lutColor(idx) : col, 1.0);
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
  return d >= 1.0 ? 1e9 : exp2(d * LOG_FAR) - 1.0;
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
  vec3 c = texelFetch(uWorldTex, q, 0).rgb;
  if (uOutline.x > 0.0) c = min(c + outline(q), 1.0);
  return c;
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