import { describe, expect, it } from 'vitest';
import { boltPath, Lightning, type Strike } from '../src/world/lightning';

function run(l: Lightning, seconds: number, active = true): Strike[] {
  const out: Strike[] = [];
  for (let i = 0; i <= seconds * 60; i++) {
    const s = l.update(i / 60, active);
    if (s) out.push(s);
  }
  return out;
}

describe('lightning', () => {
  it('strikes about every 12 s, 2-15 km away, in 2-4 flashes within 0.4 s', () => {
    const strikes = run(new Lightning(1), 600);
    expect(strikes.length).toBeGreaterThanOrEqual(30);
    expect(strikes.length).toBeLessThanOrEqual(80);
    for (const s of strikes) {
      expect(s.distanceM).toBeGreaterThanOrEqual(2000);
      expect(s.distanceM).toBeLessThanOrEqual(15000);
      expect(s.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(s.bearingDeg).toBeLessThan(360);
      expect(s.pulses.length).toBeGreaterThanOrEqual(2);
      expect(s.pulses.length).toBeLessThanOrEqual(4);
      expect(s.pulses[0]).toBe(0);
      expect(s.pulses[s.pulses.length - 1]).toBeLessThanOrEqual(0.4);
    }
    for (let i = 1; i < strikes.length; i++) expect(strikes[i].t0 - strikes[i - 1].t0).toBeGreaterThanOrEqual(2 - 1e-9);
  });
  it('is the same storm from the same seed', () => {
    expect(run(new Lightning(7), 120)).toEqual(run(new Lightning(7), 120));
    expect(run(new Lightning(7), 120)).not.toEqual(run(new Lightning(8), 120));
  });
  it('no storm, no strikes', () => {
    const l = new Lightning(1);
    expect(run(l, 600, false)).toHaveLength(0);
    expect(l.flash(100)).toBe(0);
  });
  it('the sky flashes at the strike and is dark again a second later', () => {
    const l = new Lightning(3);
    expect(l.flash(0)).toBe(0);
    const s = run(l, 60)[0];
    const last = l.last!;
    expect(s.t0).toBeLessThanOrEqual(last.t0);
    expect(l.flash(last.t0)).toBeGreaterThan(0.3);
    expect(l.flash(last.t0)).toBeLessThanOrEqual(1);
    expect(l.flash(last.t0 + 1)).toBe(0);
    expect(l.flash(last.t0 - 0.01)).toBe(0);
  });
  it('the bolt runs from the cloud down to the ground', () => {
    const p = boltPath(42);
    expect(p[0]).toEqual([0, 1]);
    expect(p[p.length - 1][1]).toBeCloseTo(0, 9);
    for (let i = 1; i < p.length; i++) expect(p[i][1]).toBeLessThan(p[i - 1][1]);
    expect(boltPath(42)).toEqual(p);
    expect(boltPath(43)).not.toEqual(p);
  });
});
