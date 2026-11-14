import { describe, expect, it } from 'vitest';
import { BORDER_TOL_M, COAST_LEVEL, buildTerrainTin, isSeaFace, simplifyBorder } from '../src/world/terrain-tin';
import { buildTerrainMesh } from '../src/world/terrain-mesher';
import { RAMP } from '../src/engine/palette';
import type { Tile } from '../src/world/geodesy';

describe('border profile over the sea', () => {
  // a bay along the edge: sea at 0 m (a few pixels just below or above it), then the shore rises steeply
  const profile = Array.from({ length: 49 }, (_, k) => ({
    x: k * 50,
    y: k < 30 ? (k % 7 === 3 ? -0.4 : k % 11 === 5 ? 0.3 : 0) : (k - 29) * 25,
  }));

  it('keeps the sea at exactly 0 m up to the shore', () => {
    const line = simplifyBorder(profile, BORDER_TOL_M);
    const at = (x: number) => {
      let k = 1;
      while (k < line.length - 1 && line[k].x < x) k++;
      const a = line[k - 1], b = line[k];
      return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
    };
    for (const p of profile) if (p.y < COAST_LEVEL) expect(at(p.x)).toBe(0);
    // the land is still simplified: far fewer points than the profile
    expect(line.length).toBeLessThan(8);
    expect(line[0]).toEqual({ x: 0, y: 0 });
    expect(line[line.length - 1]).toEqual(profile[profile.length - 1]);
  });

  it('a plain Douglas–Peucker over the same profile lifted the sea (the bay bug)', () => {
    // the straight segment from the bay to the hill top passes over the last sea points
    const a = { x: 0, y: 0 }, b = profile[profile.length - 1];
    const lifted = profile.filter((p) => p.y < COAST_LEVEL && a.y + ((b.y - a.y) * p.x) / b.x > COAST_LEVEL);
    expect(lifted.length).toBeGreaterThan(0);
  });

  it('a tile whose south edge runs through a bay: every face over the sea lies at 0 m', () => {
    const tile: Tile = { z: 14, x: 9516, y: 6397 };
    const grid = 48, side = grid + 1;
    // sea, a low headland in the south-west corner and a high one in the south-east: along the
    // south edge the straight segment between their shores passes over the bay within tolerance
    const heights = Float32Array.from({ length: side * side }, (_, k) => {
      const i = k % side, j = Math.floor(k / side);
      const west = 30 - 3 * Math.hypot(i, j - grid);
      const east = 300 - 30 * Math.hypot(i - grid, j - grid);
      return Math.max(0, west, east);
    });
    // a colour boundary (a shade in the water) ending on the south edge in the bay: its end
    // vertex takes the border's height there
    const colourLines = { lines: [{ pts: [{ x: 20, y: grid }, { x: 22, y: 30 }, { x: 30, y: 25 }], closed: false }] };
    const tin = buildTerrainTin(tile, grid, heights, { colourLines });
    let seaFaces = 0;
    const dem = (x: number, y: number) => heights[Math.round(y) * side + Math.round(x)];
    for (const t of tin.tris) {
      const ids = [t.a, t.b, t.c];
      // faces wholly over the bay (every corner over 0 m of DEM)
      if (!ids.every((v) => dem(tin.vx[v], tin.vy[v]) === 0)) continue;
      seaFaces++;
      for (const v of ids) expect(tin.vh[v]).toBe(0);
    }
    expect(seaFaces).toBeGreaterThan(0);
  });

  it('an island lower than the first belt is land, though all its vertices are at 0 m', () => {
    const tile: Tile = { z: 14, x: 9516, y: 6397 };
    const grid = 48, side = grid + 1;
    // a 15 m island in open sea, astride the north border like Şövalye Island in Fethiye bay
    const heights = Float32Array.from({ length: side * side }, (_, k) => {
      const i = k % side, j = Math.floor(k / side);
      return Math.max(0, 15 - 1.5 * Math.hypot((i - 24) / 2, j));
    });
    const tin = buildTerrainTin(tile, grid, heights);
    let island = 0, sea = 0;
    tin.tris.forEach((t, ti) => {
      const cx = (tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, cy = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      const d = Math.hypot((cx - 24) / 2, cy);
      if (d < 7) { island++; expect(isSeaFace(tin, ti)).toBe(false); }
      if (d > 12) { sea++; expect(isSeaFace(tin, ti)).toBe(true); }
    });
    expect(island).toBeGreaterThan(0);
    expect(sea).toBeGreaterThan(0);
    // and the mesh colours it as land
    const mesh = buildTerrainMesh({ tile, grid, heights, skirtDepth: 0 });
    let landVerts = 0;
    for (let v = 0; v < mesh.vertexCount; v++) if ((mesh.ramps[v] & 0xfff) !== RAMP.SEA) landVerts++;
    expect(landVerts).toBeGreaterThan(0);
  });
});
