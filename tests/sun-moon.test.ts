import { describe, expect, it } from 'vitest';
import { daysSinceJ2000, moonEcliptic, moonPosition, sunPosition } from '../src/world/sun';
import { timeForPreset, TIMES_OF_DAY } from '../src/world/time-of-day';

const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('moon ephemeris', () => {
  it('matches Meeus example 47.a (1992-04-12 0h TD)', () => {
    // JD 2448724.5 → 1992-04-12T00:00Z; ΔT (~59 s) shifts the Moon by ~0.008°
    const n = daysSinceJ2000(new Date(Date.UTC(1992, 3, 12)));
    const m = moonEcliptic(n);
    expect(Math.abs(m.lon - 133.162655)).toBeLessThan(0.05);
    expect(Math.abs(m.lat - -3.229126)).toBeLessThan(0.03);
    expect(Math.abs(m.distKm - 368409.7)).toBeLessThan(500);
  });

  it('phases line up with known new / full moons', () => {
    const newMoon = moonPosition(new Date(Date.UTC(2024, 3, 8, 18, 21)), { lat: 0, lon: 0 });
    expect(newMoon.illumination).toBeLessThan(0.01);
    const full = moonPosition(new Date(Date.UTC(2024, 3, 23, 23, 49)), { lat: 0, lon: 0 });
    expect(full.illumination).toBeGreaterThan(0.99);
    expect(Math.abs(full.phase - 0.5)).toBeLessThan(0.01);
  });

  it('sits opposite the sun at full moon and beside it at new moon', () => {
    const loc = { lat: 47.26, lon: 11.34 };
    const tf = new Date(Date.UTC(2024, 3, 23, 23, 49));
    expect(dot(sunPosition(tf, loc).dir, moonPosition(tf, loc).dir)).toBeLessThan(-0.97);
    const tn = new Date(Date.UTC(2024, 3, 8, 18, 21));
    expect(dot(sunPosition(tn, loc).dir, moonPosition(tn, loc).dir)).toBeGreaterThan(0.97);
  });

  it('is new half a synodic month after a known full moon', () => {
    const t0 = new Date(Date.UTC(2024, 3, 23, 23, 49));
    const t1 = new Date(t0.getTime() + 14.765 * 86400000);
    expect(moonPosition(t1, { lat: 0, lon: 0 }).illumination).toBeLessThan(0.02);
  });

  it('returns unit direction vectors', () => {
    const d = moonPosition(new Date(), { lat: -33.9, lon: 151.2 }).dir;
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
  });
});

describe('sun position', () => {
  it('is near the zenith at solar noon on the equator at the March equinox', () => {
    const e = sunPosition(new Date(Date.UTC(2024, 2, 20, 12, 7)), { lat: 0, lon: 0 }).elevationDeg;
    expect(e).toBeGreaterThan(89);
  });
  it('rises in the east and sets in the west (dir.x: +east)', () => {
    const loc = { lat: 47.26, lon: 11.34 };
    const am = sunPosition(new Date(Date.UTC(2024, 5, 21, 3, 0)), loc).dir;
    const pm = sunPosition(new Date(Date.UTC(2024, 5, 21, 17, 0)), loc).dir;
    expect(am[0]).toBeGreaterThan(0);
    expect(pm[0]).toBeLessThan(0);
  });
});

describe('time-of-day presets', () => {
  const now = new Date(Date.UTC(2026, 10, 9, 10, 0));
  const places = [
    { lat: 47.26, lon: 11.34 },
    { lat: -33.9, lon: 151.2 },
    { lat: 0, lon: -78 },
  ];
  it('orders morning < day < evening < night and hits the target elevations', () => {
    for (const loc of places) {
      const el = (t: Date): number => sunPosition(t, loc).elevationDeg;
      const m = timeForPreset('morning', loc, now);
      const d = timeForPreset('day', loc, now);
      const e = timeForPreset('evening', loc, now);
      const n = timeForPreset('night', loc, now);
      expect(m.getTime()).toBeLessThan(d.getTime());
      expect(d.getTime()).toBeLessThan(e.getTime());
      expect(e.getTime()).toBeLessThan(n.getTime());
      expect(Math.abs(el(m) - 10)).toBeLessThan(2);
      expect(Math.abs(el(e) - 4)).toBeLessThan(2);
      expect(el(d)).toBeGreaterThan(el(m));
      expect(el(n)).toBeLessThan(-8);
    }
  });
  it('real returns now unchanged; every preset is a valid date in polar regions too', () => {
    expect(timeForPreset('real', places[0], now)).toBe(now);
    for (const tod of TIMES_OF_DAY) {
      expect(Number.isNaN(timeForPreset(tod, { lat: 78, lon: 15 }, now).getTime())).toBe(false);
    }
  });
});
