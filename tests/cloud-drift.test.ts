import { mat4 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';
import { CloudField } from '../src/world/cloud-field';
import { cloudLayers } from '../src/world/clouds';

/** a WebGL2 context that only hands out dummy objects: the field builds tiles without a GPU */
const fakeGl = new Proxy({}, { get: () => () => ({}) }) as unknown as WebGL2RenderingContext;

describe('clouds drift with the wind', () => {
  it('every tile moves by wind × time at its height', () => {
    const at = { lat: 47.26, lon: 11.34 };
    const field = new CloudField(fakeGl, at);
    field.setLayers(cloudLayers({ cloudPct: 50, cloudLowPct: 50, tempC: 10, dewPointC: 2, elevation: 600 }));
    const view = mat4.lookAt(mat4.create(), [0, 2000, 0], [0, 2000, -1], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), 1, 1, 1, 1e6);
    for (let i = 0; i < 200; i++) field.update(at, at, view, proj);
    const tiles = (field as unknown as { tiles: Map<string, { offset: Float32Array }> }).tiles;
    const before = new Map([...tiles].map(([k, t]) => [k, [t.offset[0], t.offset[2]]]));
    expect(before.size).toBeGreaterThan(0);
    field.advance(60, () => [10, -5]); // 10 m/s east, 5 m/s south for a minute
    field.update(at, at, view, proj);
    for (const [k, [x, z]] of before) {
      const t = tiles.get(k);
      if (!t) continue;
      expect(t.offset[0] - x).toBeCloseTo(600, 0); // east
      expect(t.offset[2] - z).toBeCloseTo(300, 0); // world z points south
    }
  });
});
