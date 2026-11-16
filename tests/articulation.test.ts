import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { F117, SU27, aircraftMesh, PART_IDS, type AircraftMesh } from '../src/flight/aircraft';
import { lightOn, newPoses, poseJoints, signals, type ControlInputs } from '../src/flight/articulation';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';

const REST: ControlInputs = { pitch: 0, roll: 0, yaw: 0, flaps: 0, speedbrake: 0, gear: 1, nav: 1, beacon: 1, landing: 1 };
const mesh = aircraftMesh('su27');
const idOf = (name: string, m: AircraftMesh = mesh): number => {
  const i = m.joints.findIndex((j) => j.name === name);
  expect(i, name).toBeGreaterThanOrEqual(0);
  return i;
};

/** centroid of a joint's vertices after posing */
function centre(name: string, c: Partial<ControlInputs>, m: AircraftMesh = mesh): vec3 {
  const j = idOf(name, m);
  const poses = poseJoints(m.joints, signals({ ...REST, ...c }), newPoses(m.joints));
  const out = vec3.create();
  const p = vec3.create();
  let n = 0;
  for (let v = 0; v < m.joint.length; v++) {
    if (m.joint[v] !== j + 1) continue;
    vec3.set(p, m.vertices[v * 6], m.vertices[v * 6 + 1], m.vertices[v * 6 + 2]);
    vec3.transformMat3(p, p, poses[j].rot);
    vec3.add(p, p, poses[j].off);
    vec3.add(out, out, p);
    n++;
  }
  expect(n).toBeGreaterThan(0);
  return vec3.scale(out, out, 1 / n);
}
const moved = (name: string, c: Partial<ControlInputs>, m: AircraftMesh = mesh): vec3 =>
  vec3.sub(vec3.create(), centre(name, c, m), centre(name, {}, m));

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

  it('each panel is only its own surface (the stabilator once rode on the flaperon)', () => {
    const zRange = (name: string): [number, number] => {
      const j = idOf(name) + 1;
      let lo = Infinity, hi = -Infinity;
      for (let v = 0; v < mesh.joint.length; v++) {
        if (mesh.joint[v] !== j) continue;
        lo = Math.min(lo, mesh.vertices[v * 6 + 2]);
        hi = Math.max(hi, mesh.vertices[v * 6 + 2]);
      }
      return [lo, hi];
    };
    for (const s of ['L', 'R']) {
      const flap = zRange(`Flaperon_${s}`);
      const stab = zRange(`Stabilator_${s}`);
      expect(flap[1]).toBeLessThan(stab[0]); // the whole flaperon is ahead of the stabilator
      expect(stab[1] - stab[0]).toBeGreaterThan(3); // the stabilator keeps its whole 3.4 m root-to-tip chord
    }
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

describe('F-117 rig exported from the .blend', () => {
  const f = aircraftMesh('f117');
  const mv = (name: string, c: Partial<ControlInputs>): vec3 => moved(name, c, f);

  it('carries hinges, lights and break points', () => {
    expect(f.joints.map((j) => j.name).sort()).toEqual([
      'ElevonIn_L', 'ElevonIn_R', 'ElevonOut_L', 'ElevonOut_R', 'MainDoor_L', 'MainDoor_R', 'MainGear_L', 'MainGear_R',
      'MainWheel_L', 'MainWheel_R', 'NoseDoor_L', 'NoseDoor_R', 'NoseGear', 'NoseWheel', 'Ruddervator_L', 'Ruddervator_R',
    ]);
    expect(f.lights.map((l) => l.kind).sort()).toEqual(['beacon', 'beacon', 'landing', 'nav', 'nav', 'nav']);
    expect(F117.parts.map((p) => p.id).sort()).toEqual(['finL', 'finR', 'wingL', 'wingR']);
    const finR = F117.parts.find((p) => p.id === 'finR')!;
    expect(finR.maxLoad).toBe(140e3);
    expect(finR.tip[0]).toBeCloseTo(1.5);
    // the tail halves separate whole, with their hinges
    for (const s of ['L', 'R']) {
      const j = idOf(`Ruddervator_${s}`, f) + 1;
      const tag = PART_IDS.indexOf(`fin${s}` as (typeof PART_IDS)[number]) + 1;
      for (let v = 0; v < f.joint.length; v++) if (f.joint[v] === j) expect(f.parts[v]).toBe(tag);
    }
  });

  it('surfaces move the right way', () => {
    for (const n of ['ElevonIn_L', 'ElevonIn_R', 'ElevonOut_L', 'ElevonOut_R']) expect(mv(n, { pitch: 1 })[1]).toBeGreaterThan(0.02);
    expect(mv('ElevonOut_R', { roll: 1 })[1]).toBeGreaterThan(0.02);
    expect(mv('ElevonOut_L', { roll: 1 })[1]).toBeLessThan(-0.02);
    // flaps droop the inboard elevons only
    expect(mv('ElevonIn_L', { flaps: 1 })[1]).toBeLessThan(-0.02);
    expect(vec3.length(mv('ElevonOut_L', { flaps: 1 }))).toBeLessThan(1e-6);
    // butterfly tail: pull raises both trailing edges, right pedal moves both to the right
    for (const s of ['L', 'R']) {
      // (all-moving: the centroid sits near the pivot, so it moves only a few centimetres)
      expect(mv(`Ruddervator_${s}`, { pitch: 1 })[1]).toBeGreaterThan(0.01);
      expect(mv(`Ruddervator_${s}`, { yaw: 1 })[0]).toBeGreaterThan(0.01);
    }
  });

  it('gear stows forward and hides, doors close behind it', () => {
    for (const n of ['NoseGear', 'MainGear_L', 'MainGear_R']) {
      const d = mv(n, { gear: 0.5 });
      expect(d[2]).toBeLessThan(-0.1);
      expect(d[1]).toBeGreaterThan(0.05);
    }
    const poses = poseJoints(f.joints, signals({ ...REST, gear: 0 }), newPoses(f.joints));
    expect(poses[idOf('MainWheel_R', f)].visible).toBe(false);
    for (const n of ['NoseDoor_L', 'MainDoor_R']) {
      expect(mv(n, { gear: 0.5 })[1]).toBeLessThan(-0.1);
      expect(vec3.length(mv(n, { gear: 0 }))).toBeLessThan(1e-6);
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
