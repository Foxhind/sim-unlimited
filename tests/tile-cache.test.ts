import { describe, expect, it } from 'vitest';
import { meshBytes, pickEvictions } from '../src/world/tile-cache';

const entries = [
  { key: 'a', ts: 300, bytes: 400 },
  { key: 'b', ts: 100, bytes: 400 },
  { key: 'c', ts: 200, bytes: 400 },
];

describe('pickEvictions', () => {
  it('keeps everything under quota', () => {
    expect(pickEvictions(entries, 10, 10000)).toEqual([]);
  });
  it('evicts oldest first for entry quota', () => {
    expect(pickEvictions(entries, 2, 10000)).toEqual(['b']);
    expect(pickEvictions(entries, 1, 10000)).toEqual(['b', 'c']);
  });
  it('evicts oldest first for byte quota', () => {
    expect(pickEvictions(entries, 10, 800)).toEqual(['b']);
    expect(pickEvictions(entries, 10, 400)).toEqual(['b', 'c']);
  });
  it('handles empty cache', () => {
    expect(pickEvictions([], 0, 0)).toEqual([]);
  });
});
describe('meshBytes', () => {
  it('counts the mesh buffers; a stale glow ground of an old record is not one of them', () => {
    const buf = (n: number) => new ArrayBuffer(n);
    const old = { vertices: buf(8), ramps: buf(4), rVertices: buf(16), glowVertices: buf(100), glowRamps: buf(50) };
    expect(meshBytes(old)).toBe(28);
  });
});
