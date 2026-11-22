import { describe, expect, it } from 'vitest';
import { Air, newAirSample } from '../src/flight/air';
import {
  CameraMotion, FOG_CLEAR, fogRange, gloom, precipAltitudeFactor, precipDrift, precipParticles, precipVisibilityM, stormTurbulence,
} from '../src/world/precipitation';
import { airConditions, type Weather } from '../src/world/weather';

describe('visibility in precipitation', () => {
  it('rain and snow hide the distance, snow far more', () => {
    expect(precipVisibilityM('rain', 4)).toBeCloseTo(6964, -1);
    expect(precipVisibilityM('snow', 1.5)).toBeCloseTo(3011, -1);
    expect(precipVisibilityM('rain', 12)).toBeLessThan(precipVisibilityM('rain', 4));
    expect(precipVisibilityM('none', 5)).toBe(Infinity);
    expect(precipVisibilityM('rain', 0)).toBe(Infinity);
  });
  it('the fog follows the visibility; a reported 24 km and clear weather keep the old 15-55 km', () => {
    expect(fogRange(undefined)).toEqual(FOG_CLEAR);
    expect(fogRange(24000)).toEqual({ start: 15000, end: 55000 });
    expect(fogRange(Infinity)).toEqual({ start: 15000, end: 55000 });
    expect(fogRange(2000).end).toBeCloseTo(4600, 6);
    expect(fogRange(2000).start).toBeCloseTo((4600 * 15) / 55, 6);
    expect(fogRange(100).end).toBe(1200);
  });
});

describe('where precipitation falls', () => {
  it('below the cloud base, fading out 300 m above it', () => {
    expect(precipAltitudeFactor(900, 1000, 0)).toBe(1);
    expect(precipAltitudeFactor(1150, 1000, 0)).toBeCloseTo(0.5, 6);
    expect(precipAltitudeFactor(1400, 1000, 0)).toBe(0);
  });
  it('with no cloud layer: from 3000 m above the ground', () => {
    expect(precipAltitudeFactor(3400, undefined, 500)).toBe(1);
    expect(precipAltitudeFactor(3900, undefined, 500)).toBe(0);
  });
});

describe('particles', () => {
  it('more of them the harder it falls, within bounds; none when dry', () => {
    const counts = [0.1, 1, 4, 12, 60].map((r) => precipParticles('rain', r).count);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[0]).toBe(600);
    expect(counts[4]).toBe(4000);
    expect(precipParticles('snow', 1.5)).toMatchObject({ box: 24, fall: 1.5 });
    expect(precipParticles('rain', 4)).toMatchObject({ count: 2800, box: 36, fall: 9 });
    expect(precipParticles('none', 4).count).toBe(0);
    expect(precipParticles('rain', 0).count).toBe(0);
  });
});

describe('the drift of the particles past the camera', () => {
  it('a standing camera sees them fall and go downwind (x east, y up, z = -north)', () => {
    expect(precipDrift([3, 4], 9)).toEqual([3, -9, -4]);
    expect(precipDrift([0, 0], 1.5)[1]).toBe(-1.5);
    expect(Math.hypot(precipDrift([0, 0], 1.5)[0], precipDrift([0, 0], 1.5)[2])).toBe(0);
  });
  it('a flying camera adds its own motion; a backdrop orbit passes none', () => {
    expect(precipDrift([3, 4], 9, [50, -2, 10])).toEqual([-47, -7, -14]);
    expect(precipDrift([3, 4], 9, undefined)).toEqual([3, -9, -4]);
  });
});

describe('camera motion', () => {
  it('velocity from the positions; a re-centred world keeps the last one', () => {
    const m = new CameraMotion();
    m.update([0, 100, 0], 0.1);
    expect([...m.vel]).toEqual([0, 0, 0]);
    m.update([10, 100, 0], 0.1);
    expect(m.vel[0]).toBeCloseTo(100, 4);
    m.update([-4990, 100, 3000], 0.1); // the origin moved
    expect(m.vel[0]).toBeCloseTo(100, 4);
    m.update([-4980, 100, 3000], 0.1);
    expect(m.vel[0]).toBeCloseTo(100, 4);
    expect(m.vel[2]).toBeCloseTo(0, 4);
    m.update([0, 0, 0], 0); // paused
    expect(m.vel[0]).toBeCloseTo(100, 4);
  });
});

describe('storm air', () => {
  const calm: Weather = { tempC: 15, cloudPct: 100, windFromDeg: 0, windMs: 0, gustMs: 0, at: { lat: 47, lon: 11 }, time: 0 };
  it('a thunderstorm is rough, heavy rain a little, snow and dry air not', () => {
    expect(stormTurbulence({ thunder: true, precipKind: 'rain', precipMmH: 12 })).toBe(3);
    expect(stormTurbulence({ precipKind: 'rain', precipMmH: 4 })).toBeCloseTo(0.2, 6);
    expect(stormTurbulence({ precipKind: 'rain', precipMmH: 40 })).toBe(0.6);
    expect(stormTurbulence({ precipKind: 'snow', precipMmH: 4 })).toBe(0);
    expect(stormTurbulence({})).toBe(0);
    expect(gloom({ thunder: true })).toBe(1);
    expect(gloom({ precipKind: 'snow', precipMmH: 3 })).toBeCloseTo(0.3, 6);
    expect(gloom({ precipKind: 'none', precipMmH: 0 })).toBe(0);
  });
  it('the flight model meets turbulence in a storm even with no wind', () => {
    expect(airConditions(calm).turbulence).toBe(0);
    const c = airConditions({ ...calm, precipKind: 'rain', precipMmH: 12, thunder: true });
    expect(c.turbulence).toBe(3);
    const rough = (air: Air): number => {
      const s = newAirSample();
      let peak = 0;
      for (let i = 0; i < 600; i++) {
        air.sample(s, 500, 500, 80, 1 / 60);
        peak = Math.max(peak, Math.abs(s.wind[1]));
      }
      return peak;
    };
    expect(rough(new Air(airConditions(calm)))).toBe(0);
    expect(rough(new Air(c))).toBeGreaterThan(1);
  });
});
