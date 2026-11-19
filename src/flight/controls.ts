import type { FlightControls } from './model';
import type { Settings } from '../ui/settings';

export type Action =
  | 'pitchUp' | 'pitchDown' | 'rollLeft' | 'rollRight' | 'yawLeft' | 'yawRight'
  | 'throttleUp' | 'throttleDown' | 'gear' | 'flaps' | 'brakes' | 'speedbrake'
  | 'pause' | 'mute' | 'restart' | 'newPoint' | 'autopilot' | 'autoland'
  | 'camCockpit' | 'camOrbit' | 'camChase' | 'camFlyby' | 'camTower' | 'camTarget'
  // autopilot selectors, radios, HUD mode, flight map
  | 'hdgDec' | 'hdgInc' | 'altDec' | 'altInc' | 'spdDec' | 'spdInc' | 'crsDec' | 'crsInc'
  | 'apNav' | 'navTune' | 'adfTune' | 'hudMode' | 'mapZoom';

/** selector knobs: one step per press, then repeating while held (Shift makes a step ten times bigger) */
export const KNOB_ACTIONS = ['hdgDec', 'hdgInc', 'altDec', 'altInc', 'spdDec', 'spdInc', 'crsDec', 'crsInc'] as const;
export type KnobAction = (typeof KNOB_ACTIONS)[number];
const KNOB_DELAY_S = 0.4;
const KNOB_RATE_S = 0.07;

/** Q37 default layout; arrows are the stick (Up pushes the nose down). */
export const DEFAULT_BINDINGS: Record<Action, string> = {
  pitchUp: 'ArrowDown',
  pitchDown: 'ArrowUp',
  rollLeft: 'ArrowLeft',
  rollRight: 'ArrowRight',
  yawLeft: 'KeyQ',
  yawRight: 'KeyE',
  throttleUp: 'KeyA',
  throttleDown: 'KeyZ',
  gear: 'KeyG',
  flaps: 'KeyF',
  brakes: 'KeyB',
  speedbrake: 'KeyX',
  pause: 'Escape',
  mute: 'KeyM',
  restart: 'KeyR',
  newPoint: 'KeyN',
  autopilot: 'KeyP',
  autoland: 'KeyL',
  camCockpit: 'F1',
  camOrbit: 'F2',
  camChase: 'F3',
  camFlyby: 'F4',
  camTower: 'F5',
  camTarget: 'F6',
  hdgDec: 'BracketLeft',
  hdgInc: 'BracketRight',
  altDec: 'Minus',
  altInc: 'Equal',
  spdDec: 'Digit9',
  spdInc: 'Digit0',
  crsDec: 'Semicolon',
  crsInc: 'Quote',
  apNav: 'KeyU',
  navTune: 'KeyT',
  adfTune: 'KeyY',
  hudMode: 'KeyH',
  mapZoom: 'KeyK',
};

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/** Gear/flaps ignore repeat toggles inside this window: switch bounce and double taps. */
export const TOGGLE_LOCKOUT_S = 0.35;
/** Gamepad button hysteresis: analog triggers/worn buttons hovering near 0.5 must not chatter. */
const PAD_PRESS = 0.6;
const PAD_RELEASE = 0.3;

/** Minimal input surface Controls needs; the real Input implements it. */
export interface ControlInput {
  readonly mouseX: number;
  readonly mouseY: number;
  down(code: string): boolean;
  consumePresses(): Set<string>;
}

export class Controls {
  throttle = 0;
  gearDown = true;
  flaps = false;
  private edges = new Set<Action>();
  private padHeld: boolean[] = [];
  private clock = 0;
  private lastToggle: Partial<Record<'gear' | 'flaps', number>> = {};
  private axes = { pitch: 0, roll: 0, yaw: 0 };
  /** knob steps this frame: signed count per knob, x10 with Shift */
  private knobSteps = new Map<KnobAction, number>();
  private knobHeld = new Map<KnobAction, number>();

  binding(action: Action, settings: Settings): string {
    return settings.bindings[action] ?? DEFAULT_BINDINGS[action];
  }

  justPressed(action: Action): boolean {
    return this.edges.has(action);
  }

  /** steps of a selector knob this frame (a press, then auto-repeat while held); 10 per step with Shift */
  knob(action: KnobAction): number {
    return this.knobSteps.get(action) ?? 0;
  }

  /** The autopilot sets gear/flaps itself; adopt its state so disengaging doesn't snap back to a stale one. */
  syncSystems(gearDown: boolean, flaps: boolean): void {
    this.gearDown = gearDown;
    this.flaps = flaps;
  }

  private toggleAllowed(a: 'gear' | 'flaps'): boolean {
    const last = this.lastToggle[a];
    if (last !== undefined && this.clock - last < TOGGLE_LOCKOUT_S) return false;
    this.lastToggle[a] = this.clock;
    return true;
  }

  update(dt: number, input: ControlInput, settings: Settings, canvasW: number, canvasH: number): FlightControls {
    this.edges.clear();
    this.clock += dt;
    const down = (a: Action): boolean => input.down(this.binding(a, settings));
    // edges come from keydown events, not from polling: a tap shorter than a frame still counts once
    const presses = input.consumePresses();
    const edge = (a: Action): void => {
      if (presses.has(this.binding(a, settings))) this.edges.add(a);
    };

    // gamepad: stick pitch/roll, bumpers yaw, A/B throttle, X gear, Y flaps, Start pause
    let padPitch = 0, padRoll = 0, padYaw = 0, padThr = 0;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (pad) {
      const dz = (v: number): number => (Math.abs(v) < 0.12 ? 0 : v);
      padRoll = dz(pad.axes[0] ?? 0);
      padPitch = -dz(pad.axes[1] ?? 0);
      padYaw = (pad.buttons[5]?.pressed ? 1 : 0) - (pad.buttons[4]?.pressed ? 1 : 0);
      padThr = (pad.buttons[0]?.pressed ? 1 : 0) - (pad.buttons[1]?.pressed ? 1 : 0);
      const held = pad.buttons.map((b, i) => {
        const v = b.value || (b.pressed ? 1 : 0);
        return this.padHeld[i] ? v > PAD_RELEASE : v > PAD_PRESS;
      });
      const rose = (i: number): boolean => (held[i] ?? false) && !(this.padHeld[i] ?? false);
      if (rose(2)) this.edges.add('gear');
      if (rose(3)) this.edges.add('flaps');
      if (rose(9)) this.edges.add('pause');
      if (rose(12)) this.edges.add('camChase');
      if (rose(13)) this.edges.add('camCockpit');
      this.padHeld = held;
    } else {
      this.padHeld = [];
    }

    let pitch = (down('pitchUp') ? 1 : 0) - (down('pitchDown') ? 1 : 0) + padPitch;
    let roll = (down('rollRight') ? 1 : 0) - (down('rollLeft') ? 1 : 0) + padRoll;
    let yaw = (down('yawRight') ? 1 : 0) - (down('yawLeft') ? 1 : 0) + padYaw;

    if (settings.mouseJoystick) {
      roll = clamp1(input.mouseX / (canvasW * 0.35));
      pitch = clamp1(-input.mouseY / (canvasH * 0.35));
    }

    // keyboard axes get a short ramp so taps don't jerk the airframe
    const k = Math.min(1, 12 * dt);
    this.axes.pitch += (clamp1(pitch) - this.axes.pitch) * k;
    this.axes.roll += (clamp1(roll) - this.axes.roll) * k;
    this.axes.yaw += (clamp1(yaw) - this.axes.yaw) * k;

    this.throttle = Math.max(0, Math.min(1, this.throttle + ((down('throttleUp') ? 1 : 0) - (down('throttleDown') ? 1 : 0) + padThr) * 0.55 * dt));
    edge('gear');
    edge('flaps');
    if (this.edges.has('gear') && this.toggleAllowed('gear')) this.gearDown = !this.gearDown;
    if (this.edges.has('flaps') && this.toggleAllowed('flaps')) this.flaps = !this.flaps;
    for (const a of ['pause', 'mute', 'restart', 'newPoint', 'autopilot', 'autoland', 'camCockpit', 'camOrbit', 'camChase', 'camFlyby', 'camTower', 'camTarget', 'speedbrake', 'apNav', 'navTune', 'adfTune', 'hudMode', 'mapZoom'] as Action[]) {
      edge(a);
    }
    this.knobSteps.clear();
    const big = input.down('ShiftLeft') || input.down('ShiftRight') ? 10 : 1;
    for (const a of KNOB_ACTIONS) {
      const pressed = presses.has(this.binding(a, settings));
      let n = pressed ? 1 : 0;
      if (down(a) || pressed) {
        const held = (this.knobHeld.get(a) ?? -KNOB_DELAY_S) + (pressed ? 0 : dt);
        if (held > 0) {
          n += Math.floor(held / KNOB_RATE_S);
          this.knobHeld.set(a, held % KNOB_RATE_S);
        } else this.knobHeld.set(a, held);
      } else this.knobHeld.delete(a);
      if (n) this.knobSteps.set(a, n * big);
    }

    return {
      pitch: this.axes.pitch,
      roll: this.axes.roll,
      yaw: this.axes.yaw,
      throttle: this.throttle,
      gearDown: this.gearDown,
      flaps: this.flaps,
      brakes: down('brakes') || (pad?.buttons[6]?.pressed ?? false),
      speedbrake: down('speedbrake'),
    };
  }
}