import { describe, expect, it } from 'vitest';
import { colourOf, LAND_PALETTE, nearestLand } from '../src/engine/palette';
import type { RgbaImage } from '../src/world/landsat';
import {
  crop, faceColorByMode, FULL_LAND, gaussianBlur, gradeImage, isNeutralGrade, LS_PX, NEUTRAL_GRADE, medianCut, neighbourTiles, processLandsat, quantize, stitch3x3,
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
  it('maps to the land palette, a limited palette uses at most k colours', () => {
    const img = crop(stitch3x3(Array.from({ length: 9 }, (_, k) => solid([k * 25, 100 + k * 10, 40]))), 0, 0, 768, 768);
    const all = quantize(img, FULL_LAND);
    expect(all.index[0]).toBe(nearestLand(0, 100, 40));
    const four = medianCut(img, 4);
    expect(four).toHaveLength(4);
    const q = quantize(img, [...new Set(four.map((c) => nearestLand(...c)))]);
    expect(q.used.length).toBeLessThanOrEqual(4);
    expect(at(q.image, 0, 0)).toEqual([...LAND_PALETTE[q.index[0]]]);
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

  it('a face takes the most frequent quantized colour under it, as an RGB face colour', () => {
    const p = processLandsat(mosaic, { z: 12, x: 4, y: 4 }, { blurM: 0, colours: 0 });
    const f = faceColorByMode(p.quantized, p.raw.width, 48);
    expect(f(1, 1, 40, 1, 1, 40)).toBe(colourOf(LAND_PALETTE[nearestLand(...sand)]));
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

describe('landsatTerrain (game)', () => {
  it('mesh and drape/collision build the same TIN from the same imagery', async () => {
    const { landsatTerrain, LANDSAT_TUNING } = await import('../src/world/landsat-process');
    const { buildTerrainTin, tinSampler } = await import('../src/world/terrain-tin');
    const { buildTerrainMesh } = await import('../src/world/terrain-mesher');
    const f = (await import('./fixtures/terrarium-12-2379-1599.json')).default;
    const borders = { n: Float32Array.from(f.borders.n), s: Float32Array.from(f.borders.s), w: Float32Array.from(f.borders.w), e: Float32Array.from(f.borders.e) };
    const heights = Float32Array.from(f.heights);
    // a mosaic with a sand disc in a forest, so there are colour boundaries
    const W = 768, data = new Uint8ClampedArray(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const c = Math.hypot(x - 380, y - 400) < 70 ? [196, 180, 140] : [38, 58, 32];
      data.set([...c, 255], (y * W + x) * 4);
    }
    const ls = landsatTerrain({ data, width: W, height: W }, f.tile, f.grid);
    expect(ls.lines.length).toBeGreaterThan(0);
    expect(ls.maxVerts).toBe(LANDSAT_TUNING.maxVerts);
    const colourLines = { lines: ls.lines, maxVerts: ls.maxVerts };
    const tin = buildTerrainTin(f.tile, f.grid, heights, { borders, colourLines });
    const mesh = buildTerrainMesh({ tile: f.tile, grid: f.grid, heights, borders, faceColor: ls.faceColor, colourLines, skirtDepth: 0 });
    // mesh = the same land triangles + skirt quads along the border
    const skirt = mesh.vertexCount - tin.tris.length * 3;
    expect(skirt).toBeGreaterThan(0);
    expect(skirt % 6).toBe(0);
    // the drape sampler sees the mesh's vertex heights
    const s = tinSampler(tin, f.tile);
    expect(Number.isFinite(s(29.1, 36.65))).toBe(true);
    const plain = buildTerrainTin(f.tile, f.grid, heights, { borders });
    expect(tin.vx.length).toBeGreaterThan(plain.vx.length);
  });
});

describe('one water colour', () => {
  it('imagery water becomes the water ramp; sea-level boundary vertices do not lift sea faces', async () => {
    const { RAMP, nearestLand, isWaterLand } = await import('../src/engine/palette');
    const { quantize, faceColorByMode } = await import('../src/world/landsat-process');
    const blue = nearestLand(10, 30, 90), green = nearestLand(40, 90, 30);
    expect(isWaterLand(blue)).toBe(true);
    const q = quantize(solid([10, 30, 90], 8, 8), [blue, green]);
    expect(faceColorByMode(q, 8, 4)(0, 0, 4, 0, 0, 4)).toBe(RAMP.WATER);
    // a fixture with sea: boundaries drawn over the sea keep water faces at 0 m
    const { buildTerrainTin } = await import('../src/world/terrain-tin');
    const f = (await import('./fixtures/terrarium-12-2379-1599.json')).default;
    const borders = { n: Float32Array.from(f.borders.n), s: Float32Array.from(f.borders.s), w: Float32Array.from(f.borders.w), e: Float32Array.from(f.borders.e) };
    const heights = Float32Array.from(f.heights);
    const ring = [{ x: 2, y: 6 }, { x: 9, y: 6 }, { x: 9, y: 14 }, { x: 2, y: 14 }, { x: 2, y: 6 }]; // in the bay (west)
    const tin = buildTerrainTin(f.tile, f.grid, heights, { borders, colourLines: { lines: [{ pts: ring, closed: true }] } });
    const at = (p: { x: number; y: number }) => tin.vx.findIndex((x, k) => Math.abs(x - p.x) < 1e-9 && Math.abs(tin.vy[k] - p.y) < 1e-9);
    for (const p of ring) {
      const k = at(p);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(tin.vh[k] === 0 || tin.vh[k] >= 0.5).toBe(true);
    }
  });
});
const px = (r: number, g: number, b: number) => ({ data: new Uint8ClampedArray([r, g, b, 255]), width: 1, height: 1 });

describe('gradeImage', () => {
  it('leaves the image untouched when neutral', () => {
    const img = px(10, 120, 200);
    expect(isNeutralGrade(NEUTRAL_GRADE)).toBe(true);
    expect(gradeImage(img, NEUTRAL_GRADE)).toBe(img);
  });
  it('brightness adds to every channel', () => {
    const out = gradeImage(px(100, 100, 100), { ...NEUTRAL_GRADE, brightness: 0.1 });
    expect([...out.data.slice(0, 3)]).toEqual([126, 126, 126]);
  });
  it('contrast pivots about mid-grey', () => {
    const out = gradeImage(px(64, 128, 191), { ...NEUTRAL_GRADE, contrast: 2 });
    expect(out.data[0]).toBeLessThan(10);
    expect(Math.abs(out.data[1] - 128)).toBeLessThanOrEqual(1);
    expect(out.data[2]).toBeGreaterThan(245);
  });
  it('gamma above 1 lightens the shadows', () => {
    expect(gradeImage(px(64, 64, 64), { ...NEUTRAL_GRADE, gamma: 2 }).data[0]).toBeGreaterThan(100);
  });
  it('zero saturation gives grey', () => {
    const d = gradeImage(px(200, 50, 50), { ...NEUTRAL_GRADE, saturation: 0 }).data;
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
  });
});
