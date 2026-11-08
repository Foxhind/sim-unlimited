import { describe, expect, it } from 'vitest';
import {
  decodeTerrarium,
  enuToLatLon,
  gridLatLon,
  latLonToEnu,
  tileBounds,
  tileCenter,
  tileForLatLon,
  tileSizeMeters,
} from '../src/world/geodesy';

describe('slippy tiles', () => {
  it('maps known coordinates', () => {
    expect(tileForLatLon(0, 0, 1)).toEqual({ z: 1, x: 1, y: 1 });
    expect(tileForLatLon(85, -180, 2)).toEqual({ z: 2, x: 0, y: 0 });
  });

  it('bounds cover the world at z0', () => {
    const b = tileBounds({ z: 0, x: 0, y: 0 });
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    expect(b.south).toBeCloseTo(-85.0511, 3);
    expect(b.north).toBeCloseTo(85.0511, 3);
  });

  it('center lies inside bounds and roundtrips through tileForLatLon', () => {
    for (const t of [{ z: 14, x: 8800, y: 5600 }, { z: 8, x: 135, y: 88 }, { z: 12, x: 0, y: 0 }]) {
      const c = tileCenter(t);
      const b = tileBounds(t);
      expect(c.lon).toBeGreaterThan(b.west);
      expect(c.lon).toBeLessThan(b.east);
      expect(c.lat).toBeGreaterThan(b.south);
      expect(c.lat).toBeLessThan(b.north);
      const back = tileForLatLon(c.lat, c.lon, t.z);
      expect(back.x).toBe(t.x);
      expect(back.y).toBe(t.y);
    }
  });

  it('tile ground size shrinks with latitude and zoom', () => {
    expect(tileSizeMeters({ z: 14, x: 0, y: 8192 })).toBeCloseTo((2 * Math.PI * 6371000) / 16384, 0);
    const eq = tileSizeMeters({ z: 14, x: 8192, y: 8192 });
    const moscow = tileSizeMeters({ z: 14, x: 9900, y: 5100 });
    expect(moscow).toBeLessThan(eq * 0.75);
    expect(moscow).toBeGreaterThan(eq * 0.5);
  });

  it('grid samples stay inside the tile and are monotonic', () => {
    const t = { z: 14, x: 8800, y: 5600 };
    const b = tileBounds(t);
    let prevLon = -Infinity;
    let prevLat = Infinity;
    for (let i = 0; i <= 32; i++) {
      const p = gridLatLon(t, i, 16, 32);
      expect(p.lon).toBeGreaterThanOrEqual(b.west);
      expect(p.lon).toBeLessThanOrEqual(b.east);
      expect(p.lon).toBeGreaterThan(prevLon);
      prevLon = p.lon;
      const q = gridLatLon(t, 16, i, 32);
      expect(q.lat).toBeLessThan(prevLat);
      prevLat = q.lat;
    }
  });
});

describe('ENU frames', () => {
  const origin = { lat: 47.26, lon: 11.35 };

  it('east/north distances match spherical geodesy', () => {
    // small delta: tangent plane approximates the parallel (curvature is quadratic)
    const [e, n, u] = latLonToEnu(origin, 47.26, 11.36, 0);
    expect(e).toBeCloseTo((0.01 * Math.PI / 180) * 6371000 * Math.cos((47.26 * Math.PI) / 180), 0);
    expect(Math.abs(n)).toBeLessThan(1);
    expect(Math.abs(u)).toBeLessThan(1);
    const [e2, n2] = latLonToEnu(origin, 48.26, 11.35, 0);
    expect(Math.abs(e2)).toBeLessThan(1);
    expect(n2).toBeCloseTo((Math.PI / 180) * 6371000, -2);
  });

  it('roundtrips lat/lon through ENU with sub-meter error', () => {
    for (const [dlat, dlon] of [[0.5, 0.7], [-0.3, 1.2], [0.01, -0.02]]) {
      const lat = origin.lat + dlat;
      const lon = origin.lon + dlon;
      const enu = latLonToEnu(origin, lat, lon, 1234);
      const back = enuToLatLon(origin, enu[0], enu[1], enu[2]);
      expect(latLonToEnu(origin, back.lat, back.lon, 1234)[0]).toBeCloseTo(enu[0], 3);
      expect(latLonToEnu(origin, back.lat, back.lon, 1234)[1]).toBeCloseTo(enu[1], 3);
      expect(back.alt).toBeCloseTo(1234, 3);
    }
  });
});

describe('decodeTerrarium', () => {
  it('decodes sea level and integers', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(127, 156, 0)).toBe(-100);
    expect(decodeTerrarium(139, 184, 0)).toBe(3000);
  });
  it('decodes the fractional blue channel', () => {
    expect(decodeTerrarium(128, 0, 128)).toBeCloseTo(0.5, 6);
  });
});