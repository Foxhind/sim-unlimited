import { describe, expect, it } from 'vitest';
import type { Tile } from '../src/world/geodesy';
import { padDem, parentEdges, sampleDem } from '../src/world/terrain-source';
import { buildTerrainTin, type TerrainTin } from '../src/world/terrain-tin';

const SIZE = 64;
const GRID = 16;

/** a DEM defined over global pixels: hills plus pixel noise, the same whichever tile reads it */
function elev(gx: number, gy: number): number {
  const noise = ((Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) >>> 0) % 31;
  return Math.fround(600 + 420 * Math.sin(gx / 23) * Math.cos(gy / 17) + 150 * Math.sin((gx + gy) / 9) + noise - 15);
}

const Z = 12;
/** the DEM is defined at zoom Z; a coarser zoom averages it, like the real pyramid */
function pixels(t: Tile): Float32Array {
  const k = 2 ** (Z - t.z);
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0;
      for (let v = 0; v < k; v++) for (let u = 0; u < k; u++) sum += elev((t.x * SIZE + x) * k + u, (t.y * SIZE + y) * k + v);
      out[y * SIZE + x] = sum / (k * k);
    }
  }
  return out;
}

function dem(t: Tile) {
  const around = Array.from({ length: 9 }, (_, k) => pixels({ z: t.z, x: t.x + (k % 3) - 1, y: t.y + Math.floor(k / 3) - 1 }));
  return sampleDem(padDem(SIZE, around), GRID);
}

function load(t: Tile, withParent = false) {
  const { heights, borders } = dem(t);
  if (withParent) borders.coarse = parentEdges(t, dem({ z: t.z - 1, x: t.x >> 1, y: t.y >> 1 }).borders);
  return { heights, borders, tin: buildTerrainTin(t, GRID, heights, { borders }) };
}

/** border vertices of one edge as (position along the edge, height), sorted */
function edge(tin: TerrainTin, e: 'n' | 's' | 'w' | 'e'): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < tin.vx.length; k++) {
    const on = e === 'n' ? tin.vy[k] === 0 : e === 's' ? tin.vy[k] === GRID : e === 'w' ? tin.vx[k] === 0 : tin.vx[k] === GRID;
    if (on) out.push([e === 'n' || e === 's' ? tin.vx[k] : tin.vy[k], tin.vh[k]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** largest vertical distance from the vertices of `a` to the polyline `b` */
function gap(a: Array<[number, number]>, b: Array<[number, number]>): number {
  let worst = 0;
  for (const [f, h] of a) {
    let k = 1;
    while (k < b.length - 1 && b[k][0] < f) k++;
    const [f0, h0] = b[k - 1], [f1, h1] = b[k];
    const on = f1 > f0 ? h0 + ((h1 - h0) * (f - f0)) / (f1 - f0) : h0;
    worst = Math.max(worst, Math.abs(on - h));
  }
  return worst;
}

describe('tile seams', () => {
  const A: Tile = { z: 12, x: 2140, y: 1420 };
  const a = load(A);
  const east = load({ ...A, x: A.x + 1 });
  const south = load({ ...A, y: A.y + 1 });

  it('neighbours read the same edge profile and the same lattice nodes on the edge', () => {
    expect(Array.from(a.borders.e)).toEqual(Array.from(east.borders.w));
    expect(Array.from(a.borders.s)).toEqual(Array.from(south.borders.n));
    const side = GRID + 1;
    for (let k = 0; k < side; k++) {
      expect(a.heights[k * side + GRID]).toBe(east.heights[k * side]);
      expect(a.heights[GRID * side + k]).toBe(south.heights[k]);
    }
  });

  it('the four tiles of a corner agree on its height', () => {
    const diag = load({ ...A, x: A.x + 1, y: A.y + 1 });
    const h = a.borders.e[SIZE];
    expect(a.borders.s[SIZE]).toBe(h);
    expect(east.borders.s[0]).toBe(h);
    expect(south.borders.e[0]).toBe(h);
    expect(diag.borders.n[0]).toBe(h);
    expect(diag.borders.w[0]).toBe(h);
  });

  it('edge profiles are low-passed: pixel noise does not reach the border', () => {
    let rough = 0;
    for (let k = 1; k < SIZE; k++) rough = Math.max(rough, Math.abs(a.borders.e[k] - (a.borders.e[k - 1] + a.borders.e[k + 1]) / 2));
    expect(rough).toBeLessThan(4); // raw pixels: up to ±15 m
  });

  it('meshes of neighbours meet along the shared edge', () => {
    for (const [mine, theirs] of [[edge(a.tin, 'e'), edge(east.tin, 'w')], [edge(a.tin, 's'), edge(south.tin, 'n')]]) {
      expect(mine.length).toBeGreaterThan(3);
      expect(gap(mine, theirs)).toBeLessThan(1e-2);
      expect(gap(theirs, mine)).toBeLessThan(1e-2);
    }
  });

  it('a tile stitched to its coarser neighbour lies on the parent border line', () => {
    const parent = load({ z: A.z - 1, x: A.x >> 1, y: A.y >> 1 });
    for (const child of [A, { ...A, x: A.x + 1, y: A.y + 1 }]) {
      const c = load(child, true);
      const plain = load(child);
      const coarse = c.tin.coarse!;
      // the extra border vertices sit on the tile's own line: unstitched, the surface is unchanged
      for (const e of ['n', 's', 'w', 'e'] as const) expect(gap(edge(c.tin, e), edge(plain.tin, e))).toBeLessThan(1e-2);
      const stitched: TerrainTin = { ...c.tin, vh: c.tin.vh.map((h, k) => Math.max(0, h) + coarse.dh[k]) };
      for (const e of [child.y % 2 ? 's' : 'n', child.x % 2 ? 'e' : 'w'] as const) {
        const off = ((e === 'n' || e === 's' ? child.x : child.y) % 2) * GRID;
        const theirs = edge(parent.tin, e).map(([f, h]) => [f * 2 - off, h] as [number, number]);
        const mine = edge(stitched, e);
        const bit = { n: 1, s: 2, w: 4, e: 8 }[e];
        expect(c.tin.vx.some((_, k) => coarse.edges[k] & bit)).toBe(true);
        expect(gap(edge(c.tin, e), theirs)).toBeGreaterThan(0.5); // there was a step to close
        expect(gap(mine, theirs)).toBeLessThan(1e-2);
        expect(gap(theirs.filter(([f]) => f >= 0 && f <= GRID), mine)).toBeLessThan(1e-2);
      }
    }
  });
});
