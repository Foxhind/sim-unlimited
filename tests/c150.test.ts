import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { AIRCRAFT, C150, aircraftMesh, flameMesh, PART_IDS } from '../src/flight/aircraft';
import { newPoses, poseJoints, signals, type ControlInputs } from '../src/flight/articulation';
import { Autopilot } from '../src/flight/autopilot';
import { Controls, type ControlInput } from '../src/flight/controls';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';
import { defaultSettings } from '../src/ui/settings';

const REST: ControlInputs = { pitch: 0, roll: 0, yaw: 0, flaps: 0, speedbrake: 0, gear: 1, nav: 1, beacon: 1, landing: 1 };
const idle: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, gearDown: true, flaps: false, brakes: false, speedbrake: false,
};
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const mesh = aircraftMesh('c150');
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

/** level flight at `alt` (stick on climb rate) for `secs`, or held at a pitch attitude */
function fly(m: FlightModel, secs: number, c: (m: FlightModel, t: number) => Partial<FlightControls>): void {
  for (let t = 0; t < secs && !m.crashed; t += PHYSICS_STEP) m.update(PHYSICS_STEP, { ...idle, ...c(m, t) });
}

describe('Cessna 150 rig exported from the .blend', () => {
  it('is the real size, with its hinges, lights and break points', () => {
    expect(AIRCRAFT.c150).toBe(C150);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < mesh.vertices.length; v += 6) {
      for (let k = 0; k < 3; k++) expect(Number.isFinite(mesh.vertices[v + k])).toBe(true);
      minX = Math.min(minX, mesh.vertices[v]); maxX = Math.max(maxX, mesh.vertices[v]);
      minY = Math.min(minY, mesh.vertices[v + 1]); maxY = Math.max(maxY, mesh.vertices[v + 1]);
      minZ = Math.min(minZ, mesh.vertices[v + 2]); maxZ = Math.max(maxZ, mesh.vertices[v + 2]);
    }
    expect(maxX - minX).toBeCloseTo(10.17, 1); // span
    expect(maxZ - minZ).toBeCloseTo(7.29, 1); // length
    // the fin 2.58 m above the tyres (2.59 to the beacon), which stand gearHeight below the model's origin
    expect(maxY + C150.gearHeight).toBeCloseTo(2.58, 1);
    expect(minY).toBeGreaterThan(-C150.gearHeight - 0.01);
    expect(minY).toBeLessThan(-C150.gearHeight + 0.01);
    expect(mesh.ramps.length / 3).toBeLessThan(1500);

    const names = mesh.joints.map((j) => j.name).sort();
    expect(names).toEqual(['Aileron_L', 'Aileron_R', 'Elevator_L', 'Elevator_R', 'Flap_L', 'Flap_R', 'Rudder']);
    expect(mesh.lights.map((l) => l.kind).sort()).toEqual(['beacon', 'landing', 'nav', 'nav', 'nav']);
    // red on the pilot's left (-x), green on the right; the wing tip lights go with their wings
    const nav = (n: string) => mesh.lights.find((l) => l.name === n)!;
    expect(nav('NavLight_L').pos[0]).toBeLessThan(-5);
    expect(nav('NavLight_L').rgb).toBe(0xff2a1a);
    expect(nav('NavLight_L').part).toBe(PART_IDS.indexOf('wingL') + 1);
    expect(nav('NavLight_R').part).toBe(PART_IDS.indexOf('wingR') + 1);
    expect(nav('Beacon_Top').part).toBe(0);
    // the fin stays with the fuselage
    expect(C150.parts.map((p) => p.id).sort()).toEqual(['stabL', 'stabR', 'wingL', 'wingR']);
    for (const [n, part] of [['Aileron_L', 'wingL'], ['Flap_R', 'wingR'], ['Elevator_L', 'stabL']] as const) {
      const j = idOf(n) + 1;
      const tag = PART_IDS.indexOf(part) + 1;
      for (let v = 0; v < mesh.joint.length; v++) if (mesh.joint[v] === j) expect(mesh.parts[v]).toBe(tag);
    }
    for (let v = 0; v < mesh.joint.length; v++) if (mesh.joint[v] === idOf('Rudder') + 1) expect(mesh.parts[v]).toBe(0);
    // the wing panels carry their struts: some of their triangles reach down to the fuselage's lower side
    const wingLow = Math.min(...[...mesh.parts].flatMap((p, v) => (p === PART_IDS.indexOf('wingR') + 1 ? [mesh.vertices[v * 6 + 1]] : [])));
    expect(wingLow).toBeLessThan(-0.3);
  });

  it('surfaces move the right way', () => {
    for (const s of ['L', 'R']) {
      expect(moved(`Elevator_${s}`, { pitch: 1 })[1]).toBeGreaterThan(0.03); // pull: trailing edges up
      expect(moved(`Flap_${s}`, { flaps: 1 })[1]).toBeLessThan(-0.1);
    }
    expect(moved('Rudder', { yaw: 1 })[0]).toBeGreaterThan(0.03); // right pedal: trailing edge right
    // roll right: right aileron up, left one down
    expect(moved('Aileron_R', { roll: 1 })[1]).toBeGreaterThan(0.03);
    expect(moved('Aileron_L', { roll: 1 })[1]).toBeLessThan(-0.03);
    // the gear signal moves nothing: it is fixed
    for (const j of mesh.joints) expect(Object.keys(j.terms)).not.toContain('gear_leg');
  });
});

describe('Cessna 150 flies like one', () => {
  it('has a propeller, not a jet: no exhaust flame, no engine to lose', () => {
    expect(C150.prop).toBeDefined();
    expect(C150.nozzles).toEqual([]);
    expect(flameMesh(C150, 1, 0).ramps.length).toBe(0);
    expect(new FlightModel(C150).engineShare).toBe(1);
  });

  it('tops out at about 109 kt level at full throttle', () => {
    const m = new FlightModel(C150);
    m.spawnAir(vec3.fromValues(0, 300, 0), 0);
    fly(m, 200, (m) => ({ throttle: 1, pitch: clamp((300 - m.pos[1]) * 0.01 - m.verticalSpeed * 0.05, -1, 1) }));
    expect(m.airspeed).toBeGreaterThan(53);
    expect(m.airspeed).toBeLessThan(58);
  });

  it('climbs at about 670 ft/min at its best climb speed', () => {
    const m = new FlightModel(C150);
    m.spawnAir(vec3.fromValues(0, 300, 0), 0);
    fly(m, 90, (m) => ({ throttle: 1, pitch: clamp((9 - m.pitchDeg) * 0.04 - m.omega[0] * 0.6, -0.5, 0.5) }));
    expect(m.airspeed).toBeGreaterThan(34);
    expect(m.airspeed).toBeLessThan(42);
    expect(m.verticalSpeed).toBeGreaterThan(2.8);
    expect(m.verticalSpeed).toBeLessThan(4.0);
  });

  it('stalls at about 48 kt clean, and pulled through the limiter it can be stalled', () => {
    const m = new FlightModel(C150);
    m.spawnAir(vec3.fromValues(0, 1000, 0), 0);
    let stallAt = 0;
    fly(m, 40, (m, t) => {
      if (m.stall && !stallAt) stallAt = m.indicatedSpeed;
      return { pitch: t < 5 ? 0 : clamp((t - 5) / 15, 0, 1) };
    });
    expect(stallAt).toBeGreaterThan(23);
    expect(stallAt).toBeLessThan(28);
    expect(m.crashed).toBe(false);
  });

  it('flies straight hands off at cruise power', () => {
    const m = new FlightModel(C150);
    m.spawnAir(vec3.fromValues(0, 1000, 0), 0);
    fly(m, 60, () => ({ throttle: 0.75 }));
    expect(Math.abs(m.bankDeg)).toBeLessThan(2);
    expect(Math.abs(m.verticalSpeed)).toBeLessThan(1.5);
    expect(m.airspeed).toBeGreaterThan(45);
  });

  it('takes off in under 300 m and climbs away', () => {
    const m = new FlightModel(C150);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    let run = 0;
    fly(m, 60, (m) => {
      const air = !m.onGround;
      if (air && !run) run = -m.pos[2];
      return { throttle: 1, pitch: air ? clamp((8 - m.pitchDeg) * 0.04 - m.omega[0] * 0.6, -0.3, 0.3) : m.airspeed > 26 ? 0.6 : 0 };
    });
    expect(m.crashed, m.crashReason).toBe(false);
    expect(run).toBeGreaterThan(180);
    expect(run).toBeLessThan(300);
    expect(m.pos[1]).toBeGreaterThan(80);
  });

  it('keeps its fixed gear down: the gear key does nothing, landing with the lever up is no belly landing', () => {
    const c = new Controls();
    c.gearFixed = true;
    const input: ControlInput = { mouseX: 0, mouseY: 0, down: () => false, consumePresses: () => new Set(['KeyG']) };
    expect(c.update(0.5, input, defaultSettings(), 800, 600).gearDown).toBe(true);
    c.syncSystems(false, false);
    expect(c.gearDown).toBe(true);

    const m = new FlightModel(C150);
    m.spawnAir(vec3.fromValues(0, 40, 0), 0);
    fly(m, 3, () => ({ gearDown: false }));
    expect(m.actuators.gear).toBe(1);
    // let it settle onto the ground from 40 m in a gentle glide
    fly(m, 120, (m) => ({ gearDown: false, throttle: 0.35, flaps: true, pitch: clamp((-1 - m.verticalSpeed) * 0.05 - m.omega[0] * 0.3, -0.5, 0.5) }));
    expect(m.crashed, m.crashReason).toBe(false);
    expect(m.onGround).toBe(true);
  });

  it('lands itself on the autopilot and stops on the runway', () => {
    const m = new FlightModel(C150);
    m.spawnAir(vec3.fromValues(600, 200, 3500), -10);
    const ap = new Autopilot();
    ap.startLanding(m, 0, 0, 0);
    let touch = 0;
    for (let t = 0; t < 900 && !m.crashed; t += PHYSICS_STEP) {
      m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, { ...idle, throttle: 0.6 }));
      if (m.onGround && !touch) touch = m.touchdownSink;
      if (ap.landing === 'rollout' && m.speed < 1) break;
    }
    expect(m.crashed, m.crashReason).toBe(false);
    expect(m.onGround).toBe(true);
    expect(touch).toBeLessThan(C150.landingSinkLimit);
    expect(Math.abs(m.pos[0])).toBeLessThan(15);
    expect(-m.pos[2]).toBeLessThan(1500);
  });
});
