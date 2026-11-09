import type { Input } from '../engine/input';
import type { FlightControls } from './model';
import type { Settings } from '../ui/settings';

export type Action =
  | 'pitchUp' | 'pitchDown' | 'rollLeft' | 'rollRight' | 'yawLeft' | 'yawRight'
  | 'throttleUp' | 'throttleDown' | 'gear' | 'flaps' | 'brakes' | 'speedbrake'
  | 'pause' | 'mute' | 'restart' | 'newPoint'
  | 'camCockpit' | 'camOrbit' | 'camChase' | 'camFlyby' | 'camTower' | 'camTarget';

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
  camCockpit: 'F1',
  camOrbit: 'F2',
  camChase: 'F3',
  camFlyby: 'F4',
  camTower: 'F5',
  camTarget: 'F6',
};

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

export class Controls {
  throttle = 0;
  gearDown = true;
  flaps = false;
  private edges = new Set<Action>();
  private prevKeys = new Set<string>();
  private prevButtons: boolean[] = [];
  private axes = { pitch: 0, roll: 0, yaw: 0 };

  binding(action: Action, settings: Settings): string {
    return settings.bindings[action] ?? DEFAULT_BINDINGS[action];
  }

  justPressed(action: Action): boolean {
    return this.edges.has(action);
  }

  update(dt: number, input: Input, settings: Settings, canvasW: number, canvasH: number): FlightControls {
    this.edges.clear();
    const down = (a: Action): boolean => input.down(this.binding(a, settings));
    const edge = (a: Action): boolean => {
      const code = this.binding(a, settings);
      const now = input.down(code);
      const was = this.prevKeys.has(code);
      if (now && !was) this.edges.add(a);
      return now;
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
      const btn = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
      const was = (i: number): boolean => this.prevButtons[i] ?? false;
      if (btn(2) && !was(2)) this.edges.add('gear');
      if (btn(3) && !was(3)) this.edges.add('flaps');
      if (btn(9) && !was(9)) this.edges.add('pause');
      if (btn(12) && !was(12)) this.edges.add('camChase');
      if (btn(13) && !was(13)) this.edges.add('camCockpit');
      this.prevButtons = pad.buttons.map((b) => b.pressed);
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
    if (edge('gear')) this.gearDown = !this.gearDown;
    if (edge('flaps')) this.flaps = !this.flaps;
    for (const a of ['pause', 'mute', 'restart', 'newPoint', 'camCockpit', 'camOrbit', 'camChase', 'camFlyby', 'camTower', 'camTarget', 'speedbrake'] as Action[]) {
      edge(a);
    }

    this.prevKeys = new Set(input.keys);
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