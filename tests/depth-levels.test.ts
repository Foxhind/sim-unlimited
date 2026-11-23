import { describe, expect, it } from 'vitest';
import { depthLevels, type LevelItem } from '../src/world/depth-levels';

const item = (key: number, c: [number, number][], reach = 0.1): LevelItem => ({ key, c, reach });

describe('depth levels of the loose ribbons', () => {
  it('a piece over another it overlaps takes the next level: the higher key over the lower', () => {
    // a shoulder (1.3) under its carriageway (1.46), a footway (1.41) crossing both
    const shoulder = item(1.3, [[0, 0], [4, 0]], 0.2);
    const carriageway = item(1.46, [[0, 0], [4, 0]], 0.1);
    const footway = item(1.41, [[2, -1], [2, 1]], 0.05);
    expect(depthLevels([carriageway, footway, shoulder])).toEqual([3, 2, 1]);
  });

  it('pieces that do not overlap share the lowest level, whatever their keys', () => {
    const a = item(1.3, [[0, 0], [1, 0]]), b = item(1.9, [[0, 1], [1, 1]]), c = item(1.5, [[3, 0], [3, 2]]);
    expect(depthLevels([a, b, c])).toEqual([1, 1, 1]);
  });

  it('pieces of the same key never raise each other (the shoulders of a split road)', () => {
    const parts = [0, 1, 2, 3].map((k) => item(1.3, [[k, 0], [k + 1, 0]], 0.2));
    expect(depthLevels(parts)).toEqual([1, 1, 1, 1]);
  });

  it('overlap counts the reach of both: a near miss is no overlap, a touch within the reach is', () => {
    const a = item(1.4, [[0, 0], [2, 0]], 0.1);
    expect(depthLevels([a, item(1.5, [[0, 0.25], [2, 0.25]], 0.1)])).toEqual([1, 1]);
    expect(depthLevels([a, item(1.5, [[0, 0.15], [2, 0.15]], 0.1)])).toEqual([1, 2]);
    // past a segment's end: the distance to its end point
    expect(depthLevels([a, item(1.5, [[2.15, -1], [2.15, 1]], 0.1)])).toEqual([1, 2]);
    expect(depthLevels([a, item(1.5, [[2.25, -1], [2.25, 1]], 0.1)])).toEqual([1, 1]);
  });

  it('a level is one over the highest it overlaps, not over every lower one', () => {
    // b over a, c over b, d over a only: d needs no more than 2
    const a = item(1.0, [[0, 0], [10, 0]], 0.2);
    const b = item(1.1, [[1, -1], [1, 1]]), c = item(1.2, [[0, 0.8], [2, 0.8]]), d = item(1.3, [[8, -1], [8, 1]]);
    expect(depthLevels([a, b, c, d])).toEqual([1, 2, 3, 2]);
  });

  it('long segments find each other wherever they cross, a single point too', () => {
    const a = item(1.4, [[0, 0], [60, 60]]), b = item(1.5, [[0, 60], [60, 0]]), p = item(1.6, [[30, 30]]);
    expect(depthLevels([a, b, p])).toEqual([1, 2, 3]);
  });
});
