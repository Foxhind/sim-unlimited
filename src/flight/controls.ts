import type { FlightControls } from './model';
import type { Settings } from '../ui/settings';
import { DEFAULT_PAD_BINDINGS, PadReader } from './gamepad';
import type { PadState } from '../engine/input';

export type Action =
  | 'pitchUp' | 'pitchDown' | 'rollLeft' | 'rollRight' | 'yawLeft' | 'yawRight'
  | 'throttleUp' | 'throttleDown' | 'gear' | 'flaps' | 'brakes' | 'speedbrake'
  | 'pause' | 'mute' | 'restart' | 'newPoint' | 'autopilot' | 'autoland'
  | 'camCockpit' | 'camOrbit' | 'camChase' | 'camFlyby' | 'camTower' | 'camTarget' | 'camNext'
  // autopilot selectors, radios, HUD mode, flight map
  | 'hdgDec' | 'hdgInc' | 'altDec' | 'altInc' | 'spdDec' | 'spdInc' | 'crsDec' | 'crsInc'
  | 'apNav' | 'navTune' | 'adfTune' | 'hudMode' | 'mapZoom' | 'mapMode';

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
  /** the next camera in turn: the touch controls' and the gamepad's one camera button */
  camNext: 'KeyC',
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
  /** the flight map: in the corner, full screen opaque, full screen see-through */
  mapMode: 'Tab',
};

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/** Gear/flaps ignore repeat toggles inside this window: switch bounce and double taps. */
export const TOGGLE_LOCKOUT_S = 0.35;

/** Minimal input surface Controls needs; the real Input implements it. */
export interface ControlInput {
  readonly mouseX: number;
  readonly mouseY: number;
  down(code: string): boolean;
  consumePresses(): Set<string>;
  /** how far a code is held 0..1 (an analog trigger); absent: held = 1 */
  value?(code: string): number;
  /** the gamepad this frame (Input.pollPads), absent or null without one */
  readonly pad?: PadState | null;
}

/** controls from an on-screen source (the touch controls): analog axes, held and pressed actions */
export interface ExtraControls {
  pitch: number;
  roll: number;
  yaw: number;
  /** the throttle lever's position while a finger holds it, else null */
  throttle: number | null;
  held: ReadonlySet<Action>;
  presses: ReadonlySet<Action>;
}

export class Controls {
  throttle = 0;
  gearDown = true;
  /** fixed gear: the gear key does nothing and the gear stays down */
  gearFixed = false;
  flaps = false;
  private edges = new Set<Action>();
  private pad = new PadReader();
  private clock = 0;
  private lastToggle: Partial<Record<'gear' | 'flaps', number>> = {};
  private axes = { pitch: 0, roll: 0, yaw: 0 };
  /** knob steps this frame: signed count per knob, x10 with Shift */
  private knobSteps = new Map<KnobAction, number>();
  private knobHeld = new Map<KnobAction, number>();

  binding(action: Action, settings: Settings): string {
    return settings.bindings[action] ?? DEFAULT_BINDINGS[action];
  }

  /** the gamepad button (or axis half) of an action: "Pad:B3", or '' when it has none */
  padBinding(action: Action, settings: Settings): string {
    return settings.padBindings[action] ?? DEFAULT_PAD_BINDINGS[action] ?? '';
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
    this.gearDown = gearDown || this.gearFixed;
    this.flaps = flaps;
  }

  private toggleAllowed(a: 'gear' | 'flaps'): boolean {
    const last = this.lastToggle[a];
    if (last !== undefined && this.clock - last < TOGGLE_LOCKOUT_S) return false;
    this.lastToggle[a] = this.clock;
    return true;
  }

  update(dt: number, input: ControlInput, settings: Settings, canvasW: number, canvasH: number, extra?: ExtraControls): FlightControls {
    this.edges.clear();
    this.clock += dt;
    const codes = (a: Action): string[] => {
      const p = this.padBinding(a, settings);
      return p ? [this.binding(a, settings), p] : [this.binding(a, settings)];
    };
    const down = (a: Action): boolean => codes(a).some((c) => input.down(c)) || (extra?.held.has(a) ?? false);
    /** 0..1: an analog trigger bound to the action gives its travel, a key or button 1 */
    const amount = (a: Action): number => {
      let v = extra?.held.has(a) ? 1 : 0;
      for (const c of codes(a)) v = Math.max(v, input.value ? input.value(c) : input.down(c) ? 1 : 0);
      return v;
    };
    // edges come from keydown events, not from polling: a tap shorter than a frame still counts once
    const presses = input.consumePresses();
    const pressed = (a: Action): boolean => codes(a).some((c) => presses.has(c)) || (extra?.presses.has(a) ?? false);
    const edge = (a: Action): void => {
      if (pressed(a)) this.edges.add(a);
    };

    const pad = this.pad.read(input.pad ?? null, settings.padAxes);

    let pitch = (down('pitchUp') ? 1 : 0) - (down('pitchDown') ? 1 : 0) + pad.pitch + (extra?.pitch ?? 0);
    let roll = (down('rollRight') ? 1 : 0) - (down('rollLeft') ? 1 : 0) + pad.roll + (extra?.roll ?? 0);
    const yaw = amount('yawRight') - amount('yawLeft') + pad.yaw + (extra?.yaw ?? 0);

    if (settings.mouseJoystick) {
      roll = clamp1(input.mouseX / (canvasW * 0.35));
      pitch = clamp1(-input.mouseY / (canvasH * 0.35));
    }

    // keyboard axes get a short ramp so taps don't jerk the airframe
    const k = Math.min(1, 12 * dt);
    this.axes.pitch += (clamp1(pitch) - this.axes.pitch) * k;
    this.axes.roll += (clamp1(roll) - this.axes.roll) * k;
    this.axes.yaw += (clamp1(yaw) - this.axes.yaw) * k;

    this.throttle = Math.max(0, Math.min(1, this.throttle + (amount('throttleUp') - amount('throttleDown')) * 0.55 * dt));
    // a lever (the touch one while held, a joystick's when it moves) sets the throttle outright
    const lever = extra?.throttle ?? pad.throttle;
    if (lever !== null) this.throttle = lever;
    edge('gear');
    edge('flaps');
    if (this.edges.has('gear') && !this.gearFixed && this.toggleAllowed('gear')) this.gearDown = !this.gearDown;
    if (this.edges.has('flaps') && this.toggleAllowed('flaps')) this.flaps = !this.flaps;
    for (const a of ['pause', 'mute', 'restart', 'newPoint', 'autopilot', 'autoland', 'camCockpit', 'camOrbit', 'camChase', 'camFlyby', 'camTower', 'camTarget', 'camNext', 'speedbrake', 'apNav', 'navTune', 'adfTune', 'hudMode', 'mapZoom', 'mapMode'] as Action[]) {
      edge(a);
    }
    this.knobSteps.clear();
    const big = input.down('ShiftLeft') || input.down('ShiftRight') ? 10 : 1;
    for (const a of KNOB_ACTIONS) {
      const tapped = pressed(a);
      let n = tapped ? 1 : 0;
      if (down(a) || tapped) {
        const held = (this.knobHeld.get(a) ?? -KNOB_DELAY_S) + (tapped ? 0 : dt);
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
      brakes: down('brakes'),
      speedbrake: down('speedbrake'),
    };
  }
}
