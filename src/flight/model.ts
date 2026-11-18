import { mat3, quat, vec3 } from 'gl-matrix';
import { G0 } from './atmosphere';
import { CALM_AIR, newAirSample, type Air, type AirSample } from './air';
import { PART_IDS, tableLookup, type AircraftConfig, type CarryDef, type PartId } from './aircraft';
import type { ControlInputs } from './articulation';

export const PHYSICS_STEP = 1 / 120;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const RHO0 = 1.225;

/** normal-force coefficient of a plate square to the flow: what a fully stalled surface becomes */
const CD90 = 1.3;
/** the flow separates over this many radians either side of a surface's stall angle */
const STALL_BAND = 8 * D2R;
/** control surface actuator rate, rad/s */
const ACTUATOR_RATE = 1.4;
/** fly-by-wire pitch loop: natural frequency squared, damping, integral gain */
const FBW_WN2 = 16;
const FBW_DAMP = 6.5;
const FBW_KI = 14;
/** roll-rate loop gain, 1/s */
const FBW_ROLL = 4;
/** rudder pedal authority is cut back above this dynamic pressure (rudder load limiter), Pa */
const RUDDER_Q = 12000;
/** below this airspeed the surfaces follow the stick directly */
const FBW_MIN_SPEED = 25;
/** part tips are probed against the ground only this close to it, m */
const TIP_PROBE_AGL = 150;
/** seconds of flutter beyond the never-exceed speed before something comes off */
const FLUTTER_TIME = 1.5;
const DEBRIS_LIFE = 25;
/** drawn surfaces follow the fly-by-wire commands at this many full deflections per second */
const SURFACE_RATE = 4;
/** seconds for a full gear cycle, for the flaps and for the airbrake to run out (drawing only) */
const GEAR_TIME = 6;
const FLAP_TIME = 4;
const AIRBRAKE_TIME = 2;
/** the pitot reads nothing below this true airspeed, m/s (~20 kt): the dynamic pressure is a few pascals */
const PITOT_MIN_SPEED = 10;
/** time constant of the airspeed indication, s: the pressure lines smooth out the gusts */
const PITOT_LAG = 0.6;
/** below this ground speed the flight path marker is caged at the boresight; it is fully free by PATH_FREE_SPEED, m/s */
const PATH_CAGE_SPEED = 2;
const PATH_FREE_SPEED = 8;

export interface FlightControls {
  pitch: number; // -1 push .. +1 pull
  roll: number; // -1 left .. +1 right
  yaw: number; // -1 left .. +1 right
  throttle: number; // 0..1
  gearDown: boolean;
  flaps: boolean;
  brakes: boolean;
  speedbrake: boolean;
}

export interface GroundContact {
  height: number;
  water: boolean;
  building: boolean;
}

export type GroundProbe = (pos: vec3) => GroundContact;

const flatGround: GroundProbe = () => ({ height: 0, water: false, building: false });

export type DamageCause = 'overload' | 'flutter' | 'strike' | 'collision';

export interface DamageEvent {
  part: PartId;
  cause: DamageCause;
  /** model clock when it happened, s */
  time: number;
}

/** A part that has come off: falls and tumbles on its own for a while. */
export interface Debris {
  /** index into PART_IDS */
  part: number;
  /** position of the part's pivot relative to the aircraft (world axes): survives origin rebasing */
  rel: vec3;
  vel: vec3;
  quat: quat;
  omega: vec3;
  age: number;
}

/** yaw about world up, then pitch about body right, then roll about body aft. */
export function attitudeQuat(out: quat, pitchDeg: number, headingDeg: number, rollDeg: number): quat {
  const qy = quat.setAxisAngle(quat.create(), vec3.fromValues(0, 1, 0), -headingDeg * D2R);
  const qx = quat.setAxisAngle(quat.create(), vec3.fromValues(1, 0, 0), pitchDeg * D2R);
  const qz = quat.setAxisAngle(quat.create(), vec3.fromValues(0, 0, 1), -rollDeg * D2R);
  quat.multiply(out, qy, qx);
  return quat.multiply(out, out, qz);
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** a lifting surface as the integrator uses it: flat numbers, radians, signed control travels */
interface Surf {
  part: number;
  /** aerodynamic centre from the current centre of gravity (moves with damage) */
  px: number; py: number; pz: number;
  /** as designed: from the intact aircraft's centre of gravity, and the intact lift curve */
  bx: number; by: number; bz: number;
  base: { cla: number; alpha0: number; stall: number; k: number };
  carry: CarryDef | null;
  nx: number; ny: number;
  area: number;
  cla: number;
  alpha0: number;
  stall: number;
  k: number;
  tau: number;
  /** deflection per unit pitch / roll / yaw command, signed so that +command gives nose up / roll right / yaw right */
  sp: number; sr: number; sy: number;
  max: number;
  flap: boolean;
  shield: number;
  /** current deflection and last local angle of attack */
  defl: number;
  alpha: number;
}

/**
 * Six-degree-of-freedom rigid body flown through moving air.
 *
 * Aerodynamics is a strip model: every surface in the aircraft's config gets the air velocity at its
 * own position (aircraft velocity minus wind, plus the aircraft's rotation), its own angle of attack
 * and a lift/drag curve that is valid all the way round (attached flow blending into a flat plate
 * past the stall). Forces act where the surfaces are, so stability, damping, wing drop, spins and
 * the behaviour with a wing missing are consequences of geometry.
 *
 * The pilot's stick goes through a fly-by-wire layer (load-factor / angle-of-attack command in pitch,
 * roll-rate command, yaw damper) that moves the actual control surfaces at a finite rate.
 */
export class FlightModel {
  readonly pos = vec3.create();
  readonly vel = vec3.create();
  readonly quat = quat.create();
  readonly omega = vec3.create(); // body rates: x pitch, y yaw, z roll (right-hand)
  onGround = false;
  crashed = false;
  crashReason = '';
  touchdownSink = 0;
  touchdownTimer = 0;
  stall = false;
  /** stalled and rotating: a developed spin */
  spin = false;
  alphaDeg = 0;
  betaDeg = 0;
  gLoad = 1;
  /** true airspeed, m/s (speed is over the ground) */
  airspeed = 0;
  /** equivalent airspeed, m/s: what the wing feels */
  eas = 0;
  /** airspeed as an instrument shows it, m/s: lagged, zero below the pitot's threshold */
  indicatedSpeed = 0;
  /** the air data (indicated speed, angle of attack) is meaningful: the pitot reads */
  airDataValid = false;
  /**
   * direction of travel over the ground relative to the nose, degrees, alpha/beta convention, for the
   * flight path marker; caged toward 0 at a standstill, where the direction of a crawl means nothing
   */
  pathAlphaDeg = 0;
  pathBetaDeg = 0;
  mach = 0;
  /** air velocity at the aircraft, world axes, m/s */
  readonly wind = vec3.create();
  /** outside air temperature, K */
  oat = 288.15;
  /** per PART_IDS index: the part has separated */
  readonly lost: boolean[] = PART_IDS.map(() => false);
  readonly damage: DamageEvent[] = [];
  readonly debris: Debris[] = [];
  /** mass and inertias as they are now: the separated parts took theirs with them */
  mass: number;
  readonly inertia: [number, number, number];
  /** where the centre of gravity has moved since the parts came off, body axes, m */
  readonly cgShift = vec3.create();
  /** model clock, s */
  time = 0;
  /**
   * Where the moving parts are drawn (articulation.ts): the fly-by-wire commands, and the gear, flaps and
   * airbrake running at their actuator speeds. The physics itself uses the switches as they are.
   */
  readonly actuators: ControlInputs = {
    pitch: 0, roll: 0, yaw: 0, flaps: 0, speedbrake: 0, gear: 1, nav: 1, beacon: 1, landing: 1,
  };
  /** the next step puts the actuators where the controls are, without travel (after a spawn) */
  private snapActuators = true;

  private rot = mat3.create();
  private tmpQ = quat.create();
  private tmpV = vec3.create();
  private acc = 0;
  private readonly air = newAirSample();
  private readonly surfs: Surf[];
  private readonly partSlots: { idx: number; tip: [number, number, number]; maxLoad: number; mass: number; cm: [number, number, number] }[];
  private readonly load = PART_IDS.map(() => 0);
  private readonly loadF = PART_IDS.map(() => 0);
  /** whole-aircraft lift slope (per rad) and zero-alpha lift, for the fly-by-wire */
  private readonly cla: number;
  private readonly cl0: number;
  private readonly clMax: number;
  private readonly flapAlpha: number;
  /** control moment per unit command per Pa of dynamic pressure, intact airframe */
  private readonly pitchEff: number;
  private readonly rollEff: number;
  private readonly yawEff: number;
  /** roll damping moment per unit (dynamic pressure x roll rate / airspeed) */
  private readonly rollDamp: number;
  private fbwI = 0;
  private nz = 1;
  private flutter = 0;
  private probeTurn = 0;

  constructor(readonly cfg: AircraftConfig) {
    this.mass = cfg.mass;
    this.inertia = [...cfg.inertia];
    let cla = 0, cl0 = 0, flapSum = 0, pe = 0, re = 0, ye = 0, damp = 0;
    this.surfs = cfg.surfaces.map((d) => {
      const [px, py, pz] = d.pos;
      const [nx, ny] = d.normal;
      // moment of a unit force along the normal: tells which way a deflection turns the aircraft
      const mx = -pz * ny;
      const my = pz * nx;
      const mz = px * ny - py * nx;
      const tau = d.tau ?? 0;
      const travel = (deg: number | undefined, m: number): number => (deg ? deg * D2R * Math.sign(m) : 0);
      const s: Surf = {
        part: d.part ? PART_IDS.indexOf(d.part) : -1,
        px, py, pz, nx, ny,
        bx: px, by: py, bz: pz,
        base: { cla: d.cla, alpha0: (d.alpha0 ?? 0) * D2R, stall: d.stall * D2R, k: d.k },
        carry: d.carry ? { ...d.carry, stall: d.carry.stall * D2R } : null,
        area: d.area, cla: d.cla, alpha0: (d.alpha0 ?? 0) * D2R, stall: d.stall * D2R, k: d.k, tau,
        sp: travel(d.pitch, mx), // nose up = +x moment
        sr: travel(d.roll, -mz), // roll right = -z moment
        sy: travel(d.yaw, -my), // yaw right = -y moment
        max: ((d.pitch ?? 0) + (d.roll ?? 0) + (d.yaw ?? 0)) * D2R,
        flap: d.flap ?? false,
        shield: d.shield ?? 0,
        defl: 0,
        alpha: 0,
      };
      const lift = d.area * d.cla * ny * ny;
      cla += lift;
      cl0 += lift * s.alpha0;
      damp += d.area * d.cla * mz * mz;
      if (s.flap) flapSum += d.area * d.cla;
      const power = d.area * d.cla * tau;
      pe += power * Math.abs(s.sp * mx);
      re += power * Math.abs(s.sr * mz);
      ye += power * Math.abs(s.sy * my);
      return s;
    });
    this.cla = cla / cfg.wingArea;
    this.cl0 = cl0 / cfg.wingArea;
    this.clMax = this.cl0 + this.cla * cfg.stallAlpha * D2R * 0.8;
    this.flapAlpha = flapSum > 0 ? (cfg.flapClBonus * cfg.wingArea) / flapSum : 0;
    this.pitchEff = Math.max(pe, 1e-3);
    this.rollEff = Math.max(re, 1e-3);
    this.yawEff = Math.max(ye, 1e-3);
    this.rollDamp = damp;
    this.partSlots = cfg.parts.map((p) => {
      // the part's mass sits at the centroid of its surfaces
      const own = cfg.surfaces.filter((s) => s.part === p.id);
      const area = own.reduce((a, s) => a + s.area, 0);
      const cm: [number, number, number] = [0, 0, 0];
      for (const s of own) for (let i = 0; i < 3; i++) cm[i] += (s.pos[i] * s.area) / area;
      return { idx: PART_IDS.indexOf(p.id), tip: p.tip, maxLoad: p.maxLoad, mass: cfg.partMass[p.id] ?? 0, cm };
    });
  }

  /** the drawing's origin as it now sits on the airframe: mesh coordinates of the current centre of gravity */
  get meshCg(): [number, number, number] {
    const c = this.cfg.cg;
    return [c[0] + this.cgShift[0], c[1] + this.cgShift[1], c[2] + this.cgShift[2]];
  }

  /**
   * Puts every surface where it now is relative to the centre of gravity, and gives the fuselage the lift
   * it has left with the wings it has left.
   */
  private refit(): void {
    const iL = PART_IDS.indexOf('wingL');
    const iR = PART_IDS.indexOf('wingR');
    const [cx, cy, cz] = this.cgShift;
    for (const s of this.surfs) {
      const b = s.base;
      s.cla = b.cla;
      s.alpha0 = b.alpha0;
      s.stall = b.stall;
      s.k = b.k;
      let shift = 0;
      const c = s.carry;
      if (c) {
        // each wing carries over its half; what remains of that acts on its own side of the body
        const cL = (c.share / 2) * (this.lost[iL] ? 0 : 1);
        const cR = (c.share / 2) * (this.lost[iR] ? 0 : 1);
        const keep = 1 - c.share + cL + cR;
        const gone = 1 - (cL + cR) / c.share;
        s.cla = b.cla * keep;
        s.alpha0 = b.alpha0 * (1 - gone);
        s.stall = b.stall + (c.stall - b.stall) * gone;
        // induced drag of the remaining span: it grows as the lifting span shrinks to the body's
        s.k = b.k + (c.k - b.k) * gone;
        shift = (c.offset * (cR - cL)) / keep;
      }
      s.px = s.bx + shift - cx;
      s.py = s.by - cy;
      s.pz = s.bz - cz;
    }
  }

  /** a design position (from the intact aircraft's centre of gravity) relative to the current one */
  private here(out: vec3, p: readonly number[]): vec3 {
    return vec3.set(out, p[0] - this.cgShift[0], p[1] - this.cgShift[1], p[2] - this.cgShift[2]);
  }

  /** speed over the ground (inertial), m/s */
  get speed(): number {
    return vec3.length(this.vel);
  }

  get verticalSpeed(): number {
    return this.vel[1];
  }

  private basis(): void {
    mat3.fromQuat(this.rot, this.quat);
  }

  forward(out: vec3): vec3 {
    this.basis();
    return vec3.transformMat3(out, vec3.fromValues(0, 0, -1), this.rot);
  }

  get pitchDeg(): number {
    const f = this.forward(vec3.create());
    return Math.asin(Math.max(-1, Math.min(1, f[1]))) * R2D;
  }

  get bankDeg(): number {
    this.basis();
    const right = vec3.transformMat3(vec3.create(), vec3.fromValues(1, 0, 0), this.rot);
    return Math.asin(Math.max(-1, Math.min(1, -right[1]))) * R2D;
  }

  get headingDeg(): number {
    const f = this.forward(vec3.create());
    return ((Math.atan2(f[0], -f[2]) * R2D) % 360 + 360) % 360;
  }

  /** direction of travel over the ground, degrees true (heading when not moving) */
  get trackDeg(): number {
    if (Math.hypot(this.vel[0], this.vel[2]) < 3) return this.headingDeg;
    return ((Math.atan2(this.vel[0], -this.vel[2]) * R2D) % 360 + 360) % 360;
  }

  isLost(part: PartId): boolean {
    return this.lost[PART_IDS.indexOf(part)];
  }

  /** deflection of every control surface, rad, in the order of cfg.surfaces (for drawing and tests) */
  get deflections(): number[] {
    return this.surfs.map((s) => s.defl);
  }

  private reset(): void {
    vec3.zero(this.omega);
    this.crashed = false;
    this.crashReason = '';
    this.stall = false;
    this.spin = false;
    this.lost.fill(false);
    this.damage.length = 0;
    this.debris.length = 0;
    this.mass = this.cfg.mass;
    this.inertia[0] = this.cfg.inertia[0];
    this.inertia[1] = this.cfg.inertia[1];
    this.inertia[2] = this.cfg.inertia[2];
    vec3.zero(this.cgShift);
    this.load.fill(0);
    this.loadF.fill(0);
    this.fbwI = 0;
    this.nz = 1;
    this.flutter = 0;
    this.touchdownTimer = 0;
    this.indicatedSpeed = 0;
    this.airDataValid = false;
    this.pathAlphaDeg = 0;
    this.pathBetaDeg = 0;
    this.snapActuators = true;
    for (const s of this.surfs) {
      s.defl = 0;
      s.alpha = 0;
    }
    this.refit();
  }

  spawnAir(position: vec3, headingDeg: number): void {
    this.reset();
    vec3.copy(this.pos, position);
    attitudeQuat(this.quat, 0, headingDeg, 0);
    const f = this.forward(vec3.create());
    vec3.scale(this.vel, f, this.cfg.cruiseSpeed * 0.7);
    this.airspeed = this.speed;
    this.indicatedSpeed = this.speed;
    this.airDataValid = true;
    this.onGround = false;
  }

  spawnGround(position: vec3, headingDeg: number, groundHeight: number): void {
    this.reset();
    vec3.set(this.pos, position[0], groundHeight + this.cfg.gearHeight, position[2]);
    attitudeQuat(this.quat, 0, headingDeg, 0);
    vec3.zero(this.vel);
    this.airspeed = 0;
    this.onGround = true;
  }

  /** Fixed-step accumulator; returns number of physics steps taken. */
  update(dt: number, controls: FlightControls, probe: GroundProbe = flatGround, air: Air = CALM_AIR): number {
    this.acc = Math.min(this.acc + dt, PHYSICS_STEP * 10);
    let steps = 0;
    while (this.acc >= PHYSICS_STEP) {
      this.acc -= PHYSICS_STEP;
      steps++;
      if (!this.crashed) this.step(PHYSICS_STEP, controls, probe, air);
    }
    this.touchdownTimer = Math.max(0, this.touchdownTimer - dt);
    return steps;
  }

  /** The airframe is destroyed: everything stops. */
  destroy(reason: string): void {
    this.crashed = true;
    this.crashReason = reason;
    vec3.zero(this.vel);
    vec3.zero(this.omega);
  }

  /**
   * A part breaks off. `impulse` (N·s, world axes) is the blow that did it, applied at the part's tip:
   * it slows the aircraft and slews it round the point of contact.
   */
  detach(part: PartId, cause: DamageCause, impulse?: vec3): boolean {
    const idx = PART_IDS.indexOf(part);
    const slot = this.partSlots.find((p) => p.idx === idx);
    if (!slot || this.lost[idx]) return false;
    this.lost[idx] = true;
    this.damage.push({ part, cause, time: this.time });
    this.basis();
    const R = this.rot;
    const [tx, ty, tz] = this.here(vec3.create(), slot.tip);
    if (impulse) {
      const m = this.mass;
      vec3.scaleAndAdd(this.vel, this.vel, impulse, 1 / m);
      // impulse into body axes, then the angular kick of r x J
      const jx = impulse[0] * R[0] + impulse[1] * R[1] + impulse[2] * R[2];
      const jy = impulse[0] * R[3] + impulse[1] * R[4] + impulse[2] * R[5];
      const jz = impulse[0] * R[6] + impulse[1] * R[7] + impulse[2] * R[8];
      const I = this.inertia;
      this.omega[0] += (ty * jz - tz * jy) / I[0];
      this.omega[1] += (tz * jx - tx * jz) / I[1];
      this.omega[2] += (tx * jy - ty * jx) / I[2];
    }
    // the piece leaves from where it was, carrying the aircraft's motion plus a tumble of its own
    const side = Math.sign(tx) || 1;
    const rel = vec3.fromValues(tx * 0.6, ty * 0.6, tz);
    vec3.transformMat3(rel, rel, R);
    const vel = vec3.clone(this.vel);
    vel[0] += R[0] * side * 3 + R[3] * 2;
    vel[1] += R[1] * side * 3 + R[4] * 2;
    vel[2] += R[2] * side * 3 + R[5] * 2;
    this.debris.push({
      part: idx, rel, vel, quat: quat.clone(this.quat),
      omega: vec3.fromValues(2.5 + (idx % 3), 1.5 * side, -4 * side), age: 0,
    });
    this.shed(slot.mass, slot.cm);
    this.refit();
    return true;
  }

  /**
   * `mp` kg leaves from `p` (design position): the centre of gravity moves away from it, the inertias lose
   * the part's share (parallel axis, the part taken as a point mass) and the airframe stays where it was.
   */
  private shed(mp: number, p: readonly number[]): void {
    if (mp <= 0) return;
    const m = this.mass;
    const rest = m - mp;
    const c = this.cgShift;
    const r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const d = r.map((v) => (-mp * v) / rest);
    const I = this.inertia;
    const I0 = this.cfg.inertia;
    // pitch about x, yaw about y, roll about z; never below a third of the intact value (the panels are not
    // point masses, and the fuselage keeps most of its own)
    const perp = (v: number[], i: number): number => v[(i + 1) % 3] ** 2 + v[(i + 2) % 3] ** 2;
    for (let i = 0; i < 3; i++) I[i] = Math.max(I0[i] / 3, I[i] - mp * perp(r, i) - rest * perp(d, i));
    this.mass = rest;
    // the reference point follows the centre of gravity: move it in the world by the same amount
    this.basis();
    const R = this.rot;
    for (let i = 0; i < 3; i++) {
      const dw = R[i] * d[0] + R[3 + i] * d[1] + R[6 + i] * d[2];
      this.pos[i] += dw;
      // debris is kept relative to that point
      for (const b of this.debris) b.rel[i] -= dw;
    }
    c[0] += d[0];
    c[1] += d[1];
    c[2] += d[2];
  }

  private stepDebris(dt: number): void {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age > DEBRIS_LIFE) {
        this.debris.splice(i, 1);
        continue;
      }
      // a tumbling panel: lots of drag, terminal velocity around 50 m/s
      const v = vec3.length(d.vel);
      vec3.scale(d.vel, d.vel, Math.max(0, 1 - 0.004 * v * dt));
      d.vel[1] -= G0 * dt;
      d.rel[0] += (d.vel[0] - this.vel[0]) * dt;
      d.rel[1] += (d.vel[1] - this.vel[1]) * dt;
      d.rel[2] += (d.vel[2] - this.vel[2]) * dt;
      const w = vec3.length(d.omega);
      quat.setAxisAngle(this.tmpQ, vec3.scale(this.tmpV, d.omega, 1 / w), w * dt);
      quat.multiply(d.quat, d.quat, this.tmpQ);
      quat.normalize(d.quat, d.quat);
    }
  }

  private moveActuators(dt: number, c: FlightControls, pitch: number, roll: number, yaw: number): void {
    const a = this.actuators;
    const snap = this.snapActuators;
    const go = (cur: number, target: number, rate: number): number => (snap ? target : cur + clamp(target - cur, -rate * dt, rate * dt));
    a.pitch = go(a.pitch, pitch, SURFACE_RATE);
    a.roll = go(a.roll, roll, SURFACE_RATE);
    a.yaw = go(a.yaw, yaw, SURFACE_RATE);
    a.flaps = go(a.flaps, c.flaps ? 1 : 0, 1 / FLAP_TIME);
    a.speedbrake = go(a.speedbrake, c.speedbrake ? 1 : 0, 1 / AIRBRAKE_TIME);
    a.gear = go(a.gear, c.gearDown ? 1 : 0, 1 / GEAR_TIME);
    this.snapActuators = false;
  }

  private step(dt: number, c: FlightControls, probe: GroundProbe, env: Air): void {
    const cfg = this.cfg;
    this.time += dt;
    this.basis();
    const R = this.rot; // columns are the body axes in world space
    const S = cfg.wingArea;
    const W = this.mass * G0;

    const contact = probe(this.pos);
    const agl = this.pos[1] - contact.height;
    const A: AirSample = env.sample(this.air, this.pos[1], agl, this.airspeed, dt, cfg.wingSpan);
    vec3.copy(this.wind, A.wind);
    this.oat = A.temperature;
    const rho = A.density;

    // velocity through the air, body axes
    const ax = this.vel[0] - A.wind[0];
    const ay = this.vel[1] - A.wind[1];
    const az = this.vel[2] - A.wind[2];
    const ub = ax * R[0] + ay * R[1] + az * R[2];
    const vb = ax * R[3] + ay * R[4] + az * R[5];
    const wb = ax * R[6] + ay * R[7] + az * R[8];
    const V = Math.hypot(ax, ay, az);
    const alpha = V > 1 ? Math.atan2(-vb, -wb) : 0;
    const beta = V > 1 ? Math.asin(clamp(ub / V, -1, 1)) : 0;
    const qbar = 0.5 * rho * V * V;
    this.airspeed = V;
    this.eas = V * Math.sqrt(rho / RHO0);
    this.mach = V / A.speedOfSound;
    this.alphaDeg = alpha * R2D;
    this.betaDeg = beta * R2D;
    const pitot = V >= PITOT_MIN_SPEED ? V : 0;
    this.indicatedSpeed += (pitot - this.indicatedSpeed) * Math.min(1, dt / PITOT_LAG);
    if (pitot === 0 && this.indicatedSpeed < 0.5) this.indicatedSpeed = 0;
    this.airDataValid = this.indicatedSpeed > 0;

    // flight path over the ground, body axes: where the aircraft is actually going
    {
      const gv = this.vel;
      const gs = Math.hypot(gv[0], gv[1], gv[2]);
      const free = smooth((gs - PATH_CAGE_SPEED) / (PATH_FREE_SPEED - PATH_CAGE_SPEED));
      if (free > 0) {
        const gu = gv[0] * R[0] + gv[1] * R[1] + gv[2] * R[2];
        const gvb = gv[0] * R[3] + gv[1] * R[4] + gv[2] * R[5];
        const gw = gv[0] * R[6] + gv[1] * R[7] + gv[2] * R[8];
        this.pathAlphaDeg = Math.atan2(-gvb, -gw) * R2D * free;
        this.pathBetaDeg = Math.asin(clamp(gu / gs, -1, 1)) * R2D * free;
      } else {
        this.pathAlphaDeg = 0;
        this.pathBetaDeg = 0;
      }
    }

    const wx = this.omega[0];
    const wy = this.omega[1];
    const wz = this.omega[2];
    const bank = Math.asin(clamp(-R[1], -1, 1));

    // ---- fly-by-wire: stick -> normalised pitch / roll / yaw commands -------------------------
    let P: number;
    let Rc: number;
    let Y: number;
    const fbwOn = !this.onGround && V > FBW_MIN_SPEED;
    if (!fbwOn) {
      P = c.pitch;
      Rc = c.roll;
      Y = c.yaw;
      this.fbwI = 0;
    } else {
      const f = cfg.fbw;
      const qf = Math.max(qbar, 400);
      // pitch: the stick asks for load factor; the limiter turns that into an angle of attack it may reach
      const nCmd = c.pitch >= 0 ? 1 + c.pitch * (f.gMax - 1) : 1 + c.pitch * (1 - f.gMin);
      const aMax = (f.alphaLimit + (f.alphaOverride - f.alphaLimit) * smooth((c.pitch - 0.85) / 0.15)) * D2R;
      // the angle of attack that would close the gap between the load factor asked for and the one measured
      const aNeed = alpha + ((nCmd - this.nz) * W) / (qf * S * this.cla);
      const aCmd = clamp(aNeed, -0.6 * f.alphaLimit * D2R, aMax);
      const e = aCmd - alpha;
      // rate of change of alpha: pitch rate less the rate the flight path is already turning
      const alphaDot = wx - (G0 / Math.max(V, 40)) * (this.nz - R[4]);
      const raw = ((FBW_WN2 * e - FBW_DAMP * alphaDot + this.fbwI) * this.inertia[0]) / (qf * this.pitchEff);
      P = clamp(raw, -1, 1);
      if (P === raw || Math.sign(e) !== Math.sign(raw)) this.fbwI = clamp(this.fbwI + FBW_KI * e * dt, -8, 8);
      // roll: rate command; hands off and upright it eases the wings level
      const level = Math.max(0, 1 - Math.abs(c.roll) / 0.1);
      const pCmd = c.roll * f.rollRate - level * clamp(0.8 * Math.atan2(-R[1], R[4]), -0.6, 0.6);
      // the rate error, plus the aileron it takes to hold that rate against the wing's roll damping
      Rc = clamp(((pCmd + wz) * FBW_ROLL * this.inertia[2] + (this.rollDamp * qbar * pCmd) / Math.max(V, 40)) / (qf * this.rollEff), -1, 1);
      // yaw: pedals (load-limited at speed) plus sideslip suppression and a yaw damper around the turn rate
      const rTurn = (G0 * Math.sin(bank)) / Math.max(V, 40);
      const yAcc = 5 * beta - 2 * (-wy - rTurn);
      // (the damper's authority is limited, and it is scheduled out past the stall where it would only fight the pilot)
      const yLim = 0.5 * (1 - smooth((Math.abs(alpha) - 22 * D2R) / (15 * D2R)));
      Y = clamp(c.yaw * Math.min(1, RUDDER_Q / qf) + clamp((yAcc * this.inertia[1]) / (qf * this.yawEff), -yLim, yLim), -1, 1);
    }

    this.moveActuators(dt, c, P, Rc, Y);

    // ---- aerodynamic forces and moments, body axes ---------------------------------------------
    let Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
    const load = this.load;
    load.fill(0);
    // rolling gusts: the air itself turns about the flight direction
    const wzAir = wz - A.gustRoll;
    // top-mounted fins sit in the wing's wake once the nose is well up
    const wake = smooth((Math.abs(alpha) - 25 * D2R) / (30 * D2R));
    // ground effect: the ground cuts the trailing vortices, so less induced drag and a little more lift
    const gx = agl < cfg.wingSpan ? (16 * Math.max(agl, 0.5)) / cfg.wingSpan : 0;
    const ge = gx > 0 ? (gx * gx) / (1 + gx * gx) : 1;
    const maxStep = ACTUATOR_RATE * dt;
    for (const s of this.surfs) {
      if (s.part >= 0 && this.lost[s.part]) continue;
      // control deflection: commanded, limited, rate-limited
      if (s.max > 0) {
        let d = P * s.sp + Rc * s.sr + Y * s.sy;
        const lim = s.stall - 2 * D2R;
        if (s.tau === 1 && fbwOn && Math.abs(s.alpha) < lim + s.max) {
          // the computers never drive an all-moving surface past its own stall (that would lose the control
          // power) for as long as its travel can keep the flow attached at all
          d = clamp(d, -lim - s.alpha, lim - s.alpha);
        }
        d = clamp(d, -s.max, s.max);
        s.defl += clamp(d - s.defl, -maxStep, maxStep);
      }
      // air velocity at the surface, in the plane of its chord and its normal
      const vx = ub + (wy * s.pz - wzAir * s.py);
      const vy = vb + (wzAir * s.px - wx * s.pz);
      const vz = wb + (wx * s.py - wy * s.px);
      const vf = -vz;
      const vn = vx * s.nx + vy * s.ny;
      const v2 = vf * vf + vn * vn;
      if (v2 < 4) {
        s.alpha = 0;
        continue;
      }
      const a = Math.atan2(-vn, vf);
      s.alpha = a;
      const lifting = s.ny > 0.9;
      const qa = 0.5 * rho * v2 * s.area * (1 - s.shield * wake);
      const flap = s.flap && c.flaps ? this.flapAlpha : 0;
      const aAtt = a + s.alpha0 + flap + s.tau * s.defl;
      const aPl = a + (s.tau === 1 ? s.defl : 0.3 * s.tau * s.defl);
      // attached share: 1 below the stall, 0 well beyond it and for flow from behind
      // (a lowered flap adds lift without bringing the stall forward by as much: it raises the maximum)
      const att = vf > 0 ? 1 - smooth((Math.abs(aAtt - 0.7 * flap) - (s.stall - STALL_BAND)) / (2 * STALL_BAND)) : 0;
      const clA = s.cla * aAtt * (lifting ? 1 + 0.08 * (1 - ge) : 1);
      const sp = Math.sin(aPl);
      const cp = Math.cos(aPl);
      const cl = att * clA + (1 - att) * CD90 * sp * cp;
      const cd = att * s.k * (lifting ? ge : 1) * clA * clA + (1 - att) * CD90 * sp * sp;
      const inv = 1 / Math.sqrt(v2);
      // lift is square to the local flow, drag along it
      const Ff = qa * (-cl * vn - cd * vf) * inv;
      const Fn = qa * (cl * vf - cd * vn) * inv;
      const fx = Fn * s.nx;
      const fy = Fn * s.ny;
      const fz = -Ff;
      Fx += fx;
      Fy += fy;
      Fz += fz;
      Mx += s.py * fz - s.pz * fy;
      My += s.pz * fx - s.px * fz;
      Mz += s.px * fy - s.py * fx;
      if (s.part >= 0) load[s.part] += Fn;
    }
    if (V > 0.5) {
      // zero-lift drag of the whole airframe, rising through the transonic range
      const cd0 = cfg.cd0 * tableLookup(cfg.waveDrag, this.mach) +
        (c.gearDown ? cfg.gearCd : 0) + (c.flaps ? cfg.flapCd : 0) + (c.speedbrake ? cfg.speedbrakeCd : 0);
      const k = (-qbar * S * cd0) / V;
      Fx += ub * k;
      Fy += vb * k;
      Fz += wb * k;
      // fuselage in cross-flow: drag along the flow across it, so in a spin (air coming up from below at
      // tens of m/s) any sideways motion of the nose and tail is resisted in proportion to that flow
      // (the aft station carries more of the side area and a longer arm, so the pair is stabilising)
      for (let i = 0; i < 2; i++) {
        const z = (i === 0 ? cfg.nose[2] * 0.5 : cfg.tail[2] * 0.75) - this.cgShift[2];
        const k = 0.5 * rho * cfg.bodySide * (i === 0 ? 0.4 : 0.6);
        const vx = ub + wy * z;
        const vy = vb - wx * z;
        const fx = -k * Math.hypot(vx, vy) * vx;
        Fx += fx;
        My += z * fx;
      }
      if (cfg.spinYaw > 0) {
        // nose high and turning: the forebody vortices push the nose further round (flat spin).
        // Bounded by the oncoming dynamic pressure, so the fins' damping sets a steady spin rate.
        const aa = Math.abs(alpha);
        // (the vortices need the nose well up, and are gone again when the flow meets it square on)
        const g = smooth((aa - 30 * D2R) / (15 * D2R)) * (1 - smooth((aa - 80 * D2R) / (15 * D2R)));
        if (g > 0) My += cfg.spinYaw * qbar * S * cfg.wingSpan * g * Math.tanh((wy * cfg.wingSpan) / (2 * V) / 0.15);
      }
    }
    // thrust: falls with air density (so with altitude and heat); the afterburner gains from ram pressure
    const abFrac = cfg.thrustAfterburner > cfg.thrustDry ? Math.max(0, (c.throttle - 0.85) / 0.15) : 0;
    const lapse = Math.pow(rho / RHO0, 0.7);
    const thrust = lapse * c.throttle * (
      cfg.thrustDry * (1 - 0.12 * Math.min(this.mach, 1.5)) +
      (cfg.thrustAfterburner - cfg.thrustDry) * abFrac * (1 + 0.25 * this.mach * this.mach)
    );
    Fz -= thrust;

    this.nz = Fy / W;
    this.gLoad = this.onGround ? 1 : this.nz;
    this.stall = !this.onGround && V > 10 && (Math.abs(this.alphaDeg) > cfg.stallAlpha || qbar * S * this.clMax < 0.85 * W);
    this.spin = this.stall && Math.abs(this.alphaDeg) > cfg.stallAlpha && Math.abs(wy) > 0.7 && V < 130;

    const accel = this.tmpV;
    accel[0] = (R[0] * Fx + R[3] * Fy + R[6] * Fz) / this.mass;
    accel[1] = (R[1] * Fx + R[4] * Fy + R[7] * Fz) / this.mass - G0;
    accel[2] = (R[2] * Fx + R[5] * Fy + R[8] * Fz) / this.mass;

    // Euler's equations: the gyroscopic terms are what flatten a spin
    const [Ix, Iy, Iz] = this.inertia;
    let aaX = (Mx + (Iy - Iz) * wy * wz) / Ix;
    let aaY = (My + (Iz - Ix) * wz * wx) / Iy;
    const aaZ = (Mz + (Ix - Iy) * wx * wy) / Iz;

    // ---- structure ---------------------------------------------------------------------------
    if (!this.onGround) {
      const lp = Math.min(1, dt / 0.06);
      for (const p of this.partSlots) {
        if (this.lost[p.idx]) continue;
        this.loadF[p.idx] += (Math.abs(load[p.idx]) - this.loadF[p.idx]) * lp;
        if (this.loadF[p.idx] > p.maxLoad) this.detach(PART_IDS[p.idx], 'overload');
      }
      if (this.eas > cfg.vne * 1.1) {
        this.flutter += dt;
        if (this.flutter > FLUTTER_TIME) {
          // tail surfaces go first, then the wings
          const order: PartId[] = ['finL', 'stabR', 'finR', 'stabL', 'wingL', 'wingR'];
          const next = order.find((id) => this.partSlots.some((p) => PART_IDS[p.idx] === id) && !this.isLost(id));
          if (next) this.detach(next, 'flutter');
          this.flutter = FLUTTER_TIME * 0.4;
        }
      } else {
        this.flutter = Math.max(0, this.flutter - dt);
      }
    }

    // ---- ground and obstacles ------------------------------------------------------------------
    const clearance = c.gearDown ? cfg.gearHeight : 0.5;
    const groundY = contact.height + clearance;
    const rightX = R[0], rightY = R[1], rightZ = R[2];

    if (contact.building) return this.destroy('BUILDING STRIKE');
    if (this.onGround) {
      if (contact.water) return this.destroy('WATER IMPACT');
      if (!c.gearDown) return this.destroy('GEAR-UP LANDING');
      // tires: vertical clamp, strong roll centering, pitch free to rotate within limits
      accel[1] = Math.max(accel[1], 0);
      this.omega[2] *= Math.max(0, 1 - 12 * dt);
      const pitch = this.pitchDeg;
      if (pitch < -0.5) this.omega[0] += (-0.5 - pitch) * D2R * 10;
      if (pitch > 14) this.omega[0] -= (pitch - 14) * D2R * 10;
      // gear holds the airframe level until the pilot rotates
      const targetPitch = c.pitch > 0.15 ? Math.min(14, c.pitch * 14) : 0;
      aaX = (targetPitch - pitch) * D2R * 60 - this.omega[0] * 11;
      // rolling resistance + wheel brakes along horizontal motion
      const hs = Math.hypot(this.vel[0], this.vel[2]);
      if (hs > 0.01) {
        const decel = Math.min(hs / dt, 0.3 + (c.brakes ? cfg.brakeDecel : 0));
        accel[0] -= (this.vel[0] / hs) * decel;
        accel[2] -= (this.vel[2] / hs) * decel;
      }
      // tire lateral grip: kill sideways slip
      const latV = this.vel[0] * rightX + this.vel[1] * rightY + this.vel[2] * rightZ;
      accel[0] -= rightX * latV * 6;
      accel[1] -= rightY * latV * 6;
      accel[2] -= rightZ * latV * 6;
      // the wheels resist yaw; at a crawl they hold the heading against the wind altogether
      const grip = clamp(1 - hs / 25, 0, 1);
      aaY = aaY * (1 - grip) - this.omega[1] * (2 + 8 * grip);
      // nosewheel steering at taxi speed
      if (hs < 40) aaY += -c.yaw * 0.8 * Math.min(1, hs / 10);
      if (this.pos[1] > groundY + 0.12 && this.vel[1] > 0.5) {
        this.onGround = false; // rotated off the runway
      }
    } else if (this.pos[1] <= groundY && this.vel[1] <= 0.5) {
      const sink = -this.vel[1];
      if (contact.water) return this.destroy('WATER IMPACT');
      if (!c.gearDown) return this.destroy('GEAR-UP LANDING');
      if (sink > cfg.landingSinkLimit) return this.destroy('HARD IMPACT');
      if (Math.abs(bank * R2D) > cfg.landingBankLimit || R[4] < 0) return this.destroy('WINGTIP STRIKE');
      this.onGround = true;
      // a bounce with residual upward velocity must not keep the airframe creeping up the runway
      if (this.vel[1] > 0) this.vel[1] = 0;
      this.touchdownSink = sink;
      this.touchdownTimer = 2;
    }

    // extremities against terrain and buildings: one point per step, only near the ground
    if (agl < TIP_PROBE_AGL && !this.crashed) {
      const n = this.partSlots.length + 2;
      const turn = this.probeTurn++ % n;
      const slot = turn < this.partSlots.length ? this.partSlots[turn] : null;
      if (!slot || !this.lost[slot.idx]) {
        const t = slot ? slot.tip : turn === this.partSlots.length ? cfg.nose : cfg.tail;
        const tip = this.here(vec3.create(), t);
        vec3.transformMat3(tip, tip, R);
        vec3.add(tip, tip, this.pos);
        const hit = probe(tip);
        if (hit.building || tip[1] < hit.height - 0.2) {
          if (!slot) return this.destroy(hit.building ? 'BUILDING STRIKE' : hit.water ? 'WATER IMPACT' : 'TERRAIN IMPACT');
          // the part is torn off; the blow takes a little speed and slews the aircraft round the contact
          const impulse = vec3.scale(vec3.create(), this.vel, -0.03 * this.mass);
          this.detach(PART_IDS[slot.idx], 'strike', impulse);
        }
      }
    }

    // ---- integration (semi-implicit Euler) -----------------------------------------------------
    vec3.scaleAndAdd(this.vel, this.vel, accel, dt);
    vec3.scaleAndAdd(this.pos, this.pos, this.vel, dt);
    if (this.onGround) {
      this.pos[1] = Math.max(this.pos[1], groundY);
      if (this.vel[1] < 0) this.vel[1] = 0;
    }
    this.omega[0] += aaX * dt;
    this.omega[1] += aaY * dt;
    this.omega[2] += aaZ * dt;
    const w = vec3.length(this.omega);
    if (w > 1e-6) {
      quat.setAxisAngle(this.tmpQ, vec3.scale(this.tmpV, this.omega, 1 / w), w * dt);
      quat.multiply(this.quat, this.quat, this.tmpQ);
      quat.normalize(this.quat, this.quat);
    }
    if (this.onGround) {
      // keep the airframe level in roll while rolling
      const target = quat.create();
      attitudeQuat(target, this.pitchDeg, this.headingDeg, 0);
      quat.slerp(this.quat, this.quat, target, Math.min(1, 6 * dt));
    }
    if (this.debris.length > 0) this.stepDebris(dt);
  }
}
