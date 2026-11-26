import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { AN225, C150, F117, F16, SU27 } from '../src/flight/aircraft';
import { attitudeQuat, FlightModel, PHYSICS_STEP, type FlightControls, type GroundProbe } from '../src/flight/model';

// The undercarriage: a spring and a damper on every leg, standing on the ground under that leg.

const idle: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, gearDown: true, flaps: false, brakes: false, speedbrake: false,
};

function run(m: FlightModel, seconds: number, c: Partial<FlightControls>, probe?: GroundProbe, each?: () => void): void {
  for (let t = 0; t < seconds; t += PHYSICS_STEP) {
    m.update(PHYSICS_STEP, { ...idle, ...c }, probe);
    each?.();
    if (m.crashed) break;
  }
}

describe('undercarriage', () => {
  it('every aircraft stands on its wheels as drawn, level, each leg loaded', () => {
    for (const cfg of [SU27, F117, AN225, F16, C150]) {
      const m = new FlightModel(cfg);
      m.spawnGround(vec3.fromValues(0, 0, 0), 30, 0);
      const y0 = m.pos[1];
      run(m, 5, { brakes: true });
      expect(m.crashed, cfg.id).toBe(false);
      expect(m.onGround).toBe(true);
      expect(Math.abs(m.pos[1] - y0), cfg.id).toBeLessThan(0.03);
      expect(Math.abs(m.bankDeg)).toBeLessThan(0.1);
      expect(m.speed).toBeLessThan(0.05);
      for (const c of m.gearCompression) {
        expect(c, cfg.id).toBeGreaterThan(0.05);
        expect(c, cfg.id).toBeLessThan(0.25);
      }
    }
  });

  it('rolls down into a dip and up out of it with every wheel on the ground', () => {
    // a 2 m deep dip across the runway, 60 m long, with gentle sides
    const dip: GroundProbe = (p) => {
      const d = -p[2] - 100;
      const h = d < 0 || d > 60 ? 0 : -2 * Math.sin((Math.PI * d) / 60) ** 2;
      return { height: h, water: false, building: false };
    };
    const m = new FlightModel(SU27);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    const above = m.pos[1];
    vec3.set(m.vel, 0, 0, -12);
    let lowest = Infinity, airborne = 0;
    run(m, 15, { throttle: 0.12 }, dip, () => {
      lowest = Math.min(lowest, m.pos[1]);
      if (!m.onGround) airborne++;
    });
    expect(m.crashed).toBe(false);
    expect(-m.pos[2]).toBeGreaterThan(160); // through it and out the other side
    expect(lowest).toBeLessThan(above - 1.7); // it went down with the ground: not held at the height it had
    expect(airborne).toBe(0);
  });

  it('runs off a step down and drops onto its wheels', () => {
    const step: GroundProbe = (p) => ({ height: -p[2] > 50 ? -0.6 : 0, water: false, building: false });
    const m = new FlightModel(F16);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    const y0 = m.pos[1];
    vec3.set(m.vel, 0, 0, -8);
    run(m, 15, {}, step);
    expect(m.crashed).toBe(false);
    expect(m.onGround).toBe(true);
    expect(m.pos[1]).toBeCloseTo(y0 - 0.6, 1);
  });

  it('leans with the ground across a slope, the downhill legs taking more of the weight', () => {
    // the ground falls 6% to the east (+x); the aircraft faces north, so its right wing is downhill
    const slope: GroundProbe = (p) => ({ height: -0.06 * p[0], water: false, building: false });
    const m = new FlightModel(SU27);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    run(m, 6, { brakes: true }, slope);
    expect(m.crashed).toBe(false);
    const want = (Math.atan(0.06) * 180) / Math.PI;
    expect(m.bankDeg).toBeGreaterThan(want * 0.8); // right wing down
    expect(m.bankDeg).toBeLessThan(want * 1.3);
    const [left, right] = m.gearCompression;
    expect(right).toBeGreaterThan(left);
  });

  it('spawned on a slope it stands with the ground, without a jolt', () => {
    // 12% up to the north-east, 5% falling to the south-east
    const hill: GroundProbe = (p) => ({ height: -0.12 * p[2] * 0.7 + 0.12 * p[0] * 0.7, water: false, building: false });
    for (const cfg of [SU27, AN225, C150]) {
      const m = new FlightModel(cfg);
      m.spawnGround(vec3.fromValues(0, 0, 0), 45, 0, hill);
      const pitch0 = m.pitchDeg, bank0 = m.bankDeg;
      let peak = 0, moved = 0;
      run(m, 1, { brakes: true }, hill, () => {
        peak = Math.max(peak, ...m.gearCompression);
        moved = Math.max(moved, Math.abs(m.pitchDeg - pitch0), Math.abs(m.bankDeg - bank0));
      });
      expect(m.crashed, cfg.id).toBe(false);
      expect(pitch0, cfg.id).toBeGreaterThan(5); // nose up the hill
      expect(Math.abs(bank0), cfg.id).toBeLessThan(1); // facing straight up it
      expect(peak, cfg.id).toBeLessThan(0.22);
      // uphill the weight moves aft and the nose leg unloads: a few degrees on the short Cessna, no more
      expect(moved, cfg.id).toBeLessThan(5);
      expect(m.speed, cfg.id).toBeLessThan(0.2);
    }
  });

  it('one main wheel on a bump banks the aircraft away from it', () => {
    const bump: GroundProbe = (p) => ({ height: p[0] < -1 ? 0.25 : 0, water: false, building: false });
    const m = new FlightModel(F16);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    run(m, 4, { brakes: true }, bump);
    expect(m.bankDeg).toBeGreaterThan(3); // the left wheel is up: right wing down
    expect(m.onGround).toBe(true);
  });

  it('runs away down a slope with the brakes off; held with them on', () => {
    const hill: GroundProbe = (p) => ({ height: 0.05 * p[2], water: false, building: false }); // falls to the north
    const free = new FlightModel(C150);
    free.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    run(free, 8, {}, hill);
    expect(free.speed).toBeGreaterThan(2);
    expect(free.pos[2]).toBeLessThan(-5);
    const held = new FlightModel(C150);
    held.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    run(held, 8, { brakes: true }, hill);
    expect(held.speed).toBeLessThan(0.1);
  });

  it('the nose wheel steers at taxi speed; at take-off speed the turn is gentle', () => {
    const taxi = new FlightModel(SU27);
    taxi.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    vec3.set(taxi.vel, 0, 0, -6);
    run(taxi, 4, { yaw: 1, throttle: 0.15 });
    expect(taxi.crashed).toBe(false);
    expect(taxi.headingDeg).toBeGreaterThan(30);
    expect(taxi.headingDeg).toBeLessThan(180);
    const fast = new FlightModel(SU27);
    fast.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    vec3.set(fast.vel, 0, 0, -70);
    let bank = 0;
    run(fast, 2, { yaw: 0.5, throttle: 0.6 }, undefined, () => (bank = Math.max(bank, Math.abs(fast.bankDeg))));
    expect(fast.crashed).toBe(false);
    expect(fast.onGround).toBe(true);
    expect(bank).toBeLessThan(4);
    const turned = fast.headingDeg > 180 ? fast.headingDeg - 360 : fast.headingDeg;
    expect(turned).toBeGreaterThan(0.5);
    expect(turned).toBeLessThan(15);
  });

  it('lands on one main wheel in a slight bank and rolls level onto the other', () => {
    const m = new FlightModel(F117);
    m.spawnAir(vec3.fromValues(0, 2.6, 0), 0);
    vec3.set(m.vel, 0, -1.2, -75);
    // a few degrees of right bank: the right wheel touches first
    attitudeQuat(m.quat, 0, 0, 4);
    let firstLeft = -1, firstRight = -1, t = 0;
    run(m, 4, {}, undefined, () => {
      t += PHYSICS_STEP;
      const [l, r] = m.gearCompression;
      if (l > 0 && firstLeft < 0) firstLeft = t;
      if (r > 0 && firstRight < 0) firstRight = t;
    });
    expect(m.crashed, m.crashReason).toBe(false);
    expect(firstRight).toBeGreaterThan(0);
    expect(firstLeft).toBeGreaterThan(firstRight);
    expect(Math.abs(m.bankDeg)).toBeLessThan(1);
    expect(m.onGround).toBe(true);
  });
});
