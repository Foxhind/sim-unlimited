import { describe, expect, it } from 'vitest';
import { RAMP, TERRAIN_RAMP_BASE, VGA_PALETTE, nearestVga } from '../src/engine/palette';
import { LANDSAT_URL, landsatFaceColor, landsatRamp, landsatSource } from '../src/world/landsat';
import { buildTerrainMesh } from '../src/world/terrain-mesher';

describe('landsat imagery tiles', () => {
  it('uses the same z/x/y up to z12 and the z12 ancestor below', () => {
    expect(landsatSource({ z: 10, x: 594, y: 399 })).toEqual({ tile: { z: 10, x: 594, y: 399 }, x0: 0, y0: 0, scale: 1 });
    expect(landsatSource({ z: 14, x: 9517, y: 6398 })).toEqual({ tile: { z: 12, x: 2379, y: 1599 }, x0: 0.25, y0: 0.5, scale: 0.25 });
    expect(LANDSAT_URL({ z: 12, x: 2379, y: 1599 })).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/2000-12-01/GoogleMapsCompatible_Level12/12/1599/2379.jpeg',
    );
  });
});

describe('landsatRamp', () => {
  it('a face takes the nearest default VGA colour as its own ramp', () => {
    expect(landsatRamp(0, 0, 170)).toBe(TERRAIN_RAMP_BASE + 1);
    const forest = landsatRamp(38, 58, 32) - TERRAIN_RAMP_BASE;
    const [r, g, b] = VGA_PALETTE[forest];
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(landsatRamp(200, 182, 140)).not.toBe(landsatRamp(38, 58, 32));
  });
});

describe('landsatFaceColor', () => {
  // 256² image: left half forest, right half sand
  const W = 256;
  const data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const c = x < 128 ? [38, 58, 32] : [196, 180, 140];
    data.set([...c, 255], (y * W + x) * 4);
  }
  const img = { data, width: W, height: W };

  it('averages the pixels under a face', () => {
    const f = landsatFaceColor(img, { z: 12, x: 0, y: 0 }, 48);
    expect(f(2, 2, 20, 2, 2, 20)).toBe(TERRAIN_RAMP_BASE + nearestVga(38, 58, 32));
    expect(f(30, 2, 46, 2, 46, 20)).toBe(TERRAIN_RAMP_BASE + nearestVga(196, 180, 140));
  });

  it('a z14 tile reads its quarter of the z12 image; a sliver falls back to its centroid pixel', () => {
    // x=1 of 4 → image columns 64..128 (forest); x=2 → 128..192 (sand)
    expect(landsatFaceColor(img, { z: 14, x: 1, y: 0 }, 48)(0, 0, 48, 0, 0, 48)).toBe(TERRAIN_RAMP_BASE + nearestVga(38, 58, 32));
    expect(landsatFaceColor(img, { z: 14, x: 2, y: 0 }, 48)(0, 0, 48, 0, 0, 48)).toBe(TERRAIN_RAMP_BASE + nearestVga(196, 180, 140));
    expect(landsatFaceColor(img, { z: 12, x: 0, y: 0 }, 48)(40, 10, 40.01, 30, 40.02, 10)).toBe(TERRAIN_RAMP_BASE + nearestVga(196, 180, 140));
  });

  it('colours mesh land faces, sea stays water', () => {
    const grid = 16, side = grid + 1;
    const heights = new Float32Array(side * side).map((_, k) => ((k % side) < 4 ? 0 : 50 + (k % side) * 30));
    const mesh = buildTerrainMesh({ tile: { z: 12, x: 0, y: 0 }, grid, heights, skirtDepth: 0, faceColor: () => TERRAIN_RAMP_BASE + 5 });
    const used = new Set(mesh.ramps);
    expect(used).toEqual(new Set([TERRAIN_RAMP_BASE + 5, RAMP.WATER]));
  });
});
