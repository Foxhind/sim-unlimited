import { describe, expect, it } from 'vitest';
import { gridLatLon, latLonToEnu, tileBounds, tileCenter, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { computeRunwayPlanes, flattenRunways, runwayStart } from '../src/world/runway';
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

describe('runwayStart', () => {
  // LOWI 08/26 as mapped in OSM (west end first), plus a grass glider strip beside it
  const main: OsmLine = { points: [[11.3316904, 47.2588763], [11.357032, 47.2616144]], tags: { aeroway: 'runway', ref: '08/26', surface: 'asphalt' } };
  const grass: OsmLine = { points: [[11.3405, 47.2575], [11.3480, 47.2583]], tags: { aeroway: 'runway', surface: 'grass' } };

  it('starts in from the nearer end, facing down the runway', () => {
    const east = runwayStart([main], { lat: 47.2617, lon: 11.3575 })!;
    expect(east.hdg).toBeCloseTo(261, 0);
    const [e, n] = latLonToEnu({ lat: 47.2616144, lon: 11.357032 }, east.lat, east.lon, 0);
    expect(Math.hypot(e, n)).toBeCloseTo(60, 0);
    const west = runwayStart([main], { lat: 47.2585, lon: 11.33 })!;
    expect(west.hdg).toBeCloseTo(81, 0);
  });

  it('prefers the paved runway to a nearer grass strip, and gives up far from any runway', () => {
    const s = runwayStart([grass, main], { lat: 47.2580, lon: 11.3440 })!;
    expect(s.hdg % 180).toBeCloseTo(81, 0);
    expect(runwayStart([main], { lat: 47.30, lon: 11.35 })).toBeNull();
  });
});
