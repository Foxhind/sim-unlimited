import type { FlightControls, FlightModel } from './model';

const R2D = 180 / Math.PI;
/** deg of intercept heading per metre of cross-track error on final */
const KP_XTRK = 0.05;
const XTRK_LEAD = 12; // s
const SETTLE_H = 8; // m
const SETTLE_GAIN = 0.04;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Textbook PID: proportional on error, integral with conditional anti-windup,
 * derivative on measurement (no kick on setpoint changes) and a first-order filter.
 */
export class Pid {
  private i = 0;
  private prev: number | null = null;
  private dFilt = 0;

  constructor(
    readonly kp: number,
    readonly ki: number,
    readonly kd: number,
    readonly lo: number,
    readonly hi: number,
    private readonly dTau = 0.15,
  ) {}

  reset(): void {
    this.i = 0;
    this.prev = null;
    this.dFilt = 0;
  }

  step(setpoint: number, measurement: number, dt: number): number {
    const e = setpoint - measurement;
    let d = 0;
    if (this.prev !== null && dt > 0) {
      const raw = -(measurement - this.prev) / dt;
      const a = dt / (this.dTau + dt);
      this.dFilt += (raw - this.dFilt) * a;
      d = this.dFilt;
    }
    this.prev = measurement;
    const unsat = this.kp * e + this.i + this.kd * d;
    const out = clamp(unsat, this.lo, this.hi);
    // integrate only when not pushing further into saturation
    if (out === unsat || Math.sign(e) !== Math.sign(unsat - out)) {
      this.i = clamp(this.i + this.ki * e * dt, this.lo, this.hi);
    }
    return out;
  }
}

/** final approach speed the autoland flies (and the HUD shows in APP), m/s */
export function approachSpeed(m: FlightModel): number {
  return m.cfg.cruiseSpeed * 0.42;
}

export type LandingPhase = 'intercept' | 'final' | 'rollout';

/** HDG flies the selected heading; NAV tracks the tuned VOR course or ILS localizer */
export type LateralMode = 'HDG' | 'NAV';

/** what NAV mode steers on: the course and the cross-track error (+ = aircraft right of the course), m */
export interface NavGuidance {
  course: number;
  xtkM: number;
}

/** deg of intercept per metre off the course in NAV mode, and the steepest intercept it flies */
const NAV_KP = 0.03;
const NAV_MAX_INTERCEPT = 30;

export interface AutopilotTargets {
  altitude: number; // m
  speed: number; // m/s true airspeed
  heading: number; // deg
}

/**
 * Cascaded autopilot: altitude -> flight-path angle -> pitch stick (rate damped),
 * speed -> throttle, heading -> bank -> roll stick (rate damped).
 * Runs at frame rate on the model's state; outputs full FlightControls.
 */
export class Autopilot {
  readonly targets: AutopilotTargets = { altitude: 3000, speed: 200, heading: 0 };
  private readonly gamma = new Pid(2.2, 0.35, 0, -0.5, 0.5, 0.2);
  private readonly speedPid = new Pid(0.02, 0.004, 0, 0, 1, 0.5);
  private readonly bank = new Pid(0.9, 0, 0, -1, 1);
  private readonly roll = new Pid(0.06, 0, 0, -1, 1);
  private throttle = 0.6;
  private vsF = 0;
  private readonly yawPid = new Pid(0.03, 0, 0, -0.5, 0.5);
  /** terrain height under a world (x, z) point; set by the sim, flat zero by default */
  groundAt: (x: number, z: number) => number = () => 0;
  landing: LandingPhase | null = null;
  lateral: LateralMode = 'HDG';
  /** NAV-mode guidance from the radio, fed every frame; null while there is no usable signal */
  nav: NavGuidance | null = null;
  private thr: { x: number; z: number; hdg: number } | null = null;
  private interStage = 0;
  /** pattern size multiplier: sluggish roll authority means a wider turn radius */
  private patternScale = 1;
  private holdAlt = 450;
  /** altitude the approach began at: the pattern is never flown above it */
  private startAlt = 450;

  /** Autoland on the runway whose threshold is (x, z) in world metres and whose heading is hdgDeg. */
  startLanding(m: FlightModel, x: number, z: number, hdgDeg: number): void {
    this.engage(m);
    this.thr = { x, z, hdg: hdgDeg };
    // The sim turns slowly, so pick an initial fix far enough out on the extended centreline
    // that joining it needs at most a ~35 deg turn.
    const H = (hdgDeg * Math.PI) / 180;
    const cross = (m.pos[0] - x) * Math.cos(H) + (m.pos[2] - z) * Math.sin(H);
    const along = (m.pos[0] - x) * Math.sin(H) - (m.pos[2] - z) * Math.cos(H);
    this.interStage = 0;
    this.patternScale = clamp((2.2 / m.cfg.fbw.rollRate) ** 0.6, 1, 2.5);
    this.startAlt = m.pos[1];
    this.holdAlt = Math.min(m.pos[1], this.groundAt(x, z) + 450);
    // far out and roughly on the approach side: go straight to the final-approach law
    // (needs the aircraft to be able to reach the centreline at <= ~35 deg intercept before the threshold)
    const hdgOff = Math.abs(((m.headingDeg - hdgDeg + 540) % 360) - 180);
    this.landing = along < -5000 && Math.abs(cross) < 0.7 * (-along - 2500) && hdgOff < 45 ? 'final' : 'intercept';
    this.yawPid.reset();
  }

  /** The sim rebases its floating origin, so the threshold is re-fed every frame. */
  moveThreshold(x: number, z: number): void {
    if (this.thr) {
      this.thr.x = x;
      this.thr.z = z;
    }
  }

  stopLanding(): void {
    this.landing = null;
    this.thr = null;
  }

  private landingUpdate(dt: number, m: FlightModel, base: FlightControls): FlightControls {
    const th = this.thr!;
    const H = (th.hdg * Math.PI) / 180;
    const ux = Math.sin(H), uz = -Math.cos(H); // runway direction (heading 0 = -z)
    const rx = Math.cos(H), rz = Math.sin(H); // right of the runway direction
    const rel = [m.pos[0] - th.x, m.pos[2] - th.z];
    const along = rel[0] * ux + rel[1] * uz;
    const cross = rel[0] * rx + rel[1] * rz;
    const V = Math.max(30, m.speed);
    const vApp = approachSpeed(m);
    // speed is held through the air (what the wing feels); the path over the ground uses ground velocity
    const tas = Math.max(30, m.airspeed);
    const gt = this.groundAt(th.x, th.z);
    // the threshold's height may only become known on the way in (terrain still loading): never hold below 450 m over it
    this.holdAlt = Math.max(this.holdAlt, Math.min(this.startAlt, gt + 450));
    const GLIDE = (3 * Math.PI) / 180;
    const out: FlightControls = { ...base };

    if (this.landing === 'intercept') {
      // Pattern entry. E is the point on the extended centreline where final is joined. If E is not
      // roughly ahead of the aircraft (<= 50 deg off the runway heading) we first fly to an offset
      // waypoint O out to the side, so the base leg turns in toward E at a moderate angle.
      const k = this.patternScale;
      const FIXD = 12000 * k;
      const CAPTURE = 6500 * k; // must exceed the turn radius or the aircraft orbits the waypoint
      const ex = th.x - ux * FIXD, ez = th.z - uz * FIXD;
      const brgTo = (px: number, pz: number): number => ((Math.atan2(px - m.pos[0], -(pz - m.pos[2])) * R2D) + 360) % 360;
      const angOff = (b: number): number => Math.abs(((b - th.hdg + 540) % 360) - 180);
      if (this.interStage === 0) {
        const side = cross >= 0 ? 1 : -1;
        const ox = th.x - ux * (FIXD + 9000 * k) + rx * side * 7000 * k;
        const oz = th.z - uz * (FIXD + 9000 * k) + rz * side * 7000 * k;
        const direct = angOff(brgTo(ex, ez)) <= 50 && -along > FIXD * 0.6;
        if (direct) this.interStage = 1;
        else {
          this.targets.heading = brgTo(ox, oz);
          if (Math.hypot(ox - m.pos[0], oz - m.pos[2]) < CAPTURE) this.interStage = 1;
        }
      }
      if (this.interStage === 1) {
        this.targets.heading = brgTo(ex, ez);
        const toE = Math.hypot(ex - m.pos[0], ez - m.pos[2]);
        const hdgErr = angOff(m.headingDeg);
        if (toE < CAPTURE || (Math.abs(cross) < 300 && hdgErr < 15 && along > -FIXD - 9000 * k)) this.landing = 'final';
      }
      this.targets.speed = vApp + 35;
      // terrain clearance along the track: never hold below the highest ground ahead plus a margin
      const hr = (m.headingDeg * Math.PI) / 180;
      let highest = this.groundAt(m.pos[0], m.pos[2]);
      for (const d of [1500, 3000, 5000, 8000]) {
        highest = Math.max(highest, this.groundAt(m.pos[0] + Math.sin(hr) * d, m.pos[2] - Math.cos(hr) * d));
      }
      this.targets.altitude = Math.max(this.holdAlt, highest + 250);
      return this.update(dt, m, { ...base, gearDown: true, flaps: false }, true);
    }

    if (this.landing === 'final') {
      out.gearDown = true;
      const aim = 300; // aim point past the threshold
      const dAim = Math.max(0, aim - along);
      out.flaps = dAim < 10000;
      const glideAlt = Math.min(this.holdAlt, gt + dAim * Math.tan(GLIDE));
      const ground = this.groundAt(m.pos[0], m.pos[2]);
      const h = m.pos[1] - m.cfg.gearHeight - ground;
      // lateral: steer back to the centreline, limited intercept angle
      // first-order cross-track law: close the lateral error at k*cross m/s, capped to a 30 deg intercept
      // PD lead: steer on the cross-track error predicted XTRK_LEAD seconds ahead, which stops the
      // overshoot that the sluggish heading response would otherwise cause when capturing the centreline
      // ground velocity across the runway: with a crosswind the nose is not where the aircraft is going
      const crossRate = m.vel[0] * rx + m.vel[2] * rz;
      const hdgT = th.hdg - clamp((cross + XTRK_LEAD * crossRate) * KP_XTRK, -40, 40);
      // steer the track, not the heading, onto it: the crab angle into the wind then comes by itself
      const hErr = ((hdgT - m.trackDeg + 540) % 360) - 180;
      const bankLim = clamp(h / 4, 4, 40); // shallow bank near the ground: no wingtip strikes
      const bankT = clamp(hErr * 0.8, -bankLim, bankLim);
      const rollStick = (this.roll.step(bankT, m.bankDeg, dt) - 0.004 * (m.omega[2] * R2D)) * this.rollScale(m);
      // vertical: glide-slope error biases the flight-path angle; flare below 14 m
      this.vsF += (m.vel[1] - this.vsF) * Math.min(1, dt / 0.25);
      let gammaT = glideAlt < this.holdAlt ? -GLIDE + clamp((glideAlt - m.pos[1]) * 0.0006, -0.04, 0.04) : clamp((glideAlt - m.pos[1]) * 0.004, -0.06, 0.06);
      const flare = h < 25;
      if (flare) gammaT = Math.asin(clamp(-(0.7 + 0.055 * h) / V, -0.1, 0));
      const gammaM = Math.asin(clamp(this.vsF / V, -0.5, 0.5));
      // low and not sinking: the slow integral term holds the nose up as speed bleeds off and the
      // aircraft would float on down the runway, so add a gentle direct sink-rate push to settle it
      const settle = h < SETTLE_H && this.vsF > -0.6 ? SETTLE_GAIN * (-0.9 - this.vsF) : 0;
      const stick = (this.gamma.step(gammaT, gammaM, dt) - 0.35 * m.omega[0]) * (flare ? 2.5 : 1) + settle;
      const vTarget = dAim > 10000 ? vApp + 35 : vApp;
      const thrT = h < 9 ? 0 : this.speedPid.step(vTarget, tas, dt);
      this.throttle += (thrT - this.throttle) * Math.min(1, dt / (h < 9 ? 0.3 : 1.5));
      out.pitch = clamp(stick, -1, 1);
      out.roll = clamp(rollStick, -1, 1);
      out.yaw = 0;
      out.throttle = clamp(this.throttle, 0, 1);
      this.targets.altitude = glideAlt;
      this.targets.speed = vApp;
      this.targets.heading = hdgT;
      // not stable on the centreline close to the ground: go around and fly the pattern again
      const hdgOff = Math.abs(((m.trackDeg - th.hdg + 540) % 360) - 180);
      if (h < 80 && h > 3 && (Math.abs(cross) > 90 || hdgOff > 15)) {
        this.landing = 'intercept';
        this.interStage = 0;
        this.holdAlt = gt + 450;
        this.speedPid.reset();
        this.throttle = 1;
        return this.update(dt, m, { ...base, gearDown: true, flaps: false }, true);
      }
      if (m.onGround) this.landing = 'rollout';
      return out;
    }

    // rollout: brakes, idle, hold the centreline with rudder
    out.gearDown = true;
    out.flaps = false; // dump flap lift so the wheels stay loaded
    out.speedbrake = true; // lift dump
    out.brakes = true;
    out.throttle = 0;
    out.pitch = -0.2;
    out.roll = 0;
    const hErr = ((th.hdg - m.headingDeg + 540) % 360) - 180;
    out.yaw = clamp(-cross * 0.01 + hErr * 0.03, -0.5, 0.5);
    this.throttle = 0;
    return out;
  }

  /**
   * NAV mode: steer the track onto the course, the intercept growing with the cross-track error
   * (with a lead on how fast it is closing), and hold the crab into the wind; returns the heading.
   */
  navHeading(m: FlightModel, g: NavGuidance): number {
    const C = (g.course * Math.PI) / 180;
    const xRate = m.vel[0] * Math.cos(C) + m.vel[2] * Math.sin(C);
    const trackT = g.course - clamp((g.xtkM + XTRK_LEAD * xRate) * NAV_KP, -NAV_MAX_INTERCEPT, NAV_MAX_INTERCEPT);
    const crab = ((m.headingDeg - m.trackDeg + 540) % 360) - 180;
    return (((trackT + crab) % 360) + 360) % 360;
  }

  /** the roll loop is tuned for ~0.75 rad/s of roll per unit stick; scale the stick for snappier airframes */
  private rollScale(m: FlightModel): number {
    return Math.min(1, 0.75 / m.cfg.fbw.rollRate);
  }

  engage(m: FlightModel): void {
    this.targets.altitude = Math.round(m.pos[1]);
    this.targets.speed = Math.round(m.airspeed);
    this.targets.heading = Math.round(m.headingDeg);
    this.gamma.reset();
    this.speedPid.reset();
    this.bank.reset();
    this.roll.reset();
    this.throttle = 0.6;
    this.vsF = m.vel[1];
  }

  update(dt: number, m: FlightModel, base: FlightControls, fromLanding = false): FlightControls {
    if (this.landing && !fromLanding) return this.landingUpdate(dt, m, base);
    if (!fromLanding && this.lateral === 'NAV' && this.nav) this.targets.heading = this.navHeading(m, this.nav);
    const V = Math.max(30, m.speed);
    // altitude -> desired climb rate -> desired flight-path angle (soft, rate limited)
    const vsCmd = clamp((this.targets.altitude - m.pos[1]) * 0.08, -12, 12);
    this.vsF += (m.vel[1] - this.vsF) * Math.min(1, dt / 0.25);
    const gammaT = Math.asin(clamp(vsCmd / V, -0.3, 0.3));
    const gammaM = Math.asin(clamp(this.vsF / V, -0.5, 0.5));
    // stick: P/I on flight-path error plus pitch-rate damping from the gyro (omega.x)
    const stick = this.gamma.step(gammaT, gammaM, dt) - 0.35 * m.omega[0];

    // speed -> throttle, smoothed so the engine never jumps
    const thrT = this.speedPid.step(this.targets.speed, m.airspeed, dt);
    this.throttle += (thrT - this.throttle) * Math.min(1, dt / 1.5);

    // heading -> bank -> roll stick with roll-rate damping
    const hErr = ((this.targets.heading - m.headingDeg + 540) % 360) - 180;
    const bankT = this.bank.step(hErr / 30, 0, dt) * (this.landing === 'intercept' ? 40 : 25); // deg
    const rollStick = (this.roll.step(bankT, m.bankDeg, dt) - 0.04 * (m.omega[2] * R2D) * 0.1) * this.rollScale(m);

    return {
      ...base,
      pitch: clamp(stick, -1, 1),
      roll: clamp(rollStick, -1, 1),
      yaw: 0,
      throttle: clamp(this.throttle, 0, 1),
    };
  }
}
