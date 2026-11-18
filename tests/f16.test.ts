import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { AIRCRAFT, F16, aircraftMesh, fitAircraft, modelMesh, PART_IDS } from '../src/flight/aircraft';
import f16Model from '../src/flight/models/f16.json';
import { newPoses, poseJoints, signals, type ControlInputs } from '../src/flight/articulation';
import { Autopilot } from '../src/flight/autopilot';
import { CameraRig } from '../src/flight/cameras';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';
import type { Input } from '../src/engine/input';

const REST: ControlInputs = { pitch: 0, roll: 0, yaw: 0, flaps: 0, speedbrake: 0, gear: 1, nav: 1, beacon: 1, landing: 1 };
const idle: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, gearDown: false, flaps: false, brakes: false, speedbrake: false,
};
const mesh = aircraftMesh('f16');
const idOf = (name: string): number => {
  const i = mesh.joints.findIndex((j) => j.name === name);
  expect(i, name).toBeGreaterThanOrEqual(0);
  return i;
};

/** centroid of a joint's vertices after posing */
function centre(name: string, c: Partial<ControlInputs>): vec3 {
  const j = idOf(name);
  const poses = poseJoints(mesh.joints, signals({ ...REST, ...c }), newPoses(mesh.joints));
  const out = vec3.create();
  const p = vec3.create();
  let n = 0;
  for (let v = 0; v < mesh.joint.length; v++) {
    if (mesh.joint[v] !== j + 1) continue;
    vec3.set(p, mesh.vertices[v * 6], mesh.vertices[v * 6 + 1], mesh.vertices[v * 6 + 2]);
    vec3.transformMat3(p, p, poses[j].rot);
    vec3.add(p, p, poses[j].off);
    vec3.add(out, out, p);
    n++;
  }
  expect(n).toBeGreaterThan(0);
  return vec3.scale(out, out, 1 / n);
}
const moved = (name: string, c: Partial<ControlInputs>): vec3 => vec3.sub(vec3.create(), centre(name, c), centre(name, {}));

function fly(seconds: number, m: FlightModel, c: (t: number) => Partial<FlightControls>, each?: (t: number) => void): void {
  for (let t = 0; t < seconds && !m.crashed; t += PHYSICS_STEP) {
    m.update(PHYSICS_STEP, { ...idle, ...c(t) });
    each?.(t);
  }
}

describe('F-16AM rig exported from the .blend', () => {
  it('is the real size, with its hinges, lights and break points', () => {
    expect(AIRCRAFT.f16).toBe(F16);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < mesh.vertices.length; v += 6) {
      for (let k = 0; k < 3; k++) {
        expect(Number.isFinite(mesh.vertices[v + k])).toBe(true);
        lo[k] = Math.min(lo[k], mesh.vertices[v + k]);
        hi[k] = Math.max(hi[k], mesh.vertices[v + k]);
      }
    }
    expect(hi[0] - lo[0]).toBeCloseTo(9.4, 1); // span over the launch rails, clean
    expect(hi[2] - lo[2]).toBeCloseTo(15.0, 1); // length
    expect(hi[1] + F16.gearHeight).toBeCloseTo(5.01, 1); // fin tip over the tyres
    expect(lo[1]).toBeGreaterThan(-F16.gearHeight - 0.05);
    // low-poly: the fixed airframe and the moving parts
    const fixed = mesh.joint.filter((j, v) => v % 3 === 0 && j === 0).length;
    expect(fixed).toBeLessThan(1200);
    expect(mesh.ramps.length / 3).toBeLessThan(1500);

    const names = mesh.joints.map((j) => j.name).sort();
    expect(names).toEqual([
      'Flaperon_L', 'Flaperon_R', 'LEFlap_L', 'LEFlap_R', 'MainDoor_L', 'MainDoor_R', 'MainGear_L', 'MainGear_R',
      'MainWheel_L', 'MainWheel_R', 'NoseDoor_L', 'NoseDoor_R', 'NoseGear', 'NoseWheel', 'Rudder',
      'SpeedbrakeLower_L', 'SpeedbrakeLower_R', 'SpeedbrakeUpper_L', 'SpeedbrakeUpper_R', 'Stabilator_L', 'Stabilator_R',
    ]);
    expect(mesh.lights.map((l) => l.kind).sort()).toEqual(['beacon', 'landing', 'nav', 'nav', 'nav']);
    // red on the pilot's left (-x), green on the right
    const navL = mesh.lights.find((l) => l.name === 'NavLight_L')!;
    expect(navL.pos[0]).toBeLessThan(-0.5);
    expect(navL.rgb).toBe(0xff2a1a);
    expect(F16.parts.map((p) => p.id).sort()).toEqual(['stabL', 'stabR', 'wingL', 'wingR']);
    // control surfaces leave with their part; the rudder stays with the fuselage
    for (const [n, part] of [['Flaperon_L', 'wingL'], ['LEFlap_R', 'wingR'], ['Stabilator_L', 'stabL']] as const) {
      const j = idOf(n) + 1;
      const tag = PART_IDS.indexOf(part) + 1;
      for (let v = 0; v < mesh.joint.length; v++) if (mesh.joint[v] === j) expect(mesh.parts[v]).toBe(tag);
    }
    const rudder = idOf('Rudder') + 1;
    for (let v = 0; v < mesh.joint.length; v++) if (mesh.joint[v] === rudder) expect(mesh.parts[v]).toBe(0);
  });

  it('surfaces move the right way', () => {
    for (const s of ['L', 'R']) {
      expect(moved(`Stabilator_${s}`, { pitch: 1 })[1]).toBeGreaterThan(0.05); // pull: trailing edges up
      expect(moved(`Flaperon_${s}`, { flaps: 1 })[1]).toBeLessThan(-0.05);
      expect(moved(`LEFlap_${s}`, { flaps: 1 })[1]).toBeLessThan(-0.02);
      expect(moved(`SpeedbrakeUpper_${s}`, { speedbrake: 1 })[1]).toBeGreaterThan(0.2);
      expect(moved(`SpeedbrakeLower_${s}`, { speedbrake: 1 })[1]).toBeLessThan(-0.2);
    }
    // roll right: right flaperon and stabilator up, left ones down
    expect(moved('Flaperon_R', { roll: 1 })[1]).toBeGreaterThan(0.03);
    expect(moved('Flaperon_L', { roll: 1 })[1]).toBeLessThan(-0.03);
    expect(moved('Stabilator_R', { roll: 1 })[1]).toBeGreaterThan(0.01);
    expect(moved('Stabilator_L', { roll: 1 })[1]).toBeLessThan(-0.01);
    // right pedal: the rudder's trailing edge to the right
    expect(moved('Rudder', { yaw: 1 })[0]).toBeGreaterThan(0.1);
  });

  it('nose leg stows aft, main legs forward, all hide; doors open only in transit', () => {
    const at = (gear: number) => poseJoints(mesh.joints, signals({ ...REST, gear }), newPoses(mesh.joints));
    const nose = moved('NoseGear', { gear: 0.5 });
    expect(nose[2]).toBeGreaterThan(0.1);
    expect(nose[1]).toBeGreaterThan(0.1);
    for (const s of ['L', 'R']) {
      const main = moved(`MainGear_${s}`, { gear: 0.5 });
      expect(main[2]).toBeLessThan(-0.1);
      expect(main[1]).toBeGreaterThan(0.1);
      expect(at(0)[idOf(`MainWheel_${s}`)].visible).toBe(false);
      for (const n of [`NoseDoor_${s}`, `MainDoor_${s}`]) {
        expect(moved(n, { gear: 0.5 })[1]).toBeLessThan(-0.05);
        expect(vec3.length(moved(n, { gear: 0 }))).toBeLessThan(1e-6);
      }
    }
    for (const n of ['NoseGear', 'MainGear_L', 'MainGear_R']) {
      expect(at(0)[idOf(n)].visible).toBe(false);
      expect(at(1)[idOf(n)].visible).toBe(true);
    }
  });
});

describe('swappable markings and loadouts', () => {
  const colours = (m: ReturnType<typeof aircraftMesh>): Set<number> => new Set(Array.from(m.ramps));
  const slots = (f16Model as { decal?: number[] }).decal ?? [];

  it('the model carries roundel slots, painted with the markings chosen', () => {
    for (const k of [1, 2, 3]) expect(slots.filter((s) => s === k).length).toBeGreaterThan(20);
    // no choice: the first markings, Ukraine's
    expect(F16.insignia![0].id).toBe('ua');
    expect(colours(aircraftMesh('f16')).has(0x2457b8)).toBe(true);
    const dk = aircraftMesh(fitAircraft(F16, 'dk'));
    expect(colours(dk).has(0xc8102e)).toBe(true);
    expect(colours(dk).has(0x2457b8)).toBe(false);
    // the geometry is the same, only the roundels change colour
    expect(dk.vertices).toEqual(aircraftMesh('f16').vertices);
    let changed = 0;
    const ua = aircraftMesh('f16');
    for (let v = 0; v < ua.ramps.length; v++) {
      const t = Math.floor(v / 3);
      if (ua.ramps[v] !== dk.ramps[v]) {
        changed++;
        expect(slots[t]).toBeGreaterThan(0);
      }
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('unknown ids fall back to the defaults; a loadout adds its mass and drag', () => {
    const d = fitAircraft(F16, 'nope', 'nope');
    expect(d.insigniaId).toBe('ua');
    expect(d.loadoutId).toBe('clean');
    expect(d.mass).toBe(F16.mass);
    const armed = { ...F16, loadouts: [...F16.loadouts!, { id: 'aa', name: 'AA', stores: ['aim120'], mass: 320, cd: 0.004 }] };
    const f = fitAircraft(armed, 'be', 'aa');
    expect(f.mass).toBe(F16.mass + 320);
    expect(f.cd0).toBeCloseTo(F16.cd0 + 0.004, 9);
    expect(f.insigniaId).toBe('be');
  });

  it('a store is drawn only when the loadout carries it', () => {
    const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const json = {
      positions: [...tri, ...tri.map((c) => c + 2)], rgb: [0x808080, 0xffffff], parts: [0, 0],
      store: [0, 1], storeNames: ['tank'],
    };
    expect(modelMesh(json).ramps.length).toBe(3);
    expect(modelMesh(json, { stores: ['tank'] }).ramps.length).toBe(6);
  });
});

describe('F-16AM in flight', () => {
  it('has afterburner T/W above 1 and goes supersonic at altitude', () => {
    expect(F16.thrustAfterburner / (F16.mass * 9.80665)).toBeGreaterThan(1);
    const m = new FlightModel(F16);
    m.spawnAir(vec3.fromValues(0, 11000, 0), 0);
    vec3.scale(m.vel, m.vel, 280 / m.speed);
    fly(120, m, () => ({ throttle: 1 }));
    expect(m.mach).toBeGreaterThan(1.4);
  });

  it('pulls 9 g at speed and holds the 25 deg limiter when slow, without breaking anything', () => {
    const m = new FlightModel(F16);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    vec3.scale(m.vel, m.vel, 250 / m.speed);
    let g = 0;
    fly(8, m, (t) => ({ throttle: 1, pitch: t > 2 ? 1 : 0 }), () => { g = Math.max(g, m.gLoad); });
    expect(g).toBeGreaterThan(8.3);
    expect(g).toBeLessThan(9.3);
    expect(m.damage.length).toBe(0);
    for (const v of [90, 120]) {
      const s = new FlightModel(F16);
      s.spawnAir(vec3.fromValues(0, 3000, 0), 0);
      vec3.scale(s.vel, s.vel, v / s.speed);
      let aMax = 0;
      fly(8, s, (t) => ({ throttle: 0.5, pitch: t > 1 ? 1 : 0 }), () => { aMax = Math.max(aMax, s.alphaDeg); });
      expect(aMax).toBeGreaterThan(24);
      expect(aMax).toBeLessThan(F16.stallAlpha);
      expect(Math.abs(s.alphaDeg - 25)).toBeLessThan(1);
    }
  });

  it('rolls fast and levels its wings hands off', () => {
    const m = new FlightModel(F16);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    vec3.scale(m.vel, m.vel, 200 / m.speed);
    let p = 0;
    fly(10, m, (t) => ({ throttle: 0.7, roll: t > 1 && t < 1.5 ? 1 : 0 }), () => { p = Math.max(p, -m.omega[2]); });
    expect(p * 57.3).toBeGreaterThan(150);
    expect(Math.abs(m.bankDeg)).toBeLessThan(2);
  });

  it('takes off with afterburner in under a kilometre', () => {
    const m = new FlightModel(F16);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    let run = 0;
    fly(30, m, () => {
      if (!m.onGround && !run) run = -m.pos[2];
      return { throttle: 1, gearDown: true, pitch: run ? Math.max(-0.3, Math.min(0.3, (10 - m.pitchDeg) * 0.05 - m.omega[0] * 0.5)) : m.airspeed > 70 ? 0.8 : 0 };
    });
    expect(m.crashed, m.crashReason).toBe(false);
    expect(run).toBeGreaterThan(300);
    expect(run).toBeLessThan(1000);
    expect(m.pos[1]).toBeGreaterThan(200);
  });

  it('holds altitude and speed on the autopilot', () => {
    const m = new FlightModel(F16);
    m.spawnAir(vec3.fromValues(0, 2750, 0), 90);
    vec3.scale(m.vel, m.vel, 200 / m.speed);
    const ap = new Autopilot();
    ap.engage(m);
    ap.targets.altitude = 3000;
    ap.targets.speed = 200;
    const alts: number[] = [];
    for (let t = 0; t < 240; t += PHYSICS_STEP) {
      m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, { ...idle, throttle: 0.6 }));
      if (t > 150) alts.push(m.pos[1]);
    }
    expect(m.crashed).toBe(false);
    expect(Math.max(...alts) - Math.min(...alts)).toBeLessThan(12);
    expect(Math.abs(alts[alts.length - 1] - 3000)).toBeLessThan(10);
    expect(Math.abs(m.speed - 200)).toBeLessThan(5);
  });

  it('lands itself and stops on the runway', () => {
    const m = new FlightModel(F16);
    m.spawnAir(vec3.fromValues(2500, 500, 14000), -30);
    const ap = new Autopilot();
    ap.startLanding(m, 0, 0, 0);
    let touch = 0;
    for (let t = 0; t < 900 && !m.crashed; t += PHYSICS_STEP) {
      m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, { ...idle, throttle: 0.6, gearDown: true }));
      if (m.onGround && !touch) touch = m.touchdownSink;
      if (ap.landing === 'rollout' && m.speed < 1) break;
    }
    expect(m.crashed, m.crashReason).toBe(false);
    expect(m.onGround).toBe(true);
    expect(touch).toBeLessThan(F16.landingSinkLimit);
    expect(Math.abs(m.pos[0])).toBeLessThan(20);
    expect(-m.pos[2]).toBeLessThan(3000);
  });

  it('the pilot sits under the canopy', () => {
    const input = { consumeMouse: () => [0, 0], consumeWheel: () => 0 } as unknown as Input;
    const m = new FlightModel(F16);
    m.spawnAir(vec3.fromValues(0, 1000, 0), 0); // heading 0: nose towards -z
    const rig = new CameraRig();
    rig.setMode('cockpit', m);
    rig.update(m, 0.016, input, vec3.create());
    expect(rig.pos[2] - m.pos[2]).toBeCloseTo(-6.0, 3);
    expect(rig.pos[1] - m.pos[1]).toBeCloseTo(0.9, 3);
  });
});
