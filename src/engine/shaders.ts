/**
 * Logarithmic depth for every world pass (terrain, OSM drape, aircraft, trees, lights).
 * A standard 24-bit depth buffer with near 0.5 m resolves only ~0.5 m at 2 km and ~3 m at 5 km,
 * so overlays draped 0.3-1.4 m above the terrain z-fought with it beyond a couple of km.
 * log2(1 + w) / log2(1 + far) keeps the relative resolution ~1e-6 (centimetres at 10 km).
 * Must match the far plane of the projection (main.ts / camera.ts).
 */
import { GLOW_LEVEL_MASK, GLOW_LEVELS, GLOW_SHIFT, GLOW_STEP_BASE, LIGHT, LUT_SIZE, MAT, MATERIAL_FLAG, OVERLAY_LUT_BASE, PAYLOAD_MASK, POINT_STEP, SNOW_FLAG, TREE_TRUNK_RAMP } from './palette';

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
flat out vec3 vColor;
out float vLogW;
${GLOW_VS}
void main() {
  vec3 wp = toWorld(aPos);
  if ((int(aMorph.y) & uCoarse) != 0) wp.y += aMorph.x;
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  float diff = max(dot(normalize(toWorldDir(aNormal)), uSunDir), 0.0);
  float lit = 0.30 + 0.70 * diff;
  float litStep = lit * 11.0;
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  vColor = shadeColour(aRamp, litStep, fog);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
}
`;

export const WORLD_FS = `#version 300 es
precision highp float;
flat in vec3 vColor;
out vec4 oColor;
${LOG_DEPTH_FS}
void main() {
  writeLogDepth();
  oColor = vec4(vColor, 1.0);
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
flat out vec3 vColor;
out float vLogW;
${GLOW_VS}
void main() {
  vec3 wp = toWorld(aPos * aInstSR.x + aInstPos);
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  float diff = max(dot(normalize(toWorldDir(aNormal)), uSunDir), 0.0);
  float lit = 0.30 + 0.70 * diff;
  float litStep = lit * 11.0;
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  uint packed = (uint(aInstFlags) << 24u) | uint(aInstSR.y);
  if (aPart > 0.5) packed = (packed & ${GLOW_LEVEL_MASK << GLOW_SHIFT}u) | ${TREE_TRUNK_RAMP}u;
  vColor = shadeColour(packed, litStep, fog);
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
flat out vec3 vColor;
out float vLogW;
${COLOUR_GLSL}
void main() {
  vec3 wp = toWorld(aPos);
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  // >= 0: a LUT index; < 0: -(RGB + 1), shaded like a lit face by daylight (palette.ts pointValue)
  vColor = aIndex >= 0.0 ? lutColor(uint(aIndex)) : shadeRgb(rgbOf(uint(-aIndex - 1.0)), ${POINT_STEP}u, 0u);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
  gl_PointSize = uPointSize;
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
out vec4 oColor;
${GLOW_VS}
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
      return;
    }
  }
  float t = clamp(dir.y, 0.0, 1.0);
  float band = floor(pow(1.0 - t, 1.6) * 9.0);
  uint idx = 192u + uint(min(band, 8.0));
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
  float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  if (ang < 0.018) {
    idx = ${LIGHT.SUN}u;
  } else if (ang < 0.045) {
    idx = ${LIGHT.SUN_HALO}u;
  }
  oColor = vec4(lutColor(idx), 1.0);
}
`;

/** 2x supersampled world → screen: the mean of each 2×2 block */
export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform sampler2D uWorldTex;
out vec4 oColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec3 c = texelFetch(uWorldTex, p, 0).rgb + texelFetch(uWorldTex, p + ivec2(1, 0), 0).rgb
    + texelFetch(uWorldTex, p + ivec2(0, 1), 0).rgb + texelFetch(uWorldTex, p + ivec2(1, 1), 0).rgb;
  oColor = vec4(c * 0.25, 1.0);
}
`;

export const RESOLVE_FS = `#version 300 es
precision highp float;
uniform sampler2D uWorldTex;
uniform highp usampler2D uOverlayTex;
uniform sampler2D uColorTex;
uniform sampler2D uLut;
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