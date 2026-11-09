import { describe, expect, it } from 'vitest';
import { gridLatLon, latLonToEnu, tileBounds, tileCenter, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { computeRunwayPlanes, flattenRunways } from '../src/world/runway';
import { latticeSampler } from '../src/world/terrain-source';
import type { OsmLine } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8708, y: 5745 };
const GRID = 8;

function runway(): OsmLine {
  const c = tileCenter(TILE);
  const b = tileBounds(TILE);
  return {
    points: [
      [b.west + (b.east - b.west) * 0.2, c.lat],
      [b.west + (b.east - b.west) * 0.8, c.lat],
    ],
    tags: { aeroway: 'runway', width: '45' },
  };
}

function slopedHeights(): Float32Array {
  const side = GRID + 1;
  const h = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) h[j * side + i] = 100 + i * 2 + j;
  return h;
}

describe('runway planes (Q40)', () => {
  it('flattens the core strip to one plane and blends the edges', () => {
    const h = slopedHeights();
    const original = h.slice();
    expect(flattenRunways(h, TILE, GRID, [runway()], () => 100)).toBe(true);
    const side = GRID + 1;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const ll = gridLatLon(TILE, i, j, GRID);
        const [e, n] = latLonToEnu(tileCenter(TILE), ll.lat, ll.lon, 0);
        const d = Math.abs(-n); // runway runs east-west through the tile center
        if (Math.abs(e) < tileSizeMeters(TILE) * 0.25 && d <= 22.5) expect(h[j * side + i]).toBe(100);
        if (d > 22.5 + 35) expect(h[j * side + i]).toBe(original[j * side + i]);
      }
    }
  });

  it('plane comes from centerline samples, independent of the lattice resolution', () => {
    // sloped surface: plane is the mean along the centerline, even if no lattice vertex is in the core
    const sample = (lon: number) => 100 + (lon - tileBounds(TILE).west) * 1000;
    const planes = computeRunwayPlanes(TILE, GRID, [runway()], sample);
    expect(planes).toHaveLength(1);
    expect(planes[0].half).toBe(22.5);
    const b = tileBounds(TILE);
    const midLon = b.west + (b.east - b.west) * 0.5;
    expect(planes[0].plane).toBeCloseTo(sample(midLon), 1);
  });

  it('latticeSampler returns the flattened lattice values at vertices', () => {
    const h = slopedHeights();
    flattenRunways(h, TILE, GRID, [runway()], () => 100);
    const sampler = latticeSampler(h, TILE, GRID);
    const side = GRID + 1;
    const ll = gridLatLon(TILE, 4, 4, GRID);
    expect(sampler(ll.lon, ll.lat)).toBeCloseTo(h[4 * side + 4], 3);
  });

  it('is a no-op without runways', () => {
    const h = slopedHeights();
    const original = h.slice();
    expect(flattenRunways(h, TILE, GRID, [], () => 0)).toBe(false);
    expect(Array.from(h)).toEqual(Array.from(original));
    expect(computeRunwayPlanes(TILE, GRID, [], () => 0)).toHaveLength(0);
  });
});
