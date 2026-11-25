import { describe, expect, it } from 'vitest';
import { NORMAL_Q, unweld, weld } from '../src/world/weld';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh, WINDOW_ATTR_FLOATS } from '../src/world/building-mesher';

/** every attribute back from the index the same bits, a normal within 1/NORMAL_Q */
function expectSameList(vertices: Float32Array, welded: Float32Array, index: Uint32Array): void {
  const back = unweld(welded, 6, index);
  const a = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length), b = new Uint32Array(back.buffer);
  for (let v = 0; v < index.length; v++) {
    for (let i = 0; i < 3; i++) expect(b[v * 6 + i]).toBe(a[v * 6 + i]);
    for (let i = 3; i < 6; i++) expect(Math.abs(back[v * 6 + i] - vertices[v * 6 + i])).toBeLessThanOrEqual(1 / NORMAL_Q);
  }
}

describe('weld', () => {
  it('two triangles of a quad on one plane share their diagonal, though their normals differ in the last bits', () => {
    const n = [0, 1, 0], n2 = [1e-9, 1, -1e-9];
    const vertices = new Float32Array([
      0, 0, 0, ...n, 1, 0, 0, ...n, 1, 0, 1, ...n,
      0, 0, 0, ...n2, 1, 0, 1, ...n2, 0, 0, 1, ...n2,
    ]);
    const ramps = new Uint32Array([7, 7, 7, 7, 7, 7]);
    const w = weld(6, [{ data: vertices, size: 6, normal: true }, { data: ramps, size: 1 }]);
    expect(w.unique).toBe(4);
    expect(Array.from(w.index)).toEqual([0, 1, 2, 0, 2, 3]);
    expectSameList(vertices, w.streams[0] as Float32Array, w.index);
    expect(Array.from(unweld(w.streams[1] as Uint32Array, 1, w.index))).toEqual(Array.from(ramps));
  });

  it('keeps apart what differs in any other attribute: a colour, a window code, a bent normal', () => {
    const v = (x: number, nx: number) => [x, 0, 0, nx, 1, 0];
    const vertices = new Float32Array([...v(0, 0), ...v(0, 0), ...v(0, 0.01), ...v(0, 0)]);
    const ramps = new Uint32Array([1, 2, 1, 1]);
    const win = new Float32Array([0, 0, 4, 3, 5, 0, 0, 4, 3, 5, 0, 0, 4, 3, 5, 0, 0, 4, 3, 6]);
    const w = weld(4, [{ data: vertices, size: 6, normal: true }, { data: ramps, size: 1 }, { data: win, size: 5 }]);
    expect(w.unique).toBe(4);
  });

  it('passes an absent stream on, -0 and 0 apart (bits), the types kept', () => {
    const vertices = new Float32Array([0, 0, 0, 0, 1, 0, -0, 0, 0, 0, 1, 0]);
    const levels = new Float32Array(0);
    const w = weld(2, [{ data: vertices, size: 6, normal: true }, { data: levels, size: 1 }]);
    expect(w.unique).toBe(2);
    expect(w.streams[0]).toBeInstanceOf(Float32Array);
    expect(w.streams[1]).toBe(levels);
  });

  it('welds a real building mesh, every triangle as it was', () => {
    const TILE: Tile = { z: 14, x: 8800, y: 5500 };
    const b = tileBounds(TILE), cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    const ring = (dx: number): [number, number][] => [[cx + dx, cy], [cx + dx + 0.0003, cy], [cx + dx + 0.0003, cy + 0.0002], [cx + dx, cy + 0.0002], [cx + dx, cy]];
    const m = buildBuildingMesh({
      tile: TILE, sampleHeight: () => 100,
      buildings: [
        { rings: [ring(0)], tags: { building: 'apartments', 'building:levels': '5', 'building:architecture': 'neo-renaissance' } },
        { rings: [ring(0.0005)], tags: { building: 'house', 'roof:shape': 'gabled' } },
      ],
    });
    const w = weld(m.vertexCount, [{ data: m.vertices, size: 6, normal: true }, { data: m.ramps, size: 1 }, { data: m.windows, size: WINDOW_ATTR_FLOATS }]);
    expect(w.unique).toBeLessThan(m.vertexCount * 0.75);
    expectSameList(m.vertices, w.streams[0] as Float32Array, w.index);
    expect(Array.from(unweld(w.streams[1] as Uint32Array, 1, w.index))).toEqual(Array.from(m.ramps));
    expect(Array.from(unweld(w.streams[2] as Float32Array, WINDOW_ATTR_FLOATS, w.index))).toEqual(Array.from(m.windows));
  });
});
