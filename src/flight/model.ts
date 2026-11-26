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
/** an oleo strut's compression under the aircraft's weight at rest, m: the tyres then sit on the ground as drawn */
const STRUT_STATIC = 0.15;
/** compression beyond which the strut bottoms out, m */
const STRUT_TRAVEL = 0.45;
/** damping of a leg against its share of the mass, as a fraction of critical */
const STRUT_DAMP = 0.7;
/** rolling resistance and the tyre's side grip, as friction coefficients */
const ROLL_MU = 0.015;
const TYRE_MU = 0.8;
/** slip speed over which a tyre's braking builds up, as a time: v / (g * this) is the share of full grip */
const SLIP_LONG = 0.03;
/** slip angle at which a tyre's side force peaks, rad; below SLIP_CRAWL m/s the slip counts as at that speed */
const SLIP_ANGLE = 8 * D2R;
const SLIP_CRAWL = 2;
/**
 * On the wheels the fly-by-wire's ground mode: the stick asks for an attitude, from the one the aircraft stands
 * at (neutral: the nose wheel on the ground) up to GROUND_PITCH_MAX at full aft stick, reached at no more than
 * GROUND_PITCH_RATE (derotating, GROUND_DEROTATE); proportional and integral gains on the pitch rate as in the
 * air. The integral carries over at lift-off and touchdown, so the nose neither slams down nor leaps up when
 * the wheels take or give the weight
 */
const GROUND_PITCH_MAX = 14 * D2R;
const GROUND_PITCH_RATE = 5 * D2R;
const GROUND_DEROTATE = 3 * D2R;
const GROUND_ATT_GAIN = 1.5;
const GROUND_KQ = 6;
const GROUND_KI = 10;
/**
 * Nose wheel steering: full travel at a walk; faster, no more than turns the aircraft at STEER_ACCEL sideways
 * at full pedal (the angle falls as 1/speed^2), so at take-off speeds the pedals mostly work the rudder
 */
const STEER_MAX = 45 * D2R;
const STEER_ACCEL = 2.5;
/** the legs look for the ground below this height of the centre of gravity, m */
const GEAR_PROBE_AGL = 40;
/** fuselage skids (nose, tail): stiffness as the depth that would carry the weight, friction, depth that is fatal */
const SKID_STATIC = 0.05;
const SKID_MU = 0.5;
const SKID_FATAL = 0.6;

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

/** the ground at a point; `surfaceOnly`: the height and water are wanted, not the buildings (a wheel's probe) */
export type GroundProbe = (pos: vec3, surfaceOnly?: boolean) => GroundContact;

const flatGround: GroundProbe = () => ({ height: 0, water: false, building: false });

/** a leg of the undercarriage as the integrator uses it */
interface Leg {
  /** bottom of the tyre at rest, from the intact aircraft's centre of gravity */
  x: number; y: number; z: number;
  steer: boolean;
  /** spring rate N/m and damping N·s/m */
  k: number;
  c: number;
  /** compression now, m (0 = off the ground) */
  comp: number;
}

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
  private tmpP = vec3.create();
  private tmpR = vec3.create();
  private tmpN = vec3.create();
  private readonly underWater: boolean[] = [];
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
  /** the undercarriage legs, then the nose and tail skids */
  private readonly legs: Leg[];
  private readonly skids: Leg[];
  /** nose to main wheels, m */
  private readonly wheelbase: number;
  /** the pitch the aircraft stands at on its wheels, rad */
  private readonly restPitch: number;
  /** friction coefficient of the wheel brakes, on the main legs */
  private readonly brakeMu: number;
  /** scratch for the ground under each contact point: x, ground height, z, then the point's own height */
  private readonly under: Float64Array;
  /** moment of the ground contact forces this step, body axes */
  private readonly contactM = vec3.create();

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
    // the weight splits between the nose and the main legs by where they stand fore and aft of the centre of
    // gravity; each leg's spring carries its share at STRUT_STATIC
    const W0 = cfg.mass * G0;
    const nose = cfg.gear.filter((g) => g.steer);
    const main = cfg.gear.filter((g) => !g.steer);
    const avgZ = (ls: typeof cfg.gear): number => ls.reduce((a, g) => a + g.pos[2], 0) / Math.max(1, ls.length);
    const zN = avgZ(nose), zM = avgZ(main);
    this.wheelbase = Math.max(1, zM - zN);
    const noseShare = nose.length && main.length && zM > zN ? clamp(zM / (zM - zN), 0.03, 0.5) : 0;
    const mainShare = main.length ? 1 - noseShare : 0;
    // the nose leg is damped against the aircraft pitching about its main wheels, not just its share of the
    // weight: otherwise the nose drops through on the derotation and the aircraft wheelbarrows
    const noseMass = (cfg.inertia[0] + cfg.mass * zM * zM) / this.wheelbase ** 2;
    this.legs = cfg.gear.map((g) => {
      const share = g.steer ? noseShare / nose.length : mainShare / main.length;
      const k = (share * W0) / (STRUT_STATIC * (1 + 3 * (STRUT_STATIC / STRUT_TRAVEL) ** 3));
      const m = g.steer ? Math.max(share * cfg.mass, noseMass / nose.length) : share * cfg.mass;
      return { x: g.pos[0], y: g.pos[1] - STRUT_STATIC, z: g.pos[2], steer: !!g.steer, k, c: 2 * STRUT_DAMP * Math.sqrt(k * m), comp: 0 };
    });
    {
      const avg = (ls: Leg[], k: 'y' | 'z'): number => ls.reduce((a, l) => a + l[k], 0) / ls.length;
      const n = this.legs.filter((l) => l.steer), m = this.legs.filter((l) => !l.steer);
      this.restPitch = n.length && m.length ? Math.atan2(avg(m, 'y') - avg(n, 'y'), avg(m, 'z') - avg(n, 'z')) : 0;
    }
    // the brakes give the config's deceleration with the weight on the main wheels
    this.brakeMu = Math.min(1, cfg.brakeDecel / G0 / Math.max(mainShare, 0.5));
    // the fuselage's ends: stiff, rough, and fatal when driven deep into the ground
    const sk = (W0 * 0.5) / SKID_STATIC;
    this.skids = [cfg.nose, cfg.tail].map((p) => ({ x: p[0], y: p[1], z: p[2], steer: false, k: sk, c: 2 * Math.sqrt(sk * cfg.mass * 0.5), comp: 0 }));
    this.under = new Float64Array((this.legs.length + this.skids.length) * 4);
  }

  /** compression of each undercarriage leg, m, in the order of cfg.gear (0 = the wheel is off the ground) */
  get gearCompression(): number[] {
    return this.legs.map((l) => l.comp);
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

  /** share of the engines still on the airframe, 0..1 */
  get engineShare(): number {
    const noz = this.cfg.nozzles;
    if (noz.length === 0) return 1;
    return noz.filter((n) => !n.part || !this.lost[n.part - 1]).length / noz.length;
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
    for (const l of this.legs) l.comp = 0;
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

  /**
   * On its wheels at `position` (the height is the ground's, `groundHeight`). With `probe`, it stands on the
   * ground as it is there: pitched and banked with the slope under its wheels, every leg at its static load.
   */
  spawnGround(position: vec3, headingDeg: number, groundHeight: number, probe?: GroundProbe): void {
    this.reset();
    // standing on its wheels: the pitch the nose and main legs give, the tyres on the ground as drawn
    attitudeQuat(this.quat, this.restPitch * R2D, headingDeg, 0);
    this.basis();
    let R = this.rot;
    let low = this.legs.length ? Infinity : -this.cfg.gearHeight;
    for (const l of this.legs) low = Math.min(low, R[1] * l.x + R[4] * (l.y + STRUT_STATIC) + R[7] * l.z);
    vec3.set(this.pos, position[0], groundHeight - low, position[2]);
    if (probe && this.legs.length >= 3) {
      this.probeUnder(probe);
      const [nx, ny, nz] = this.groundPlane(this.tmpN);
      const h = headingDeg * D2R;
      const fx = Math.sin(h), fz = -Math.cos(h);
      const along = -(nx * fx + nz * fz) / ny;
      const across = -(nx * -fz + nz * fx) / ny;
      attitudeQuat(this.quat, (this.restPitch + Math.atan(along)) * R2D, headingDeg, -Math.atan(across) * R2D);
      this.basis();
      R = this.rot;
      // then down (or up) onto the ground under the legs
      this.probeUnder(probe);
      let gap = 0;
      for (let i = 0; i < this.legs.length; i++) gap += this.under[i * 4 + 1] - this.under[i * 4 + 3];
      this.pos[1] += gap / this.legs.length - STRUT_STATIC / Math.max(ny, 0.5);
    }
    vec3.zero(this.vel);
    this.airspeed = 0;
    this.onGround = true;
    for (const l of this.legs) l.comp = STRUT_STATIC;
  }

  /** Fixed-step accumulator; returns number of physics steps taken. */
  update(dt: number, controls: FlightControls, probe: GroundProbe = flatGround, air: Air = CALM_AIR): number {
    // fixed gear stays down whatever the gear lever says
    if (this.cfg.fixedGear && !controls.gearDown) controls = { ...controls, gearDown: true };
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
    // weight on the wheels locks the gear down whatever the lever says
    a.gear = go(a.gear, c.gearDown || this.onGround ? 1 : 0, 1 / GEAR_TIME);
    this.snapActuators = false;
  }

  /** the ground under every contact point (legs, then skids) into `under`: x, ground height, z, the point's height */
  private probeUnder(probe: GroundProbe): void {
    const R = this.rot;
    const U = this.under;
    const legs = this.legs;
    const r = this.tmpR;
    for (let i = 0; i < legs.length + this.skids.length; i++) {
      const l = i < legs.length ? legs[i] : this.skids[i - legs.length];
      this.here(r, [l.x, l.y, l.z]);
      const wx = this.pos[0] + R[0] * r[0] + R[3] * r[1] + R[6] * r[2];
      const wy = this.pos[1] + R[1] * r[0] + R[4] * r[1] + R[7] * r[2];
      const wz = this.pos[2] + R[2] * r[0] + R[5] * r[1] + R[8] * r[2];
      const g = probe(vec3.set(this.tmpP, wx, wy, wz), true);
      U[i * 4] = wx;
      U[i * 4 + 1] = g.height;
      U[i * 4 + 2] = wz;
      U[i * 4 + 3] = wy;
      this.underWater[i] = g.water;
    }
  }

  /**
   * The ground's slope: a plane through the ground under the wheels (least squares, from `under`), so the springs
   * push square to it and the tyres roll along it; the aircraft runs down a slope with its brakes off. Its normal.
   */
  private groundPlane(out: vec3): vec3 {
    const U = this.under;
    const n = this.legs.length >= 3 ? this.legs.length : this.legs.length + this.skids.length;
    vec3.set(out, 0, 1, 0);
    let mx = 0, mz = 0, mh = 0;
    for (let i = 0; i < n; i++) {
      mx += U[i * 4];
      mh += U[i * 4 + 1];
      mz += U[i * 4 + 2];
    }
    mx /= n;
    mz /= n;
    mh /= n;
    let sxx = 0, sxz = 0, szz = 0, sxh = 0, szh = 0;
    for (let i = 0; i < n; i++) {
      const dx = U[i * 4] - mx, dz = U[i * 4 + 2] - mz, dh = U[i * 4 + 1] - mh;
      sxx += dx * dx;
      sxz += dx * dz;
      szz += dz * dz;
      sxh += dx * dh;
      szh += dz * dh;
    }
    const det = sxx * szz - sxz * sxz;
    if (det > 1e-6 * (sxx + szz) ** 2) {
      // (a step in the ground under one wheel, a cliff edge, is not a slope to stand on)
      const a = clamp((sxh * szz - szh * sxz) / det, -0.5, 0.5);
      const b = clamp((szh * sxx - sxh * sxz) / det, -0.5, 0.5);
      const inv = 1 / Math.hypot(a, 1, b);
      vec3.set(out, -a * inv, inv, -b * inv);
    }
    return out;
  }

  /**
   * The wheels and the fuselage skids against the ground: each undercarriage leg is a spring and a damper
   * standing on the ground under it, with a tyre that rolls along its own heading (the nose wheel steered by the
   * pedals), grips sideways and brakes; the nose and tail touch as stiff, rough skids. The forces go into
   * `accel` (world) and `contactM` (body moments). Returns whether any wheel carries weight.
   */
  private groundContact(c: FlightControls, probe: GroundProbe, gearOut: boolean, accel: vec3, bank: number): boolean {
    const cfg = this.cfg;
    const R = this.rot;
    const U = this.under;
    const legs = this.legs;
    const pts = legs.length + this.skids.length;
    const r = this.tmpR;
    const water = this.underWater;
    this.probeUnder(probe);
    const [nx, ny, nz] = this.groundPlane(this.tmpN);
    const M = this.contactM;
    vec3.zero(M);
    let fx = 0, fy = 0, fz = 0;
    let wow = false;
    let sink = 0;
    const hs = Math.hypot(this.vel[0], this.vel[2]);
    const steer = c.yaw * Math.min(STEER_MAX, (STEER_ACCEL * this.wheelbase) / Math.max(hs * hs, 1e-3));
    const [wx, wy, wz] = this.omega;
    for (let i = 0; i < pts; i++) {
      const leg = i < legs.length;
      const l = leg ? legs[i] : this.skids[i - legs.length];
      if (leg && !gearOut) {
        l.comp = 0;
        continue;
      }
      // depth below the ground, square to it
      const pen = (U[i * 4 + 1] - U[i * 4 + 3]) * ny;
      if (pen <= 0) {
        l.comp = 0;
        continue;
      }
      if (water[i]) {
        this.destroy('WATER IMPACT');
        return false;
      }
      if (!leg && pen > SKID_FATAL) {
        this.destroy('TERRAIN IMPACT');
        return false;
      }
      // velocity of the point: the aircraft's, plus its rotation about the centre of gravity
      const [rx, ry, rz] = this.here(r, [l.x, l.y, l.z]);
      const bx = wy * rz - wz * ry, by = wz * rx - wx * rz, bz = wx * ry - wy * rx;
      const vx = this.vel[0] + R[0] * bx + R[3] * by + R[6] * bz;
      const vy = this.vel[1] + R[1] * bx + R[4] * by + R[7] * bz;
      const vz = this.vel[2] + R[2] * bx + R[5] * by + R[8] * bz;
      const vn = vx * nx + vy * ny + vz * nz;
      if (leg && !this.onGround) sink = Math.max(sink, -vn);
      // the strut: a gas spring that stiffens as it closes, and a damper; much stiffer still once it bottoms
      // out. It pushes, never pulls
      let N = leg ? l.k * pen * (1 + 3 * (pen / STRUT_TRAVEL) ** 3) - l.c * vn : l.k * pen - l.c * vn;
      if (leg && pen > STRUT_TRAVEL) N += 10 * l.k * (pen - STRUT_TRAVEL);
      N = Math.max(0, N);
      l.comp = pen;
      if (leg) wow = true;
      // along the ground: the tyre rolls along its heading (the nose wheel's turned by the steering), grips sideways
      const sa = leg && l.steer ? steer : 0;
      const sx = Math.sin(sa), sz = -Math.cos(sa);
      let ex = R[0] * sx + R[6] * sz, ey = R[1] * sx + R[7] * sz, ez = R[2] * sx + R[8] * sz;
      const en = ex * nx + ey * ny + ez * nz;
      ex -= en * nx;
      ey -= en * ny;
      ez -= en * nz;
      const el = Math.hypot(ex, ey, ez) || 1;
      ex /= el;
      ey /= el;
      ez /= el;
      // the side direction: n x e
      const qx = ny * ez - nz * ey, qy = nz * ex - nx * ez, qz = nx * ey - ny * ex;
      const vl = vx * ex + vy * ey + vz * ez;
      const vs = vx * qx + vy * qy + vz * qz;
      let Fl: number, Fs: number;
      if (leg) {
        const mu = ROLL_MU + (c.brakes && !l.steer ? this.brakeMu : 0);
        Fl = -N * clamp(vl / (G0 * SLIP_LONG), -mu, mu);
        // the side force follows the slip angle (cornering), up to the tyre's grip
        Fs = -N * TYRE_MU * clamp(vs / (Math.max(Math.abs(vl), SLIP_CRAWL) * SLIP_ANGLE), -1, 1);
      } else {
        // a skid scrapes the same whichever way it goes
        const vt = Math.hypot(vl, vs);
        const f = vt > 1e-6 ? (N * Math.min(SKID_MU, vt / (G0 * SLIP_LONG) * SKID_MU)) / vt : 0;
        Fl = -f * vl;
        Fs = -f * vs;
      }
      const Fx = nx * N + ex * Fl + qx * Fs;
      const Fy = ny * N + ey * Fl + qy * Fs;
      const Fz = nz * N + ez * Fl + qz * Fs;
      fx += Fx;
      fy += Fy;
      fz += Fz;
      // its moment about the centre of gravity, body axes
      const gx = Fx * R[0] + Fy * R[1] + Fz * R[2];
      const gy = Fx * R[3] + Fy * R[4] + Fz * R[5];
      const gz = Fx * R[6] + Fy * R[7] + Fz * R[8];
      M[0] += ry * gz - rz * gy;
      M[1] += rz * gx - rx * gz;
      M[2] += rx * gy - ry * gx;
    }
    if (wow && !this.onGround) {
      // touchdown: too fast onto the wheels breaks them, too much bank puts a wingtip into the ground first
      if (sink > cfg.landingSinkLimit) {
        this.destroy('HARD IMPACT');
        return false;
      }
      if (Math.abs(bank * R2D) > cfg.landingBankLimit || R[4] < 0) {
        this.destroy('WINGTIP STRIKE');
        return false;
      }
      this.touchdownSink = Math.max(sink, -this.vel[1]);
      this.touchdownTimer = 2;
    }
    accel[0] += fx / this.mass;
    accel[1] += fy / this.mass;
    accel[2] += fz / this.mass;
    return wow;
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
      const ground = this.onGround ? smooth((V - 10) / (FBW_MIN_SPEED - 10)) : 0;
      if (ground > 0) {
        // ground mode, coming in with the airflow over the tail
        const qf = Math.max(qbar, 400);
        const theta = Math.asin(clamp(-R[7], -1, 1));
        const want = this.restPitch + c.pitch * (c.pitch > 0 ? GROUND_PITCH_MAX : 2 * D2R);
        const e = clamp(GROUND_ATT_GAIN * (want - theta), -GROUND_DEROTATE, GROUND_PITCH_RATE) - wx;
        const raw = ((GROUND_KQ * e + this.fbwI) * this.inertia[0]) / (qf * this.pitchEff);
        const Pg = clamp(raw, -1, 1);
        if (Pg === raw || Math.sign(e) !== Math.sign(raw)) this.fbwI = clamp(this.fbwI + GROUND_KI * e * dt, -8, 8);
        P = c.pitch + (Pg - c.pitch) * ground;
      } else {
        this.fbwI = 0;
      }
      Rc = c.roll;
      Y = c.yaw;
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
    let thrust: number;
    if (cfg.prop) {
      // a piston engine: its power falls with density (Gagg-Ferrar), the propeller turns it into thrust at
      // an efficiency that grows with airspeed, no more than its static thrust at low speed
      const p = cfg.prop;
      const power = p.power * c.throttle * Math.max(0, 1.132 * (rho / RHO0) - 0.132);
      // (efficiency / V, which tends to 1 / effSpeed standing still)
      const etaPerV = V > 1e-3 ? (p.efficiency * -Math.expm1(-V / p.effSpeed)) / V : p.efficiency / p.effSpeed;
      thrust = Math.min(cfg.thrustDry * c.throttle * (rho / RHO0), etaPerV * power);
    } else {
      const abFrac = cfg.thrustAfterburner > cfg.thrustDry ? Math.max(0, (c.throttle - 0.85) / 0.15) : 0;
      const lapse = Math.pow(rho / RHO0, 0.7);
      thrust = lapse * c.throttle * (
        cfg.thrustDry * (1 - 0.12 * Math.min(this.mach, 1.5)) +
        (cfg.thrustAfterburner - cfg.thrustDry) * abFrac * (1 + 0.25 * this.mach * this.mach)
      );
    }
    // an engine that went with its wing gives nothing, and the ones left push off the centre line: the
    // missing engines' share comes off the total, and its moment about the centre of gravity with it (only
    // the lost ones', so an intact aircraft trims exactly as before)
    const noz = cfg.nozzles;
    let live = noz.length;
    for (const n of noz) {
      if (!n.part || !this.lost[n.part - 1]) continue;
      live--;
      const each = thrust / noz.length;
      const [rx, ry] = this.here(this.tmpV, [n.pos[0] - cfg.cg[0], n.pos[1] - cfg.cg[1], n.pos[2] - cfg.cg[2]]);
      // take away r x F of F = (0, 0, -each), the push along the body's forward axis
      Mx += ry * each;
      My -= rx * each;
    }
    Fz -= noz.length ? (thrust * live) / noz.length : thrust;

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
    let aaZ = (Mz + (Ix - Iy) * wx * wy) / Iz;

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
    if (contact.building) return this.destroy('BUILDING STRIKE');
    const gearOut = this.actuators.gear > 0.99;
    if (!gearOut && agl < 0.5) {
      if (contact.water) return this.destroy('WATER IMPACT');
      return this.destroy('GEAR-UP LANDING');
    }
    let wow = false;
    if (agl < GEAR_PROBE_AGL) {
      wow = this.groundContact(c, probe, gearOut, accel, bank);
      if (this.crashed) return;
      // the moments of the wheels and skids on the ground, through the inertias
      aaX += this.contactM[0] / Ix;
      aaY += this.contactM[1] / Iy;
      aaZ += this.contactM[2] / Iz;
    } else {
      for (const l of this.legs) l.comp = 0;
    }
    this.onGround = wow;

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
        // (the nose and tail ride on their skids: only driven deep into the ground are they fatal)
        if (hit.building || tip[1] < hit.height - (slot ? 0.2 : SKID_FATAL + 0.4)) {
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
    this.omega[0] += aaX * dt;
    this.omega[1] += aaY * dt;
    this.omega[2] += aaZ * dt;
    const w = vec3.length(this.omega);
    if (w > 1e-6) {
      quat.setAxisAngle(this.tmpQ, vec3.scale(this.tmpV, this.omega, 1 / w), w * dt);
      quat.multiply(this.quat, this.quat, this.tmpQ);
      quat.normalize(this.quat, this.quat);
    }
    if (this.debris.length > 0) this.stepDebris(dt);
  }
}
