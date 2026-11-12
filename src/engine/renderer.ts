import { mat4, vec3 } from 'gl-matrix';
import { createProgram, must, uniformMap, type Uniforms } from './gl';
import { LUT_TOTAL } from './palette';
import { DOWNSAMPLE_FS, FULLSCREEN_VS, POINTS_FS, POINTS_VS, RESOLVE_FS, SKY_FS, TREE_VS, WORLD_FS, WORLD_VS } from './shaders';

export interface Mesh {
  vao: WebGLVertexArrayObject;
  vertexCount: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  width = 0;
  height = 0;
  msaa = false;

  private fbo: WebGLFramebuffer;
  private indexTex: WebGLTexture;
  private depthRb: WebGLRenderbuffer;
  private overlayFbo: WebGLFramebuffer;
  private overlayTex: WebGLTexture;
  private colorFbo: WebGLFramebuffer;
  private colorTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private triVao: WebGLVertexArrayObject;

  private worldProg: WebGLProgram;
  private worldU: Uniforms;
  private treeProg: WebGLProgram;
  private treeU: Uniforms;
  private pointsProg: WebGLProgram;
  private pointsU: Uniforms;
  private skyProg: WebGLProgram;
  private skyU: Uniforms;
  private dsProg: WebGLProgram;
  private dsU: Uniforms;
  private resolveProg: WebGLProgram;
  private resolveU: Uniforms;

  private invViewProj = mat4.create();
  /** night: faces whose ramp carries a glow level are drawn street-lit (palette.ts GLOW_*) */
  nightGlow = false;

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
    this.overlayTex = must(gl.createTexture(), 'overlay texture');
    this.overlayFbo = must(gl.createFramebuffer(), 'overlay framebuffer');
    this.colorTex = must(gl.createTexture(), 'resolve color texture');
    this.colorFbo = must(gl.createFramebuffer(), 'resolve color framebuffer');
    this.lutTex = must(gl.createTexture(), 'LUT texture');
    for (const [tex, internal, format, type] of [
      [this.indexTex, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT],
      [this.overlayTex, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE],
      [this.colorTex, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      [this.lutTex, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    ] as [WebGLTexture, number, number, number][]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (tex === this.lutTex) gl.texImage2D(gl.TEXTURE_2D, 0, internal, 256, LUT_TOTAL / 256, 0, format, type, null);
    }

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
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd', 'uGlow',
    ]);
    this.treeProg = createProgram(gl, TREE_VS, WORLD_FS);
    this.treeU = uniformMap(gl, this.treeProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd', 'uGlow',
    ]);
    this.pointsProg = createProgram(gl, POINTS_VS, POINTS_FS);
    this.pointsU = uniformMap(gl, this.pointsProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uPointSize', 'uOn', 'uRound',
    ]);
    this.skyProg = createProgram(gl, FULLSCREEN_VS, SKY_FS);
    this.skyU = uniformMap(gl, this.skyProg, ['uInvViewProj', 'uCamPos', 'uSunDir', 'uMoonDir']);
    this.dsProg = createProgram(gl, FULLSCREEN_VS, DOWNSAMPLE_FS);
    this.dsU = uniformMap(gl, this.dsProg, ['uIndexTex', 'uLut']);
    this.resolveProg = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS);
    this.resolveU = uniformMap(gl, this.resolveProg, ['uIndexTex', 'uOverlayTex', 'uColorTex', 'uLut', 'uMsaa']);
  }

  /**
   * Q12: "MSAA" = 2x supersampled world pass. Integer targets cannot blend, so the
   * downsample averages LUT colors only where the four subsamples disagree; with the
   * toggle off the image stays strictly palette-indexed.
   */
  setMsaa(enabled: boolean): void {
    if (enabled === this.msaa) return;
    this.msaa = enabled;
    if (this.width > 0) this.alloc();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.alloc();
  }

  private alloc(): void {
    const gl = this.gl;
    const s = this.msaa ? 2 : 1;
    const w = this.width * s, h = this.height * s;
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.indexTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Index framebuffer incomplete');
    }

    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, this.width, this.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.overlayFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.overlayTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Overlay framebuffer incomplete');
    }

    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.colorFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Resolve color framebuffer incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  beginFrame(lut: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, LUT_TOTAL / 256, gl.RGBA, gl.UNSIGNED_BYTE, lut);

    const s = this.msaa ? 2 : 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width * s, this.height * s);
    // overlay passes leave depthMask false; depth clears are masked by it
    gl.depthMask(true);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([1]));
  }

  drawSky(view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, moonDir: vec3): void {
    const gl = this.gl;
    mat4.multiply(this.invViewProj, proj, view);
    mat4.invert(this.invViewProj, this.invViewProj);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.skyProg);
    gl.uniformMatrix4fv(this.skyU.uInvViewProj, false, this.invViewProj);
    gl.uniform3fv(this.skyU.uCamPos, camPos);
    gl.uniform3fv(this.skyU.uSunDir, sunDir);
    gl.uniform3fv(this.skyU.uMoonDir, moonDir);
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
    gl.uniform1i(this.worldU.uGlow, this.nightGlow ? 1 : 0);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
  }

  /** Q36: instanced cone trees (18 verts per cone, count instances). */
  drawTrees(
    vao: WebGLVertexArrayObject,
    count: number,
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
    gl.useProgram(this.treeProg);
    gl.uniformMatrix4fv(this.treeU.uView, false, view);
    gl.uniformMatrix4fv(this.treeU.uProj, false, proj);
    gl.uniform3fv(this.treeU.uOffset, offset);
    gl.uniform3fv(this.treeU.uCamPos, camPos);
    gl.uniform3fv(this.treeU.uSunDir, sunDir);
    gl.uniform1f(this.treeU.uFogStart, fogStart);
    gl.uniform1f(this.treeU.uFogEnd, fogEnd);
    gl.uniform1i(this.treeU.uGlow, this.nightGlow ? 1 : 0);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, count);
  }

  /** Q7: fixed-screen-size emissive points (or 1 px GL lines: vertex pairs); depth-tested but no depth writes. */
  drawLights(
    vao: WebGLVertexArrayObject,
    count: number,
    offset: vec3,
    view: mat4,
    proj: mat4,
    camPos: vec3,
    pointSize: number,
    on: boolean,
    mode: 'points' | 'lines' = 'points',
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.pointsProg);
    gl.uniform1i(this.pointsU.uRound, mode === 'points' ? 1 : 0);
    gl.uniformMatrix4fv(this.pointsU.uView, false, view);
    gl.uniformMatrix4fv(this.pointsU.uProj, false, proj);
    gl.uniform3fv(this.pointsU.uOffset, offset);
    gl.uniform3fv(this.pointsU.uCamPos, camPos);
    gl.uniform1f(this.pointsU.uPointSize, pointSize);
    gl.uniform1i(this.pointsU.uOn, on ? 1 : 0);
    gl.bindVertexArray(vao);
    gl.drawArrays(mode === 'points' ? gl.POINTS : gl.LINES, 0, count);
    gl.depthMask(true);
  }

  /** Index-buffer passes (font) run between drawWorld and resolve with depth disabled. */
  beginOverlay(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.viewport(0, 0, this.width, this.height);
    if (this.msaa) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.colorFbo);
      gl.useProgram(this.dsProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(this.dsU.uIndexTex, 0);
      gl.uniform1i(this.dsU.uLut, 1);
      gl.bindVertexArray(this.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // overlay index 0 is the "transparent" sentinel: HUD/menu ramps never use it
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.overlayFbo);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
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
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.uniform1i(this.resolveU.uIndexTex, 0);
    gl.uniform1i(this.resolveU.uLut, 1);
    gl.uniform1i(this.resolveU.uOverlayTex, 2);
    gl.uniform1i(this.resolveU.uColorTex, 3);
    gl.uniform1i(this.resolveU.uMsaa, this.msaa ? 1 : 0);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}