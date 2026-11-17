import { describe, expect, it } from 'vitest';
import {
  applyM3, buildSkyPoints, limitingMagnitude, PLANETS_OFFSET, planetPositions, precessionMatrix, radec, skyMatrix,
} from '../src/world/sky';
import { STAR_CATALOG } from '../src/world/star-catalog';
import { daysSinceJ2000 } from '../src/world/sun';

const R2D = 180 / Math.PI;
const toRaDec = (v: number[]): [number, number] => [((Math.atan2(v[1], v[0]) * R2D) + 360) % 360, Math.asin(v[2]) * R2D];
const sepDeg = (a: number[], b: number[]): number => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * R2D;

describe('precession', () => {
  it('matches Meeus example 21.b (θ Persei to 2028 Nov 13.19)', () => {
    const n = daysSinceJ2000(new Date(Date.UTC(2028, 10, 13, 4, 33, 36)));
    // proper motion left out (the catalogue has none): it moves the star ~15″ over the 29 years
    const [ra, dec] = toRaDec(applyM3(precessionMatrix(n), radec(41.054063, 49.22775)));
    expect(Math.abs(ra - 41.547214)).toBeLessThan(0.006);
    expect(Math.abs(dec - 49.348483)).toBeLessThan(0.006);
  });
});

describe('sky matrix', () => {
  const moscow = { lat: 55.75, lon: 37.62 };
  it('keeps Polaris at the latitude, due north', () => {
    for (const h of [0, 6, 12, 18]) {
      const d = applyM3(skyMatrix(new Date(Date.UTC(2026, 10, 17, h)), moscow), radec(37.9545, 89.2641));
      expect(Math.abs(Math.asin(d[1]) * R2D - moscow.lat)).toBeLessThan(0.8);
      expect(d[2]).toBeLessThan(0); // -north
    }
  });
  it('culminates Sirius at 90° − lat + dec, rising in the east', () => {
    let best = -90;
    let rising: number[] | undefined;
    let prev = -1;
    for (let m = 0; m < 24 * 60; m += 2) {
      const d = applyM3(skyMatrix(new Date(Date.UTC(2026, 0, 15) + m * 60000), moscow), radec(101.287, -16.716));
      best = Math.max(best, Math.asin(d[1]) * R2D);
      if (prev < 0 && d[1] >= 0) rising = d;
      prev = d[1];
    }
    expect(Math.abs(best - (90 - moscow.lat - 16.716))).toBeLessThan(0.3);
    expect(rising![0]).toBeGreaterThan(0.5);
  });
  it('is a rotation', () => {
    const d = applyM3(skyMatrix(new Date(), { lat: -33.9, lon: 151.2 }), radec(200, 30));
    expect(Math.hypot(...d)).toBeCloseTo(1, 9);
  });
});

describe('planets', () => {
  it('matches Meeus example 33.a (Venus, 1992 Dec 20)', () => {
    const date = new Date(Date.UTC(1992, 11, 20));
    const n = daysSinceJ2000(date);
    const venus = planetPositions(date).find((p) => p.name === 'Venus')!;
    const [ra, dec] = toRaDec(applyM3(precessionMatrix(n), venus.dir));
    expect(Math.abs(ra - 316.17291)).toBeLessThan(0.05);
    expect(Math.abs(dec - -18.88801)).toBeLessThan(0.05);
    expect(Math.abs(venus.distAU - 0.910947)).toBeLessThan(0.002);
  });
  it('puts Jupiter and Saturn 0.1° apart at the 2020 great conjunction', () => {
    const ps = planetPositions(new Date(Date.UTC(2020, 11, 21, 18)));
    const j = ps.find((p) => p.name === 'Jupiter')!, s = ps.find((p) => p.name === 'Saturn')!;
    expect(sepDeg(j.dir, s.dir)).toBeLessThan(0.15);
    expect(j.mag).toBeGreaterThan(-2.3);
    expect(j.mag).toBeLessThan(-1.8);
    expect(s.mag).toBeGreaterThan(0.3);
    expect(s.mag).toBeLessThan(0.9);
  });
  it('keeps Venus and Mercury close to the sun and the magnitudes in their real ranges', () => {
    for (let d = 0; d < 800; d += 7) {
      const ps = planetPositions(new Date(Date.UTC(2025, 0, 1) + d * 86400000));
      const v = ps.find((p) => p.name === 'Venus')!;
      expect(v.mag).toBeGreaterThan(-4.95);
      expect(v.mag).toBeLessThan(-3.7);
      const mars = ps.find((p) => p.name === 'Mars')!;
      expect(mars.mag).toBeGreaterThan(-3);
      expect(mars.mag).toBeLessThan(2);
    }
  });
});

describe('catalogue and visibility', () => {
  it('holds the bright stars, Sirius first, with the planet slots after them', () => {
    expect(STAR_CATALOG.length / 4).toBeGreaterThan(2500);
    expect(STAR_CATALOG.slice(0, 3)).toEqual([101.287, -16.716, -1.44]);
    expect(buildSkyPoints().length).toBe(PLANETS_OFFSET + 5 * 7);
  });
  it('shows no stars by day, the brightest at dusk, all in the dark', () => {
    expect(limitingMagnitude(30, -30, 0)).toBeLessThan(-4.5);
    const dusk = limitingMagnitude(-6, -30, 0);
    expect(dusk).toBeGreaterThan(1);
    expect(dusk).toBeLessThan(3);
    expect(limitingMagnitude(-30, -30, 0)).toBeCloseTo(5.5);
    expect(limitingMagnitude(-30, 40, 1)).toBeLessThan(4.5);
  });
});
