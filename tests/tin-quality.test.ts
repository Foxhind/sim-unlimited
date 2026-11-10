import { expect, it } from 'vitest';
import type { Tile } from '../src/world/geodesy';
import { BELT_STEP, buildTerrainTin, type TinDebug } from '../src/world/terrain-tin';

const TILE: Tile = { z: 14, x: 9000, y: 6000 };
const GRID = 64;
function lat(fn: (i: number, j: number) => number) {
  const s = GRID + 1, h = new Float32Array(s * s);
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) h[j * s + i] = fn(i, j);
  return h;
}
const terr = lat((i, j) => 300 + 250 * Math.sin(i / 7) * Math.cos(j / 9) + 80 * Math.sin(i / 3 + j / 5) - (i < 12 ? 400 : 0));

// Plain Delaunay gave rms ≈ 91 m here: its edges ignored the isolines and bridged belts.
it('TIN fits the lattice (belt triangulation beats plain Delaunay)', () => {
  const tin = buildTerrainTin(TILE, GRID, terr);
  // rms error vs lattice via barycentric raster
  let se = 0, n = 0, maxE = 0;
  const side = GRID + 1;
  for (const t of tin.tris) {
    const ax = tin.vx[t.a], ay = tin.vy[t.a], bx = tin.vx[t.b], by = tin.vy[t.b], cx = tin.vx[t.c], cy = tin.vy[t.c];
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (!d) continue;
    for (let j = Math.floor(Math.min(ay, by, cy)); j <= Math.ceil(Math.max(ay, by, cy)); j++)
      for (let i = Math.floor(Math.min(ax, bx, cx)); i <= Math.ceil(Math.max(ax, bx, cx)); i++) {
        const w1 = ((i - ax) * (cy - ay) - (cx - ax) * (j - ay)) / d;
        const w2 = ((bx - ax) * (j - ay) - (i - ax) * (by - ay)) / d;
        const w0 = 1 - w1 - w2;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const h = tin.vh[t.a] * w0 + tin.vh[t.b] * w1 + tin.vh[t.c] * w2;
        const e = Math.abs(h - terr[j * side + i]);
        se += e * e; n++; maxE = Math.max(maxE, e);
      }
  }
  expect(Math.sqrt(se / n)).toBeLessThan(75);
  let steep = 0;
  for (const t of tin.tris) { const hs = [tin.vh[t.a], tin.vh[t.b], tin.vh[t.c]]; if (Math.max(...hs) - Math.min(...hs) > 200) steep++; }
  console.log(`verts ${tin.vx.length} tris ${tin.tris.length} rms ${Math.sqrt(se / n).toFixed(1)} max ${maxE.toFixed(0)} tris>200m ${steep}`);
});

// Belts: every interior vertex sits on an isoline, and isolines are fixed edges, so a triangle
// lies inside one belt between two consecutive multiples of the step (refinement may add
// in-between lines locally, which only splits a belt). Same input → same TIN.
it('triangles stay inside one belt and the TIN is deterministic', () => {
  const rough = lat((i, j) => 600 + 500 * Math.sin(i / 3.1) * Math.cos(j / 2.7) + 300 * Math.sin((i * j) / 40));
  for (const h of [terr, rough]) {
    for (const z of [14, 12, 10]) {
      const tile: Tile = { z, x: 9000 >> (14 - z), y: 6000 >> (14 - z) };
      const debug: TinDebug = {};
      const tin = buildTerrainTin(tile, GRID, h, { debug });
      const step = debug.step!;
      const inner = (k: number) => tin.vx[k] > 0 && tin.vx[k] < GRID && tin.vy[k] > 0 && tin.vy[k] < GRID;
      for (const t of tin.tris) {
        const ks = [t.a, t.b, t.c];
        if (!ks.every(inner)) continue;
        // all corners within [n·step, (n+1)·step] for one n
        const hs = ks.map((k) => tin.vh[k] / step);
        expect(Math.max(...hs) - Math.floor(Math.min(...hs) + 1e-9), JSON.stringify(ks.map((k) => tin.vh[k]))).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(buildTerrainTin(tile, GRID, h)).toEqual(tin);
    }
  }
});

// Real DEM (Terrarium 12/2177/1436, Inn valley at Innsbruck, lattice + borders as the game decodes
// them). Here simplified isoline chords ran along the tile edge over a border vertex and two belt
// boundaries were silently missing from the triangulation.
it('every belt boundary of a real tile is an edge of the TIN', async () => {
  const fx = (await import('./fixtures/terrarium-12-2177-1436.json')).default;
  const borders = {
    n: Float32Array.from(fx.borders.n), s: Float32Array.from(fx.borders.s),
    w: Float32Array.from(fx.borders.w), e: Float32Array.from(fx.borders.e),
  };
  const debug: TinDebug = {};
  const tin = buildTerrainTin(fx.tile, fx.grid, Float32Array.from(fx.heights), { borders, debug });
  const edges = new Set<number>();
  const n = tin.vx.length;
  for (const t of tin.tris) for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) edges.add(Math.min(u, v) * n + Math.max(u, v));
  expect(debug.missing).toBe(0);
  for (const [a, b] of debug.constraints!) expect(edges.has(Math.min(a, b) * n + Math.max(a, b))).toBe(true);
  // the belt step stays at the game's default here (no budget escalation)
  expect(debug.step).toBe(BELT_STEP);
});

// Real coast (Terrarium 12/2379/1599, Fethiye bay): the sea is mostly exactly 0 m with a few
// pixels at −1…−3 m. Sea must stay a flat water surface at 0 m.
it("the sea of a real coastal tile stays flat at 0 m and its plain is not lifted", async () => {
  const fx = (await import('./fixtures/terrarium-12-2379-1599.json')).default;
  const borders = {
    n: Float32Array.from(fx.borders.n), s: Float32Array.from(fx.borders.s),
    w: Float32Array.from(fx.borders.w), e: Float32Array.from(fx.borders.e),
  };
  const h = Float32Array.from(fx.heights);
  const tin = buildTerrainTin(fx.tile, fx.grid, h, { borders });
  const at = (u: number, v: number): number => {
    let best = -Infinity, val = NaN;
    for (const t of tin.tris) {
      const ax = tin.vx[t.a], ay = tin.vy[t.a];
      const d = (tin.vx[t.b] - ax) * (tin.vy[t.c] - ay) - (tin.vx[t.c] - ax) * (tin.vy[t.b] - ay);
      if (!d) continue;
      const w1 = ((u - ax) * (tin.vy[t.c] - ay) - (tin.vx[t.c] - ax) * (v - ay)) / d;
      const w2 = ((tin.vx[t.b] - ax) * (v - ay) - (u - ax) * (tin.vy[t.b] - ay)) / d;
      const w0 = 1 - w1 - w2, m = Math.min(w0, w1, w2);
      if (m > best) {
        best = m;
        val = Math.max(0, tin.vh[t.a]) * w0 + Math.max(0, tin.vh[t.b]) * w1 + Math.max(0, tin.vh[t.c]) * w2;
      }
    }
    return val;
  };
  const side = fx.grid + 1;
  let sea = 0, lifted = 0, worst = 0;
  for (let j = 0; j <= fx.grid; j++) for (let i = 0; i <= fx.grid; i++) {
    if (h[j * side + i] > 0) continue;
    sea++;
    const z = at(i, j);
    if (z > 0.5) lifted++;
    worst = Math.max(worst, z);
  }
  expect(sea).toBeGreaterThan(50);
  // Before the coastline was traced above 0 m, sea at exactly 0 counted as land and shared the
  // lowest belt with the plain (on the 32-lattice: 60 sea nodes lifted by up to 62 m).
  // What remains are shallow nodes by the shore, where the simplified coastline (eps 2 cells,
  // ~330 m chords at z12) cuts a corner of the sea: measured 7 nodes, up to 16.6 m.
  expect(lifted).toBeLessThanOrEqual(8);
  expect(worst).toBeLessThan(20);
  // The coastal plain (5–20 m) between the coastline and the first isoline kilometres inland
  // is one sloping 0…250 m belt without refinement: rms 50.8 m over the tile, up to 169 m over the
  // plain. Refinement puts in-between isolines where the lattice is far off (21.1 and 34 m).
  let se = 0, n = 0, plain = 0;
  for (let j = 0; j <= fx.grid; j++) for (let i = 0; i <= fx.grid; i++) {
    const e = at(i, j) - Math.max(0, h[j * side + i]);
    se += e * e;
    n++;
    if (h[j * side + i] > 0 && h[j * side + i] < 30) plain = Math.max(plain, Math.abs(e));
  }
  expect(Math.sqrt(se / n)).toBeLessThan(25);
  expect(plain).toBeLessThan(45);
});
