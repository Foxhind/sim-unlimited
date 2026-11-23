import { describe, expect, it } from 'vitest';
import { RAMP } from '../src/engine/palette';
import { gridLatLon, type Tile } from '../src/world/geodesy';
import { buildTerrainMesh } from '../src/world/terrain-mesher';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';
import { buildSurfaceTin } from '../src/world/surface-tin';

const TILE: Tile = { z: 14, x: 9000, y: 6000 };
const GRID = 32;

function lattice(fn: (i: number, j: number) => number): Float32Array {
  const side = GRID + 1;
  const h = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) h[j * side + i] = fn(i, j);
  return h;
}

const hills = lattice((i, j) => 400 + 250 * Math.sin(i / 4) * Math.cos(j / 5) + 40 * Math.sin(i * j));

describe('terrain TIN sampler', () => {
  it('returns the vertex height at every TIN vertex (water clamped to 0)', () => {
    const tin = buildTerrainTin(TILE, GRID, hills);
    const sample = tinSampler(tin, TILE);
    for (let k = 0; k < tin.vx.length; k++) {
      const ll = gridLatLon(TILE, tin.vx[k], tin.vy[k], GRID);
      expect(sample(ll.lon, ll.lat)).toBeCloseTo(Math.max(tin.vh[k], 0), 3);
    }
  });

  it('interpolates linearly inside a triangle (centroid = mean of vertices)', () => {
    const tin = buildTerrainTin(TILE, GRID, hills);
    const sample = tinSampler(tin, TILE);
    for (const t of tin.tris.slice(0, 20)) {
      const gx = (tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3;
      const gy = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      const ll = gridLatLon(TILE, gx, gy, GRID);
      const mean = (Math.max(tin.vh[t.a], 0) + Math.max(tin.vh[t.b], 0) + Math.max(tin.vh[t.c], 0)) / 3;
      expect(sample(ll.lon, ll.lat)).toBeCloseTo(mean, 3);
    }
  });

  it('matches the rendered mesh: land faces are the TIN triangles, in order, at the same heights', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: hills, skirtDepth: 10 });
    // the mesh's own surface (a z14 tile's: surface-tin.ts)
    const tin = buildSurfaceTin(TILE, GRID, hills);
    const sample = tinSampler(tin, TILE);
    expect(m.vertexCount / 3).toBeGreaterThanOrEqual(tin.tris.length);
    tin.tris.forEach((t, ti) => {
      const meshY = (m.vertices[(ti * 3) * 6 + 1] + m.vertices[(ti * 3 + 1) * 6 + 1] + m.vertices[(ti * 3 + 2) * 6 + 1]) / 3;
      const gx = (tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3;
      const gy = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      const ll = gridLatLon(TILE, gx, gy, GRID);
      expect(sample(ll.lon, ll.lat)).toBeCloseTo(meshY, 2);
    });
  });

  it('is within half a belt of the lattice it was built from on smooth terrain', () => {
    const smooth = lattice((i, j) => 300 + 6 * i + 3 * j);
    const tin = buildTerrainTin(TILE, GRID, smooth);
    const sample = tinSampler(tin, TILE);
    let worst = 0;
    for (let j = 0; j <= GRID; j += 3) {
      for (let i = 0; i <= GRID; i += 3) {
        const ll = gridLatLon(TILE, i, j, GRID);
        worst = Math.max(worst, Math.abs(sample(ll.lon, ll.lat) - smooth[j * (GRID + 1) + i]));
      }
    }
    expect(worst).toBeLessThanOrEqual(25 + 1e-6);
  });

  it('reports water (<= 0) over a flooded tile and clamps outside the tile', () => {
    const sea = lattice(() => -40);
    const sample = tinSampler(buildTerrainTin(TILE, GRID, sea), TILE);
    const ll = gridLatLon(TILE, 10, 10, GRID);
    expect(sample(ll.lon, ll.lat)).toBe(0);
    const out = gridLatLon(TILE, -5, 40, GRID);
    expect(Number.isFinite(sample(out.lon, out.lat))).toBe(true);
    expect(RAMP.WATER).toBeDefined();
  });
});
