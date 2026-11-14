/**
 * Logarithmic depth for every world pass (terrain, OSM drape, aircraft, trees, lights).
 * A standard 24-bit depth buffer with near 0.5 m resolves only ~0.5 m at 2 km and ~3 m at 5 km,
 * so overlays draped 0.3-1.4 m above the terrain z-fought with it beyond a couple of km.
 * log2(1 + w) / log2(1 + far) keeps the relative resolution ~1e-6 (centimetres at 10 km).
 * Must match the far plane of the projection (main.ts / camera.ts).
 */
import { GLOW_LEVEL_MASK, GLOW_SHIFT, GLOW_STEP_BASE, LIGHT, LUT_SIZE, OVERLAY_LUT_BASE, RAMP, RAMP_MASK, SNOW_FLAG, TREE_TRUNK_RAMP } from './palette';

export const DEPTH_FAR = 200000;
/**
 * Night glow (palette.ts): ramp | level << GLOW_SHIFT. With uGlow on, a glowing face is shaded at
 * least at step GLOW_STEP_BASE + level and looked up in that level's street-lit copy of the LUT.
 * Winter: with uSnow on, a face flagged SNOW_FLAG is drawn in the snow ramp.
 */
const GLOW_VS = `
uniform int uGlow;
uniform int uSnow;
uint glowIndex(uint packedRamp, float litStep, float fog) {
  uint ramp = packedRamp & ${RAMP_MASK}u;
  if (uSnow == 1 && (packedRamp & ${SNOW_FLAG}u) != 0u) ramp = ${RAMP.SNOW}u;
  uint lvl = uGlow == 1 ? (packedRamp >> ${GLOW_SHIFT}u) & ${GLOW_LEVEL_MASK}u : 0u;
  if (lvl > 0u) litStep = max(litStep, ${GLOW_STEP_BASE}.0 + float(lvl));
  float idx = mix(litStep, 15.0, fog);
  return lvl * ${LUT_SIZE}u + ramp * 16u + uint(clamp(idx + 0.5, 0.0, 15.0));
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
flat out uint vIndex;
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
  vIndex = glowIndex(aRamp, litStep, fog);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
}
`;

export const WORLD_FS = `#version 300 es
precision highp float;
flat in uint vIndex;
out uint oIndex;
${LOG_DEPTH_FS}
void main() {
  writeLogDepth();
  oIndex = vIndex;
}
`;

export const TREE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
// 0 crown (the instance's foliage ramp), 1 trunk (bark, keeping the instance's glow level)
layout(location=2) in float aPart;
layout(location=3) in vec3 aInstPos;
layout(location=4) in vec2 aInstSR;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec4 uOffset;
${PLACE_VS}${ORTHO_VS}
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uFogStart;
uniform float uFogEnd;
flat out uint vIndex;
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
  uint packed = uint(aInstSR.y);
  if (aPart > 0.5) packed = (packed & ~${RAMP_MASK | SNOW_FLAG}u) | ${TREE_TRUNK_RAMP}u;
  vIndex = glowIndex(packed, litStep, fog);
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
flat out uint vIndex;
out float vLogW;
void main() {
  vec3 wp = toWorld(aPos);
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  vIndex = uint(aIndex);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vLogW = logW(gl_Position);
  gl_PointSize = uPointSize;
}
`;

export const POINTS_FS = `#version 300 es
precision highp float;
flat in uint vIndex;
uniform int uOn;
/** 1: round points; 0: GL lines (gl_PointCoord is undefined for lines) */
uniform int uRound;
out uint oIndex;
${LOG_DEPTH_FS}
void main() {
  if (uOn == 0) discard;
  writeLogDepth();
  if (uRound == 1) {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
  }
  oIndex = vIndex;
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
out uint oIndex;
void main() {
  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w - uCamPos);
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
  oIndex = idx;
}
`;

export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform highp usampler2D uIndexTex;
uniform sampler2D uLut;
out vec4 oColor;
vec3 lut(uint i) { return texelFetch(uLut, ivec2(int(i & 255u), int(i >> 8u)), 0).rgb; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  uint a = texelFetch(uIndexTex, p, 0).r;
  uint b = texelFetch(uIndexTex, p + ivec2(1, 0), 0).r;
  uint c = texelFetch(uIndexTex, p + ivec2(0, 1), 0).r;
  uint d = texelFetch(uIndexTex, p + ivec2(1, 1), 0).r;
  vec3 ca = lut(a);
  // interior pixels keep the exact palette color; only edges blend
  oColor = vec4(a == b && a == c && a == d ? ca : (ca + lut(b) + lut(c) + lut(d)) * 0.25, 1.0);
}
`;

export const RESOLVE_FS = `#version 300 es
precision highp float;
uniform highp usampler2D uIndexTex;
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
    uint idx = texelFetch(uIndexTex, p, 0).r;
    oColor = vec4(texelFetch(uLut, ivec2(int(idx & 255u), int(idx >> 8u)), 0).rgb, 1.0);
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