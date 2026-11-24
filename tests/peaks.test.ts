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
  /** a summit a little off node (i, j), on ground of 1000 m */
  const at = (i: number, j: number, ele: number) => ({ ...peakNear(i, j, ele), ground: 1000 });
  /** metres per lattice step at the test tile */
  const ll0 = gridLatLon(TILE, 32, 32, GRID);
  const STEP = (40075016.686 * Math.cos((ll0.lat * Math.PI) / 180)) / (2 ** TILE.z * GRID);

  it('raises the node nearest a summit to its height', () => {
    const h = flat();
    expect(applyPeaks({ heights: h }, TILE, GRID, [at(20, 30, 1040)])).toBe(true);
    expect(h[30 * SIDE + 20]).toBe(1040);
  });

  it('pulls the ground up within REACH_M, less linearly with distance, to nothing at REACH_M', () => {
    const h = flat();
    applyPeaks({ heights: h }, TILE, GRID, [at(30, 30, 1060)]);
    const [x, y] = [30.2, 29.7];
    let raised = 0;
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        if (i === 30 && j === 30) continue;
        const d = (Math.hypot(i - x, j - y) * STEP) / PEAK.REACH_M;
        const want = d < 1 ? 1000 + 60 * (1 - d) : 1000;
        expect(h[j * SIDE + i]).toBeCloseTo(want, 1);
        if (d < 1) raised++;
      }
    }
    // ~30 m steps: a 100 m reach takes in some thirty nodes
    expect(raised).toBeGreaterThan(20);
  });

  it('never lowers the ground, and leaves a summit too far above it alone', () => {
    const h = flat();
    expect(applyPeaks({ heights: h }, TILE, GRID, [at(20, 30, 990), at(40, 10, 1000 + PEAK.MAX_LIFT_M + 1)])).toBe(false);
    expect(h.every((v) => v === 1000)).toBe(true);
  });

  it('takes the highest pull where summits overlap, whatever their order', () => {
    const a = flat(), b = flat();
    const ps = [at(30, 30, 1050), at(32, 30, 1080)];
    applyPeaks({ heights: a }, TILE, GRID, ps);
    applyPeaks({ heights: b }, TILE, GRID, [...ps].reverse());
    expect(a).toEqual(b);
  });

  it('lifts a shared border node alike from both tiles (a summit just over the border)', () => {
    const east: Tile = { ...TILE, x: TILE.x + 1 };
    const p = { ...peakNear(63, 30, 1050), ground: 1000 };
    const w = flat(), e = flat();
    applyPeaks({ heights: w }, TILE, GRID, [p]);
    applyPeaks({ heights: e }, east, GRID, [p]);
    let touched = 0;
    for (let j = 0; j <= GRID; j++) {
      expect(e[j * SIDE + 0]).toBeCloseTo(w[j * SIDE + GRID], 3);
      if (w[j * SIDE + GRID] > 1000) touched++;
    }
    expect(touched).toBeGreaterThan(0);
    expect(e.some((v, k) => k % SIDE > 0 && v > 1000)).toBe(true);
  });
});
