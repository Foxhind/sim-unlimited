import { mat3, quat, vec3 } from 'gl-matrix';
import { atmosphere, G0 } from './atmosphere';
import { alphaForCl, tableLookup, type AircraftConfig } from './aircraft';

export const PHYSICS_STEP = 1 / 120;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

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

/** yaw about world up, then pitch about body right, then roll about body aft. */
export function attitudeQuat(out: quat, pitchDeg: number, headingDeg: number, rollDeg: number): quat {
  const qy = quat.setAxisAngle(quat.create(), vec3.fromValues(0, 1, 0), -headingDeg * D2R);
  const qx = quat.setAxisAngle(quat.create(), vec3.fromValues(1, 0, 0), pitchDeg * D2R);
  const qz = quat.setAxisAngle(quat.create(), vec3.fromValues(0, 0, 1), -rollDeg * D2R);
  quat.multiply(out, qy, qx);
  return quat.multiply(out, out, qz);
}

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
  alphaDeg = 0;
  betaDeg = 0;
  gLoad = 1;
  private rot = mat3.create();
  private tmpQ = quat.create();
  private acc = 0;

  constructor(readonly cfg: AircraftConfig) {}

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

  spawnAir(position: vec3, headingDeg: number): void {
    vec3.copy(this.pos, position);
    attitudeQuat(this.quat, 0, headingDeg, 0);
    const f = this.forward(vec3.create());
    vec3.scale(this.vel, f, this.cfg.cruiseSpeed * 0.7);
    vec3.zero(this.omega);
    this.onGround = false;
    this.crashed = false;
  }

  spawnGround(position: vec3, headingDeg: number, groundHeight: number): void {
    vec3.set(this.pos, position[0], groundHeight + this.cfg.gearHeight, position[2]);
    attitudeQuat(this.quat, 0, headingDeg, 0);
    vec3.zero(this.vel);
    vec3.zero(this.omega);
    this.onGround = true;
    this.crashed = false;
  }

  /** Fixed-step accumulator; returns number of physics steps taken. */
  update(dt: number, controls: FlightControls, probe: GroundProbe = flatGround): number {
    this.acc = Math.min(this.acc + dt, PHYSICS_STEP * 10);
    let steps = 0;
    while (this.acc >= PHYSICS_STEP) {
      this.acc -= PHYSICS_STEP;
      steps++;
      if (!this.crashed) this.step(PHYSICS_STEP, controls, probe);
    }
    this.touchdownTimer = Math.max(0, this.touchdownTimer - dt);
    return steps;
  }

  private crash(reason: string): void {
    this.crashed = true;
    this.crashReason = reason;
    vec3.zero(this.vel);
    vec3.zero(this.omega);
  }

  private step(dt: number, c: FlightControls, probe: GroundProbe): void {
    const cfg = this.cfg;
    this.basis();
    const rotTD = mat3.transpose(mat3.create(), this.rot);

    const vBody = vec3.transformMat3(vec3.create(), this.vel, rotTD);
    const V = vec3.length(this.vel);
    const alpha = V > 1 ? Math.atan2(-vBody[1], -vBody[2]) : 0;
    const beta = V > 1 ? Math.asin(Math.max(-1, Math.min(1, vBody[0] / V))) : 0;
    this.alphaDeg = alpha * R2D;
    this.betaDeg = beta * R2D;

    const atm = atmosphere(this.pos[1]);
    const qbar = 0.5 * atm.density * V * V;
    const qFactor = Math.max(0.12, Math.min(1.6, qbar / 20000));
    this.stall = this.alphaDeg > cfg.stallAlpha || (V < 55 && !this.onGround && qbar * cfg.wingArea * 1.2 < cfg.mass * G0);
    const eff = this.stall ? Math.max(0.25, 1 - (this.alphaDeg - cfg.stallAlpha) / 25) : 1;

    const cl = tableLookup(cfg.cl, this.alphaDeg) + (c.flaps ? cfg.flapClBonus : 0);
    const postStall = Math.max(0, this.alphaDeg - cfg.stallAlpha) / 25;
    const cd =
      cfg.cd0 + cfg.inducedK * cl * cl + postStall * 0.35 +
      (c.gearDown ? cfg.gearCd : 0) + (c.flaps ? cfg.flapCd : 0) + (c.speedbrake ? cfg.speedbrakeCd : 0);
    const lift = qbar * cfg.wingArea * cl;
    const drag = qbar * cfg.wingArea * cd;
    this.gLoad = Math.abs(lift) / (cfg.mass * G0);

    // aerodynamic forces in body axes
    const force = vec3.create();
    if (V > 0.5) {
      const invV = 1 / V;
      // drag opposes the body-frame velocity
      vec3.scale(force, vBody, -drag * invV);
      // lift perpendicular to velocity in the pitch plane
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      force[1] += lift * ca;
      force[2] += -lift * sa;
      // sideslip damping force
      force[0] += -qbar * cfg.wingArea * 0.6 * beta;
    }
    const abFrac = cfg.thrustAfterburner > cfg.thrustDry ? Math.max(0, (c.throttle - 0.85) / 0.15) : 0;
    const thrust = cfg.thrustDry * c.throttle + (cfg.thrustAfterburner - cfg.thrustDry) * abFrac * c.throttle;
    force[2] -= thrust;

    const accel = vec3.transformMat3(vec3.create(), force, this.rot);
    vec3.scale(accel, accel, 1 / cfg.mass);
    accel[1] -= G0;

    // angular dynamics: control power + stability + damping (Flanker-lite Cm model)
    const right = vec3.transformMat3(vec3.create(), vec3.fromValues(1, 0, 0), this.rot);
    const bank = Math.asin(Math.max(-1, Math.min(1, -right[1])));
    const trimAlpha = qbar * cfg.wingArea > cfg.mass * G0 * 0.15
      ? alphaForCl(cfg, (cfg.mass * G0) / Math.max(1, qbar * cfg.wingArea) - (c.flaps ? cfg.flapClBonus : 0)) * D2R
      : 2 * D2R;
    const angAcc = vec3.fromValues(
      cfg.controlPower[0] * c.pitch * eff * qFactor + cfg.cmAlpha * (alpha - trimAlpha) * qFactor - cfg.damping[0] * this.omega[0],
      -cfg.controlPower[1] * c.yaw * eff * qFactor - 0.9 * beta * qFactor - cfg.damping[1] * this.omega[1],
      -cfg.controlPower[2] * c.roll * eff * qFactor - 0.4 * beta * qFactor + 1.6 * bank * qFactor - cfg.damping[2] * this.omega[2],
    );

    const contact = probe(this.pos);
    const clearance = c.gearDown ? cfg.gearHeight : 0.5;
    const groundY = contact.height + clearance;

    if (this.onGround) {
      if (contact.building) return this.crash('BUILDING STRIKE');
      if (contact.water) return this.crash('WATER IMPACT');
      if (!c.gearDown) return this.crash('GEAR-UP LANDING');
      // tires: vertical clamp, strong roll centering, pitch free to rotate within limits
      accel[1] = Math.max(accel[1], 0);
      this.omega[2] *= Math.max(0, 1 - 12 * dt);
      const pitch = this.pitchDeg;
      if (pitch < -0.5) this.omega[0] += (-0.5 - pitch) * D2R * 10;
      if (pitch > 14) this.omega[0] -= (pitch - 14) * D2R * 10;
      // gear holds the airframe level until the pilot rotates
      const targetPitch = c.pitch > 0.15 ? Math.min(14, c.pitch * 14) : 0;
      angAcc[0] += (targetPitch - pitch) * D2R * 300 - this.omega[0] * 3;
      // rolling resistance + wheel brakes along horizontal motion
      const hv = vec3.fromValues(this.vel[0], 0, this.vel[2]);
      const hs = vec3.length(hv);
      if (hs > 0.01) {
        const decel = Math.min(hs / dt, 0.3 + (c.brakes ? cfg.brakeDecel : 0));
        vec3.scaleAndAdd(accel, accel, hv, -decel / hs);
      }
      // tire lateral grip: kill sideways slip
      const latV = vec3.dot(this.vel, right);
      vec3.scaleAndAdd(accel, accel, right, -latV * 6);
      // nosewheel steering at taxi speed
      if (hs < 40) angAcc[1] += -c.yaw * 0.8 * Math.min(1, hs / 10);
      if (this.pos[1] > groundY + 0.12 && this.vel[1] > 0.5) {
        this.onGround = false; // rotated off the runway
      }
    } else {
      if (contact.building) return this.crash('BUILDING STRIKE');
      if (this.pos[1] <= groundY && this.vel[1] <= 0.5) {
        const sink = -this.vel[1];
        const bank = Math.abs(this.bankDeg);
        if (contact.water) return this.crash('WATER IMPACT');
        if (!c.gearDown) return this.crash('GEAR-UP LANDING');
        if (sink > cfg.landingSinkLimit) return this.crash('HARD IMPACT');
        if (bank > cfg.landingBankLimit) return this.crash('WINGTIP STRIKE');
        this.onGround = true;
        // a bounce with residual upward velocity must not keep the airframe creeping up the runway
        if (this.vel[1] > 0) this.vel[1] = 0;
        this.touchdownSink = sink;
        this.touchdownTimer = 2;
      }
    }

    // semi-implicit integration
    vec3.scaleAndAdd(this.vel, this.vel, accel, dt);
    vec3.scaleAndAdd(this.pos, this.pos, this.vel, dt);
    if (this.onGround) {
      this.pos[1] = Math.max(this.pos[1], groundY);
      if (this.vel[1] < 0) this.vel[1] = 0;
    }
    vec3.scaleAndAdd(this.omega, this.omega, angAcc, dt);
    const w = vec3.length(this.omega);
    if (w > 1e-6) {
      quat.setAxisAngle(this.tmpQ, vec3.scale(vec3.create(), this.omega, 1 / w), w * dt);
      quat.multiply(this.quat, this.quat, this.tmpQ);
      quat.normalize(this.quat, this.quat);
    }
    if (this.onGround) {
      // keep the airframe level in roll while rolling
      const target = quat.create();
      attitudeQuat(target, this.pitchDeg, this.headingDeg, 0);
      quat.slerp(this.quat, this.quat, target, Math.min(1, 6 * dt));
    }
  }
}