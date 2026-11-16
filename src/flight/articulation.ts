/**
 * Moving parts of an exported airframe: control surfaces, airbrake, gear and doors (joints), and its lights.
 * The data comes from the .blend (tools/su27-rig.py → tools/export-aircraft.py); the formulas here are the
 * ones the Blender drivers use, and the exporter refuses a file whose drivers compute anything else.
 *
 * Mesh axes: x right, y up, z aft.
 */
import { mat3, vec3 } from 'gl-matrix';

/** inputs, as on the SU27_Controls empty in Blender */
export interface ControlInputs {
  /** fly-by-wire pitch / roll / yaw commands, -1..1 (+ = nose up, roll right, yaw right) */
  pitch: number;
  roll: number;
  yaw: number;
  /** 0..1 */
  flaps: number;
  speedbrake: number;
  /** gear cycle: 1 = down and locked, 0 = up and locked */
  gear: number;
  /** lights switched on, 0 or 1 */
  nav: number;
  beacon: number;
  landing: number;
}

export type Signals = ControlInputs & { gearLeg: number; gearDoor: number };
/** signal names as they are written in the model (Blender custom properties) */
export type SignalName = keyof ControlInputs | 'gear_leg' | 'gear_door';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** the derived signals: struts move in the middle of the gear cycle, doors are open only while it runs */
export function signals(c: ControlInputs): Signals {
  return { ...c, gearLeg: clamp01((c.gear - 0.2) / 0.6), gearDoor: clamp01(5 * Math.min(c.gear, 1 - c.gear)) };
}

export function signal(s: Signals, name: string): number {
  switch (name) {
    case 'gear_leg': return s.gearLeg;
    case 'gear_door': return s.gearDoor;
    default: {
      const v = (s as unknown as Record<string, number>)[name];
      if (v === undefined) throw new Error(`unknown articulation signal ${name}`);
      return v;
    }
  }
}

export interface JointDef {
  name: string;
  /** a point on the hinge line and its direction, rest pose; positive angles turn right-handed about it */
  pivot: number[];
  axis: number[];
  /** 1-based index of the joint this one rides on (a wheel on its strut), 0 = the airframe */
  parent: number;
  /** angle, deg = clamp(bias + Σ gain × signal, limits) */
  terms: { [signal: string]: number | undefined };
  bias: number;
  limits: number[];
  /** drawn only while this signal is at least `min` (a stowed gear leg is hidden behind its doors) */
  show?: { signal: string; min: number };
}

export interface LightDef {
  name: string;
  kind: string;
  pos: number[];
  rgb: number;
  /** switch that lights it */
  signal: string;
  /** 1-based joint it rides on (landing light on the nose strut), 0 = the airframe */
  joint: number;
  /** separable part it goes with (PART_IDS index + 1), 0 = the fuselage */
  part: number;
  /** period s, lit s, phase as a fraction of the period */
  blink?: number[];
  /** lit only while this signal is fully up (>= 0.99) */
  require?: string;
}

export function jointAngle(j: JointDef, s: Signals): number {
  let a = j.bias;
  for (const name in j.terms) a += (j.terms[name] ?? 0) * signal(s, name);
  return Math.min(j.limits[1], Math.max(j.limits[0], a));
}

/** Pose of every joint for these signals: p' = rot · p + off (rest mesh coordinates), parents included. */
export interface JointPose {
  rot: mat3;
  off: vec3;
  visible: boolean;
}

export function newPoses(joints: JointDef[]): JointPose[] {
  return joints.map(() => ({ rot: mat3.create(), off: vec3.create(), visible: true }));
}

const q = vec3.create();

export function poseJoints(joints: JointDef[], s: Signals, out: JointPose[]): JointPose[] {
  // parents come before their children in the export (they are found by walking the tree), but do not rely on it
  const done = new Uint8Array(joints.length);
  const solve = (i: number): void => {
    if (done[i]) return;
    const j = joints[i];
    const o = out[i];
    const a = (jointAngle(j, s) * Math.PI) / 180;
    const [x, y, z] = j.axis;
    const c = Math.cos(a), sn = Math.sin(a), t = 1 - c;
    // rotation about the unit axis (column-major, as gl-matrix)
    mat3.set(o.rot,
      t * x * x + c, t * x * y + sn * z, t * x * z - sn * y,
      t * x * y - sn * z, t * y * y + c, t * y * z + sn * x,
      t * x * z + sn * y, t * y * z - sn * x, t * z * z + c);
    // about the pivot: off = pivot - rot · pivot
    vec3.set(q, j.pivot[0], j.pivot[1], j.pivot[2]);
    vec3.transformMat3(o.off, q, o.rot);
    vec3.sub(o.off, q, o.off);
    o.visible = !j.show || signal(s, j.show.signal) >= j.show.min;
    if (j.parent > 0) {
      solve(j.parent - 1);
      const p = out[j.parent - 1];
      mat3.multiply(o.rot, p.rot, o.rot);
      vec3.transformMat3(o.off, o.off, p.rot);
      vec3.add(o.off, o.off, p.off);
      o.visible &&= p.visible;
    }
    done[i] = 1;
  };
  for (let i = 0; i < joints.length; i++) solve(i);
  return out;
}

/** a light is lit (its switch on, blinking phase, required signal) at time t, s */
export function lightOn(l: LightDef, s: Signals, t: number): boolean {
  if (signal(s, l.signal) < 0.5) return false;
  if (l.require && signal(s, l.require) < 0.99) return false;
  if (l.blink) {
    const [period, lit, phase] = l.blink;
    const k = (((t + phase * period) % period) + period) % period;
    if (k >= lit) return false;
  }
  return true;
}
