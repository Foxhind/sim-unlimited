import { colour, selfLit } from '../engine/palette';
import { SIGNAL_SHAPE } from './props-mesher';
import type { P2 } from './ribbon-shapes';

/**
 * A junction's traffic lights (ground-cover signals) on one cycle of PHASES slots, PHASE_S each,
 * the same for everyone at a moment of sim time: its approaches grouped by their axes (signalPlan),
 * each group open in its slots, the whole schedule turned by the junction's shift (signalShift) so
 * that neighbouring junctions are not all in step. A slot's end leaving an open group: yellow alone
 * for YELLOW_S; one coming to a closed group: red and yellow for RED_YELLOW_S. At night (local mean
 * solar time DUTY_H) the lights of a junction of minor roads only flash yellow, all in step.
 */
export const SIGNAL = {
  PHASES: 4,
  PHASE_S: 15,
  YELLOW_S: 3,
  RED_YELLOW_S: 2,
  /** the night duty: from, to, local solar hours */
  DUTY_H: [0, 5] as [number, number],
  /** the duty's flashing: a period, lit its first half, seconds (wall clock) */
  BLINK_S: 1,
} as const;

/** the lenses lit, a bit each */
export const LENS = { RED: 1, YELLOW: 2, GREEN: 4 } as const;

/** the lenses' colours: lit (light sources), and unlit by day */
export const LENS_RGB = {
  RED: colour(255, 45, 30),
  YELLOW: colour(255, 190, 30),
  GREEN: colour(40, 255, 130),
  DARK: colour(26, 28, 30),
} as const;

/** a lens on its head's face, a hair in front of it: the unlit one, the lit one over it, metres */
export const LENS_OUT = { DARK: 0.01, LIT: 0.02 } as const;

/** two approaches are one flow where their axes are closer than this to parallel (cosine; 45°, ground-cover CROSS_COS) */
const PARALLEL_COS = Math.SQRT1_2;
/** per number of groups, each group's slots, the senior first */
const SLOTS: ReadonlyArray<ReadonlyArray<number>> = [[0b0111], [0b0011, 0b1100], [0b0011, 0b0100, 0b1000], [0b0001, 0b0010, 0b0100, 0b1000]];

/** an approach to a junction: the way out along it (unit), its road's priority (way-styles roadPriority) */
export interface SignalApproach { facing: P2; prio: number }

const mod = (v: number, m: number): number => ((v % m) + m) % m;
/** an angle to 1e-6 rad: the same in the neighbour tile's frame */
const q = (a: number): number => Math.round(a * 1e6);

/**
 * Per approach, the slots it is open in (a bit each). The approaches whose axes are within 45° are
 * one group, the senior road's first: by priority, then axis and direction (whatever the order they
 * come in: the neighbour tile builds the same junction alone); each joins the first group whose
 * axis (its first member's) is parallel to it. More than PHASES groups: the two of closest axes are
 * one until PHASES are left. One group is open three slots of four, two half the cycle each, three
 * the senior half and a quarter each, four a quarter each.
 */
export function signalPlan(approaches: ReadonlyArray<SignalApproach>): number[] {
  const dir = approaches.map((a) => mod(Math.atan2(a.facing[1], a.facing[0]), 2 * Math.PI));
  const axis = dir.map((d) => mod(d, Math.PI));
  const order = approaches.map((_, k) => k).sort((a, b) =>
    approaches[b].prio - approaches[a].prio || q(axis[a]) - q(axis[b]) || q(dir[a]) - q(dir[b]));
  const groups: number[][] = [];
  for (const k of order) {
    const f = approaches[k].facing;
    const g = groups.find((m) => { const h = approaches[m[0]].facing; return Math.abs(f[0] * h[0] + f[1] * h[1]) > PARALLEL_COS; });
    if (g) g.push(k); else groups.push([k]);
  }
  while (groups.length > SIGNAL.PHASES) {
    let best = [0, 1], gap = Infinity;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const d = Math.abs(axis[groups[i][0]] - axis[groups[j][0]]), e = Math.min(d, Math.PI - d);
      if (e < gap - 1e-9) { gap = e; best = [i, j]; }
    }
    groups[best[0]].push(...groups[best[1]]);
    groups.splice(best[1], 1);
  }
  const masks = approaches.map(() => 0);
  if (!groups.length) return masks;
  const slots = SLOTS[groups.length - 1];
  groups.forEach((g, i) => { for (const k of g) masks[k] = slots[i]; });
  return masks;
}

/** a junction's turn of the cycle, 0..PHASES−1 slots, from a key of its place (its nodes' `lon,lat`): the same in every tile */
export function signalShift(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return ((h ^ (h >>> 16)) >>> 0) % SIGNAL.PHASES;
}

/** a road of residential standing or lower (not motorway, trunk, primary, secondary, tertiary or their links): its lights flash yellow at night */
export function isMinorRoad(tags: Record<string, string>): boolean {
  return !/^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(tags.highway ?? '');
}

/**
 * The lenses lit (LENS bits) of an approach open in slots `mask` at a junction of `shift`: at sim
 * time `simSeconds` (epoch seconds), local solar hour `localHour`; a duty light flashes by the wall
 * clock `blinkSeconds` (a steady 1 Hz whatever the time acceleration). Open slots in a row are one
 * green.
 */
export function signalAspect(mask: number, shift: number, duty: boolean, simSeconds: number, localHour: number, blinkSeconds: number): number {
  const S = SIGNAL;
  if (duty && localHour >= S.DUTY_H[0] && localHour < S.DUTY_H[1]) return mod(blinkSeconds, S.BLINK_S) < S.BLINK_S / 2 ? LENS.YELLOW : 0;
  const t = mod(simSeconds + shift * S.PHASE_S, S.PHASES * S.PHASE_S);
  const s = Math.min(S.PHASES - 1, Math.floor(t / S.PHASE_S)), r = t - s * S.PHASE_S;
  const open = ((mask >> s) & 1) !== 0, next = ((mask >> ((s + 1) % S.PHASES)) & 1) !== 0;
  if (open) return next || r < S.PHASE_S - S.YELLOW_S ? LENS.GREEN : LENS.YELLOW;
  return next && r >= S.PHASE_S - S.RED_YELLOW_S ? LENS.RED | LENS.YELLOW : LENS.RED;
}

/** per traffic light of a tile: its post's foot x, y, z (the tile's frame), its head's yaw, its slots (mask), shift, duty (1 or 0) */
export const SIGNAL_STRIDE = 7;
/** at most this many lenses of a light lit at once (red and yellow) */
export const MAX_LIT = 2;
/** vertices of a lens: a square, both windings */
export const LENS_VERTICES = 12;

/** the height of a lens (one LENS bit) over the post's foot, metres */
export function lensY(lens: number): number {
  return lens === LENS.RED ? SIGNAL_SHAPE.RED_Y : lens === LENS.YELLOW ? SIGNAL_SHAPE.YELLOW_Y : SIGNAL_SHAPE.GREEN_Y;
}

/** a lens's corners: a square LENS_HALF each way at height `y`, `out` in front of the head's face of a post at (x, z) facing `yaw` */
export function lensCorners(x: number, y: number, z: number, yaw: number, out: number): { x: number; y: number; z: number }[] {
  const cx = Math.cos(yaw), cz = Math.sin(yaw), d = SIGNAL_SHAPE.HEAD_FRONT + out, h = SIGNAL_SHAPE.LENS_HALF;
  const px = x + cx * d, pz = z + cz * d;
  const at = (side: number, up: number) => ({ x: px - cz * side * h, y: y + up * h, z: pz + cx * side * h });
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

/**
 * Each light's lenses lit now into `aspects` (one per light of `signals`, SIGNAL_STRIDE); true when
 * any is not what it held
 */
export function signalAspects(signals: Float32Array, simSeconds: number, localHour: number, blinkSeconds: number, aspects: Uint8Array): boolean {
  let changed = false;
  for (let i = 0, n = 0; i + SIGNAL_STRIDE <= signals.length; i += SIGNAL_STRIDE, n++) {
    const a = signalAspect(signals[i + 4], signals[i + 5], signals[i + 6] !== 0, simSeconds, localHour, blinkSeconds);
    if (aspects[n] !== a) { aspects[n] = a; changed = true; }
  }
  return changed;
}

/**
 * The lit lenses of `aspects` as self-lit faces (pos + normal, a face colour per vertex: the world
 * mesh's), LENS_OUT.LIT in front of the head; their vertex count
 */
export function litLenses(signals: Float32Array, aspects: Uint8Array, verts: Float32Array, ramps: Uint32Array): number {
  let v = 0;
  const tri = (a: { x: number; y: number; z: number }, b: typeof a, c: typeof a, ramp: number) => {
    const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z, e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const p of [a, b, c]) {
      verts.set([p.x, p.y, p.z, nx, ny, nz], v * 6);
      ramps[v++] = ramp;
    }
  };
  for (let i = 0, n = 0; i + SIGNAL_STRIDE <= signals.length; i += SIGNAL_STRIDE, n++) {
    for (const lens of [LENS.RED, LENS.YELLOW, LENS.GREEN]) {
      if (!(aspects[n] & lens)) continue;
      const ramp = selfLit(lens === LENS.RED ? LENS_RGB.RED : lens === LENS.YELLOW ? LENS_RGB.YELLOW : LENS_RGB.GREEN);
      const [a, b, c, d] = lensCorners(signals[i], signals[i + 1] + lensY(lens), signals[i + 2], signals[i + 3], LENS_OUT.LIT);
      // both windings: whatever the side drawn
      tri(a, b, c, ramp);
      tri(a, c, d, ramp);
      tri(a, c, b, ramp);
      tri(a, d, c, ramp);
    }
  }
  return v;
}
