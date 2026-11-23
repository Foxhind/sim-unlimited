import { describe, expect, it } from 'vitest';
import { gridLatLon, type Tile } from '../src/world/geodesy';
import { applyPeaks, PEAK, peaksOf } from '../src/world/peaks';

const TILE: Tile = { z: 14, x: 9518, y: 6396 };
const GRID = 64;
const SIDE = GRID + 1;

function flat(h = 1000): Float32Array {
  return new Float32Array(SIDE * SIDE).fill(h);
}

/** a summit a little off node (i, j) */
function peakNear(i: number, j: number, ele: number) {
  const ll = gridLatLon(TILE, i + 0.2, j - 0.3, GRID);
  return { lon: ll.lon, lat: ll.lat, ele };
}

describe('peaksOf', () => {
  it('takes natural=peak points with a readable ele', () => {
    const peaks = peaksOf([
      { at: [29.1, 36.6], tags: { natural: 'peak', ele: '1969' } },
      { at: [29.2, 36.7], tags: { natural: 'peak', ele: '1 969 m?' } },
      { at: [29.3, 36.8], tags: { natural: 'peak' } },
      { at: [29.4, 36.9], tags: { natural: 'peak', ele: '812,5' } },
      { at: [29.5, 37.0], tags: { man_made: 'mast', ele: '900' } },
    ]);
    expect(peaks).toEqual([{ lon: 29.1, lat: 36.6, ele: 1969 }, { lon: 29.4, lat: 36.9, ele: 812.5 }]);
  });
});

describe('applyPeaks', () => {
  it('raises the node nearest a summit to its height, and no other', () => {
    const h = flat();
    expect(applyPeaks({ heights: h }, TILE, GRID, [peakNear(20, 30, 1040)])).toBe(true);
    expect(h[30 * SIDE + 20]).toBe(1040);
    let raised = 0;
    for (const v of h) if (v !== 1000) raised++;
    expect(raised).toBe(1);
  });

  it('never lowers the ground, and leaves a summit too far above it alone', () => {
    const h = flat();
    expect(applyPeaks({ heights: h }, TILE, GRID, [peakNear(20, 30, 990), peakNear(40, 10, 1000 + PEAK.MAX_LIFT_M + 1)])).toBe(false);
    expect(h.every((v) => v === 1000)).toBe(true);
  });

  it('keeps off the tile border (the neighbour shares those nodes)', () => {
    const h = flat();
    applyPeaks({ heights: h }, TILE, GRID, [peakNear(0, 30, 1040), peakNear(64, 30, 1040), peakNear(30, 0, 1040), peakNear(30, 64, 1040)]);
    expect(h.every((v) => v === 1000)).toBe(true);
  });
});
