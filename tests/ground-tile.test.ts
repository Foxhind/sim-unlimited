import { describe, expect, it } from 'vitest';
import { gridLatLon } from '../src/world/geodesy';
import { groundSampler, packGround } from '../src/world/ground-tile';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { tinSampler } from '../src/world/terrain-tin';
import { demOf, GRID, lattice, road, TILE } from './roads-helpers';

describe('a ground tile packed for the main thread', () => {
  it('samples the same surface as the TIN it was packed from', () => {
    const relief = (xm: number, ym: number) => 500 + 0.1 * xm + 0.2 * ym;
    const net = buildRoadNet([road({ highway: 'primary' }, [[5, 24], [59, 24]])]);
    const tin = buildSurfaceTin(TILE, GRID, lattice(relief), { roads: { net, z: solveRoadHeights(net, demOf(net, relief)) } });
    const packed = packGround(tin, []);
    // plain arrays that cross a worker boundary
    expect(packed.tris).toBeInstanceOf(Uint32Array);
    expect(packed.vx).toBeInstanceOf(Float64Array);
    const a = tinSampler(tin, TILE), b = groundSampler(packed, TILE);
    for (let j = 0; j <= 20; j++) {
      for (let i = 0; i <= 20; i++) {
        const ll = gridLatLon(TILE, (i * GRID) / 20, (j * GRID) / 20, GRID);
        expect(b(ll.lon, ll.lat)).toBe(a(ll.lon, ll.lat));
      }
    }
  });
});
