export const WORLD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aRamp;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uOffset;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uFogStart;
uniform float uFogEnd;
flat out uint vIndex;
void main() {
  vec3 wp = aPos + uOffset;
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  float diff = max(dot(normalize(aNormal), uSunDir), 0.0);
  float lit = 0.30 + 0.70 * diff;
  float litStep = lit * 11.0;
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  float idx = mix(litStep, 15.0, fog);
  vIndex = aRamp * 16u + uint(clamp(idx + 0.5, 0.0, 15.0));
  gl_Position = uProj * uView * vec4(wp, 1.0);
}
`;

export const WORLD_FS = `#version 300 es
precision highp float;
flat in uint vIndex;
out uint oIndex;
void main() {
  oIndex = vIndex;
}
`;

export const TREE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=3) in vec3 aInstPos;
layout(location=4) in vec2 aInstSR;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uOffset;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uFogStart;
uniform float uFogEnd;
flat out uint vIndex;
void main() {
  vec3 wp = aPos * aInstSR.x + aInstPos + uOffset;
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  float diff = max(dot(normalize(aNormal), uSunDir), 0.0);
  float lit = 0.30 + 0.70 * diff;
  float litStep = lit * 11.0;
  float fog = clamp((length(rel) - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  fog = floor(fog * 12.0) / 12.0;
  float idx = mix(litStep, 15.0, fog);
  vIndex = uint(aInstSR.y) * 16u + uint(clamp(idx + 0.5, 0.0, 15.0));
  gl_Position = uProj * uView * vec4(wp, 1.0);
}
`;

export const POINTS_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aIndex;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uOffset;
uniform vec3 uCamPos;
uniform float uPointSize;
flat out uint vIndex;
void main() {
  vec3 wp = aPos + uOffset;
  vec3 rel = wp - uCamPos;
  float d = length(rel.xz);
  wp.y -= (d * d) / (2.0 * 6371000.0);
  vIndex = uint(aIndex);
  gl_Position = uProj * uView * vec4(wp, 1.0);
  gl_PointSize = uPointSize;
}
`;

export const POINTS_FS = `#version 300 es
precision highp float;
flat in uint vIndex;
uniform int uOn;
out uint oIndex;
void main() {
  if (uOn == 0) discard;
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
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
out uint oIndex;
void main() {
  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w - uCamPos);
  float t = clamp(dir.y, 0.0, 1.0);
  float band = floor(pow(1.0 - t, 1.6) * 9.0);
  uint idx = 192u + uint(min(band, 8.0));
  float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  if (ang < 0.018) {
    idx = 208u + 15u;
  } else if (ang < 0.045) {
    idx = 208u + 11u;
  }
  oIndex = idx;
}
`;

export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform highp usampler2D uIndexTex;
uniform sampler2D uLut;
out vec4 oColor;
vec3 lut(uint i) { return texelFetch(uLut, ivec2(int(i), 0), 0).rgb; }
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
    oColor = vec4(texelFetch(uLut, ivec2(int(o), 0), 0).rgb, 1.0);
  } else if (uMsaa == 1) {
    oColor = vec4(texelFetch(uColorTex, p, 0).rgb, 1.0);
  } else {
    uint idx = texelFetch(uIndexTex, p, 0).r;
    oColor = vec4(texelFetch(uLut, ivec2(int(idx), 0), 0).rgb, 1.0);
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