import { describe, expect, it } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import { atmosphere, G0 } from '../src/flight/atmosphere';
import { AIRCRAFT, F117, SU27, aircraftMesh, tableLookup } from '../src/flight/aircraft';
import { FlightModel, PHYSICS_STEP, attitudeQuat, type FlightControls } from '../src/flight/model';

const idle: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0,
  gearDown: true, flaps: false, brakes: false, speedbrake: false,
};

describe('atmosphere', () => {
  it('sea level ISA', () => {
    const a = atmosphere(0);
    expect(a.temperature).toBeCloseTo(288.15, 2);
    expect(a.pressure).toBeCloseTo(101325, 0);
    expect(a.density).toBeCloseTo(1.225, 3);
    expect(a.speedOfSound).toBeCloseTo(340.3, 0);
  });
  it('density halves by ~6.5 km and tropopause is isothermal', () => {
    expect(atmosphere(6500).density).toBeLessThan(0.65);
    expect(atmosphere(11000).temperature).toBeCloseTo(216.65, 2);
    expect(atmosphere(15000).temperature).toBeCloseTo(216.65, 2);
    expect(atmosphere(15000).density).toBeLessThan(atmosphere(11000).density);
  });
});

describe('aircraft configs', () => {
  it('Su-27 has afterburner T/W > 1, F-117 is subsonic with weaker roll', () => {
    expect(SU27.thrustAfterburner / (SU27.mass * G0)).toBeGreaterThan(1);
    expect(F117.thrustAfterburner).toBe(F117.thrustDry);
    expect(F117.maxSpeed).toBeLessThan(340);
    expect(F117.fbw.rollRate).toBeLessThan(SU27.fbw.rollRate / 2);
    expect(AIRCRAFT.su27).toBe(SU27);
  });
  it('tables interpolate and clamp', () => {
    expect(tableLookup(SU27.waveDrag, 0.4)).toBe(1);
    expect(tableLookup(SU27.waveDrag, 1.0)).toBeCloseTo((1.5 + 2.7) / 2, 5);
    expect(tableLookup(SU27.waveDrag, -5)).toBe(SU27.waveDrag[0][1]);
    expect(tableLookup(SU27.waveDrag, 99)).toBe(SU27.waveDrag[SU27.waveDrag.length - 1][1]);
  });
  it('meshes are low-poly, finite, and non-empty', () => {
    for (const id of ['su27', 'f117'] as const) {
      const m = aircraftMesh(id);
      const tris = m.ramps.length / 3;
      expect(tris).toBeGreaterThan(100);
      expect(tris).toBeLessThan(600);
      expect(m.vertices.length).toBe(m.ramps.length * 6);
      expect(m.vertices.every(Number.isFinite)).toBe(true);
      expect(aircraftMesh(id)).toBe(m); // cached
    }
  });
});

describe('attitude quaternion', () => {
  it('heading 0 faces north, 90 faces east', () => {
    const m = new FlightModel(SU27);
    attitudeQuat(m.quat, 0, 0, 0);
    expect(vec3.equals(m.forward(vec3.create()), vec3.fromValues(0, 0, -1))).toBe(true);
    attitudeQuat(m.quat, 0, 90, 0);
    const f = m.forward(vec3.create());
    expect(f[0]).toBeCloseTo(1, 5);
    expect(f[2]).toBeCloseTo(0, 5);
    expect(m.headingDeg).toBeCloseTo(90, 3);
  });
  it('positive pitch raises the nose at any heading; positive bank drops right wing', () => {
    const m = new FlightModel(SU27);
    attitudeQuat(m.quat, 15, 135, 0);
    expect(m.pitchDeg).toBeCloseTo(15, 3);
    expect(m.headingDeg).toBeCloseTo(135, 3);
    attitudeQuat(m.quat, 0, 0, 30);
    expect(m.bankDeg).toBeCloseTo(30, 3);
  });
});

function run(m: FlightModel, seconds: number, c: Partial<FlightControls> = {}, probe?: (p: vec3) => { height: number; water: boolean; building: boolean }): void {
  const controls = { ...idle, ...c };
  const steps = Math.round(seconds / PHYSICS_STEP);
  for (let i = 0; i < steps; i++) m.update(PHYSICS_STEP, controls, probe);
}

describe('flight model', () => {
  it('air start holds speed and altitude hands-off for 10 s', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    const v0 = m.speed;
    run(m, 10);
    expect(m.crashed).toBe(false);
    expect(Math.abs(m.pos[1] - 3000)).toBeLessThan(250);
    expect(m.speed).toBeGreaterThan(v0 * 0.75);
    expect(m.speed).toBeLessThan(v0 * 1.25);
    expect(Math.abs(m.bankDeg)).toBeLessThan(3);
  });

  it('pulling pitch climbs; pushing descends', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    run(m, 4, { pitch: 0.6 });
    expect(m.pitchDeg).toBeGreaterThan(8);
    expect(m.verticalSpeed).toBeGreaterThan(10);
    const m2 = new FlightModel(SU27);
    m2.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    run(m2, 4, { pitch: -0.6 });
    expect(m2.verticalSpeed).toBeLessThan(-10);
  });

  it('roll input banks right and damping recovers wings level', () => {
    const m = new FlightModel(F117);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    run(m, 1.5, { roll: 1 });
    expect(m.bankDeg).toBeGreaterThan(12);
    run(m, 6);
    expect(Math.abs(m.bankDeg)).toBeLessThan(5);
  });

  it('full afterburner accelerates the Su-27 past cruise', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    run(m, 25, { throttle: 1 });
    expect(m.speed).toBeGreaterThan(SU27.cruiseSpeed);
  });

  it('stall: high alpha bleeds speed and raises the stall flag', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    run(m, 15, { pitch: 1, throttle: 0 });
    expect(m.stall).toBe(true);
    expect(m.speed).toBeLessThan(SU27.cruiseSpeed * 0.7);
  });

  it('gentle touchdown on flat ground lands; hard impact crashes', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3, 0), 0);
    vec3.copy(m.vel, vec3.fromValues(0, -2, -70));
    run(m, 4, { gearDown: true });
    expect(m.crashed).toBe(false);
    expect(m.onGround).toBe(true);
    expect(m.touchdownSink).toBeGreaterThan(0);

    const h = new FlightModel(SU27);
    h.spawnAir(vec3.fromValues(0, 3, 0), 0);
    vec3.copy(h.vel, vec3.fromValues(0, -9, -70));
    run(h, 4, { gearDown: true });
    expect(h.crashed).toBe(true);
    expect(h.crashReason).toBe('HARD IMPACT');
  });

  it('water and buildings crash on contact', () => {
    const w = new FlightModel(SU27);
    w.spawnAir(vec3.fromValues(0, 3, 0), 0);
    vec3.copy(w.vel, vec3.fromValues(0, -2, -70));
    run(w, 3, {}, () => ({ height: 0, water: true, building: false }));
    expect(w.crashReason).toBe('WATER IMPACT');

    const b = new FlightModel(SU27);
    b.spawnAir(vec3.fromValues(0, 100, 0), 0);
    run(b, 1, {}, () => ({ height: 0, water: false, building: true }));
    expect(b.crashReason).toBe('BUILDING STRIKE');
  });

  it('takeoff roll: brakes hold, full thrust + rotation lifts off', () => {
    const m = new FlightModel(SU27);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    run(m, 2, { throttle: 0.3, brakes: true });
    expect(m.speed).toBeLessThan(1);
    run(m, 12, { throttle: 1 });
    expect(m.speed).toBeGreaterThan(70);
    expect(m.onGround).toBe(true);
    run(m, 6, { throttle: 1, pitch: 0.7 });
    expect(m.onGround).toBe(false);
    expect(m.pos[1]).toBeGreaterThan(SU27.gearHeight + 2);
  });

  it('brakes decelerate the landing roll', () => {
    const m = new FlightModel(SU27);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    vec3.copy(m.vel, vec3.fromValues(0, 0, -70));
    run(m, 8, { brakes: true });
    expect(m.speed).toBeLessThan(35);
    expect(m.onGround).toBe(true);
  });

  it('fixed-step accumulator never exceeds catch-up cap', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    const steps = m.update(5, idle);
    expect(steps).toBeLessThanOrEqual(10);
    expect(quat.length(m.quat)).toBeCloseTo(1, 4);
  });
});