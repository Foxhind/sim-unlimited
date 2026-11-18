import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { AIRCRAFT, AN225, aircraftMesh, flameMesh, PART_IDS } from '../src/flight/aircraft';
import { newPoses, poseJoints, signals, type ControlInputs } from '../src/flight/articulation';
import { Autopilot } from '../src/flight/autopilot';
import { CameraRig } from '../src/flight/cameras';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';
import type { Input } from '../src/engine/input';

const REST: ControlInputs = { pitch: 0, roll: 0, yaw: 0, flaps: 0, speedbrake: 0, gear: 1, nav: 1, beacon: 1, landing: 1 };
const idle: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, gearDown: false, flaps: false, brakes: false, speedbrake: false,
};
const mesh = aircraftMesh('an225');
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

describe('An-225 rig exported from the .blend', () => {
  it('is the real size, with its hinges, lights and break points', () => {
    expect(AIRCRAFT.an225).toBe(AN225);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < mesh.vertices.length; v += 6) {
      for (let k = 0; k < 3; k++) expect(Number.isFinite(mesh.vertices[v + k])).toBe(true);
      minX = Math.min(minX, mesh.vertices[v]); maxX = Math.max(maxX, mesh.vertices[v]);
      minY = Math.min(minY, mesh.vertices[v + 1]); maxY = Math.max(maxY, mesh.vertices[v + 1]);
      minZ = Math.min(minZ, mesh.vertices[v + 2]); maxZ = Math.max(maxZ, mesh.vertices[v + 2]);
    }
    expect(maxX - minX).toBeCloseTo(88.4, 1); // span
    expect(maxZ - minZ).toBeCloseTo(84.0, 1); // length
    // fin tips 18.1 m above the tyres, which stand gearHeight below the model's origin
    expect(maxY + AN225.gearHeight).toBeCloseTo(18.1, 1);
    expect(minY).toBeGreaterThan(-AN225.gearHeight - 0.05);
    const fixed = mesh.joint.filter((j, v) => v % 3 === 0 && j === 0).length;
    expect(fixed).toBeLessThan(1500);
    expect(mesh.ramps.length / 3).toBeLessThan(3000);

    const names = mesh.joints.map((j) => j.name);
    for (const s of ['L', 'R']) {
      for (const n of ['Aileron', 'FlapIn', 'FlapOut', 'Spoiler', 'Elevator', 'Rudder', 'NoseGear', 'NoseDoor', 'MainDoor']) expect(names).toContain(`${n}_${s}`);
      for (let i = 1; i <= 7; i++) expect(names).toContain(`MainGear_${s}${i}`);
    }
    expect(names.length).toBe(32);
    expect(mesh.lights.map((l) => l.kind).sort()).toEqual(['beacon', 'beacon', 'landing', 'nav', 'nav', 'nav']);
    // red on the pilot's left (-x), green on the right
    expect(mesh.lights.find((l) => l.name === 'NavLight_L')!.pos[0]).toBeLessThan(-44);
    expect(mesh.lights.find((l) => l.name === 'NavLight_L')!.rgb).toBe(0xff2a1a);
    expect(AN225.parts.map((p) => p.id).sort()).toEqual([...PART_IDS].sort());
    // control surfaces leave with their part
    for (const [n, part] of [['Aileron_L', 'wingL'], ['FlapOut_R', 'wingR'], ['Elevator_L', 'stabL'], ['Rudder_R', 'finR']] as const) {
      const j = idOf(n) + 1;
      const tag = PART_IDS.indexOf(part) + 1;
      for (let v = 0; v < mesh.joint.length; v++) if (mesh.joint[v] === j) expect(mesh.parts[v]).toBe(tag);
    }
  });

  it('surfaces move the right way', () => {
    for (const s of ['L', 'R']) {
      expect(moved(`Elevator_${s}`, { pitch: 1 })[1]).toBeGreaterThan(0.1); // pull: trailing edges up
      expect(moved(`Rudder_${s}`, { yaw: 1 })[0]).toBeGreaterThan(0.1); // right pedal: trailing edges right
      expect(moved(`FlapIn_${s}`, { flaps: 1 })[1]).toBeLessThan(-0.2);
      expect(moved(`FlapOut_${s}`, { flaps: 1 })[1]).toBeLessThan(-0.2);
      expect(moved(`Spoiler_${s}`, { speedbrake: 1 })[1]).toBeGreaterThan(0.1);
    }
    // roll right: right aileron up, left one down
    expect(moved('Aileron_R', { roll: 1 })[1]).toBeGreaterThan(0.05);
    expect(moved('Aileron_L', { roll: 1 })[1]).toBeLessThan(-0.05);
  });

  it('nose legs stow forward, main legs fold inwards, all hide; doors open only in transit', () => {
    const at = (gear: number) => poseJoints(mesh.joints, signals({ ...REST, gear }), newPoses(mesh.joints));
    for (const s of ['L', 'R']) {
      const nose = moved(`NoseGear_${s}`, { gear: 0.5 });
      expect(nose[2]).toBeLessThan(-0.1);
      expect(nose[1]).toBeGreaterThan(0.1);
      const main = moved(`MainGear_${s}4`, { gear: 0.5 });
      expect(main[0] * (s === 'L' ? 1 : -1)).toBeGreaterThan(0.1); // towards the centreline (left is -x)
      expect(main[1]).toBeGreaterThan(0.1);
      for (const n of [`NoseGear_${s}`, `MainGear_${s}1`, `MainGear_${s}7`]) {
        expect(at(0)[idOf(n)].visible).toBe(false);
        expect(at(1)[idOf(n)].visible).toBe(true);
      }
      for (const n of [`NoseDoor_${s}`, `MainDoor_${s}`]) {
        expect(moved(n, { gear: 0.5 })[1]).toBeLessThan(-0.1);
        expect(vec3.length(moved(n, { gear: 0 }))).toBeLessThan(1e-6);
      }
    }
  });
});

describe('An-225 in flight', () => {
  it('is a heavy transport: T/W about 0.3, 2.3 g, slow roll', () => {
    expect(AN225.thrustDry / (AN225.mass * 9.80665)).toBeGreaterThan(0.25);
    expect(AN225.thrustDry / (AN225.mass * 9.80665)).toBeLessThan(0.4);
    expect(AN225.thrustAfterburner).toBe(AN225.thrustDry);
    expect(AN225.nozzles.length).toBe(6);
    const m = new FlightModel(AN225);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    let gMax = 0;
    let aMax = 0;
    for (let t = 0; t < 14 && !m.crashed; t += PHYSICS_STEP) {
      m.update(PHYSICS_STEP, { ...idle, throttle: 1, pitch: t > 4 ? 1 : 0 });
      gMax = Math.max(gMax, m.gLoad);
      aMax = Math.max(aMax, m.alphaDeg);
    }
    expect(m.damage.length).toBe(0);
    expect(gMax).toBeGreaterThan(1.7);
    expect(gMax).toBeLessThan(2.6);
    expect(aMax).toBeLessThan(AN225.stallAlpha);
    const r = new FlightModel(AN225);
    r.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    for (let t = 0; t < 6; t += PHYSICS_STEP) r.update(PHYSICS_STEP, { ...idle, throttle: 0.7, roll: t > 2 ? 1 : 0 });
    expect(r.bankDeg).toBeGreaterThan(25);
    expect(r.bankDeg).toBeLessThan(65);
  });

  it('takes off in under 2 km and climbs away', () => {
    const m = new FlightModel(AN225);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    let run = 0;
    for (let t = 0; t < 60 && !m.crashed; t += PHYSICS_STEP) {
      const airborne = !m.onGround;
      if (airborne && !run) run = -m.pos[2];
      // once off, the stick holds 8 deg of pitch
      const hold = Math.max(-0.3, Math.min(0.3, (8 - m.pitchDeg) * 0.04 - m.omega[0] * 0.6));
      m.update(PHYSICS_STEP, { ...idle, throttle: 1, flaps: true, gearDown: true, pitch: airborne ? hold : m.airspeed > 75 ? 0.6 : 0 });
    }
    expect(m.crashed, m.crashReason).toBe(false);
    expect(run).toBeGreaterThan(900);
    expect(run).toBeLessThan(2000);
    expect(m.pos[1]).toBeGreaterThan(150);
    expect(m.stall).toBe(false);
  });

  it('holds altitude and speed on the autopilot', () => {
    const m = new FlightModel(AN225);
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
    const m = new FlightModel(AN225);
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
    expect(touch).toBeLessThan(AN225.landingSinkLimit);
    expect(Math.abs(m.pos[0])).toBeLessThan(20);
    expect(-m.pos[2]).toBeLessThan(3000); // stopped within 3 km of the threshold
  });
});

describe('cameras scale with the airframe', () => {
  const input = { consumeMouse: () => [0, 0], consumeWheel: () => 0 } as unknown as Input;
  it('the An-225 pilot sits in the nose, the chase camera clear of the tail', () => {
    const m = new FlightModel(AN225);
    m.spawnAir(vec3.fromValues(0, 1000, 0), 0); // heading 0: nose towards -z
    const rig = new CameraRig();
    rig.setMode('cockpit', m);
    rig.update(m, 0.016, input, vec3.create());
    expect(rig.pos[2] - m.pos[2]).toBeCloseTo(-31.8, 3);
    expect(rig.pos[1] - m.pos[1]).toBeCloseTo(1.9, 3);
    rig.setMode('chase', m);
    rig.update(m, 0.016, input, vec3.create());
    expect(rig.pos[2] - m.pos[2]).toBeGreaterThan(100);
  });
});

describe('engines and lights go with their wing', () => {
  const wing = (id: 'wingL' | 'wingR'): number => PART_IDS.indexOf(id) + 1;

  it('finds the part each engine and light is mounted on', () => {
    expect(AN225.nozzles.filter((n) => n.part === wing('wingL')).length).toBe(3);
    expect(AN225.nozzles.filter((n) => n.part === wing('wingR')).length).toBe(3);
    for (const id of ['su27', 'f16', 'f117'] as const) {
      for (const n of AIRCRAFT[id].nozzles) expect(n.part, id).toBe(0);
    }
    for (const id of ['an225', 'f117'] as const) {
      const lights = aircraftMesh(id).lights;
      const of = (name: string): number => lights.find((l) => l.name === name)?.part ?? -1;
      expect(of('NavLight_L'), id).toBe(wing('wingL'));
      expect(of('NavLight_R'), id).toBe(wing('wingR'));
      for (const n of ['Beacon_Top', 'Beacon_Bottom', 'NavLight_Tail', 'LandingLight']) expect(of(n), `${id} ${n}`).toBe(0);
    }
    for (const id of ['su27', 'f16'] as const) {
      for (const l of aircraftMesh(id).lights) expect(l.part, `${id} ${l.name}`).toBe(0);
    }
  });

  it('a lost wing takes its three engines: half the thrust, the rest yawing the nose toward the loss', () => {
    // the same airframe with the engines fixed to the fuselage, to set the engines' part apart from the wing's
    const glued = { ...AN225, nozzles: AN225.nozzles.map((n) => ({ ...n, part: 0 })) };
    const fly = (cfg: typeof AN225): FlightModel => {
      const m = new FlightModel(cfg);
      m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
      m.detach('wingL', 'overload');
      for (let t = 0; t < 1.5; t += PHYSICS_STEP) m.update(PHYSICS_STEP, { ...idle, throttle: 1 });
      return m;
    };
    const m = fly(AN225);
    const g = fly(glued);
    expect(m.engineShare).toBe(0.5);
    expect(g.engineShare).toBe(1);
    expect(m.speed).toBeLessThan(g.speed);
    // +y body rate turns the nose left: the right engines push it toward the missing left wing
    expect(m.omega[1] - g.omega[1]).toBeGreaterThan(0.005);
    expect(flameMesh(AN225, 1, 0, m.lost).ramps.length * 2).toBe(flameMesh(AN225, 1, 0).ramps.length);
  });
});
