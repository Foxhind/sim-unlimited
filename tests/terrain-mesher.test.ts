import { describe, expect, it } from 'vitest';
import { RAMP } from '../src/engine/palette';
import { tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildTerrainMesh } from '../src/world/terrain-mesher';

const TILE: Tile = { z: 12, x: 2140, y: 1420 };
const GRID = 8;

function heights(fn: (i: number, j: number) => number): Float32Array {
  const side = GRID + 1;
  const h = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) h[j * side + i] = fn(i, j);
  return h;
}

function tris(m: { vertices: Float32Array; ramps: Uint8Array; vertexCount: number }) {
  const out: Array<{ pos: number[]; normal: number[]; ramp: number }> = [];
  for (let v = 0; v < m.vertexCount; v += 3) {
    const pos: number[] = [];
    const normal: number[] = [];
    for (let k = 0; k < 3; k++) {
      pos.push(m.vertices[(v + k) * 6], m.vertices[(v + k) * 6 + 1], m.vertices[(v + k) * 6 + 2]);
      normal.push(m.vertices[(v + k) * 6 + 3], m.vertices[(v + k) * 6 + 4], m.vertices[(v + k) * 6 + 5]);
    }
    out.push({ pos, normal, ramp: m.ramps[v] });
  }
  return out;
}

function area(t: { pos: number[] }): number {
  const [a, b, c] = [t.pos.slice(0, 3), t.pos.slice(3, 6), t.pos.slice(6, 9)];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  return Math.hypot(...cr) / 2;
}

describe('buildTerrainMesh', () => {
  it('emits land + skirt triangles with flat normals and no NaN/degenerates', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 100), skirtDepth: 50 });
    expect(m.vertexCount).toBe(GRID * GRID * 2 * 3 + GRID * 4 * 2 * 3);
    expect(m.vertices.length).toBe(m.vertexCount * 6);
    expect(m.ramps.length).toBe(m.vertexCount);
    const ts = tris(m);
    for (const t of ts) {
      for (const v of [...t.pos, ...t.normal]) expect(Number.isFinite(v)).toBe(true);
      expect(area(t)).toBeGreaterThan(0);
      for (let k = 0; k < 3; k++) {
        expect(Math.hypot(t.normal[k * 3], t.normal[k * 3 + 1], t.normal[k * 3 + 2])).toBeCloseTo(1, 5);
      }
    }
    const land = ts.slice(0, GRID * GRID * 2);
    for (const t of land) {
      expect(t.normal[1]).toBeCloseTo(1, 5);
      expect(t.ramp).toBe(RAMP.GRASS);
      for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBe(100);
    }
    const skirts = ts.slice(GRID * GRID * 2);
    const minY = Math.min(...skirts.flatMap((t) => [t.pos[1], t.pos[4], t.pos[7]]));
    expect(minY).toBe(50);
  });

  it('floods h<=0 to a flat water surface at 0 m (Q13)', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => -50) });
    const land = tris(m).slice(0, GRID * GRID * 2);
    for (const t of land) {
      expect(t.ramp).toBe(RAMP.WATER);
      for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBe(0);
    }
  });

  it('clamps mixed coastline vertices and keeps both classes', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => (i < GRID / 2 ? -10 : 10)) });
    const land = tris(m).slice(0, GRID * GRID * 2);
    const rampSet = new Set(land.map((t) => t.ramp));
    expect(rampSet.has(RAMP.WATER)).toBe(true);
    expect(rampSet.has(RAMP.SAND)).toBe(true);
    for (const t of land) for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBeGreaterThanOrEqual(0);
  });

  it('colors by height and slope', () => {
    const snow = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 3000) });
    expect(tris(snow)[0].ramp).toBe(RAMP.SNOW);
    const cell = tileSizeMeters(TILE) / GRID;
    const steep = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => 500 + i * cell) });
    expect(tris(steep)[0].ramp).toBe(RAMP.ROCK);
    const forest = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 800) });
    expect(tris(forest)[0].ramp).toBe(RAMP.FOREST);
  });

  it('skirts inherit the adjacent boundary face ramp and normal', () => {
    const cell = tileSizeMeters(TILE) / GRID;
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => 500 + i * cell), skirtDepth: 50 });
    const ts = tris(m);
    const landCount = GRID * GRID * 2;
    const cellAt = (side: number, k: number): [number, number] =>
      side === 0 ? [k, 0] : side === 1 ? [k, GRID - 1] : side === 2 ? [0, k] : [GRID - 1, k];
    for (let side = 0; side < 4; side++) {
      for (let k = 0; k < GRID; k++) {
        const [i, j] = cellAt(side, k);
        const face = ts[(j * GRID + i) * 2];
        for (let q = 0; q < 2; q++) {
          const skirt = ts[landCount + side * GRID * 2 + k * 2 + q];
          expect(skirt.ramp).toBe(face.ramp);
          expect(skirt.normal).toEqual(face.normal);
        }
      }
    }
    expect(ts[landCount].normal[1]).toBeGreaterThan(0);
  });

  it('caps default skirt depth at 2000 m on coarse tiles', () => {
    const coarse: Tile = { z: 8, x: 133, y: 88 };
    const m = buildTerrainMesh({ tile: coarse, grid: GRID, heights: heights(() => 100) });
    const skirts = tris(m).slice(GRID * GRID * 2);
    const minY = Math.min(...skirts.flatMap((t) => [t.pos[1], t.pos[4], t.pos[7]]));
    expect(minY).toBe(-1900);
  });

  it('rejects mismatched height grids', () => {
    expect(() => buildTerrainMesh({ tile: TILE, grid: GRID, heights: new Float32Array(10) })).toThrow();
  });
});