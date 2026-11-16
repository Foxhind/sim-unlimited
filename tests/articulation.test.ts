import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { SU27, aircraftMesh, PART_IDS } from '../src/flight/aircraft';
import { lightOn, newPoses, poseJoints, signals, type ControlInputs } from '../src/flight/articulation';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';

const REST: ControlInputs = { pitch: 0, roll: 0, yaw: 0, flaps: 0, speedbrake: 0, gear: 1, nav: 1, beacon: 1, landing: 1 };
const mesh = aircraftMesh('su27');
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

describe('articulation signals', () => {
  it('struts move mid-cycle, doors are open only while the gear travels', () => {
    expect(signals({ ...REST, gear: 1 })).toMatchObject({ gearLeg: 1, gearDoor: 0 });
    expect(signals({ ...REST, gear: 0 })).toMatchObject({ gearLeg: 0, gearDoor: 0 });
    expect(signals({ ...REST, gear: 0.5 })).toMatchObject({ gearLeg: 0.5, gearDoor: 1 });
    expect(signals({ ...REST, gear: 0.1 }).gearLeg).toBe(0);
    expect(signals({ ...REST, gear: 0.1 }).gearDoor).toBeCloseTo(0.5);
  });

  it('beacons blink, the landing light needs the gear down', () => {
    const top = mesh.lights.find((l) => l.name === 'Beacon_Top')!;
    const bottom = mesh.lights.find((l) => l.name === 'Beacon_Bottom')!;
    expect(lightOn(top, signals(REST), 0.05)).toBe(true);
    expect(lightOn(top, signals(REST), 0.5)).toBe(false);
    expect(lightOn(bottom, signals(REST), 0.05)).toBe(false);
    expect(lightOn(bottom, signals(REST), 0.55)).toBe(true);
    const land = mesh.lights.find((l) => l.kind === 'landing')!;
    expect(lightOn(land, signals(REST), 0)).toBe(true);
    expect(lightOn(land, signals({ ...REST, gear: 0.6 }), 0)).toBe(false);
    expect(lightOn(land, signals({ ...REST, landing: 0 }), 0)).toBe(false);
  });
});

describe('Su-27 rig exported from the .blend', () => {
  it('carries hinges, lights and break points', () => {
    expect(mesh.joints.length).toBe(19);
    expect(mesh.joint.length).toBe(mesh.parts.length);
    const kinds = mesh.lights.map((l) => l.kind).sort();
    expect(kinds).toEqual(['beacon', 'beacon', 'landing', 'nav', 'nav', 'nav']);
    // red on the left (x < 0), green on the right
    const navL = mesh.lights.find((l) => l.name === 'NavLight_L')!;
    expect(navL.pos[0]).toBeLessThan(0);
    expect(navL.rgb >> 16).toBeGreaterThan(200);
    expect(SU27.parts.map((p) => p.id).sort()).toEqual([...PART_IDS].sort());
    const wingR = SU27.parts.find((p) => p.id === 'wingR')!;
    expect(wingR.maxLoad).toBe(960e3);
    // config tips are relative to the CG (0, 0, 1.4)
    expect(wingR.tip).toEqual([7, 0, 6.1 - 1.4]);
  });

  it('rest pose: every hinge at zero and drawn', () => {
    const poses = poseJoints(mesh.joints, signals(REST), newPoses(mesh.joints));
    for (const p of poses) {
      expect(p.visible).toBe(true);
      for (let k = 0; k < 9; k++) expect(p.rot[k]).toBeCloseTo(k % 4 === 0 ? 1 : 0, 6);
      for (let k = 0; k < 3; k++) expect(p.off[k]).toBeCloseTo(0, 6);
    }
  });

  it('surfaces move the right way', () => {
    // pull: stabilator trailing edges up (tail down force), both sides
    expect(moved('Stabilator_L', { pitch: 1 })[1]).toBeGreaterThan(0.05);
    expect(moved('Stabilator_R', { pitch: 1 })[1]).toBeGreaterThan(0.05);
    // roll right: right flaperon and stabilator up, left ones down
    expect(moved('Flaperon_R', { roll: 1 })[1]).toBeGreaterThan(0.02);
    expect(moved('Flaperon_L', { roll: 1 })[1]).toBeLessThan(-0.02);
    expect(moved('Stabilator_R', { roll: 1 })[1]).toBeGreaterThan(0.02);
    expect(moved('Stabilator_L', { roll: 1 })[1]).toBeLessThan(-0.02);
    // right pedal: rudder trailing edges to the right
    expect(moved('Rudder_L', { yaw: 1 })[0]).toBeGreaterThan(0.02);
    expect(moved('Rudder_R', { yaw: 1 })[0]).toBeGreaterThan(0.02);
    // landing flaps: flaperons and leading-edge flaps down
    for (const n of ['Flaperon_L', 'Flaperon_R', 'LEFlap_L', 'LEFlap_R']) expect(moved(n, { flaps: 1 })[1]).toBeLessThan(-0.02);
    // airbrake up
    expect(moved('Airbrake', { speedbrake: 1 })[1]).toBeGreaterThan(0.3);
  });

  it('gear stows forward and hides, doors open in transit and close again', () => {
    const at = (gear: number) => poseJoints(mesh.joints, signals({ ...REST, gear }), newPoses(mesh.joints));
    for (const n of ['NoseGear', 'MainGear_L', 'MainGear_R']) {
      const d = moved(n, { gear: 0.5 });
      expect(d[2]).toBeLessThan(-0.2); // forward
      expect(d[1]).toBeGreaterThan(0.1); // and up
      expect(at(0)[idOf(n)].visible).toBe(false);
      expect(at(0.5)[idOf(n)].visible).toBe(true);
    }
    // wheels go with their struts
    expect(at(0)[idOf('MainWheel_L')].visible).toBe(false);
    for (const n of ['NoseDoor_L', 'NoseDoor_R', 'MainDoor_L', 'MainDoor_R']) {
      expect(moved(n, { gear: 0.5 })[1]).toBeLessThan(-0.1);
      expect(vec3.length(moved(n, { gear: 0 }))).toBeLessThan(1e-6);
    }
  });
});

describe('actuators in the flight model', () => {
  const ctl = (c: Partial<FlightControls>): FlightControls => ({
    pitch: 0, roll: 0, yaw: 0, throttle: 0.6, gearDown: false, flaps: false, brakes: false, speedbrake: false, ...c,
  });
  const run = (m: FlightModel, s: number, c: FlightControls): void => {
    for (let t = 0; t < s; t += PHYSICS_STEP) m.update(PHYSICS_STEP, c);
  };

  it('a spawn takes the switches as they are, then the gear runs through its cycle', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    run(m, 0.1, ctl({}));
    expect(m.actuators.gear).toBe(0);
    run(m, 3, ctl({ gearDown: true, flaps: true, speedbrake: true }));
    expect(m.actuators.gear).toBeGreaterThan(0.4);
    expect(m.actuators.gear).toBeLessThan(0.6);
    expect(m.actuators.speedbrake).toBe(1);
    run(m, 4, ctl({ gearDown: true, flaps: true, speedbrake: true }));
    expect(m.actuators.gear).toBe(1);
    expect(m.actuators.flaps).toBe(1);
  });
});
