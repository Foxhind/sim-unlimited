import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
  frustumPlanes,
  gridForZoom,
  MAX_Z,
  MIN_Z,
  selectLeaves,
  sphereInFrustum,
} from '../src/world/chunks';
import { tileCenter, tileForLatLon, type Tile } from '../src/world/geodesy';

const INNSBRUCK = { lat: 47.26, lon: 11.35 };

function distKm(a: Tile, lat: number, lon: number): number {
  const c = tileCenter(a);
  const dLat = (c.lat - lat) * 111.32;
  const dLon = (c.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

describe('selectLeaves', () => {
  it('produces a bounded quadtree LOD set with z14 under the camera', () => {
    const leaves = selectLeaves(INNSBRUCK, 500);
    expect(leaves.length).toBeGreaterThan(20);
    expect(leaves.length).toBeLessThan(400);
    for (const t of leaves) {
      expect(t.z).toBeGreaterThanOrEqual(MIN_Z);
      expect(t.z).toBeLessThanOrEqual(MAX_Z);
      expect(t.x).toBeLessThan(2 ** t.z);
      expect(t.y).toBeLessThan(2 ** t.z);
    }
    const home = tileForLatLon(INNSBRUCK.lat, INNSBRUCK.lon, MAX_Z);
    expect(leaves.some((t) => t.z === home.z && t.x === home.x && t.y === home.y)).toBe(true);
  });

  it('coarsens with altitude and distance', () => {
    const high = selectLeaves(INNSBRUCK, 10000);
    expect(high.some((t) => t.z === MAX_Z && distKm(t, INNSBRUCK.lat, INNSBRUCK.lon) < 2)).toBe(false);
    const low = selectLeaves(INNSBRUCK, 500);
    const far = low.filter((t) => distKm(t, INNSBRUCK.lat, INNSBRUCK.lon) > 60);
    expect(far.length).toBeGreaterThan(0);
    for (const t of far) expect(t.z).toBeLessThanOrEqual(10);
  });

  it('lookahead refines tiles along the velocity vector', () => {
    const ahead = { lat: INNSBRUCK.lat + 0.18, lon: INNSBRUCK.lon };
    const withLook = selectLeaves(INNSBRUCK, 500, ahead);
    const without = selectLeaves(INNSBRUCK, 500);
    const maxZ = (ls: Tile[]) =>
      Math.max(...ls.filter((t) => distKm(t, ahead.lat, ahead.lon) < 3).map((t) => t.z));
    expect(maxZ(withLook)).toBeGreaterThan(maxZ(without));
  });

  it('wraps across the antimeridian', () => {
    const leaves = selectLeaves({ lat: 65, lon: 179.9 }, 1000);
    expect(leaves.length).toBeGreaterThan(10);
    const xs = new Set(leaves.map((t) => t.x));
    expect([...xs].some((x) => x < 10)).toBe(true);
    expect([...xs].some((x) => x > 2 ** MIN_Z - 10)).toBe(true);
    for (const t of leaves) expect(t.x).toBeLessThan(2 ** t.z);
  });
});

describe('frustum culling', () => {
  const view = mat4.lookAt(mat4.create(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, -1), vec3.fromValues(0, 1, 0));
  const proj = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 200000);
  const vp = mat4.multiply(mat4.create(), proj, view);
  const planes = frustumPlanes(vp);

  it('keeps spheres in front, rejects behind and far off-axis', () => {
    expect(sphereInFrustum(planes, vec3.fromValues(0, 0, -100), 10)).toBe(true);
    expect(sphereInFrustum(planes, vec3.fromValues(0, 0, 100), 10)).toBe(false);
    expect(sphereInFrustum(planes, vec3.fromValues(1000, 0, -100), 10)).toBe(false);
    expect(sphereInFrustum(planes, vec3.fromValues(0, 0, -100), 5000)).toBe(true);
  });
});

describe('gridForZoom', () => {
  it('uses coarser grids for distant LODs', () => {
    expect(gridForZoom(14)).toBe(8);
    expect(gridForZoom(12)).toBe(6);
    expect(gridForZoom(8)).toBe(4);
  });
});