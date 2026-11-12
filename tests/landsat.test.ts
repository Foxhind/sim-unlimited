import { describe, expect, it } from 'vitest';
import { RAMP, snowy, TERRAIN_RAMP_BASE } from '../src/engine/palette';
import { LANDSAT_URL, landsatSource } from '../src/world/landsat';
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

describe('terrain mesh faceColor', () => {
  it('colours mesh land faces (snow may lie on them), sea stays sea', () => {
    const grid = 16, side = grid + 1;
    const heights = new Float32Array(side * side).map((_, k) => ((k % side) < 4 ? 0 : 50 + (k % side) * 30));
    const mesh = buildTerrainMesh({ tile: { z: 12, x: 0, y: 0 }, grid, heights, skirtDepth: 0, faceColor: () => TERRAIN_RAMP_BASE + 5 });
    const used = new Set(mesh.ramps);
    expect(used).toEqual(new Set([snowy(TERRAIN_RAMP_BASE + 5), RAMP.SEA]));
  });
});
