import { describe, expect, it } from 'vitest';
import { nearestVga, TERRAIN_RAMP_BASE, VGA_PALETTE } from '../src/engine/palette';
import type { RgbaImage } from '../src/world/landsat';
import {
  crop, faceColorByMode, FULL_VGA, gaussianBlur, LS_PX, medianCut, neighbourTiles, processLandsat, quantize, stitch3x3,
} from '../src/world/landsat-process';

const solid = (c: [number, number, number], w = LS_PX, h = LS_PX): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...c, 255], i * 4);
  return { data, width: w, height: h };
};
const at = (img: RgbaImage, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

describe('stitch', () => {
  it('neighbours wrap in x and stop at the poles', () => {
    const n = neighbourTiles({ z: 2, x: 0, y: 0 });
    expect(n.slice(0, 3)).toEqual([null, null, null]);
    expect(n[3]).toEqual({ z: 2, x: 3, y: 0 });
    expect(n[8]).toEqual({ z: 2, x: 1, y: 1 });
  });
  it('places the 3×3 tiles and extends the centre edge into a missing one', () => {
    const tiles = Array.from({ length: 9 }, (_, k) => (k === 0 ? null : solid([k * 20, 0, 0])));
    const m = stitch3x3(tiles);
    expect(m.width).toBe(768);
    expect(at(m, 300, 300)).toEqual([80, 0, 0]); // centre
    expect(at(m, 600, 700)).toEqual([160, 0, 0]); // south-east
    expect(at(m, 10, 10)).toEqual([80, 0, 0]); // north-west missing → centre corner
  });
});

describe('blur', () => {
  it('keeps a flat image flat and spreads an edge over ~sigma', () => {
    expect(at(gaussianBlur(solid([10, 20, 30], 32, 32), 3), 16, 16)).toEqual([10, 20, 30]);
    const half = solid([0, 0, 0], 64, 8);
    for (let y = 0; y < 8; y++) for (let x = 32; x < 64; x++) half.data.set([200, 200, 200], (y * 64 + x) * 4);
    const b = gaussianBlur(half, 4);
    expect(at(b, 20, 4)[0]).toBe(0);
    expect(at(b, 31, 4)[0]).toBeGreaterThan(60);
    expect(at(b, 31, 4)[0]).toBeLessThan(110);
    expect(at(gaussianBlur(half, 0), 31, 4)).toEqual([0, 0, 0]);
  });
});

describe('quantize', () => {
  it('maps to VGA, a limited palette uses at most k colours', () => {
    const img = crop(stitch3x3(Array.from({ length: 9 }, (_, k) => solid([k * 25, 100 + k * 10, 40]))), 0, 0, 768, 768);
    const all = quantize(img, FULL_VGA);
    expect(all.index[0]).toBe(nearestVga(0, 100, 40));
    const four = medianCut(img, 4);
    expect(four).toHaveLength(4);
    const q = quantize(img, [...new Set(four.map((c) => nearestVga(...c)))]);
    expect(q.used.length).toBeLessThanOrEqual(4);
    expect(at(q.image, 0, 0)).toEqual([...VGA_PALETTE[q.index[0]]]);
  });
});

describe('processLandsat', () => {
  // west column forest, rest sand
  const forest: [number, number, number] = [38, 58, 32], sand: [number, number, number] = [196, 180, 140];
  const mosaic = stitch3x3(Array.from({ length: 9 }, (_, k) => solid(k % 3 === 0 ? forest : sand)));

  it('crops the tile out of the mosaic (z14 = a quarter of its z12 tile per side)', () => {
    const p = processLandsat(mosaic, { z: 14, x: 4, y: 4 }, { blurM: 0, colours: 0 });
    expect(p.raw.width).toBe(64);
    expect(at(p.raw, 0, 0)).toEqual(sand);
  });

  it('blur reaches across the seam from the neighbour tile', () => {
    const sharp = processLandsat(mosaic, { z: 12, x: 4, y: 4 }, { blurM: 0, colours: 0 });
    const soft = processLandsat(mosaic, { z: 12, x: 4, y: 4 }, { blurM: 400, colours: 0 });
    expect(at(sharp.blurred, 0, 128)).toEqual(sand);
    expect(at(soft.blurred, 0, 128)[0]).toBeLessThan(sand[0] - 20); // pulled toward the forest to the west
    expect(soft.sigmaPx).toBeGreaterThan(3);
  });

  it('a face takes the most frequent quantized colour under it', () => {
    const p = processLandsat(mosaic, { z: 12, x: 4, y: 4 }, { blurM: 0, colours: 0 });
    const f = faceColorByMode(p.quantized, p.raw.width, 48);
    expect(f(1, 1, 40, 1, 1, 40)).toBe(TERRAIN_RAMP_BASE + nearestVga(...sand));
  });
});

describe('colour boundaries', () => {
  it('cleanLabels merges patches below the area threshold into their neighbour', async () => {
    const { cleanLabels } = await import('../src/world/landsat-process');
    const size = 16, lab = new Uint8Array(size * size).fill(1);
    lab[5 * size + 5] = 2; // 1-px speck
    for (let y = 8; y < 14; y++) for (let x = 8; x < 14; x++) lab[y * size + x] = 3; // 36-px patch
    const out = cleanLabels(lab, size, 10);
    expect(out[5 * size + 5]).toBe(1);
    expect(out[10 * size + 10]).toBe(3);
    expect(lab[5 * size + 5]).toBe(2); // input untouched
  });

  it('traces a ring around a patch and a line between two halves, away from the border', async () => {
    const { colourBoundaries } = await import('../src/world/landsat-process');
    const size = 64, grid = 16, lab = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) lab[y * size + x] = x < 32 ? 1 : 2;
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) lab[y * size + x] = 3;
    const lines = colourBoundaries(lab, size, grid, 0.25);
    const ring = lines.find((l) => l.closed)!;
    expect(ring.pts).toHaveLength(5); // a square, simplified to its corners
    expect(ring.pts.map((p) => [p.x, p.y]).sort()).toEqual([[2, 2], [2, 2], [2, 6], [6, 2], [6, 6]].sort());
    const split = lines.find((l) => !l.closed)!;
    expect(split.pts.every((p) => p.x === 8 && p.y >= 0.5 && p.y <= 15.5)).toBe(true);
  });
});
