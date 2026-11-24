import { describe, expect, it } from 'vitest';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildDams, DAM, damKind } from '../src/world/dam-mesher';
import type { LonLat, OsmLine } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9518, y: 6396 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
/** a valley along the north–south axis: 40 m at its floor (x = 0), rising 0.5 m per metre either side */
const valley = (lon: number) => 40 + Math.abs((lon - c.lon) * KX) * 0.5;

function col(v: Float32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += 6) out.push(v[i]);
  return out;
}

describe('buildDams', () => {
  it('a dam across a valley: its crest level, OVER_M over the highest ground under it, its faces down to the valley floor', () => {
    // 64 m across: a station every 4 m, one on the valley floor
    const dam: OsmLine = { tags: { waterway: 'dam' }, points: [at(-32, 0), at(32, 0)] };
    const m = buildDams(TILE, [dam], valley);
    const y = col(m.vertices, 1), z = col(m.vertices, 2);
    // the abutments 16 m over the floor: the crest OVER_M over them
    expect(Math.max(...y)).toBeCloseTo(40 + 16 + DAM.dam.OVER_M, 1);
    expect(Math.min(...y)).toBeCloseTo(40 - DAM.SINK_M, 1);
    // over the floor its faces reach out SLOPE × its height either side of the crest
    expect(Math.max(...z)).toBeCloseTo(DAM.dam.CREST_M / 2 + DAM.dam.SLOPE * (16 + DAM.dam.OVER_M), 0);
    // every face's normal agrees with its winding
    const v = m.vertices;
    for (let t = 0; t < v.length; t += 18) {
      const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
      expect(n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5]).toBeGreaterThan(0);
    }
  });

  it('a weir: a low sill on the ground under it, upright', () => {
    const weir: OsmLine = { tags: { waterway: 'weir' }, points: [at(-5, 0), at(5, 0)] };
    const m = buildDams(TILE, [weir], () => 12);
    const y = col(m.vertices, 1), z = col(m.vertices, 2);
    expect(Math.max(...y)).toBeCloseTo(12 + DAM.weir.OVER_M, 4);
    expect(Math.max(...z.map(Math.abs))).toBeCloseTo(DAM.weir.CREST_M / 2, 4);
  });

  it('only dams and weirs, only the tile holding a piece’s middle', () => {
    expect(damKind({ waterway: 'river' })).toBeUndefined();
    const dam: OsmLine = { tags: { waterway: 'dam' }, points: [at(-32, 0), at(32, 0)] };
    expect(buildDams({ ...TILE, x: TILE.x + 1 }, [dam], valley).ramps.length).toBe(0);
  });
});

describe('fetching the dams', () => {
  it('dams and weirs near, as lines', () => {
    expect(overpassQuery(TILE, 'full')).toContain('way["waterway"~"^(dam|weir)$"];');
    const d = parseOverpass({ elements: [
      { type: 'node', id: 1, lat: 0, lon: 0 }, { type: 'node', id: 2, lat: 0, lon: 0.001 },
      { type: 'way', id: 10, nodes: [1, 2], tags: { waterway: 'dam' } },
    ] });
    expect(d.lines.map((l) => l.tags.waterway)).toEqual(['dam']);
  });
});
