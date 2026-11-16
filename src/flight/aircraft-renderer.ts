import { mat3, vec3, type mat4 } from 'gl-matrix';
import { must } from '../engine/gl';
import type { Mesh, Renderer } from '../engine/renderer';
import { selfLit } from '../engine/palette';
import { aircraftMesh, flameMesh, type AircraftConfig } from './aircraft';
import { lightOn, newPoses, poseJoints, signals, type JointDef, type JointPose, type LightDef } from './articulation';
import type { FlightModel } from './model';

/**
 * a light is drawn as a small self-lit diamond: this radius, m, or this share of the camera distance if
 * larger (about 1.5 px at 1080 lines), so it still reads as a point of light from afar
 */
const LIGHT_SIZE = 0.14;
const LIGHT_ANGLE = 0.004;

/**
 * The world shader takes only an offset uniform, so the airframe (a few hundred triangles)
 * is rotated on the CPU each frame and re-uploaded (a few KB, negligible).
 */
export class AircraftRenderer {
  private gl: WebGL2RenderingContext;
  private mesh: Mesh;
  private vbo: WebGLBuffer;
  private rbo: WebGLBuffer;
  private base: Float32Array;
  private live: Float32Array;
  private rot = mat3.create();
  private parts: Uint8Array = new Uint8Array(0);
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

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const lights = AircraftRenderer.dynamicMesh(gl, 'lights');
    this.lMesh = lights.mesh;
    this.lvbo = lights.vbo;
    this.lrbo = lights.rbo;
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
    if (this.cfgId === cfg.id) return;
    this.cfgId = cfg.id;
    const src = aircraftMesh(cfg.id);
    this.base = src.vertices;
    this.parts = src.parts;
    this.joint = src.joint;
    this.joints = src.joints;
    this.poses = newPoses(src.joints);
    this.lights = src.lights;
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

  draw(renderer: Renderer, model: FlightModel, view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, throttle = 0, time = 0): void {
    if (model.crashed) return;
    this.ensureMesh(model.cfg);
    mat3.fromQuat(this.rot, model.quat);
    const cg = model.cfg.cg;
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
    for (let i = 0, v = 0; i < this.base.length; i += 6, v++) {
      const st = state[this.parts[v]];
      const jn = this.joint[v];
      const pose = jn ? this.poses[jn - 1] : null;
      if (st === 1 || (pose && !pose.visible)) {
        // gone, or stowed out of sight: collapse the triangle
        this.live[i] = this.live[i + 1] = this.live[i + 2] = 0;
        continue;
      }
      vec3.set(p, this.base[i], this.base[i + 1], this.base[i + 2]);
      vec3.set(n, this.base[i + 3], this.base[i + 4], this.base[i + 5]);
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
    // the flame and the lights light themselves: no rim of either kind, no two-sided flip
    renderer.selfLit = true;
    this.drawFlame(renderer, model, view, proj, camPos, sunDir, throttle, time);
    this.drawLights(renderer, model, view, proj, camPos, sunDir, time, sig, state);
    renderer.selfLit = false;
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
    const cg = model.cfg.cg;
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
    const src = flameMesh(model.cfg, throttle, time);
    if (src.ramps.length === 0) return;
    const out = new Float32Array(src.vertices.length);
    const cg = model.cfg.cg;
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