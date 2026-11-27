import { describe, expect, it } from 'vitest';
import { Controls, type ControlInput } from '../src/flight/controls';
import { movedAxis, PadReader } from '../src/flight/gamepad';
import { padButton, type PadState } from '../src/engine/input';
import { defaultSettings } from '../src/ui/settings';

const pad = (axes: number[], mapping = 'standard'): PadState => ({ id: 'test', mapping, axes, buttons: [] });

describe('gamepad axes', () => {
  it('a standard pad: left stick pulled back raises the nose, pushed right rolls right', () => {
    const r = new PadReader().read(pad([0.8, 0.8, 0, 0]), {});
    expect(r.pitch).toBeGreaterThan(0.7);
    expect(r.roll).toBeGreaterThan(0.7);
  });

  it('a centred worn stick reads nothing', () => {
    const r = new PadReader().read(pad([0.06, -0.08, 0.05, 0]), {});
    expect([r.pitch, r.roll, r.yaw]).toEqual([0, 0, 0]);
  });

  it('a joystick has no rudder or throttle until they are assigned', () => {
    const r = new PadReader().read(pad([0, 0, 1, -1], ''), {});
    expect(r.yaw).toBe(0);
    expect(r.throttle).toBeNull();
  });

  it('a throttle lever takes over only when it moves', () => {
    const reader = new PadReader();
    const axes = { throttle: { i: 2, inv: false } };
    expect(reader.read(pad([0, 0, 1], ''), axes).throttle).toBeNull(); // at rest: idle, ignored
    expect(reader.read(pad([0, 0, 1], ''), axes).throttle).toBeNull();
    expect(reader.read(pad([0, 0, -1], ''), axes).throttle).toBe(1); // pushed forward: full
  });

  it('an inverted axis reads the other way', () => {
    const r = new PadReader().read(pad([0, 0.8]), { pitch: { i: 1, inv: true } });
    expect(r.pitch).toBeLessThan(-0.7);
  });

  it('assigning picks the axis that moved most, with its sign', () => {
    expect(movedAxis([0, 0, 1, 0], [0.1, 0, 1, -0.9])).toEqual({ i: 3, sign: -1 });
    expect(movedAxis([0, 0], [0.2, -0.3])).toBeNull();
  });
});

class PadInput implements ControlInput {
  held = new Map<string, number>();
  presses = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  pad: PadState | null = pad([0, 0, 0, 0]);
  down(code: string): boolean { return this.held.has(code); }
  value(code: string): number { return this.held.get(code) ?? 0; }
  consumePresses(): Set<string> { const p = this.presses; this.presses = new Set(); return p; }
}

describe('gamepad buttons', () => {
  const settings = defaultSettings();

  it('the right trigger opens the throttle in proportion to its travel', () => {
    const full = new Controls(), half = new Controls();
    const a = new PadInput(), b = new PadInput();
    a.held.set(padButton(7), 1);
    b.held.set(padButton(7), 0.5);
    for (let i = 0; i < 60; i++) { full.update(1 / 60, a, settings, 800, 600); half.update(1 / 60, b, settings, 800, 600); }
    expect(half.throttle).toBeCloseTo(full.throttle / 2, 5);
    expect(full.throttle).toBeGreaterThan(0.5);
  });

  it('X toggles the gear, A holds the brakes', () => {
    const c = new Controls(), i = new PadInput();
    i.presses.add(padButton(2));
    i.held.set(padButton(0), 1);
    const f = c.update(1 / 60, i, settings, 800, 600);
    expect(f.gearDown).toBe(false);
    expect(f.brakes).toBe(true);
  });

  it('a rebound action follows its new button, and one left without a button does nothing', () => {
    const s = { ...defaultSettings(), padBindings: { gear: padButton(5), flaps: '' } };
    const c = new Controls(), i = new PadInput();
    i.presses.add(padButton(2)); // the old gear button
    i.presses.add(padButton(3)); // flaps', now unbound
    let f = c.update(1 / 60, i, s, 800, 600);
    expect([f.gearDown, f.flaps]).toEqual([true, false]);
    i.presses.add(padButton(5));
    f = c.update(1 / 60, i, s, 800, 600);
    expect(f.gearDown).toBe(false);
  });
});
