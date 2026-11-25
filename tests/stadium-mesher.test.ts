import { describe, expect, it } from 'vitest';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildStadiums, STADIUM } from '../src/world/stadium-mesher';
import type { LonLat, OsmArea } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 9518, y: 6401 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const flat = () => 15;

/** a stadium 160 m east–west by 100 m: its long sides north and south */
const ring = (w: number, h: number): LonLat[] => [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2), at(-w / 2, -h / 2)];
const stadium = (w = 160, h = 100, tags: Record<string, string> = { leisure: 'stadium' }): OsmArea => ({ rings: [ring(w, h)], tags });

function col(v: Float32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += 6) out.push(v[i]);
  return out;
}

describe('buildStadiums', () => {
  it('stands along its long sides only, each a wedge rising from the pitch to the outline', () => {
    const m = buildStadiums(TILE, [stadium()], flat);
    expect(m.ramps.length).toBeGreaterThan(0);
    const x = col(m.vertices, 0), y = col(m.vertices, 1), z = col(m.vertices, 2);
    const depth = Math.min(STADIUM.DEPTH_M[1], Math.max(STADIUM.DEPTH_M[0], STADIUM.DEPTH_SHARE * Math.sqrt(160 * 100)));
    // its top: the depth's rise over the ground, at the outline (|z| = 50, z south)
    expect(Math.max(...y)).toBeCloseTo(15 + depth * STADIUM.RAKE, 1);
    const top = y.map((v, i) => [v, i] as const).filter(([v]) => v > Math.max(...y) - 1e-3).map(([, i]) => i);
    for (const i of top) expect(Math.abs(Math.abs(z[i]) - 50)).toBeLessThan(0.5);
    // nothing on the short sides (|x| = 80) but the stands' own ends, kept back from the corners
    expect(Math.max(...x.map(Math.abs))).toBeLessThan(80 - depth + 0.5);
    // the seating's inner edge at the ground, the stand's depth in from the outline
    expect(Math.min(...z.map(Math.abs))).toBeCloseTo(50 - depth, 0);
  });

  it('every face’s normal agrees with its winding; the seating faces up and towards the pitch', () => {
    const v = buildStadiums(TILE, [stadium()], flat).vertices;
    for (let t = 0; t < v.length; t += 18) {
      const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
      expect(n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5]).toBeGreaterThan(0);
    }
  });

  it('a small ground’s stands STADIUM.DEPTH_M[0] deep; none for a stadium on a roof, nor for a pitch', () => {
    const small = buildStadiums(TILE, [stadium(30, 20)], flat);
    expect(Math.max(...col(small.vertices, 1))).toBeCloseTo(15 + STADIUM.DEPTH_M[0] * STADIUM.RAKE, 3);
    expect(buildStadiums(TILE, [stadium(160, 100, { leisure: 'stadium', location: 'roof' })], flat).ramps.length).toBe(0);
    expect(buildStadiums(TILE, [stadium(160, 100, { leisure: 'pitch' })], flat).ramps.length).toBe(0);
  });

  it('drawn by the tile holding its centre only', () => {
    expect(buildStadiums({ ...TILE, x: TILE.x + 1 }, [stadium()], flat).ramps.length).toBe(0);
  });

  it('across a tile border, handed whole to both tiles (our tiles: SimProfile GROUND_BUFFER_PX), its two stands once', () => {
    // centred 30 m north of the tile's south edge: the outline reaches 20 m into the tile below
    const b = { south: c.lat - 0.5 * (tileCenter(TILE).lat - tileCenter({ ...TILE, y: TILE.y + 1 }).lat) };
    const dy = (b.south - c.lat) * KY + 30;
    const whole: OsmArea = { rings: [ring(160, 100).map(([lon, lat]) => [lon, lat + dy / KY] as LonLat)], tags: { leisure: 'stadium' } };
    const here = buildStadiums(TILE, [whole], flat), below = buildStadiums({ ...TILE, y: TILE.y + 1 }, [whole], flat);
    expect(below.ramps.length).toBe(0);
    // seating, wall, two ends: 4 quads of 2 triangles a stand
    expect(here.ramps.length / 3).toBe(2 * 4 * 2);
  });
});
