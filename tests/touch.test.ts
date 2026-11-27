import { describe, expect, it } from 'vitest';
import { TouchControls, touchLayout, type TouchLayout } from '../src/ui/touch';
import { Controls, type ControlInput } from '../src/flight/controls';
import type { Touch } from '../src/engine/input';
import { defaultSettings } from '../src/ui/settings';

interface R { x: number; y: number; w: number; h: number }
const overlap = (a: R, b: R): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const stickBox = (L: TouchLayout): R => ({ x: L.stick.x - L.stick.r, y: L.stick.y - L.stick.r, w: 2 * L.stick.r, h: 2 * L.stick.r });

/** phones (CSS px x dpr), sideways and upright, with and without a notch */
const SCREENS: Array<[string, number, number, number, { l: number; t: number; r: number; b: number }]> = [
  ['iPhone landscape', 844 * 3, 390 * 3, 3, { l: 47 * 3, t: 0, r: 47 * 3, b: 21 * 3 }],
  ['iPhone portrait', 390 * 3, 844 * 3, 3, { l: 0, t: 47 * 3, r: 0, b: 34 * 3 }],
  ['small Android landscape', 640 * 2, 360 * 2, 2, { l: 0, t: 0, r: 0, b: 0 }],
  ['small Android portrait', 360 * 2, 640 * 2, 2, { l: 0, t: 0, r: 0, b: 0 }],
];

describe('touch layout', () => {
  for (const [name, w, h, u, inset] of SCREENS) {
    it(`${name}: every control on screen, clear of the insets and of each other`, () => {
      const L = touchLayout(w, h, u, inset);
      const all: Array<[string, R]> = [['stick', stickBox(L)], ['lever', L.lever], ...L.buttons.map((b): [string, R] => [b.action, b])];
      for (const [n, r] of all) {
        expect(r.x, n).toBeGreaterThanOrEqual(inset.l);
        expect(r.y, n).toBeGreaterThanOrEqual(inset.t);
        expect(r.x + r.w, n).toBeLessThanOrEqual(w - inset.r);
        expect(r.y + r.h, n).toBeLessThanOrEqual(h - inset.b);
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) expect(overlap(all[i][1], all[j][1]), `${all[i][0]} / ${all[j][0]}`).toBe(false);
      }
    });
  }

  it('upright, the controls take a band across the bottom; sideways, columns at the sides', () => {
    const p = touchLayout(1170, 2532, 3);
    const l = touchLayout(2532, 1170, 3);
    expect(p.reserve.bottom).toBeGreaterThan(0);
    expect(p.reserve.right).toBe(0);
    expect(l.reserve.bottom).toBe(0);
    expect(l.reserve.right).toBeGreaterThan(0);
  });
});

const touchAt = (id: number, owner: string, sx: number, sy: number, x = sx, y = sy): Touch => ({ id, owner, startX: sx, startY: sy, x, y });

describe('touch controls', () => {
  const setup = (): TouchControls => {
    const t = new TouchControls();
    t.setLayout(2532, 1170, 3, 844, { l: 0, t: 0, r: 0, b: 0 });
    return t;
  };

  it('a finger on the stick zone takes the stick, on a button the button (pressed once)', () => {
    const t = setup();
    const L = t.layout;
    expect(t.claim(L.stick.x / 3, L.stick.y / 3)).toBe('stick');
    const gear = L.buttons.find((b) => b.action === 'gear')!;
    expect(t.claim((gear.x + gear.w / 2) / 3, (gear.y + gear.h / 2) / 3)).toBe('btn:gear');
    expect([...t.update(new Map(), 0).presses]).toEqual(['gear']);
    expect(t.claim(844 / 2, 20)).toBeNull(); // the sky: the view's
  });

  it('the stick pulled down and right raises the nose and rolls right, at most full throw', () => {
    const t = setup();
    const r = t.layout.stick.r / 3;
    const out = t.update(new Map([[1, touchAt(1, 'stick', 100, 300, 100 + 3 * r, 300 + 3 * r)]]), 0);
    expect(out.pitch).toBeGreaterThan(0.6);
    expect(out.roll).toBeGreaterThan(0.6);
    expect(Math.hypot(out.pitch, out.roll)).toBeCloseTo(1, 5);
  });

  it('the lever slides the throttle from where it was, by how far the finger moves', () => {
    const t = setup();
    const lh = t.layout.lever.h / 3;
    const x = (t.layout.lever.x + 20) / 3, y0 = (t.layout.lever.y + t.layout.lever.h / 2) / 3;
    expect(t.update(new Map([[2, touchAt(2, 'lever', x, y0)]]), 0.4).throttle).toBeCloseTo(0.4, 5);
    expect(t.update(new Map([[2, touchAt(2, 'lever', x, y0, x, y0 - lh / 4)]]), 0.4).throttle).toBeCloseTo(0.65, 5);
  });

  it('held buttons: brakes and rudder while the finger stays', () => {
    const t = setup();
    const out = t.update(new Map([[3, touchAt(3, 'btn:brakes', 0, 0)], [4, touchAt(4, 'btn:yawLeft', 0, 0)]]), 0);
    expect(out.held.has('brakes')).toBe(true);
    expect(out.yaw).toBe(-1);
  });

  it('Controls takes the touch lever, presses and holds', () => {
    const c = new Controls();
    const none: ControlInput = { mouseX: 0, mouseY: 0, down: () => false, consumePresses: () => new Set() };
    const f = c.update(1 / 60, none, defaultSettings(), 800, 600, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, held: new Set(['brakes']), presses: new Set(['flaps']) });
    expect(f.throttle).toBe(0.7);
    expect(f.brakes).toBe(true);
    expect(f.flaps).toBe(true);
  });
});
