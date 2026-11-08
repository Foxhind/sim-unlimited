export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`Failed to create ${what}`);
  return value;
}

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = must(gl.createShader(type), 'shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}\n${src}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = must(gl.createProgram(), 'program');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${log}`);
  }
  return prog;
}

export type Uniforms = Record<string, WebGLUniformLocation | null>;

export function uniformMap(gl: WebGL2RenderingContext, prog: WebGLProgram, names: string[]): Uniforms {
  const map: Uniforms = {};
  for (const name of names) map[name] = gl.getUniformLocation(prog, name);
  return map;
}