import { describe, expect, it } from 'vitest';
import { RAMP } from '../src/engine/palette';
import { tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildTerrainMesh } from '../src/world/terrain-mesher';

const TILE: Tile = { z: 12, x: 2140, y: 1420 };
const GRID = 16;

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

function planArea1(t: { pos: number[] }): number {
  const [ax, , az, bx, , bz, cx, , cz] = t.pos;
  return Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
}

/** land faces have planar footprint; skirts are vertical (zero footprint) */
function split(ts: ReturnType<typeof tris>) {
  const land = ts.filter((t) => planArea1(t) > 1e-3);
  const skirts = ts.filter((t) => planArea1(t) <= 1e-3);
  return { land, skirts };
}

describe('buildTerrainMesh (isoline belts)', () => {
  it('flat tile collapses to two land triangles plus skirts, no NaN/degenerates', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 100), skirtDepth: 50 });
    const ts = tris(m);
    expect(split(ts).land).toHaveLength(2);
    expect(split(ts).skirts).toHaveLength(4 * 2);
    for (const t of ts) {
      for (const v of [...t.pos, ...t.normal]) expect(Number.isFinite(v)).toBe(true);
      expect(area(t)).toBeGreaterThan(0);
    }
    for (const t of split(ts).land) {
      expect(t.normal[1]).toBeCloseTo(1, 5);
      expect(t.ramp).toBe(RAMP.GRASS);
    }
    const minY = Math.min(...split(ts).skirts.flatMap((t) => [t.pos[1], t.pos[4], t.pos[7]]));
    expect(minY).toBe(50);
  });

  it('covers the whole tile footprint exactly once', () => {
    const size = tileSizeMeters(TILE);
    const h = heights((i, j) => 300 + 200 * Math.sin(i / 2.5) * Math.cos(j / 3));
    const { land } = split(tris(buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, skirtDepth: 10 })));
    const total = land.reduce((s, t) => s + planArea1(t), 0);
    expect(total / (size * size)).toBeGreaterThan(0.995);
    expect(total / (size * size)).toBeLessThan(1.005);
  });

  it('is far lighter than the old dense grid on smooth terrain and honors the belt step', () => {
    const h = heights((i, j) => 500 + 12 * i + 6 * j); // gentle plane
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, step: 20 });
    expect(m.vertexCount / 3).toBeLessThan(GRID * GRID * 2);
  });

  it('is deterministic', () => {
    const h = heights((i, j) => 400 + 150 * Math.sin(i / 2) + 90 * Math.cos(j / 1.7));
    const a = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h });
    const b = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h });
    expect(Array.from(a.vertices)).toEqual(Array.from(b.vertices));
    expect(Array.from(a.ramps)).toEqual(Array.from(b.ramps));
  });

  it('floods h<=0 to a flat water surface at 0 m (Q13)', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => -50) });
    const { land } = split(tris(m));
    expect(land).toHaveLength(2);
    for (const t of land) {
      expect(t.ramp).toBe(RAMP.WATER);
      for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBe(0);
    }
  });

  it('places a coastline on the sea-level isoline and keeps both classes', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => (i < GRID / 2 ? -10 : 10)) });
    const ts = split(tris(m)).land;
    const rampSet = new Set(ts.map((t) => t.ramp));
    expect(rampSet.has(RAMP.WATER)).toBe(true);
    expect(rampSet.has(RAMP.GRASS)).toBe(true);
    for (const t of ts) for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBeGreaterThanOrEqual(0);
  });

  it('colors by height and slope', () => {
    const snow = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 3000) });
    expect(split(tris(snow)).land[0].ramp).toBe(RAMP.SNOW);
    const forest = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 800) });
    expect(split(tris(forest)).land[0].ramp).toBe(RAMP.FOREST);
    const cell = tileSizeMeters(TILE) / GRID;
    const steep = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => 500 + i * cell) });
    expect(split(tris(steep)).land[0].ramp).toBe(RAMP.ROCK);
  });

  it('skirts inherit the adjacent land face ramp and normal, and hang by skirtDepth', () => {
    const h = heights((i) => 500 + i * 30);
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, skirtDepth: 50, step: 20 });
    const { land, skirts } = split(tris(m));
    expect(skirts.length).toBeGreaterThanOrEqual(8);
    for (const sk of skirts) {
      expect(sk.normal[1]).toBeGreaterThan(0);
      const match = land.some((t) => t.ramp === sk.ramp && t.normal.every((v, k) => Math.abs(v - sk.normal[k]) < 1e-9));
      expect(match).toBe(true);
    }
  });

  it('caps default skirt depth at 2000 m on coarse tiles', () => {
    const coarse: Tile = { z: 8, x: 133, y: 88 };
    const m = buildTerrainMesh({ tile: coarse, grid: GRID, heights: heights(() => 100) });
    const { skirts } = split(tris(m));
    const minY = Math.min(...skirts.flatMap((t) => [t.pos[1], t.pos[4], t.pos[7]]));
    expect(minY).toBe(-1900);
  });

  it('rejects mismatched height grids', () => {
    expect(() => buildTerrainMesh({ tile: TILE, grid: GRID, heights: new Float32Array(10) })).toThrow();
  });
});
