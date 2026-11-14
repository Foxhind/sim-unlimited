import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
  coarseEdges,
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

describe('frustum culling with a camera away from the origin', () => {
  // regression: planes from a full lookAt view are world-space; the chunk centre must be passed
  // in the same frame (not camera-relative), or near ground below/ahead of the jet is culled
  const eye = vec3.fromValues(-1870, 4423, 608);
  const view = mat4.lookAt(mat4.create(), eye, vec3.fromValues(-1870, 4423, 608 - 1000), vec3.fromValues(0, 1, 0));
  const proj = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.5, 200000);
  const planes = frustumPlanes(mat4.multiply(mat4.create(), proj, view));
  const offset = vec3.fromValues(0, -1500, -3000); // 26° below the view axis: inside a 60° fov
  const world = vec3.add(vec3.create(), eye, offset);

  it('keeps ground ahead-and-below when the centre is given in world space', () => {
    expect(sphereInFrustum(planes, world, 100)).toBe(true);
  });

  it('would wrongly reject it if the centre were camera-relative', () => {
    expect(sphereInFrustum(planes, offset, 100)).toBe(false);
  });
});

describe('gridForZoom', () => {
  it('uses one contour work lattice at every zoom', () => {
    expect(gridForZoom(14)).toBe(48);
    expect(gridForZoom(12)).toBe(48);
    expect(gridForZoom(8)).toBe(48);
  });
});
describe('two tile variants', () => {
  it('detailed z14 tiles only within the detail radius, coarse z ≤ 13 beyond', async () => {
    const { DETAIL_RADIUS_M, DETAIL_Z } = await import('../src/world/chunks');
    const leaves = selectLeaves(INNSBRUCK, 1000);
    const detail = leaves.filter((t) => t.z === DETAIL_Z);
    expect(detail.length).toBeGreaterThan(10);
    // the radius is met at tile granularity: siblings of a z14 tile inside it come along (≤ one z13 tile more)
    for (const t of detail) expect(distKm(t, INNSBRUCK.lat, INNSBRUCK.lon)).toBeLessThan(DETAIL_RADIUS_M / 1000 + 4.8) // + a z13 diagonal
    for (const t of leaves.filter((l) => l.z < DETAIL_Z)) expect(distKm(t, INNSBRUCK.lat, INNSBRUCK.lon)).toBeGreaterThan(DETAIL_RADIUS_M / 1000 - 1);
    expect(selectLeaves(INNSBRUCK, 9000).some((t) => t.z === DETAIL_Z)).toBe(false);
  });

  it('a leaf that is not ready shows its coarse ancestor, which then hides its ready siblings', async () => {
    const { shownTiles } = await import('../src/world/chunks');
    const p = { z: 13, x: 100, y: 200 };
    const kids = [0, 1, 2, 3].map((k) => ({ z: 14, x: 200 + (k & 1), y: 400 + (k >> 1) }));
    const key = (t: Tile) => `${t.z}/${t.x}/${t.y}`;
    const ready = new Set([key(p), key(kids[0]), key(kids[1]), key(kids[2])]); // kid 3 waits for OSM
    const out = shownTiles(kids, (t) => ready.has(key(t)));
    expect(out.filter((o) => o.drawn).map((o) => key(o.tile))).toEqual([key(p)]);
    ready.add(key(kids[3]));
    const done = shownTiles(kids, (t) => ready.has(key(t)));
    expect(done.filter((o) => o.drawn).map((o) => key(o.tile)).sort()).toEqual(kids.map(key).sort());
    // nothing ready at all: nothing drawn
    expect(shownTiles(kids, () => false)).toEqual([]);
  });
});

describe('coarseEdges', () => {
  const drawn = (keys: string[]) => (k: string) => keys.includes(k);
  it('flags the edges whose neighbour is drawn at a coarser zoom', () => {
    // 14/8/8 is the north-west child of 13/4/4: its north and west edges are on the parent's boundary
    expect(coarseEdges({ z: 14, x: 8, y: 8 }, drawn(['13/4/3']))).toBe(1);
    expect(coarseEdges({ z: 14, x: 8, y: 8 }, drawn(['13/3/4', '12/2/1']))).toBe(4 | 1);
    expect(coarseEdges({ z: 14, x: 9, y: 9 }, drawn(['13/5/4', '13/4/5']))).toBe(8 | 2);
  });
  it('ignores neighbours of the same zoom and edges inside the parent', () => {
    expect(coarseEdges({ z: 14, x: 8, y: 8 }, drawn(['14/8/7', '14/7/8', '14/9/8', '14/8/9']))).toBe(0);
    expect(coarseEdges({ z: 14, x: 8, y: 8 }, drawn(['13/4/4']))).toBe(0);
  });
});
