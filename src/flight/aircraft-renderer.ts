import { mat3, vec3, type mat4 } from 'gl-matrix';
import { must } from '../engine/gl';
import type { Mesh, Renderer } from '../engine/renderer';
import { colour, selfLit } from '../engine/palette';
import { aircraftMesh, flameMesh, type AircraftConfig } from './aircraft';
import { lightOn, newPoses, poseJoints, signals, type JointDef, type JointPose, type LightDef } from './articulation';
import type { FlightModel } from './model';
import {
  DISC_OPACITY, GHOSTS, GLINT_GAIN, SPIN_SENSE, SPIN_TAU, blurOf, ghostOpacity, glintAt, pistonRpm, propVertices, type PropDef,
} from './propeller';

/**
 * a light is drawn as a small self-lit diamond: this radius, m, or this share of the camera distance if
 * larger (about 1.5 px at 1080 lines), so it still reads as a point of light from afar
 */
const LIGHT_SIZE = 0.14;
const LIGHT_ANGLE = 0.004;

/** the propeller disc: rings (the blades' black, their yellow tips from TIP_FROM of the radius) and sectors */
const DISC_RINGS = [0.16, 0.3, 0.45, 0.6, 0.75, 0.89, 1];
const TIP_FROM = 0.89;
const DISC_SECTORS = 48;
/** blade colours, as in tools/c150-build.py (a shade lighter: the smear of a black blade over the sky) */
const DISC_DARK = colour(0x2a, 0x2d, 0x31);
const DISC_TIP = colour(0xf2, 0xc4, 0x00);
/** glints: sectors round the disc, and the faintest one drawn */
const GLINT_SECTORS = 96;
const GLINT_MIN = 0.03;
/** ghost blades: smeared over the turn of one frame, at most this far, rad */
const GHOST_SWEEP = 0.9;

/**
 * The world shader takes only an offset uniform, so the airframe (a few hundred triangles)
 * is rotated on the CPU each frame and re-uploaded (a few KB, negligible).
 */
export class AircraftRenderer {
  private gl: WebGL2RenderingContext;
  private mesh: Mesh;
  /** the mesh holds a pose (draw has run once): its shadow can be cast */
  private posed = false;
  private vbo: WebGLBuffer;
  private rbo: WebGLBuffer;
  private base: Float32Array;
  private live: Float32Array;
  private rot = mat3.create();
  private parts: Uint8Array = new Uint8Array(0);
  private ramps: Uint32Array = new Uint32Array(0);
  /** per vertex: the hinge it turns on (1-based), and the hinges' current poses */
  private joint: Uint8Array = new Uint8Array(0);
  private joints: JointDef[] = [];
  private poses: JointPose[] = [];
  private lights: LightDef[] = [];
  private lMesh: Mesh;
  private lvbo: WebGLBuffer;
  private lrbo: WebGLBuffer;
  /** per part tag: centroid of its vertices in mesh space (the point a broken-off piece tumbles about) */
  private pivots: vec3[] = [];
  private cfgId = '';
  private fMesh: Mesh;
  private fvbo: WebGLBuffer;
  private frbo: WebGLBuffer;
  /** the propeller (cfg.prop), the vertices of its blades, and how it turns now */
  private prop: PropDef | undefined;
  private propVert: Uint8Array = new Uint8Array(0);
  private rpm = 0;
  private propAngle = 0;
  /** the turn of the last frame, rad (the ghosts' smear) */
  private propStep = 0;
  private ghost: { mesh: Mesh; vbo: WebGLBuffer; rbo: WebGLBuffer };
  private disc: { mesh: Mesh; vbo: WebGLBuffer; rbo: WebGLBuffer };
  private glint: { mesh: Mesh; vbo: WebGLBuffer; rbo: WebGLBuffer };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const lights = AircraftRenderer.dynamicMesh(gl, 'lights');
    this.lMesh = lights.mesh;
    this.lvbo = lights.vbo;
    this.lrbo = lights.rbo;
    this.ghost = AircraftRenderer.dynamicMesh(gl, 'prop ghosts');
    this.disc = AircraftRenderer.dynamicMesh(gl, 'prop disc');
    this.glint = AircraftRenderer.dynamicMesh(gl, 'prop glints');
    this.base = new Float32Array(0);
    this.live = new Float32Array(0);
    const vao = must(gl.createVertexArray(), 'aircraft VAO');
    gl.bindVertexArray(vao);
    this.vbo = must(gl.createBuffer(), 'aircraft vertices');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.rbo = must(gl.createBuffer(), 'aircraft ramps');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rbo);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0);
    gl.bindVertexArray(null);
    this.mesh = { vao, vertexCount: 0 };

    const fvao = must(gl.createVertexArray(), 'flame VAO');
    gl.bindVertexArray(fvao);
    this.fvbo = must(gl.createBuffer(), 'flame vertices');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fvbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.frbo = must(gl.createBuffer(), 'flame ramps');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.frbo);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0);
    gl.bindVertexArray(null);
    this.fMesh = { vao: fvao, vertexCount: 0 };
  }

  /** a vertex array for a mesh rebuilt every frame: pos.xyz + normal.xyz, and a face colour per vertex */
  private static dynamicMesh(gl: WebGL2RenderingContext, label: string): { mesh: Mesh; vbo: WebGLBuffer; rbo: WebGLBuffer } {
    const vao = must(gl.createVertexArray(), `${label} VAO`);
    gl.bindVertexArray(vao);
    const vbo = must(gl.createBuffer(), `${label} vertices`);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const rbo = must(gl.createBuffer(), `${label} ramps`);
    gl.bindBuffer(gl.ARRAY_BUFFER, rbo);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0);
    gl.bindVertexArray(null);
    return { mesh: { vao, vertexCount: 0 }, vbo, rbo };
  }

  private ensureMesh(cfg: AircraftConfig): void {
    const key = `${cfg.id}|${cfg.insigniaId ?? ''}|${cfg.loadoutId ?? ''}`;
    if (this.cfgId === key) return;
    this.cfgId = key;
    const src = aircraftMesh(cfg);
    this.base = src.vertices;
    this.parts = src.parts;
    this.ramps = src.ramps;
    this.joint = src.joint;
    this.joints = src.joints;
    this.poses = newPoses(src.joints);
    this.lights = src.lights;
    this.prop = cfg.prop?.hub ? cfg.prop : undefined;
    this.propVert = this.prop ? propVertices(src.vertices, this.prop) : new Uint8Array(src.ramps.length);
    this.live = new Float32Array(src.vertices.length);
    const sums: { p: vec3; n: number }[] = [];
    for (let v = 0; v < src.parts.length; v++) {
      const e = (sums[src.parts[v]] ??= { p: vec3.create(), n: 0 });
      e.p[0] += src.vertices[v * 6];
      e.p[1] += src.vertices[v * 6 + 1];
      e.p[2] += src.vertices[v * 6 + 2];
      e.n++;
    }
    this.pivots = sums.map((e) => vec3.scale(e.p, e.p, 1 / Math.max(1, e.n)));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.live.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rbo);
    gl.bufferData(gl.ARRAY_BUFFER, src.ramps, gl.STATIC_DRAW);
    this.mesh.vertexCount = src.ramps.length;
  }

  /**
   * The engine at the start: standing on the ground it is started (the propeller turns up from rest),
   * in the air it is already running.
   */
  startPropeller(model: FlightModel, running: boolean): void {
    this.rpm = running ? pistonRpm(0, model.airspeed) : 0;
    this.propStep = 0;
  }

  /** the propeller's rpm and angle after dt s (0 while paused) at this throttle */
  spin(model: FlightModel, throttle: number, dt: number): void {
    if (!model.cfg.prop || dt <= 0) return;
    const target = model.crashed ? 0 : pistonRpm(throttle, model.airspeed);
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / SPIN_TAU));
    this.propStep = ((this.rpm / 60) * 2 * Math.PI * dt);
    this.propAngle = (this.propAngle + SPIN_SENSE * this.propStep) % (2 * Math.PI);
  }

  get propRpm(): number {
    return this.rpm;
  }

  /** the aircraft into the sun's shadow map (renderer.beginShadows), in the pose its last draw left */
  drawShadow(renderer: Renderer, model: FlightModel): void {
    if (this.posed) renderer.shadowMesh(this.mesh, model.pos);
  }

  draw(renderer: Renderer, model: FlightModel, view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, throttle = 0, time = 0): void {
    if (model.crashed) return;
    this.ensureMesh(model.cfg);
    mat3.fromQuat(this.rot, model.quat);
    const cg = model.meshCg;
    const p = vec3.create();
    const n = vec3.create();
    // a separated part is drawn as debris while it lasts (its own attitude and offset), then not at all
    const state: (0 | 1 | { rot: mat3; rel: vec3; pivot: vec3 })[] = [0];
    for (let i = 0; i < model.lost.length; i++) {
      if (!model.lost[i]) {
        state[i + 1] = 0;
        continue;
      }
      const d = model.debris.find((x) => x.part === i);
      state[i + 1] = d && this.pivots[i + 1] ? { rot: mat3.fromQuat(mat3.create(), d.quat), rel: d.rel, pivot: this.pivots[i + 1] } : 1;
    }
    // control surfaces, airbrake, gear and doors where the actuators have put them
    const sig = signals(model.actuators);
    poseJoints(this.joints, sig, this.poses);
    const prop = this.prop;
    const blur = prop ? blurOf(this.rpm) : 0;
    const ca = Math.cos(this.propAngle), sa = Math.sin(this.propAngle);
    for (let i = 0, v = 0; i < this.base.length; i += 6, v++) {
      const st = state[this.parts[v]];
      const jn = this.joint[v];
      const pose = jn ? this.poses[jn - 1] : null;
      const blade = prop !== undefined && this.propVert[v] === 1;
      if (st === 1 || (pose && !pose.visible) || (blade && blur > 0)) {
        // gone, or stowed out of sight: collapse the triangle
        this.live[i] = this.live[i + 1] = this.live[i + 2] = 0;
        continue;
      }
      vec3.set(p, this.base[i], this.base[i + 1], this.base[i + 2]);
      vec3.set(n, this.base[i + 3], this.base[i + 4], this.base[i + 5]);
      if (blade) spinAbout(p, n, prop.hub, ca, sa);
      if (pose) {
        vec3.transformMat3(p, p, pose.rot);
        vec3.add(p, p, pose.off);
        vec3.transformMat3(n, n, pose.rot);
      }
      if (st === 0) {
        // the physics turns the aircraft about its centre of gravity, so the mesh does too
        vec3.sub(p, p, cg);
        vec3.transformMat3(p, p, this.rot);
        vec3.transformMat3(n, n, this.rot);
      } else {
        vec3.sub(p, p, st.pivot);
        vec3.transformMat3(p, p, st.rot);
        vec3.add(p, p, st.rel);
        vec3.transformMat3(n, n, st.rot);
      }
      this.live[i] = p[0];
      this.live[i + 1] = p[1];
      this.live[i + 2] = p[2];
      this.live[i + 3] = n[0];
      this.live[i + 4] = n[1];
      this.live[i + 5] = n[2];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.live);
    renderer.drawWorld(this.mesh, model.pos, view, proj, camPos, sunDir, 20000, 60000);
    this.posed = true;
    if (prop && blur > 0 && state[0] === 0) this.drawPropeller(renderer, model, view, proj, camPos, sunDir, blur);
    // the flame and the lights light themselves: no rim of either kind, no two-sided flip
    renderer.selfLit = true;
    renderer.selfLitGain = renderer.emission('flame');
    this.drawFlame(renderer, model, view, proj, camPos, sunDir, throttle, time);
    renderer.selfLitGain = renderer.emission('aircraftLights');
    this.drawLights(renderer, model, view, proj, camPos, sunDir, time, sig, state);
    renderer.selfLit = false;
    renderer.selfLitGain = 1;
  }

  /**
   * A turning propeller: the blades fading into ghosts smeared over the last frame's turn, the see-through
   * disc fading in, and the sun's glints on it.
   */
  private drawPropeller(
    renderer: Renderer, model: FlightModel, view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, blur: number,
  ): void {
    const prop = this.prop as PropDef;
    const cg = model.meshCg;
    const rot = this.rot;
    const p = vec3.create();
    const n = vec3.create();
    const put = (verts: number[], x: number, y: number, z: number, nx: number, ny: number, nz: number): void => {
      vec3.set(p, x - cg[0], y - cg[1], z - cg[2]);
      vec3.transformMat3(p, p, rot);
      vec3.set(n, nx, ny, nz);
      vec3.transformMat3(n, n, rot);
      verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    };
    const [hx, hy, hz] = prop.hub;
    const gl = this.gl;
    const upload = (m: { mesh: Mesh; vbo: WebGLBuffer; rbo: WebGLBuffer }, verts: number[], ramps: number[]): boolean => {
      m.mesh.vertexCount = ramps.length;
      if (ramps.length === 0) return false;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.rbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(ramps), gl.DYNAMIC_DRAW);
      return true;
    };

    // ghosts: the blades at GHOSTS angles back along the last frame's turn
    if (blur < 1) {
      const verts: number[] = [];
      const ramps: number[] = [];
      const sweep = Math.min(GHOST_SWEEP, this.propStep);
      const q = vec3.create();
      const m = vec3.create();
      for (let g = 0; g < GHOSTS; g++) {
        const a = this.propAngle - SPIN_SENSE * sweep * (g / GHOSTS);
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let i = 0, v = 0; i < this.base.length; i += 6, v++) {
          if (this.propVert[v] !== 1) continue;
          vec3.set(q, this.base[i], this.base[i + 1], this.base[i + 2]);
          vec3.set(m, this.base[i + 3], this.base[i + 4], this.base[i + 5]);
          spinAbout(q, m, prop.hub, ca, sa);
          put(verts, q[0], q[1], q[2], m[0], m[1], m[2]);
          ramps.push(this.ramps[v]);
        }
      }
      if (upload(this.ghost, verts, ramps)) {
        renderer.opacity = ghostOpacity(blur);
        renderer.drawWorld(this.ghost.mesh, model.pos, view, proj, camPos, sunDir, 20000, 60000);
        renderer.opacity = 1;
      }
    }

    // the disc: an annulus in the propeller plane, facing forward (two-sided lighting turns it to the eye)
    {
      const verts: number[] = [];
      const ramps: number[] = [];
      for (let k = 0; k + 1 < DISC_RINGS.length; k++) {
        const r0 = DISC_RINGS[k] * prop.radius, r1 = DISC_RINGS[k + 1] * prop.radius;
        const c = DISC_RINGS[k] >= TIP_FROM ? DISC_TIP : DISC_DARK;
        for (let j = 0; j < DISC_SECTORS; j++) {
          const a0 = (j / DISC_SECTORS) * 2 * Math.PI, a1 = ((j + 1) / DISC_SECTORS) * 2 * Math.PI;
          const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
          const quad: [number, number][] = [[r0 * c0, r0 * s0], [r1 * c0, r1 * s0], [r1 * c1, r1 * s1], [r0 * c1, r0 * s1]];
          for (const idx of [0, 1, 2, 0, 2, 3]) {
            put(verts, hx + quad[idx][0], hy + quad[idx][1], hz, 0, 0, -1);
            ramps.push(c);
          }
        }
      }
      if (upload(this.disc, verts, ramps)) {
        renderer.opacity = DISC_OPACITY * blur;
        renderer.drawWorld(this.disc.mesh, model.pos, view, proj, camPos, sunDir, 20000, 60000);
        renderer.opacity = 1;
      }
    }

    // glints: where the blades' faces mirror the sun to the eye, added as light over the disc
    const sun = renderer.sunGlint();
    const strength = sun.strength * GLINT_GAIN * blur;
    if (strength <= GLINT_MIN) return;
    // the sun and the eye in mesh axes (rot is orthonormal: its transpose turns world into mesh)
    const inv = mat3.transpose(mat3.create(), rot);
    const toSun = vec3.transformMat3(vec3.create(), sun.dir, inv);
    const eye = vec3.sub(vec3.create(), camPos, model.pos);
    vec3.transformMat3(eye, eye, inv);
    vec3.add(eye, eye, cg);
    const toEye = vec3.create();
    const verts: number[] = [];
    const ramps: number[] = [];
    for (let k = 0; k + 1 < DISC_RINGS.length; k++) {
      const r0 = DISC_RINGS[k] * prop.radius, r1 = DISC_RINGS[k + 1] * prop.radius;
      const rm = (r0 + r1) / 2;
      for (let j = 0; j < GLINT_SECTORS; j++) {
        const a0 = (j / GLINT_SECTORS) * 2 * Math.PI, a1 = ((j + 1) / GLINT_SECTORS) * 2 * Math.PI;
        const am = (a0 + a1) / 2;
        vec3.set(toEye, eye[0] - (hx + rm * Math.cos(am)), eye[1] - (hy + rm * Math.sin(am)), eye[2] - hz);
        vec3.normalize(toEye, toEye);
        const g = glintAt(prop, rm, am, toSun, toEye) * strength;
        if (g < GLINT_MIN) continue;
        // a few steps, as the world's flat shading has
        const lv = Math.min(1, Math.ceil(g * 6) / 6);
        const c = selfLit(colour(sun.rgb[0] * lv, sun.rgb[1] * lv, sun.rgb[2] * lv));
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const quad: [number, number][] = [[r0 * c0, r0 * s0], [r1 * c0, r1 * s0], [r1 * c1, r1 * s1], [r0 * c1, r0 * s1]];
        for (const idx of [0, 1, 2, 0, 2, 3]) {
          // (a self-lit face's normal plays no part)
          put(verts, hx + quad[idx][0], hy + quad[idx][1], hz, 0, 0, -1);
          ramps.push(c);
        }
      }
    }
    if (!upload(this.glint, verts, ramps)) return;
    renderer.additive = true;
    renderer.selfLit = true;
    renderer.selfLitGain = renderer.emission('glint');
    renderer.drawWorld(this.glint.mesh, model.pos, view, proj, camPos, sunDir, 20000, 60000);
    renderer.additive = false;
    renderer.selfLit = false;
    renderer.selfLitGain = 1;
  }

  /** navigation lights, beacons and the landing light: small self-lit diamonds that keep a visible size */
  private drawLights(
    renderer: Renderer, model: FlightModel, view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, time: number,
    sig: ReturnType<typeof signals>, state: unknown[],
  ): void {
    if (this.lights.length === 0) return;
    const verts: number[] = [];
    const ramps: number[] = [];
    const size = Math.max(LIGHT_SIZE, vec3.distance(camPos, model.pos) * LIGHT_ANGLE);
    const cg = model.meshCg;
    const p = vec3.create();
    for (const l of this.lights) {
      if (state[l.part] !== 0 || !lightOn(l, sig, time)) continue;
      const pose = l.joint ? this.poses[l.joint - 1] : null;
      if (pose && !pose.visible) continue;
      vec3.set(p, l.pos[0], l.pos[1], l.pos[2]);
      if (pose) {
        vec3.transformMat3(p, p, pose.rot);
        vec3.add(p, p, pose.off);
      }
      vec3.sub(p, p, cg);
      vec3.transformMat3(p, p, this.rot);
      const colour = selfLit(l.rgb);
      // octahedron: 8 faces round the centre
      const ax: [number, number, number][] = [[size, 0, 0], [0, size, 0], [0, 0, size]];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        for (const k of [0, 1, 2]) {
          const a = ax[k];
          const sgn = k === 0 ? sx : k === 1 ? sy : sz;
          verts.push(p[0] + a[0] * sgn, p[1] + a[1] * sgn, p[2] + a[2] * sgn, sunDir[0], sunDir[1], sunDir[2]);
          ramps.push(colour);
        }
      }
    }
    this.lMesh.vertexCount = ramps.length;
    if (ramps.length === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lrbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(ramps), gl.DYNAMIC_DRAW);
    renderer.drawWorld(this.lMesh, model.pos, view, proj, camPos, sunDir, 20000, 60000);
  }

  private drawFlame(
    renderer: Renderer, model: FlightModel, view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, throttle: number, time: number,
  ): void {
    const src = flameMesh(model.cfg, throttle, time, model.lost);
    if (src.ramps.length === 0) return;
    const out = new Float32Array(src.vertices.length);
    const cg = model.meshCg;
    const p = vec3.create();
    for (let i = 0; i < out.length; i += 6) {
      vec3.set(p, src.vertices[i] - cg[0], src.vertices[i + 1] - cg[1], src.vertices[i + 2] - cg[2]);
      vec3.transformMat3(p, p, this.rot);
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
      // self-lit: normal faces the sun so the brightest ramp step is always used
      out[i + 3] = sunDir[0]; out[i + 4] = sunDir[1]; out[i + 5] = sunDir[2];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fvbo);
    gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.frbo);
    gl.bufferData(gl.ARRAY_BUFFER, src.ramps, gl.DYNAMIC_DRAW);
    this.fMesh.vertexCount = src.ramps.length;
    renderer.drawWorld(this.fMesh, model.pos, view, proj, camPos, sunDir, 20000, 60000);
  }
}

/** turn a point and its normal about the propeller's axis (+z through the hub) by the angle of cos ca, sin sa */
function spinAbout(p: vec3, n: vec3, hub: number[], ca: number, sa: number): void {
  const x = p[0] - hub[0], y = p[1] - hub[1];
  p[0] = hub[0] + x * ca - y * sa;
  p[1] = hub[1] + x * sa + y * ca;
  const nx = n[0], ny = n[1];
  n[0] = nx * ca - ny * sa;
  n[1] = nx * sa + ny * ca;
}
