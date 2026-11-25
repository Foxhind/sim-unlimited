import { mat4, vec3, vec4 } from 'gl-matrix';
import { createProgram, must, uniformMap, type Uniforms } from './gl';
import { FAR_WINDOWS, LUT_ENTRIES, WINDOWS, type LightUniforms } from './palette';
import { NO_RIM, type RimFrame } from './rim';
import { XdrTrigger } from './xdr-trigger';
import { hdrBlocker, hdrDisplayQuery, outputMode, type HdrBlocker, type HdrConditions, type OutputMode } from './output-mode';
import { AIR_HAZE, FULLSCREEN_VS, POINTS_FS, POINTS_VS, PRECIP_FS, PRECIP_VS, RESOLVE_FS, SHADOW_FS, SHADOW_TREE_VS, SHADOW_VS, SKY_FS, STARS_FS, STARS_VS, TREE_VS, VEIL_FS, WORLD_FS, WORLD_POST_FS, WORLD_VS } from './shaders';

export interface Mesh {
  vao: WebGLVertexArrayObject;
  vertexCount: number;
  /** the first vertex drawn (0 when absent): a run of a shared VAO */
  first?: number;
}

/** wireframe of the world's faces (renderer.wire): edges over faces filled in one colour */
export interface Wireframe {
  /** edges in each face's own colour, or all in `color` */
  mode: 'object' | 'mono';
  /** the edges in 'mono', RGB 0..1 as the face colours (what WORLD_FS writes) */
  color: [number, number, number];
  /** the faces' fill, RGB 0..1 */
  fill: [number, number, number];
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

  /** the world shader's variants (WorldVariant), each a program and its uniforms */
  private world: Record<WorldVariant, { prog: WebGLProgram; u: Uniforms }>;
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
  private veilProg: WebGLProgram;
  private precipProg: WebGLProgram;
  private precipU: Uniforms;
  private precipVao: WebGLVertexArrayObject;
  private veilU: Uniforms;
  private starsProg: WebGLProgram;
  private starsU: Uniforms;
  private starsVao: WebGLVertexArrayObject;
  private starsBuf: WebGLBuffer;
  private starsCount = 0;
  /** what drawSky drew this frame, for drawStars: moon, ground height, overcast decks above / below */
  private skyMoon = vec3.create();
  private skyCover = new Float32Array(3);

  /** sun shadows (beginShadows): the depth map seen from the sun, its framebuffer and casters' programs */
  private shadowTex: WebGLTexture;
  private shadowFbo: WebGLFramebuffer;
  private shadowProg: WebGLProgram;
  private shadowU: Uniforms;
  private shadowTreeProg: WebGLProgram;
  private shadowTreeU: Uniforms;
  /** world → the shadow map's clip space this frame (SHADOW_CLIP_GLSL) */
  private shadowMat = mat4.create();
  private shadowView = mat4.create();
  private shadowProj = mat4.create();
  /** the shadow box's half-width this frame, m */
  private shadowR = 0;
  /** the shadow box's centre on the ground this frame (world, m): casters tested against it take its height */
  readonly shadowGround = vec3.create();
  /** the shadow map holds this frame's casters: the world passes take shadows */
  private shadowsOn = false;
  /** shadows wanted at all (settings) */
  shadows = true;

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
  /** latitude of the world origin, degrees: the shaders take each face's climate from it (snow, ice) */
  originLat = 0;
  /** season factor of the sim date (palette.ts seasonOf; 0: the annual mean) */
  season = 0;
  /** seconds, for the glitter path's flicker (GLITTER_GLSL) */
  time = 0;
  /** far plane of an orthographic projection (near 0); 0 = perspective (see ORTHO_VS) */
  orthoFar = 0;
  /** rim light this frame (rim.ts rimFrame) */
  rim: RimFrame = NO_RIM;
  /** weight of the rim light for what drawWorld draws next (rim.ts: terrain, buildings (objects), aircraft; 0: none) */
  rimWeight = 1;
  /** weight of the rim light for trees (drawTrees) */
  rimTreeWeight = 1;
  /**
   * what drawWorld draws next takes the silhouette rim (WORLD_POST_FS): buildings and aircraft only;
   * everything else (terrain, roads, water, areas, trees, clouds) is marked off with alpha 0
   */
  outlined = false;
  /**
   * what drawWorld draws next lights itself (the exhaust flame, aircraft lights): no rim light of
   * either kind (its pixels are marked with alpha 0 for the silhouette pass) and no two-sided flip
   * (the flame's normals are set toward the sun to keep it bright)
   */
  selfLit = false;
  /**
   * brightness of what drawWorld draws next while selfLit, × SDR white (HDR only: see emission).
   * Set from emission('flame') / emission('aircraftLights').
   */
  selfLitGain = 1;
  /**
   * what drawWorld draws next is see-through (a turning propeller's disc): blended over what is behind
   * at this opacity, leaving no depth. The target's alpha (the silhouette pass's marks) is kept.
   */
  opacity = 1;
  /** what drawWorld draws next adds its light to what is behind (glints), leaving no depth */
  additive = false;
  /**
   * what drawWorld draws next is glass (greenhouses): 0..1 of the sun's glint where a face mirrors
   * it to the eye, and of the sky's sheen toward grazing angles (WORLD_FS uGloss); 0 for any other mesh
   */
  gloss = 0;
  /**
   * windows on what drawWorld draws next (a building mesh with facade attributes, WORLD_FS):
   * 'glass' dark panes, 'lit' at night with some of them lit, 'off' for every other mesh
   */
  windows: 'off' | 'glass' | 'lit' = 'off';
  /** rare lighter dots on what drawWorld draws next (WORLD_FS uSpeckle): the terrain and OSM areas */
  speckle = false;
  /** what drawWorld draws next has no water, dots, road marks or windows (clouds): a lighter shader */
  bare = false;
  /** the world's faces and trees as an opaque wireframe (relief inspector); undefined: shaded as usual */
  wire?: Wireframe;
  /** the device pixel ratio the canvas was last sized for (resize) */
  private dpr = 1;
  /** the share of windows lit at night now (palette.ts litShare by the local hour) */
  litShare: number = WINDOWS.LIT_SHARE;
  /** the facade cell width of the far window dots drawLights draws next (palette.ts FAR_WINDOWS; the far OSM ring sets its own) */
  windowCellM: number = FAR_WINDOWS.CELL_M;
  /** the fog range (metres) the far window dots drawLights draws next run into the haze over; none by default */
  pointFog: readonly [number, number] = [1e9, 2e9];
  /** the air's haze density at sea level, per metre (shaders.ts AIR_HAZE; 0: none) */
  hazeDensity: number = AIR_HAZE.DEFAULT_DENSITY;
  /** the haze this frame: none in an orthographic view, which has no single distance to the ground */
  private hazeK(): number {
    return this.orthoFar > 0 ? 0 : this.hazeDensity;
  }
  /**
   * Experimental XDR output: the canvas drawing buffer is RGBA16F (WebGL drawingBufferStorage;
   * extended drawingBufferToneMapping where the browser has it), the world and post targets are
   * half-float, and light sources (aircraft lights, the exhaust flame, the sun, city lights) are
   * written above 1.0 so an HDR display shows them brighter than paper white. Everything else stays
   * in 0..1 and looks as before.
   */
  readonly hdrSupported: boolean;
  /** depth is reversed-Z, written by the vertex shaders (EXT_clip_control; shaders.ts LOG_DEPTH_FS) */
  readonly reversedZ: boolean;
  /** XDR is on (output 'hdr'): buffers are half-float and light sources are written above 1.0 */
  hdr = false;
  private hdrWanted = false;
  /** the screen shows HDR now (output-mode.ts); followed as it changes */
  private hdrDisplay = false;
  /** puts the page in HDR mode where WebGL has no extended tone mapping (xdr-trigger.ts) */
  private trigger: XdrTrigger | null = null;
  private triggerPending = false;
  private triggerFailed = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      // drawingBufferStorage (XDR) needs an RGBA drawing buffer; the resolve pass writes alpha 1
      alpha: true,
      depth: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const hdrGl = gl as HdrGl;
    // drawingBufferToneMapping is optional: Chrome (156) has none on WebGL, yet shows an RGBA16F
    // drawing buffer above SDR white on an XDR display
    this.hdrSupported = typeof hdrGl.drawingBufferStorage === 'function'
      && gl.getExtension('EXT_color_buffer_float') !== null;
    // reversed-Z (shaders.ts LOG_DEPTH_FS): clip depth 0..1, a float depth buffer cleared to 0, GREATER
    const clip = gl.getExtension('EXT_clip_control') as ClipControl | null;
    this.reversedZ = clip !== null;
    if (clip) {
      clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.ZERO_TO_ONE_EXT);
      gl.depthFunc(gl.GREATER);
    }
    const q = hdrDisplayQuery();
    this.hdrDisplay = q?.matches ?? false;
    q?.addEventListener('change', (e) => { this.hdrDisplay = e.matches; this.updateHdr(); });
    const depthed = (src: string, defines: readonly string[] = []) => {
      const defs = [...(this.reversedZ ? ['REVERSED_Z'] : []), ...defines].map((d) => `#define ${d} 1\n`).join('');
      return src.replace('#version 300 es\n', `#version 300 es\n${defs}`);
    };

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

    const worldNames = [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd', 'uHazeK', 'uGlow', 'uOriginLat', 'uSeason', 'uCoarse', 'uOrthoFar',
      'uLut', 'uLight', 'uHaze', 'uSat', 'uRim', 'uRimSteps', 'uRimColor', 'uTwoSided', 'uSelfLit', 'uOutlined', 'uEmit', 'uClear', 'uGloss', 'uWindows', 'uWinEmit', 'uLitShare', 'uSpeckle', ...WIRE_UNIFORMS, ...GLITTER_UNIFORMS, ...SUNLIGHT_UNIFORMS, ...SHADOW_UNIFORMS,
    ];
    const worldVariant = (v: WorldVariant) => {
      const prog = createProgram(gl, depthed(WORLD_VS), depthed(WORLD_FS, WORLD_VARIANTS[v]));
      return { prog, u: uniformMap(gl, prog, worldNames) };
    };
    this.world = { full: worldVariant('full'), ground: worldVariant('ground'), houses: worldVariant('houses'), bare: worldVariant('bare') };
    // trees have none of the surface effects
    this.treeProg = createProgram(gl, depthed(TREE_VS), depthed(WORLD_FS, WORLD_VARIANTS.bare));
    this.treeU = uniformMap(gl, this.treeProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uSunDir', 'uFogStart', 'uFogEnd', 'uHazeK', 'uGlow', 'uOriginLat', 'uSeason', 'uOrthoFar',
      'uLut', 'uLight', 'uHaze', 'uSat', 'uRim', 'uRimSteps', 'uRimColor', 'uTwoSided', 'uOutlined', 'uThinCount', ...WIRE_UNIFORMS, ...GLITTER_UNIFORMS, ...SUNLIGHT_UNIFORMS, ...SHADOW_UNIFORMS,
    ]);
    this.pointsProg = createProgram(gl, depthed(POINTS_VS), depthed(POINTS_FS));
    this.pointsU = uniformMap(gl, this.pointsProg, [
      'uView', 'uProj', 'uOffset', 'uCamPos', 'uPointSize', 'uOn', 'uRound', 'uOrthoFar', 'uStackH', 'uPull', 'uLitShare', 'uFbH', 'uCell', 'uFogStart', 'uFogEnd', 'uHazeK',
      'uLut', 'uLight', 'uHaze', 'uSat', 'uEmit',
    ]);
    this.skyProg = createProgram(gl, FULLSCREEN_VS, SKY_FS);
    this.skyU = uniformMap(gl, this.skyProg, [
      'uInvViewProj', 'uCamPos', 'uSunDir', 'uMoonDir', 'uLut', 'uLight', 'uHaze', 'uSat', 'uGlow', 'uOriginLat', 'uSeason',
      'uGroundH', 'uGroundRamp', 'uFogStart', 'uFogEnd', 'uHazeK', 'uSunEmit', 'uMoonEmit', 'uDeckUp', 'uDeckDown', 'uDeckColour', ...GLITTER_UNIFORMS, ...SUNLIGHT_UNIFORMS,
    ]);
    this.dsProg = createProgram(gl, FULLSCREEN_VS, depthed(WORLD_POST_FS));
    this.dsU = uniformMap(gl, this.dsProg, [
      'uWorldTex', 'uDepthTex', 'uScale', 'uOutline', 'uRimSteps', 'uRimColor', 'uSunDir', 'uViewProj', 'uInvViewProj', 'uFogStart', 'uFogEnd', 'uHazeK',
    ]);
    this.veilProg = createProgram(gl, FULLSCREEN_VS, VEIL_FS);
    this.veilU = uniformMap(gl, this.veilProg, ['uDensity', 'uColor', 'uScale']);
    this.precipProg = createProgram(gl, depthed(PRECIP_VS), depthed(PRECIP_FS));
    this.precipU = uniformMap(gl, this.precipProg, ['uView', 'uProj', 'uCamPos', 'uOffset', 'uStreak', 'uBox', 'uScreen', 'uColor', 'uOrthoFar']);
    // a quad a particle (strip), and every particle's fixed random place in its cube
    this.precipVao = must(gl.createVertexArray(), 'precipitation VAO');
    gl.bindVertexArray(this.precipVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, must(gl.createBuffer(), 'precipitation quad'));
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const seeds = new Float32Array(PRECIP_MAX * 3);
    let rnd = 0x9e3779b9 | 0;
    for (let i = 0; i < seeds.length; i++) {
      rnd = (Math.imul(rnd, 1664525) + 1013904223) | 0;
      seeds[i] = (rnd >>> 8) / 16777216;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, must(gl.createBuffer(), 'precipitation seeds'));
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.starsProg = createProgram(gl, STARS_VS, STARS_FS);
    this.starsU = uniformMap(gl, this.starsProg, [
      'uSky', 'uViewProj', 'uSunDir', 'uMoonDir', 'uLimit', 'uPx', 'uGroundH', 'uDeckUp', 'uDeckDown',
    ]);
    this.starsVao = must(gl.createVertexArray(), 'stars VAO');
    this.starsBuf = must(gl.createBuffer(), 'stars buffer');
    gl.bindVertexArray(this.starsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starsBuf);
    for (const [loc, size, at] of [[0, 3, 0], [1, 1, 3], [2, 3, 4]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 7 * 4, at * 4);
    }
    gl.bindVertexArray(null);
    this.resolveProg = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS);
    this.resolveU = uniformMap(gl, this.resolveProg, ['uWorldTex', 'uOverlayTex', 'uColorTex', 'uLut', 'uMsaa']);
    // the LUT lives on its own texture unit for the whole frame
    for (const [prog, u] of [
      ...Object.values(this.world).map((w): [WebGLProgram, Uniforms] => [w.prog, w.u]), [this.treeProg, this.treeU], [this.pointsProg, this.pointsU],
      [this.skyProg, this.skyU], [this.resolveProg, this.resolveU],
    ] as [WebGLProgram, Uniforms][]) {
      gl.useProgram(prog);
      gl.uniform1i(u.uLut, LUT_UNIT);
    }

    // sun shadows: a float depth map, compared in hardware (sampler2DShadow), on its own unit
    this.shadowTex = must(gl.createTexture(), 'shadow map');
    gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, SHADOW_SIZE, SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, this.reversedZ ? gl.GEQUAL : gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    this.shadowFbo = must(gl.createFramebuffer(), 'shadow framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Shadow framebuffer incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowProg = createProgram(gl, depthed(SHADOW_VS), depthed(SHADOW_FS));
    this.shadowU = uniformMap(gl, this.shadowProg, ['uShadowMat', 'uOffset', 'uCamPos', 'uCoarse']);
    this.shadowTreeProg = createProgram(gl, depthed(SHADOW_TREE_VS), depthed(SHADOW_FS));
    this.shadowTreeU = uniformMap(gl, this.shadowTreeProg, ['uShadowMat', 'uOffset', 'uCamPos', 'uThinCount']);
    for (const { prog, u } of [...Object.values(this.world), { prog: this.treeProg, u: this.treeU }]) {
      gl.useProgram(prog);
      gl.uniform1i(u.uShadowMap, SHADOW_UNIT);
    }
  }

  /**
   * Sun shadows, step 1 of 3, before beginFrame: fit the shadow map round `ground` (a point on the
   * ground near the camera) for the sun in `sunDir`, and start drawing casters into it (shadowMesh,
   * shadowTrees). The box's half-width grows with the camera's height over that ground, in steps
   * (so the shadows do not crawl as it changes), and its centre snaps to whole texels. Returns
   * false (and the world takes no shadows this frame) when shadows are off or the sun is down.
   */
  beginShadows(camPos: vec3, groundY: number, view: mat4, sunDir: vec3): boolean {
    this.shadowsOn = false;
    if (!this.shadows || this.orthoFar > 0 || sunDir[1] < SHADOW_MIN_SUN_Y) return false;
    const gl = this.gl;
    const agl = Math.max(0, camPos[1] - groundY);
    const want = Math.min(SHADOW_MAX_R, Math.max(SHADOW_MIN_R, SHADOW_R_PER_AGL * agl + SHADOW_MIN_R));
    // half-width in steps of √2 from the smallest
    this.shadowR = SHADOW_MIN_R * Math.SQRT2 ** Math.ceil(Math.log(want / SHADOW_MIN_R) / Math.log(Math.SQRT2) - 1e-6);
    const r = this.shadowR;
    // the ground under the camera, moved SHADOW_AHEAD of the half-width the way it looks
    const fx = -view[2], fz = -view[10];
    const fl = Math.hypot(fx, fz);
    const ahead = fl > 1e-3 ? (SHADOW_AHEAD * r) / fl : 0;
    const ground = vec3.set(this.shadowGround, camPos[0] + fx * ahead, groundY, camPos[2] + fz * ahead);
    // the sun's view: looking down the sun's rays at the world origin, then the centre snapped there
    const up = Math.abs(sunDir[1]) > 0.99 ? vec3.fromValues(0, 0, -1) : vec3.fromValues(0, 1, 0);
    const eye = vec3.create();
    mat4.lookAt(this.shadowView, eye, vec3.negate(vec3.create(), sunDir), up);
    const c = vec3.transformMat4(vec3.create(), ground, this.shadowView);
    const texel = (2 * r) / SHADOW_SIZE;
    const cx = Math.round(c[0] / texel) * texel, cy = Math.round(c[1] / texel) * texel;
    // view space looks down −z: the box runs SHADOW_DEPTH_M toward the sun and away from it round the centre
    mat4.ortho(this.shadowProj, cx - r, cx + r, cy - r, cy + r, -c[2] - SHADOW_DEPTH_M, -c[2] + SHADOW_DEPTH_M);
    mat4.multiply(this.shadowMat, this.shadowProj, this.shadowView);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.depthMask(true);
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([this.reversedZ ? 0 : 1]));
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    // casters' faces from both sides (thin plates, open meshes), pushed back by their slope
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(this.reversedZ ? -SHADOW_SLOPE : SHADOW_SLOPE, 0);
    for (const [prog, u] of [[this.shadowProg, this.shadowU], [this.shadowTreeProg, this.shadowTreeU]] as [WebGLProgram, Uniforms][]) {
      gl.useProgram(prog);
      gl.uniformMatrix4fv(u.uShadowMat, false, this.shadowMat);
      gl.uniform3fv(u.uCamPos, camPos);
    }
    return true;
  }

  /** the shadow map's texel this frame, m (0: no shadows) */
  get shadowTexel(): number { return this.shadowR > 0 ? (2 * this.shadowR) / SHADOW_SIZE : 0; }

  /** a caster round `center` (m, world) within `radius` falls on the shadow map this frame */
  shadowSees(center: vec3, radius: number): boolean {
    const v = this.shadowView, p = this.shadowProj;
    // the box's centre and half-width in the sun's view (ortho: x = (2·vx − (r+l)) / (r − l))
    const vx = v[0] * center[0] + v[4] * center[1] + v[8] * center[2] + v[12];
    const vy = v[1] * center[0] + v[5] * center[1] + v[9] * center[2] + v[13];
    const sx = p[0], sy = p[5];
    return Math.abs(vx * sx + p[12]) <= 1 + radius * sx && Math.abs(vy * sy + p[13]) <= 1 + radius * sy;
  }

  /** Sun shadows, step 2: a mesh drawn as drawWorld places it (`coarse`: terrain edges stitched). */
  shadowMesh(mesh: Mesh, offset: vec3 | vec4, coarse = 0): void {
    const gl = this.gl;
    gl.useProgram(this.shadowProg);
    setPlacement(gl, this.shadowU.uOffset, offset);
    gl.uniform1i(this.shadowU.uCoarse, coarse);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, mesh.first ?? 0, mesh.vertexCount);
  }

  /** Sun shadows, step 2: instanced trees, as drawTrees draws them. */
  shadowTrees(vao: WebGLVertexArrayObject, count: number, first: number, vertexCount: number, offset: vec3 | vec4, thinCount = 0): void {
    const gl = this.gl;
    gl.useProgram(this.shadowTreeProg);
    setPlacement(gl, this.shadowTreeU.uOffset, offset);
    gl.uniform1f(this.shadowTreeU.uThinCount, thinCount);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, first, vertexCount, count);
  }

  /** Sun shadows, step 3: the map is done; the world passes after beginFrame take shadows from it. */
  endShadows(): void {
    const gl = this.gl;
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowsOn = true;
  }

  /** the wireframe uniforms of a world or tree draw (WORLD_FS uWire) */
  private setWire(u: Uniforms): void {
    const gl = this.gl;
    const w = this.wire;
    gl.uniform1i(u.uWire, w ? (w.mode === 'object' ? 1 : 2) : 0);
    if (!w) return;
    gl.uniform3fv(u.uWireColor, w.color);
    gl.uniform3fv(u.uWireFill, w.fill);
    // one CSS pixel, in the target's pixels (twice as many with the supersampled world)
    gl.uniform1f(u.uWireWidth, this.dpr * (this.msaa ? 2 : 1));
  }

  /** the shadow uniforms of a world or tree draw (SHADOW_RECEIVE_VS / _FS) */
  private setShadow(u: Uniforms, on: boolean): void {
    const gl = this.gl;
    const live = on && this.shadowsOn;
    gl.uniform1f(u.uShadowOn, live ? 1 : 0);
    if (!live) return;
    gl.uniformMatrix4fv(u.uShadowMat, false, this.shadowMat);
    const texel = (2 * this.shadowR) / SHADOW_SIZE;
    gl.uniform1f(u.uShadowNormal, texel * SHADOW_NORMAL_TEXELS);
    gl.uniform1f(u.uShadowBias, SHADOW_BIAS_TEXELS * texel / (2 * SHADOW_DEPTH_M));
    gl.uniform1f(u.uShadowSoft, Math.max(SHADOW_PENUMBRA.RADIUS_M, SHADOW_PENUMBRA.MIN_TEXELS * texel) / (2 * this.shadowR));
    const [tr, tg, tb] = SHADOW_PENUMBRA.TINT;
    gl.uniform4f(u.uPenumbra, tr, tg, tb, SHADOW_PENUMBRA.MIX);
    gl.uniform1f(u.uPenumbraSat, SHADOW_PENUMBRA.SAT);
  }

  /** Q12: "MSAA" = 2x supersampled world pass, averaged 2×2 down to the screen. */
  setMsaa(enabled: boolean): void {
    if (enabled === this.msaa) return;
    this.msaa = enabled;
    if (this.width > 0) this.alloc();
  }

  /**
   * Experimental XDR output (see hdr): on only where output-mode.ts allows it, SDR everywhere else.
   * With WebGL drawingBufferToneMapping the canvas itself is put in extended mode; without it (Chrome)
   * a tiny WebGPU canvas puts the page in HDR mode (xdr-trigger.ts), which takes a moment to set up:
   * hdr turns on when it is ready, and stays off where WebGPU can't.
   */
  setHdr(enabled: boolean): void {
    this.hdrWanted = enabled;
    this.updateHdr();
  }

  /** what decides the output now (output-mode.ts) */
  private hdrConditions(): HdrConditions {
    return {
      wanted: this.hdrWanted,
      browser: this.hdrSupported && !this.triggerFailed,
      display: this.hdrDisplay,
      page: this.nativeToneMapping() || this.trigger !== null,
    };
  }

  private nativeToneMapping(): boolean {
    return typeof (this.gl as HdrGl).drawingBufferToneMapping === 'function';
  }

  /** the output this frame: 'hdr' or 'sdr' */
  get output(): OutputMode {
    return this.hdr ? 'hdr' : 'sdr';
  }

  /** why the output is SDR, null when it is HDR (the settings screen says it) */
  get hdrBlocker(): HdrBlocker | null {
    return hdrBlocker(this.hdrConditions());
  }

  private updateHdr(): void {
    const c = this.hdrConditions();
    // the page is put in extended range only while HDR could otherwise be shown
    const needTrigger = c.wanted && c.browser && c.display && !this.nativeToneMapping();
    if (!needTrigger && this.trigger) {
      this.trigger.destroy();
      this.trigger = null;
    }
    if (needTrigger && !this.trigger && !this.triggerPending) {
      this.triggerPending = true;
      void XdrTrigger.create().then((t) => {
        this.triggerPending = false;
        if (!t) this.triggerFailed = true;
        else this.trigger = t;
        this.updateHdr();
      });
    }
    this.applyHdr(outputMode(this.hdrConditions()) === 'hdr');
  }

  private applyHdr(on: boolean): void {
    if (on === this.hdr) return;
    this.hdr = on;
    (this.gl as HdrGl).drawingBufferToneMapping?.({ mode: on ? 'extended' : 'standard' });
    if (this.width > 0) this.alloc();
  }

  /** brightness of a light source × SDR white: 1 without HDR */
  /**
   * The sun as a glint off a shiny surface sees it this frame: its direction, its strength through the
   * weather 0..1 (none below the horizon) and the glint's colour 0..255 (the water glitter's core, paler).
   */
  sunGlint(): { dir: vec3; strength: number; rgb: [number, number, number] } {
    const l = this.light;
    const up = Math.min(1, Math.max(0, (this.sunDir[1] + 0.01) / 0.06));
    const g = l?.glitter;
    const rgb: [number, number, number] = g ? [255 * (0.5 + 0.5 * g[1]), 255 * (0.5 + 0.5 * g[2]), 255 * (0.5 + 0.5 * g[3])] : [255, 250, 235];
    return { dir: this.sunDir, strength: l ? l.direct[0] * up : 0, rgb };
  }

  emission(kind: keyof typeof HDR_EMISSION): number {
    return this.hdr ? HDR_EMISSION[kind] : 1;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    this.dpr = dpr;
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
    // the canvas's own buffer: half-float for XDR, 8-bit otherwise (re-set on every resize)
    const hgl = gl as HdrGl;
    if (this.hdrSupported) hgl.drawingBufferStorage!(this.hdr ? gl.RGBA16F : gl.RGBA8, this.width, this.height);
    const [cInternal, cType] = this.hdr ? [gl.RGBA16F, gl.HALF_FLOAT] : [gl.RGBA8, gl.UNSIGNED_BYTE];
    gl.bindTexture(gl.TEXTURE_2D, this.worldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, cInternal, w, h, 0, gl.RGBA, cType, null);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    if (this.reversedZ) gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, w, h, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
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
    gl.texImage2D(gl.TEXTURE_2D, 0, cInternal, this.width, this.height, 0, gl.RGBA, cType, null);
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
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([this.reversedZ ? 0 : 1]));
  }

  /**
   * Sky, sun and moon, and below the horizon the base ground (SKY_FS): a plain surface of one face
   * colour at height `ground.y`, shaded and fogged like terrain, so there is a horizon and a ground
   * whether or not the tiles have loaded. Terrain drawn afterwards covers it.
   */
  /**
   * The true sun and moon directions the world passes light faces by (SUNLIGHT_GLSL) this frame;
   * drawSky sets them, a view without a sky sets them itself before drawing.
   */
  setSunMoon(sunDir: vec3, moonDir: vec3): void {
    vec3.copy(this.sunDir, sunDir);
    vec3.copy(this.skyMoon, moonDir);
  }

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
    vec3.copy(this.skyMoon, moonDir);
    this.skyCover[0] = Math.max(1, camPos[1] - ground.y);
    this.skyCover[1] = ground.deck?.up ?? 0;
    this.skyCover[2] = ground.deck?.down ?? 0;
    gl.uniform1f(this.skyU.uGroundH, Math.max(1, camPos[1] - ground.y));
    gl.uniform1ui(this.skyU.uGroundRamp, ground.ramp >>> 0);
    gl.uniform1f(this.skyU.uFogStart, ground.fogStart);
    gl.uniform1f(this.skyU.uFogEnd, ground.fogEnd);
    gl.uniform1f(this.skyU.uHazeK, this.hazeK());
    gl.uniform1f(this.skyU.uDeckUp, ground.deck?.up ?? 0);
    gl.uniform1f(this.skyU.uDeckDown, ground.deck?.down ?? 0);
    gl.uniform1ui(this.skyU.uDeckColour, (ground.deck?.colour ?? 0) >>> 0);
    gl.uniform1i(this.skyU.uGlow, 0);
    gl.uniform1f(this.skyU.uOriginLat, this.originLat);
    gl.uniform1f(this.skyU.uSeason, this.season);
    this.setLight(this.skyU);
    gl.uniform1f(this.skyU.uSunGlow, this.light?.sunGlow ?? 0);
    gl.uniform1f(this.skyU.uAureole, this.light?.aureole ?? 0);
    gl.uniform1f(this.skyU.uSunEmit, this.emission('sun'));
    // the moon as bright as the lit windows, far below the sun
    gl.uniform1f(this.skyU.uMoonEmit, this.emission('cityLights'));
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** the sky points (sky.ts buildSkyPoints: 7 floats each); `at` > 0 replaces the floats from there on */
  setSkyPoints(data: Float32Array, at = 0): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starsBuf);
    if (at === 0) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.starsCount = data.length / 7;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, at * 4, data);
    }
  }

  /**
   * Stars and planets over the sky drawSky just drew (STARS_VS), added to its colour so they fade
   * with the twilight. `sky`: J2000 → world directions (sky.ts skyMatrix, column-major); `limit`:
   * the faintest magnitude shown; `px`: pixels of the smallest point (device pixel ratio).
   */
  drawStars(sky: Float32Array, limit: number, px: number): void {
    if (this.starsCount === 0 || this.orthoFar > 0) return;
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    // add the colour, keep the sky's alpha (the silhouette pass reads it)
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    gl.useProgram(this.starsProg);
    gl.uniformMatrix3fv(this.starsU.uSky, false, sky);
    gl.uniformMatrix4fv(this.starsU.uViewProj, false, this.viewProj);
    gl.uniform3fv(this.starsU.uSunDir, this.sunDir);
    gl.uniform3fv(this.starsU.uMoonDir, this.skyMoon);
    gl.uniform1f(this.starsU.uLimit, limit);
    gl.uniform1f(this.starsU.uPx, px * (this.msaa ? 2 : 1));
    gl.uniform1f(this.starsU.uGroundH, this.skyCover[0]);
    gl.uniform1f(this.starsU.uDeckUp, this.skyCover[1]);
    gl.uniform1f(this.starsU.uDeckDown, this.skyCover[2]);
    gl.bindVertexArray(this.starsVao);
    gl.drawArrays(gl.POINTS, 0, this.starsCount);
    gl.disable(gl.BLEND);
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
    // the lightest variant that has what these faces need
    const { prog, u } = this.world[this.bare ? 'bare' : this.speckle ? 'ground' : this.windows !== 'off' ? 'houses' : 'full'];
    gl.useProgram(prog);
    gl.uniform1i(u.uCoarse, coarse);
    gl.uniform1f(u.uOrthoFar, this.orthoFar);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    setPlacement(gl, u.uOffset, offset);
    gl.uniform3fv(u.uCamPos, camPos);
    gl.uniform3fv(u.uSunDir, sunDir);
    gl.uniform1f(u.uFogStart, fogStart);
    gl.uniform1f(u.uFogEnd, fogEnd);
    gl.uniform1f(u.uHazeK, this.hazeK());
    gl.uniform1i(u.uGlow, this.nightGlow ? 1 : 0);
    gl.uniform1f(u.uOriginLat, this.originLat);
    gl.uniform1f(u.uSeason, this.season);
    this.setLight(u);
    this.setRim(u, this.selfLit ? 0 : this.rimWeight);
    gl.uniform1i(u.uTwoSided, this.selfLit ? 0 : 1);
    gl.uniform1f(u.uSelfLit, this.selfLit ? 1 : 0);
    gl.uniform1f(u.uOutlined, this.outlined ? 1 : 0);
    gl.uniform1f(u.uEmit, this.selfLit ? this.selfLitGain : 1);
    const blend = this.additive || this.opacity < 1;
    gl.uniform1f(u.uClear, this.additive ? 0 : 1 - this.opacity);
    if (this.gloss > 0) {
      const g = this.sunGlint();
      const k = (this.gloss * g.strength) / 255;
      gl.uniform4f(u.uGloss, g.rgb[0] * k, g.rgb[1] * k, g.rgb[2] * k, this.gloss);
    } else gl.uniform4f(u.uGloss, 0, 0, 0, 0);
    if (blend) {
      gl.enable(gl.BLEND);
      // colour blended or added; the destination's alpha (silhouette marks) left as it is
      if (this.additive) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.depthMask(false);
    }
    gl.uniform1i(u.uWindows, this.windows === 'lit' ? 2 : this.windows === 'glass' ? 1 : 0);
    gl.uniform1f(u.uWinEmit, this.emission('cityLights'));
    gl.uniform1f(u.uLitShare, this.litShare);
    gl.uniform1i(u.uSpeckle, this.speckle ? 1 : 0);
    // light sources and glints are not shaded
    this.setShadow(u, !this.selfLit && !this.additive);
    this.setWire(u);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, mesh.first ?? 0, mesh.vertexCount);
    if (blend) gl.disable(gl.BLEND);
    if (!depthWrite || blend) gl.depthMask(true);
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
    /** the instances of the whole run, of which `count` are the first: far trees thinned (TREE_THIN); 0: all drawn as they are */
    thinCount = 0,
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(this.treeProg);
    gl.uniform1f(this.treeU.uThinCount, thinCount);
    gl.uniform1f(this.treeU.uOrthoFar, this.orthoFar);
    gl.uniformMatrix4fv(this.treeU.uView, false, view);
    gl.uniformMatrix4fv(this.treeU.uProj, false, proj);
    setPlacement(gl, this.treeU.uOffset, offset);
    gl.uniform3fv(this.treeU.uCamPos, camPos);
    gl.uniform3fv(this.treeU.uSunDir, sunDir);
    gl.uniform1f(this.treeU.uFogStart, fogStart);
    gl.uniform1f(this.treeU.uFogEnd, fogEnd);
    gl.uniform1f(this.treeU.uHazeK, this.hazeK());
    gl.uniform1i(this.treeU.uGlow, this.nightGlow ? 1 : 0);
    gl.uniform1f(this.treeU.uOriginLat, this.originLat);
    gl.uniform1f(this.treeU.uSeason, this.season);
    this.setLight(this.treeU);
    this.setRim(this.treeU, this.rimTreeWeight);
    gl.uniform1i(this.treeU.uTwoSided, 1);
    gl.uniform1f(this.treeU.uOutlined, 0);
    this.setShadow(this.treeU, true);
    this.setWire(this.treeU);
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
    gl.uniform1f(this.pointsU.uFbH, fbHeight);
    gl.uniform1f(this.pointsU.uCell, this.windowCellM);
    gl.uniform1f(this.pointsU.uFogStart, this.pointFog[0]);
    gl.uniform1f(this.pointsU.uFogEnd, this.pointFog[1]);
    gl.uniform1f(this.pointsU.uHazeK, this.hazeK());
    gl.uniform2f(this.pointsU.uPull, pull[0], pull[1]);
    gl.uniform1f(this.pointsU.uOrthoFar, this.orthoFar);
    gl.uniformMatrix4fv(this.pointsU.uView, false, view);
    gl.uniformMatrix4fv(this.pointsU.uProj, false, proj);
    setPlacement(gl, this.pointsU.uOffset, offset);
    gl.uniform3fv(this.pointsU.uCamPos, camPos);
    gl.uniform1f(this.pointsU.uPointSize, pointSize);
    gl.uniform1i(this.pointsU.uOn, on ? 1 : 0);
    gl.uniform1f(this.pointsU.uEmit, this.emission('cityLights'));
    gl.uniform1f(this.pointsU.uLitShare, this.litShare);
    this.setLight(this.pointsU);
    gl.bindVertexArray(vao);
    gl.drawArrays(mode === 'points' ? gl.POINTS : gl.LINES, 0, count);
    gl.depthMask(true);
  }

  /**
   * Inside a cloud (Q46): the world drawn so far whited out in `rgb` (0..1) by a dither of
   * `density` 0..1, stepped in eighths (VEIL_FS). Call after the world passes, before beginOverlay.
   */
  drawVeil(density: number, rgb: ArrayLike<number>): void {
    const d = Math.ceil(Math.max(0, Math.min(1, density)) * 8) / 8;
    if (d <= 0) return;
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.veilProg);
    gl.uniform1f(this.veilU.uDensity, d);
    gl.uniform3f(this.veilU.uColor, rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(this.veilU.uScale, this.msaa ? 2 : 1);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * Rain or snow round the camera (Q48, PRECIP_VS): `count` particles wrapped in a cube of side
   * `box` m, moved by `offset` (m, accumulated motion of the particles against the camera), each
   * drawn back along `streak` (m), `widthPx` device pixels wide, in `rgb` (0..1). Call after the
   * world passes, before drawVeil.
   */
  drawPrecip(
    view: mat4, proj: mat4, camPos: vec3,
    p: { count: number; box: number; offset: ArrayLike<number>; streak: ArrayLike<number>; widthPx: number; rgb: ArrayLike<number> },
  ): void {
    const count = Math.min(PRECIP_MAX, Math.floor(p.count));
    if (count <= 0) return;
    const gl = this.gl;
    const s = this.msaa ? 2 : 1;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.precipProg);
    gl.uniformMatrix4fv(this.precipU.uView, false, view);
    gl.uniformMatrix4fv(this.precipU.uProj, false, proj);
    gl.uniform3fv(this.precipU.uCamPos, camPos);
    gl.uniform3f(this.precipU.uOffset, p.offset[0], p.offset[1], p.offset[2]);
    gl.uniform3f(this.precipU.uStreak, p.streak[0], p.streak[1], p.streak[2]);
    gl.uniform1f(this.precipU.uBox, p.box);
    gl.uniform3f(this.precipU.uScreen, this.width * s, this.height * s, p.widthPx * s);
    gl.uniform3f(this.precipU.uColor, p.rgb[0], p.rgb[1], p.rgb[2]);
    gl.uniform1f(this.precipU.uOrthoFar, this.orthoFar);
    gl.bindVertexArray(this.precipVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
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
      // the band's width: CSS pixels (rim.ts outlineCss) → device pixels of this screen (the shader adds the supersampling)
      this.outlineFrame.set(outline ? this.rim.outline : NO_RIM.outline);
      this.outlineFrame[1] = Math.max(1, Math.min(32, Math.round(this.outlineFrame[1] * this.dpr)));
      gl.uniform4fv(this.dsU.uOutline, this.outlineFrame);
      gl.uniform1f(this.dsU.uRimSteps, this.rim.steps);
      gl.uniform3fv(this.dsU.uRimColor, this.rim.colour);
      gl.uniform3fv(this.dsU.uSunDir, this.sunDir);
      gl.uniformMatrix4fv(this.dsU.uViewProj, false, this.viewProj);
      gl.uniformMatrix4fv(this.dsU.uInvViewProj, false, this.invViewProj);
      gl.uniform1f(this.dsU.uFogStart, this.fog[0]);
      gl.uniform1f(this.dsU.uFogEnd, this.fog[1]);
      gl.uniform1f(this.dsU.uHazeK, this.hazeK());
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
  private outlineFrame = new Float32Array(4);

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
    if (u.uSky !== undefined) {
      this.gl.uniform3fv(u.uSun, this.sunDir);
      this.gl.uniform3fv(u.uMoon, this.skyMoon);
      this.gl.uniform4fv(u.uSky, this.light.sky);
      this.gl.uniform4fv(u.uDirect, this.light.direct);
      // the sunset glow turns the fog's haze toward the sky's colour (shaders.ts hazeAt)
      this.gl.uniform1f(u.uSunGlow, this.light.sunGlow);
      this.gl.uniform1f(u.uAureole, this.light.aureole);
    }
    if (u.uGlitter === undefined) return;
    const g = this.light.glitter;
    this.gl.uniform2f(u.uGlitter, g[0], g[7]);
    this.gl.uniform3fv(u.uGlitterSun, this.sunDir);
    this.gl.uniform3f(u.uGlitterCore, g[1], g[2], g[3]);
    this.gl.uniform3f(u.uGlitterEdge, g[4], g[5], g[6]);
    this.gl.uniform1f(u.uTime, this.time);
    // world dots (shaders.ts worldDot): one CSS pixel, 2 or 3 device pixels on a dense screen
    this.gl.uniform1f(u.uDotPx, Math.max(1, Math.round(this.dpr)) * (this.msaa ? 2 : 1));
  }
}

/** the base ground under the tiles (drawSky) */
/** the most rain or snow particles drawn (precipitation.ts precipParticles) */
export const PRECIP_MAX = 4000;

export interface BaseGround {
  /** its height in world y (m above sea level) */
  y: number;
  /** face colour (palette.ts): sea, or land (with the snow flag) */
  ramp: number;
  fogStart: number;
  fogEnd: number;
  /**
   * overcast decks (Q46) on to the horizon: `up` how far the base of the nearest one above is over
   * the camera, `down` how far the camera is over the top of the nearest one below (0: none), m;
   * `colour` their face colour
   */
  deck?: { up: number; down: number; colour: number };
}

/**
 * XDR brightness of the light sources in linear light, × SDR white (shaders.ts emitLight: the hue
 * holds), each capped where its strongest channel reaches shaders.ts HDR_PEAK. A saturated colour
 * (a green navigation light) needs a high gain to get there; white reaches it at HDR_PEAK.
 */
export const HDR_EMISSION = {
  /** navigation lights, beacons, landing light (aircraft-renderer drawLights) */
  aircraftLights: 64,
  /** the exhaust flame */
  flame: 32,
  /** the sun disc */
  sun: 128,
  /** window, street, beacon and runway lights (drawLights points and lines in the fixed LIGHT colours; lit windows on the walls) */
  cityLights: 48,
  /** the traffic lights' lit lenses (osm-manager lightSignals): saturated colours, as the navigation lights */
  trafficLights: 64,
  /** the sun's glints off a turning propeller */
  glint: 64,
} as const;

/** WebGL drawing buffer storage and tone mapping (not yet in TypeScript's DOM lib) */
type HdrGl = WebGL2RenderingContext & {
  drawingBufferStorage?: (internalFormat: number, width: number, height: number) => void;
  drawingBufferToneMapping?: (mapping: { mode: 'standard' | 'extended' }) => void;
};

/**
 * The world shader's variants (shaders.ts WORLD_FS): what each leaves out. ground: the terrain and
 * the OSM areas (water and dots); houses: the buildings (windows); bare: no surface effects (clouds,
 * trees); full: the rest (roads, OSM water, aircraft).
 */
type WorldVariant = 'full' | 'ground' | 'houses' | 'bare';
const WORLD_VARIANTS: Record<WorldVariant, readonly string[]> = {
  full: [],
  ground: ['NO_ROADS', 'NO_WINDOWS'],
  houses: ['NO_WATER', 'NO_SPECKLE', 'NO_ROADS'],
  bare: ['NO_WATER', 'NO_SPECKLE', 'NO_ROADS', 'NO_WINDOWS'],
};

/** EXT_clip_control (not in TypeScript's DOM lib) */
interface ClipControl {
  LOWER_LEFT_EXT: number;
  ZERO_TO_ONE_EXT: number;
  clipControlEXT(origin: number, depth: number): void;
}

/** the glitter path's uniforms (shaders.ts GLITTER_GLSL), set with the light */
const WIRE_UNIFORMS = ['uWire', 'uWireColor', 'uWireFill', 'uWireWidth'];
const GLITTER_UNIFORMS = ['uGlitter', 'uGlitterSun', 'uGlitterCore', 'uGlitterEdge', 'uTime', 'uDotPx'];
/** the light on faces (shaders.ts SUNLIGHT_GLSL) */
const SUNLIGHT_UNIFORMS = ['uSun', 'uMoon', 'uSky', 'uDirect', 'uSunGlow', 'uAureole'];

/** texture unit the LUT stays bound to */
const LUT_UNIT = 5;
/** texture unit the shadow map stays bound to */
const SHADOW_UNIT = 6;
/** the shadow receivers' uniforms (shaders.ts SHADOW_RECEIVE_VS / _FS) */
const SHADOW_UNIFORMS = ['uShadowMat', 'uShadowOn', 'uShadowNormal', 'uShadowBias', 'uShadowMap', 'uShadowSoft', 'uPenumbra', 'uPenumbraSat'];
/** shadow map texels a side */
const SHADOW_SIZE = 2048;
/**
 * the shadow box's half-width, m: SHADOW_MIN_R on the ground (under a metre a texel), growing by
 * SHADOW_R_PER_AGL per metre of the camera's height over it, up to SHADOW_MAX_R
 */
const SHADOW_MIN_R = 600;
const SHADOW_MAX_R = 6000;
const SHADOW_R_PER_AGL = 1.2;
/** the box reaches this far toward the sun and away from it round its centre, m (clouds included) */
const SHADOW_DEPTH_M = 15000;
/** no shadows with the sun this low (sine of its elevation): it no longer lights the faces */
const SHADOW_MIN_SUN_Y = 0.01;
/** against shadow acne: receivers nudged along their normal and their depth, in shadow texels; casters' slope offset */
const SHADOW_NORMAL_TEXELS = 2;
const SHADOW_BIAS_TEXELS = 2;
const SHADOW_SLOPE = 4;
/**
 * The shadow's edge (SHADOW_RECEIVE_FS sunLit / sunShaded): its taps lie RADIUS_M round the
 * fragment, at least MIN_TEXELS shadow texels (the outline off the texel grid at any height); the
 * penumbra band between shade and sun takes MIX of the way from the shade to the sun, its
 * saturation raised SAT times and its hue pushed toward an orange-leaning red-violet by TINT: a painted edge, the
 * saturated fringe of anime backgrounds, not a measured one.
 */
const SHADOW_PENUMBRA = { RADIUS_M: 0.5, MIN_TEXELS: 1, MIX: 0.45, SAT: 1.6, TINT: [1.16, 0.85, 0.97] };
/** the box's centre lies this share of its half-width ahead of the camera, where it looks */
const SHADOW_AHEAD = 0.4;

/** uOffset (see PLACE_VS): a vec3 offset places a mesh without turning it */
function setPlacement(gl: WebGL2RenderingContext, loc: WebGLUniformLocation | null, offset: vec3 | vec4): void {
  gl.uniform4f(loc, offset[0], offset[1], offset[2], offset.length > 3 ? (offset as vec4)[3] : 0);
}
