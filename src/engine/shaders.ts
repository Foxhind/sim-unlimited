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

export const RESOLVE_FS = `#version 300 es
precision highp float;
uniform highp usampler2D uIndexTex;
uniform sampler2D uLut;
out vec4 oColor;
void main() {
  uint idx = texelFetch(uIndexTex, ivec2(gl_FragCoord.xy), 0).r;
  oColor = vec4(texelFetch(uLut, ivec2(int(idx), 0), 0).rgb, 1.0);
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