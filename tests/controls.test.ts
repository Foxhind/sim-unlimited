import { describe, expect, it } from 'vitest';
import { Controls, TOGGLE_LOCKOUT_S, type ControlInput } from '../src/flight/controls';
import { defaultSettings } from '../src/ui/settings';

class FakeInput implements ControlInput {
  held = new Set<string>();
  presses = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  down(code: string): boolean { return this.held.has(code); }
  consumePresses(): Set<string> { const p = this.presses; this.presses = new Set(); return p; }
  tap(code: string): void { this.presses.add(code); }
}

const settings = defaultSettings();
const step = (c: Controls, i: FakeInput, dt = 1 / 60) => c.update(dt, i, settings, 800, 600);

describe('gear/flaps toggles', () => {
  it('a held key toggles once, not every frame', () => {
    const c = new Controls(); const i = new FakeInput();
    i.held.add('KeyG'); i.tap('KeyG');
    for (let f = 0; f < 120; f++) step(c, i);
    expect(c.gearDown).toBe(false);
  });

  it('a tap shorter than a frame still toggles', () => {
    const c = new Controls(); const i = new FakeInput();
    i.tap('KeyF'); // pressed and released between frames: never seen as held
    step(c, i);
    expect(c.flaps).toBe(true);
  });

  it('a bouncing switch inside the lockout toggles once', () => {
    const c = new Controls(); const i = new FakeInput();
    i.tap('KeyG'); step(c, i);
    i.tap('KeyG'); step(c, i); // 16 ms later
    i.tap('KeyG'); step(c, i);
    expect(c.gearDown).toBe(false);
  });

  it('a deliberate second press after the lockout toggles back', () => {
    const c = new Controls(); const i = new FakeInput();
    i.tap('KeyF'); step(c, i);
    step(c, i, TOGGLE_LOCKOUT_S + 0.01);
    i.tap('KeyF'); step(c, i);
    expect(c.flaps).toBe(false);
  });

  it('gear and flaps lockouts are independent', () => {
    const c = new Controls(); const i = new FakeInput();
    i.tap('KeyG'); i.tap('KeyF'); step(c, i);
    expect([c.gearDown, c.flaps]).toEqual([false, true]);
  });

  it('autopilot state is adopted so disengaging keeps the gear where it is', () => {
    const c = new Controls(); const i = new FakeInput();
    i.tap('KeyG'); step(c, i); // pilot retracts
    c.syncSystems(true, true); // autoland lowered gear and flaps
    expect(step(c, i).gearDown).toBe(true);
  });
});
