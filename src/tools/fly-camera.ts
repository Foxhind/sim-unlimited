/**
 * The relief inspector's free flight: a perspective camera flown with W A S D (along the view and
 * sideways), Space and Z (straight up and down) and looked round with the captured mouse. Pure
 * arithmetic on the world frame (x east, y up, z south), so it can be tested without a page.
 */

/** mouse look, radians per pixel of movement */
export const LOOK_RAD_PER_PX = 0.0025;
/** the view stops this short of straight up or down, radians */
export const PITCH_LIMIT = 1.5;
/** the speed is this share of the height above sea level per second ... */
export const SPEED_PER_ALT = 0.3;
/** ... but not slower or faster than this, m/s */
export const SPEED_MIN = 30;
export const SPEED_MAX = 3000;
/** Shift */
export const BOOST = 5;

export interface FlyKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  boost: boolean;
}

export const FLY_KEY_CODES: Record<string, keyof FlyKeys> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'up',
  KeyZ: 'down',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
};

export const noKeys = (): FlyKeys => ({ forward: false, back: false, left: false, right: false, up: false, down: false, boost: false });

/** yaw 0 looks north (−z), growing clockwise; pitch > 0 looks up */
export function forwardOf(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/** the angles after `dx`, `dy` pixels of mouse movement (screen y grows downwards) */
export function look(yaw: number, pitch: number, dx: number, dy: number): { yaw: number; pitch: number } {
  let y = yaw + dx * LOOK_RAD_PER_PX;
  y = Math.atan2(Math.sin(y), Math.cos(y));
  const p = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - dy * LOOK_RAD_PER_PX));
  return { yaw: y, pitch: p };
}

/** cruising speed at an altitude, m/s, before the Shift boost and the wheel's factor */
export function cruiseSpeed(alt: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.abs(alt) * SPEED_PER_ALT));
}

/**
 * How far the camera moves in `dt` seconds: W/S along the view (climbing when it looks up), A/D
 * level sideways, Space/Z straight up and down. Diagonals are no faster than one key.
 */
export function flyStep(yaw: number, pitch: number, keys: FlyKeys, speed: number, dt: number): [number, number, number] {
  const f = forwardOf(yaw, pitch);
  const r = [Math.cos(yaw), 0, Math.sin(yaw)];
  const m = [0, 0, 0];
  const add = (v: number[], s: number) => { for (let k = 0; k < 3; k++) m[k] += v[k] * s; };
  if (keys.forward) add(f, 1);
  if (keys.back) add(f, -1);
  if (keys.right) add(r, 1);
  if (keys.left) add(r, -1);
  if (keys.up) m[1] += 1;
  if (keys.down) m[1] -= 1;
  const len = Math.hypot(m[0], m[1], m[2]);
  if (len < 1e-9) return [0, 0, 0];
  const s = (speed * (keys.boost ? BOOST : 1) * dt) / len;
  return [m[0] * s, m[1] * s, m[2] * s];
}
