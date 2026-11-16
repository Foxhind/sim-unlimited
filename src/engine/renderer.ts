import { mat4, vec3, vec4 } from 'gl-matrix';
import { createProgram, must, uniformMap, type Uniforms } from './gl';
import { LUT_ENTRIES, type LightUniforms } from './palette';
import { NO_RIM, type RimFrame } from './rim';
import { FULLSCREEN_VS, POINTS_FS, POINTS_VS, RESOLVE_FS, SKY_FS, TREE_VS, WORLD_FS, WORLD_POST_FS, WORLD_VS } from './shaders';

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
  /** the world in RGB (2x supersampled with msaa) */
  private worldTex: WebGLTexture;
  /** the world's depth (log depth, LOG_DEPTH_FS), a texture so the silhouette rim can read it */
  private depthTex: WebGLTexture;
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
  private viewProj = mat4.create();
  /** this frame's sun direction and fog (drawSky), for the silhouette rim */
  private sunDir = vec3.create();
  private fog = new Float32Array(2);
  /** the world went through the post pass into colorTex this frame (beginOverlay) */
  private posted = false;
  /** lighting of RGB face colours this frame (beginFrame) */
  private light: LightUniforms | undefined;
  /** night: faces whose ramp carries a glow level are drawn street-lit (palette.ts GLOW_*) */
  nightGlow = false;
  /** winter: faces flagged SNOW_FLAG are drawn in snow (palette.ts) */
  snow = false;
  /** far plane of an orthographic projection (near 0); 0 = perspective (see ORTHO_VS) */
  orthoFar = 0;
  /** rim light this frame (rim.ts rimFrame) */
  rim: RimFrame = NO_RIM;
  /** weight of the rim light for what drawWorld draws next (rim.ts: terrain, objects, aircraft; 0: none) */
  rimWeight = 1;
  /** weight of the rim light for trees (drawTrees) */
  rimTreeWeight = 1;
  /**
   * two-sided lighting for what drawWorld draws next: a face seen from behind is lit by its visible
   * side's normal (false: the flame, whose normals are set toward the sun to keep it bright)
   */
  twoSided = true;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    this.worldTex = must(gl.createTexture(), 'world texture');
    this.depthTex = must(gl.createTexture(), 'depth texture');
    this.fbo = must(gl.createFramebuffer(), 'world framebuffer');
    this.overlayTex = must(gl.createTexture(), 'overlay texture');
    this.overlayFbo = must(gl.createFramebuffer(), 'overlay framebuffer');
    this.colorTex = must(gl.createTexture(), 'resolve color texture');
    this.colorFbo = must(gl.createFramebuffer(), 'resolve color framebuffer');
    this.lutTex = must(gl.createTexture(), 'LUT texture');
    for (const [tex, internal, format, type] of [
      [this.worldTex, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      [this.overlayTex, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE],
      [this.colorTex, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      [this.lutTex, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      [this.depthTex, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT],
    ] as [WebGLTexture, number, number, number][]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (tex === this.lutTex) gl.texImage2D(gl.TEXTURE_2D, 0, internal, 256, LUT_ENTRIES / 256, 0, format, type, null);
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
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd', 'uGlow', 'uSnow', 'uCoarse', 'uOrthoFar',
      'uLut', 'uLight', 'uHaze', 'uSat', 'uRim', 'uRimSteps', 'uRimColor', 'uTwoSided',
    ]);
    this.treeProg = createProgram(gl, TREE_VS, WORLD_FS);
    this.treeU = uniformMap(gl, this.treeProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd', 'uGlow', 'uSnow', 'uOrthoFar',
      'uLut', 'uLight', 'uHaze', 'uSat', 'uRim', 'uRimSteps', 'uRimColor', 'uTwoSided',
    ]);
    this.pointsProg = createProgram(gl, POINTS_VS, POINTS_FS);
    this.pointsU = uniformMap(gl, this.pointsProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uPointSize', 'uOn', 'uRound', 'uOrthoFar', 'uStackH', 'uPull',
      'uLut', 'uLight', 'uHaze', 'uSat',
    ]);
    this.skyProg = createProgram(gl, FULLSCREEN_VS, SKY_FS);
    this.skyU = uniformMap(gl, this.skyProg, [
      'uInvViewProj', 'uCamPos', 'uSunDir', 'uMoonDir', 'uLut', 'uLight', 'uHaze', 'uSat', 'uGlow', 'uSnow', 'uSunGlow',
      'uGroundH', 'uGroundRamp', 'uLightDir', 'uFogStart', 'uFogEnd',
    ]);
    this.dsProg = createProgram(gl, FULLSCREEN_VS, WORLD_POST_FS);
    this.dsU = uniformMap(gl, this.dsProg, [
      'uWorldTex', 'uDepthTex', 'uScale', 'uOutline', 'uRimSteps', 'uRimColor', 'uSunDir', 'uViewProj', 'uInvViewProj', 'uFogStart', 'uFogEnd',
    ]);
    this.resolveProg = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS);
    this.resolveU = uniformMap(gl, this.resolveProg, ['uWorldTex', 'uOverlayTex', 'uColorTex', 'uLut', 'uMsaa']);
    // the LUT lives on its own texture unit for the whole frame
    for (const [prog, u] of [
      [this.worldProg, this.worldU], [this.treeProg, this.treeU], [this.pointsProg, this.pointsU],
      [this.skyProg, this.skyU], [this.resolveProg, this.resolveU],
    ] as [WebGLProgram, Uniforms][]) {
      gl.useProgram(prog);
      gl.uniform1i(u.uLut, LUT_UNIT);
    }
  }

  /** Q12: "MSAA" = 2x supersampled world pass, averaged 2×2 down to the screen. */
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
    gl.bindTexture(gl.TEXTURE_2D, this.worldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.worldTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('World framebuffer incomplete');
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

  /** `lut`: material ramps, sky, lights and overlay colours (buildLUT); `light`: how RGB face colours are lit (lightUniforms) */
  beginFrame(lut: Uint8Array, light: LightUniforms): void {
    const gl = this.gl;
    this.light = light;
    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, LUT_ENTRIES / 256, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.activeTexture(gl.TEXTURE0);

    const s = this.msaa ? 2 : 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width * s, this.height * s);
    // overlay passes leave depthMask false; depth clears are masked by it
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 1]));
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([1]));
  }

  /**
   * Sky, sun and moon, and below the horizon the base ground (SKY_FS): a plain surface of one face
   * colour at height `ground.y`, shaded and fogged like terrain, so there is a horizon and a ground
   * whether or not the tiles have loaded. Terrain drawn afterwards covers it.
   */
  drawSky(view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, moonDir: vec3, ground: BaseGround): void {
    const gl = this.gl;
    mat4.multiply(this.viewProj, proj, view);
    mat4.invert(this.invViewProj, this.viewProj);
    vec3.copy(this.sunDir, sunDir);
    this.fog[0] = ground.fogStart;
    this.fog[1] = ground.fogEnd;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.skyProg);
    gl.uniformMatrix4fv(this.skyU.uInvViewProj, false, this.invViewProj);
    gl.uniform3fv(this.skyU.uCamPos, camPos);
    gl.uniform3fv(this.skyU.uSunDir, sunDir);
    gl.uniform3fv(this.skyU.uMoonDir, moonDir);
    gl.uniform1f(this.skyU.uGroundH, Math.max(1, camPos[1] - ground.y));
    gl.uniform1ui(this.skyU.uGroundRamp, ground.ramp >>> 0);
    gl.uniform3fv(this.skyU.uLightDir, ground.lightDir);
    gl.uniform1f(this.skyU.uFogStart, ground.fogStart);
    gl.uniform1f(this.skyU.uFogEnd, ground.fogEnd);
    gl.uniform1i(this.skyU.uGlow, 0);
    gl.uniform1i(this.skyU.uSnow, this.snow ? 1 : 0);
    this.setLight(this.skyU);
    gl.uniform1f(this.skyU.uSunGlow, this.light?.sunGlow ?? 0);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawWorld(
    mesh: Mesh,
    /** xyz: position in the world; w: yaw of the mesh frame (0 when absent) */
    offset: vec3 | vec4,
    view: mat4,
    proj: mat4,
    camPos: vec3,
    sunDir: vec3,
    fogStart: number,
    fogEnd: number,
    /** terrain tiles: edges (bits 1 n, 2 s, 4 w, 8 e) stitched to a coarser neighbour */
    coarse = 0,
    /** false: depth-tested but leaves no depth (OSM water, so roads drawn later always show over it) */
    depthWrite = true,
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(depthWrite);
    gl.useProgram(this.worldProg);
    gl.uniform1i(this.worldU.uCoarse, coarse);
    gl.uniform1f(this.worldU.uOrthoFar, this.orthoFar);
    gl.uniformMatrix4fv(this.worldU.uView, false, view);
    gl.uniformMatrix4fv(this.worldU.uProj, false, proj);
    setPlacement(gl, this.worldU.uOffset, offset);
    gl.uniform3fv(this.worldU.uCamPos, camPos);
    gl.uniform3fv(this.worldU.uSunDir, sunDir);
    gl.uniform1f(this.worldU.uFogStart, fogStart);
    gl.uniform1f(this.worldU.uFogEnd, fogEnd);
    gl.uniform1i(this.worldU.uGlow, this.nightGlow ? 1 : 0);
    gl.uniform1i(this.worldU.uSnow, this.snow ? 1 : 0);
    this.setLight(this.worldU);
    this.setRim(this.worldU, this.rimWeight);
    gl.uniform1i(this.worldU.uTwoSided, this.twoSided ? 1 : 0);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
    if (!depthWrite) gl.depthMask(true);
  }

  /** Q36: instanced trees of one type: its `vertexCount` geometry vertices from `first`, `count` instances. */
  drawTrees(
    vao: WebGLVertexArrayObject,
    count: number,
    first: number,
    vertexCount: number,
    /** xyz: position in the world; w: yaw of the mesh frame (0 when absent) */
    offset: vec3 | vec4,
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
    gl.uniform1f(this.treeU.uOrthoFar, this.orthoFar);
    gl.uniformMatrix4fv(this.treeU.uView, false, view);
    gl.uniformMatrix4fv(this.treeU.uProj, false, proj);
    setPlacement(gl, this.treeU.uOffset, offset);
    gl.uniform3fv(this.treeU.uCamPos, camPos);
    gl.uniform3fv(this.treeU.uSunDir, sunDir);
    gl.uniform1f(this.treeU.uFogStart, fogStart);
    gl.uniform1f(this.treeU.uFogEnd, fogEnd);
    gl.uniform1i(this.treeU.uGlow, this.nightGlow ? 1 : 0);
    gl.uniform1i(this.treeU.uSnow, this.snow ? 1 : 0);
    this.setLight(this.treeU);
    this.setRim(this.treeU, this.rimTreeWeight);
    gl.uniform1i(this.treeU.uTwoSided, 1);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, first, vertexCount, count);
  }

  /** Q7: fixed-screen-size emissive points (or 1 px GL lines: vertex pairs); depth-tested but no depth writes. */
  drawLights(
    vao: WebGLVertexArrayObject,
    count: number,
    /** xyz: position in the world; w: yaw of the mesh frame (0 when absent) */
    offset: vec3 | vec4,
    view: mat4,
    proj: mat4,
    camPos: vec3,
    pointSize: number,
    on: boolean,
    mode: 'points' | 'lines' = 'points',
    /** far building dots: square, each roof point stacked on screen over its wall point (building-mesher buildingDots) */
    stacked = false,
    /** pull toward the eye, metres: [constant, per metre of distance] (POINTS_VS uPull) */
    pull: readonly [number, number] = [0, 0],
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.pointsProg);
    gl.uniform1i(this.pointsU.uRound, mode === 'points' && !stacked ? 1 : 0);
    const fbHeight = this.height * (this.msaa ? 2 : 1);
    gl.uniform1f(this.pointsU.uStackH, stacked ? fbHeight : 0);
    gl.uniform2f(this.pointsU.uPull, pull[0], pull[1]);
    gl.uniform1f(this.pointsU.uOrthoFar, this.orthoFar);
    gl.uniformMatrix4fv(this.pointsU.uView, false, view);
    gl.uniformMatrix4fv(this.pointsU.uProj, false, proj);
    setPlacement(gl, this.pointsU.uOffset, offset);
    gl.uniform3fv(this.pointsU.uCamPos, camPos);
    gl.uniform1f(this.pointsU.uPointSize, pointSize);
    gl.uniform1i(this.pointsU.uOn, on ? 1 : 0);
    this.setLight(this.pointsU);
    gl.bindVertexArray(vao);
    gl.drawArrays(mode === 'points' ? gl.POINTS : gl.LINES, 0, count);
    gl.depthMask(true);
  }

  /** Overlay passes (font, vectors: 8-bit palette indices) run between drawWorld and resolve with depth disabled. */
  beginOverlay(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.viewport(0, 0, this.width, this.height);
    // the silhouette rim reads perspective log depth: none in orthographic views
    const outline = this.orthoFar === 0 && this.rim.outline[0] > 0;
    this.posted = this.msaa || outline;
    if (this.posted) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.colorFbo);
      gl.useProgram(this.dsProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.worldTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.dsU.uWorldTex, 0);
      gl.uniform1i(this.dsU.uDepthTex, 1);
      gl.uniform1i(this.dsU.uScale, this.msaa ? 2 : 1);
      gl.uniform4fv(this.dsU.uOutline, outline ? this.rim.outline : NO_RIM.outline);
      gl.uniform1f(this.dsU.uRimSteps, this.rim.steps);
      gl.uniform3fv(this.dsU.uRimColor, this.rim.colour);
      gl.uniform3fv(this.dsU.uSunDir, this.sunDir);
      gl.uniformMatrix4fv(this.dsU.uViewProj, false, this.viewProj);
      gl.uniformMatrix4fv(this.dsU.uInvViewProj, false, this.invViewProj);
      gl.uniform1f(this.dsU.uFogStart, this.fog[0]);
      gl.uniform1f(this.dsU.uFogEnd, this.fog[1]);
      gl.bindVertexArray(this.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // the depth texture is the world's attachment again next frame: no sampler may keep it bound
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
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
    gl.bindTexture(gl.TEXTURE_2D, this.worldTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.uniform1i(this.resolveU.uWorldTex, 0);
    gl.uniform1i(this.resolveU.uOverlayTex, 2);
    gl.uniform1i(this.resolveU.uColorTex, 3);
    gl.uniform1i(this.resolveU.uMsaa, this.posted ? 1 : 0);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  private rimShape = new Float32Array(4);

  private setRim(u: Uniforms, weight: number): void {
    const r = this.rim;
    this.rimShape.set(r.shape);
    this.rimShape[0] *= weight;
    this.gl.uniform4fv(u.uRim, this.rimShape);
    this.gl.uniform1f(u.uRimSteps, r.steps);
    this.gl.uniform3fv(u.uRimColor, r.colour);
  }

  private setLight(u: Uniforms): void {
    if (!this.light) return;
    this.gl.uniform3fv(u.uLight, this.light.levels);
    this.gl.uniform3fv(u.uHaze, this.light.haze);
    this.gl.uniform1f(u.uSat, this.light.saturation);
  }
}

/** the base ground under the tiles (drawSky) */
export interface BaseGround {
  /** its height in world y (m above sea level) */
  y: number;
  /** face colour (palette.ts): sea, or land (with the snow flag) */
  ramp: number;
  /** direction the terrain is lit from */
  lightDir: vec3;
  fogStart: number;
  fogEnd: number;
}

/** texture unit the LUT stays bound to */
const LUT_UNIT = 5;

/** uOffset (see PLACE_VS): a vec3 offset places a mesh without turning it */
function setPlacement(gl: WebGL2RenderingContext, loc: WebGLUniformLocation | null, offset: vec3 | vec4): void {
  gl.uniform4f(loc, offset[0], offset[1], offset[2], offset.length > 3 ? (offset as vec4)[3] : 0);
}
