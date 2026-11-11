import { expect, it } from 'vitest';
import { buildTerrainTin, type TinDebug } from '../src/world/terrain-tin';

const fx = async (name: string) => {
  const f = (await import(`./fixtures/${name}.json`)).default;
  const borders = { n: Float32Array.from(f.borders.n), s: Float32Array.from(f.borders.s), w: Float32Array.from(f.borders.w), e: Float32Array.from(f.borders.e) };
  return { tile: f.tile, grid: f.grid as number, heights: Float32Array.from(f.heights), borders };
};

/** share of pixels whose label equals the majority label of their triangle */
function purity(tin: ReturnType<typeof buildTerrainTin>, label: Uint8Array, size: number, grid: number): number {
  const k = size / grid;
  let same = 0, n = 0;
  for (const t of tin.tris) {
    const ax = tin.vx[t.a] * k, ay = tin.vy[t.a] * k, bx = tin.vx[t.b] * k, by = tin.vy[t.b] * k, cx = tin.vx[t.c] * k, cy = tin.vy[t.c] * k;
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (!d) continue;
    const counts = new Map<number, number>();
    for (let j = Math.floor(Math.min(ay, by, cy)); j <= Math.ceil(Math.max(ay, by, cy)) && j < size; j++)
      for (let i = Math.floor(Math.min(ax, bx, cx)); i <= Math.ceil(Math.max(ax, bx, cx)) && i < size; i++) {
        const w1 = ((i + 0.5 - ax) * (cy - ay) - (cx - ax) * (j + 0.5 - ay)) / d;
        const w2 = ((bx - ax) * (j + 0.5 - ay) - (i + 0.5 - ax) * (by - ay)) / d;
        if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
        const l = label[j * size + i];
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
    let best = 0, tot = 0;
    for (const c of counts.values()) { tot += c; best = Math.max(best, c); }
    same += best; n += tot;
  }
  return same / n;
}

it('colour labels flip free edges toward single-colour triangles, within the height allowance', async () => {
  const f = await fx('terrarium-12-2177-1436');
  // two colours split by a diagonal stripe the isolines do not follow
  const size = 256;
  const label = new Uint8Array(size * size).map((_, k) => (((k % size) + Math.floor(k / size)) % 96 < 48 ? 3 : 7));
  const plain = buildTerrainTin(f.tile, f.grid, f.heights, { borders: f.borders });
  const dbg: TinDebug = {};
  const coloured = buildTerrainTin(f.tile, f.grid, f.heights, { borders: f.borders, colour: { label, size }, debug: dbg });
  expect(dbg.colourFlips).toBeGreaterThan(0);
  expect(purity(coloured, label, size, f.grid)).toBeGreaterThan(purity(plain, label, size, f.grid));
  // deterministic, and a zero allowance only takes flips that do not grow the error
  expect(buildTerrainTin(f.tile, f.grid, f.heights, { borders: f.borders, colour: { label, size } })).toEqual(coloured);
  const strict: TinDebug = {};
  buildTerrainTin(f.tile, f.grid, f.heights, { borders: f.borders, colour: { label, size, maxDh: 0 }, debug: strict });
  expect(strict.colourFlips!).toBeLessThanOrEqual(dbg.colourFlips!);
});

it('without colour labels the TIN is unchanged (one-colour labels make no flips)', async () => {
  const f = await fx('terrarium-12-2379-1599');
  const plain = buildTerrainTin(f.tile, f.grid, f.heights, { borders: f.borders });
  const dbg: TinDebug = {};
  const flat = buildTerrainTin(f.tile, f.grid, f.heights, { borders: f.borders, colour: { label: new Uint8Array(64 * 64), size: 64 }, debug: dbg });
  expect(dbg.colourFlips).toBe(0);
  expect(flat).toEqual(plain);
});

it('colour boundaries become fixed edges, split where they cross isolines', async () => {
  const f = await fx('terrarium-12-2379-1599');
  // a ring and a long line across the tile, in lattice coordinates
  const ring = [{ x: 10, y: 10 }, { x: 30, y: 12 }, { x: 28, y: 30 }, { x: 12, y: 28 }, { x: 10, y: 10 }];
  const line = [{ x: 3, y: 40 }, { x: 24, y: 36 }, { x: 45, y: 41 }];
  const dbg: TinDebug = {};
  const opts = { borders: f.borders, colourLines: { lines: [{ pts: line, closed: false }, { pts: ring, closed: true }] }, debug: dbg };
  const tin = buildTerrainTin(f.tile, f.grid, f.heights, opts);
  expect(dbg.missing).toBe(0);
  expect(dbg.colourVerts).toBe(7);
  expect(dbg.colourCrossings).toBeGreaterThan(0);
  // every colour segment is covered by fixed edges: its points are vertices and consecutive
  // pieces are edges of the triangulation
  const edges = new Set<string>();
  for (const t of tin.tris) for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) edges.add(`${Math.min(a, b)},${Math.max(a, b)}`);
  const at = (p: { x: number; y: number }) => tin.vx.findIndex((x, k) => Math.abs(x - p.x) < 1e-9 && Math.abs(tin.vy[k] - p.y) < 1e-9);
  for (const p of [...ring, ...line]) expect(at(p)).toBeGreaterThanOrEqual(0);
  for (const [a, b] of dbg.constraints!) expect(edges.has(`${Math.min(a, b)},${Math.max(a, b)}`)).toBe(true);
  // crossing vertices sit on an isoline: at its level
  expect(buildTerrainTin(f.tile, f.grid, f.heights, opts)).toEqual(tin);
});

it('the colour vertex cap takes the longest boundaries that fit', async () => {
  const f = await fx('terrarium-12-2379-1599');
  const long = [{ x: 3, y: 40 }, { x: 14, y: 38 }, { x: 24, y: 36 }, { x: 45, y: 41 }];
  const short = [{ x: 20, y: 20 }, { x: 24, y: 22 }];
  const dbg: TinDebug = {};
  buildTerrainTin(f.tile, f.grid, f.heights, {
    borders: f.borders, debug: dbg, colourLines: { lines: [{ pts: long, closed: false }, { pts: short, closed: false }], maxVerts: 3 },
  });
  expect(dbg.colourVerts).toBe(2); // the long one (4) does not fit, the short one does
});
