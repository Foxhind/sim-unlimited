import { mat4, vec3 } from 'gl-matrix';
import { createProgram, must, uniformMap, type Uniforms } from './gl';
import { FULLSCREEN_VS, RESOLVE_FS, SKY_FS, WORLD_FS, WORLD_VS } from './shaders';

export interface Mesh {
  vao: WebGLVertexArrayObject;
  vertexCount: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  width = 0;
  height = 0;

  private fbo: WebGLFramebuffer;
  private indexTex: WebGLTexture;
  private depthRb: WebGLRenderbuffer;
  private lutTex: WebGLTexture;
  private triVao: WebGLVertexArrayObject;

  private worldProg: WebGLProgram;
  private worldU: Uniforms;
  private skyProg: WebGLProgram;
  private skyU: Uniforms;
  private resolveProg: WebGLProgram;
  private resolveU: Uniforms;

  private invViewProj = mat4.create();

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    this.indexTex = must(gl.createTexture(), 'index texture');
    this.depthRb = must(gl.createRenderbuffer(), 'depth renderbuffer');
    this.fbo = must(gl.createFramebuffer(), 'index framebuffer');
    this.lutTex = must(gl.createTexture(), 'LUT texture');
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    this.triVao = must(gl.createVertexArray(), 'fullscreen VAO');
    gl.bindVertexArray(this.triVao);
    const triBuf = must(gl.createBuffer(), 'fullscreen buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.worldProg = createProgram(gl, WORLD_VS, WORLD_FS);
    this.worldU = uniformMap(gl, this.worldProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd',
    ]);
    this.skyProg = createProgram(gl, FULLSCREEN_VS, SKY_FS);
    this.skyU = uniformMap(gl, this.skyProg, ['uInvViewProj', 'uCamPos', 'uSunDir']);
    this.resolveProg = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS);
    this.resolveU = uniformMap(gl, this.resolveProg, ['uIndexTex', 'uLut']);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);

    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.indexTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Index framebuffer incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  beginFrame(lut: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    // overlay passes leave depthMask false; depth clears are masked by it
    gl.depthMask(true);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([1]));
  }

  drawSky(view: mat4, proj: mat4, camPos: vec3, sunDir: vec3): void {
    const gl = this.gl;
    mat4.multiply(this.invViewProj, proj, view);
    mat4.invert(this.invViewProj, this.invViewProj);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.skyProg);
    gl.uniformMatrix4fv(this.skyU.uInvViewProj, false, this.invViewProj);
    gl.uniform3fv(this.skyU.uCamPos, camPos);
    gl.uniform3fv(this.skyU.uSunDir, sunDir);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawWorld(
    mesh: Mesh,
    offset: vec3,
    view: mat4,
    proj: mat4,
    camPos: vec3,
    sunDir: vec3,
    fogStart: number,
    fogEnd: number,
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(this.worldProg);
    gl.uniformMatrix4fv(this.worldU.uView, false, view);
    gl.uniformMatrix4fv(this.worldU.uProj, false, proj);
    gl.uniform3fv(this.worldU.uOffset, offset);
    gl.uniform3fv(this.worldU.uCamPos, camPos);
    gl.uniform3fv(this.worldU.uSunDir, sunDir);
    gl.uniform1f(this.worldU.uFogStart, fogStart);
    gl.uniform1f(this.worldU.uFogEnd, fogEnd);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
  }

  /** Index-buffer passes (font) run between drawWorld and resolve with depth disabled. */
  beginOverlay(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
  }

  resolve(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.resolveProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.resolveU.uIndexTex, 0);
    gl.uniform1i(this.resolveU.uLut, 1);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}