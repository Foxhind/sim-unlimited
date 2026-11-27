import type { PadState } from '../engine/input';
import { padButton } from '../engine/input';
import type { Action } from './controls';

/** the analog controls an axis of a gamepad or joystick can drive */
export type PadAxisRole = 'roll' | 'pitch' | 'yaw' | 'throttle';
export const PAD_AXIS_ROLES: readonly PadAxisRole[] = ['roll', 'pitch', 'yaw', 'throttle'];

/** an axis of the pad driving a control; inv flips its sense */
export interface AxisBinding {
  i: number;
  inv: boolean;
}

/**
 * The browser's "standard" layout (Xbox / PlayStation): left stick pitch and roll, right stick
 * rudder, triggers throttle, the rest as below. A pull on the stick raises the nose, as on a real
 * stick and as the arrows do (Down = pitch up).
 */
export const STANDARD_PAD_AXES: Record<PadAxisRole, AxisBinding | null> = {
  roll: { i: 0, inv: false },
  pitch: { i: 1, inv: false },
  yaw: { i: 2, inv: false },
  throttle: null,
};

/**
 * A joystick or HOTAS (no standard layout): X and Y are the stick everywhere; which axis is the
 * twist or the throttle lever differs from model to model, so those wait to be assigned in Settings.
 */
export const JOYSTICK_AXES: Record<PadAxisRole, AxisBinding | null> = {
  roll: { i: 0, inv: false },
  pitch: { i: 1, inv: false },
  yaw: null,
  throttle: null,
};

/** standard-layout buttons: A B X Y, LB RB, LT RT, Back Start, L3 R3, D-pad up down left right */
export const DEFAULT_PAD_BINDINGS: Partial<Record<Action, string>> = {
  brakes: padButton(0),
  speedbrake: padButton(1),
  gear: padButton(2),
  flaps: padButton(3),
  yawLeft: padButton(4),
  yawRight: padButton(5),
  throttleDown: padButton(6),
  throttleUp: padButton(7),
  mapMode: padButton(8),
  pause: padButton(9),
  autopilot: padButton(10),
  hudMode: padButton(11),
  camNext: padButton(12),
  camCockpit: padButton(13),
  autoland: padButton(14),
  apNav: padButton(15),
};

/** stick deadzone: a centred stick of a worn pad still reads a few percent */
const DEADZONE = 0.1;

const dz = (v: number): number => {
  const a = Math.abs(v);
  return a < DEADZONE ? 0 : (Math.sign(v) * (a - DEADZONE)) / (1 - DEADZONE);
};

export function padAxes(pad: PadState, overrides: Partial<Record<PadAxisRole, AxisBinding | null>>): Record<PadAxisRole, AxisBinding | null> {
  return { ...(pad.mapping === 'standard' ? STANDARD_PAD_AXES : JOYSTICK_AXES), ...overrides };
}

/** what the pad's axes ask for this frame */
export interface PadAnalog {
  pitch: number;
  roll: number;
  yaw: number;
  /** the throttle lever's position 0..1 when it moved this frame, else null (keys and buttons keep the throttle) */
  throttle: number | null;
}

/**
 * Reads the analog controls of a pad. A throttle lever only takes over when it moves, so a lever
 * left at idle does not pin the throttle the keys or the autopilot set.
 */
export class PadReader {
  private lastThrottle: number | null = null;

  read(pad: PadState | null, overrides: Partial<Record<PadAxisRole, AxisBinding | null>>): PadAnalog {
    const out: PadAnalog = { pitch: 0, roll: 0, yaw: 0, throttle: null };
    if (!pad) {
      this.lastThrottle = null;
      return out;
    }
    const map = padAxes(pad, overrides);
    const axis = (b: AxisBinding | null): number => {
      if (!b) return 0;
      const v = pad.axes[b.i] ?? 0;
      return b.inv ? -v : v;
    };
    out.roll = dz(axis(map.roll));
    // stick axes read +1 pulled back (towards the pilot), and pulling back raises the nose
    out.pitch = dz(axis(map.pitch));
    out.yaw = dz(axis(map.yaw));
    if (map.throttle) {
      // a lever reads -1 pushed forward (full power) .. +1 pulled back (idle)
      const lever = (1 - axis(map.throttle)) / 2;
      if (this.lastThrottle !== null && Math.abs(lever - this.lastThrottle) > 0.004) out.throttle = Math.max(0, Math.min(1, lever));
      if (this.lastThrottle === null || out.throttle !== null) this.lastThrottle = lever;
    } else {
      this.lastThrottle = null;
    }
    return out;
  }
}

/**
 * The axis that moved the most since `rest` (the axes when the assignment started), with its sign:
 * how Settings learns which axis is the twist or the lever. Null until one moved far enough.
 */
export function movedAxis(rest: readonly number[], now: readonly number[]): { i: number; sign: 1 | -1 } | null {
  let best = -1;
  let bestD = 0.5;
  for (let i = 0; i < now.length; i++) {
    const d = Math.abs((now[i] ?? 0) - (rest[i] ?? 0));
    if (d > bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  return { i: best, sign: (now[best] ?? 0) - (rest[best] ?? 0) > 0 ? 1 : -1 };
}

/** short label for a pad code in Settings: "B3", "A2+" */
export function padCodeLabel(code: string): string {
  return code.replace('Pad:', '');
}
