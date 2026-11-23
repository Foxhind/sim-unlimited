import { describe, expect, it } from 'vitest';
import { colourOf } from '../src/engine/palette';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildPiers, MOUND, PIER, pierWidth } from '../src/world/pier-mesher';
import type { LonLat } from '../src/world/osm-types';
import { overpassQuery, parseOverpass, REACH_SELECTORS } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9517, y: 6397 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const sea = () => -3;

function ys(v: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < v.length; i += 6) out.push(v[i]);
  return out;
}
function xs(v: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 6) out.push(v[i]);
  return out;
}
function zs(v: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 2; i < v.length; i += 6) out.push(v[i]);
  return out;
}

describe('pierWidth', () => {
  it('the width tag, else a pontoon, a breakwater or a groyne', () => {
    expect(pierWidth({ man_made: 'pier', width: '4' })).toBe(4);
    expect(pierWidth({ man_made: 'pier' })).toBe(PIER.WIDTH_M);
    expect(pierWidth({ man_made: 'breakwater' })).toBe(MOUND.WIDTH_M.breakwater);
    expect(pierWidth({ man_made: 'groyne', width: 'wide' })).toBe(MOUND.WIDTH_M.groyne);
  });
});

describe('buildPiers', () => {
  it('a pontoon over the sea: a deck DECK_M over the water, as wide as tagged, sides under the water', () => {
    const m = buildPiers(TILE, [{ points: [at(-40, 0), at(40, 0)], tags: { man_made: 'pier', width: '3' } }], [], sea);
    expect(m.ramps.length).toBeGreaterThan(0);
    expect(m.vertices.length).toBe(m.ramps.length * 6);
    expect(Math.max(...ys(m.vertices))).toBeCloseTo(PIER.DECK_M, 5);
    expect(Math.min(...ys(m.vertices))).toBeCloseTo(-3 - PIER.SINK_M, 5);
    // across the line (north in the world: −z here) half the width each way
    expect(Math.max(...zs(m.vertices))).toBeCloseTo(1.5, 2);
    expect(Math.min(...zs(m.vertices))).toBeCloseTo(-1.5, 2);
    expect(Math.min(...xs(m.vertices))).toBeCloseTo(-40, 1);
    for (const r of m.ramps) expect(r).toBe(colourOf(PIER.CONCRETE));
  });

  it('every face has a unit normal, the deck facing up', () => {
    const m = buildPiers(TILE, [{ points: [at(-40, 0), at(0, 10), at(40, 0)], tags: { man_made: 'pier' } }], [], sea);
    let up = 0;
    for (let i = 0; i < m.vertices.length; i += 6) {
      expect(Math.hypot(m.vertices[i + 3], m.vertices[i + 4], m.vertices[i + 5])).toBeCloseTo(1, 5);
      if (m.vertices[i + 4] > 0.99) {
        expect(m.vertices[i + 1]).toBeCloseTo(PIER.DECK_M, 5);
        up++;
      }
    }
    expect(up).toBeGreaterThan(0);
  });

  it('ashore the deck lies a hair over the ground', () => {
    const m = buildPiers(TILE, [{ points: [at(-40, 0), at(40, 0)], tags: { man_made: 'pier' } }], [], () => 5);
    expect(Math.max(...ys(m.vertices))).toBeCloseTo(5 + PIER.ASHORE_M, 5);
  });

  it('a breakwater is a rock mound: crest CREST_M up, flanks out to its full width', () => {
    const m = buildPiers(TILE, [{ points: [at(-40, 0), at(40, 0)], tags: { man_made: 'breakwater' } }], [], sea);
    expect(Math.max(...ys(m.vertices))).toBeCloseTo(MOUND.CREST_M.breakwater, 5);
    expect(Math.max(...zs(m.vertices))).toBeCloseTo(MOUND.WIDTH_M.breakwater / 2, 2);
    for (const r of m.ramps) expect(r).toBe(colourOf(MOUND.ROCK));
  });

  it('a pier mapped as an area: one deck over it, walls round it; wood when tagged so', () => {
    const ring = [at(-10, -5), at(10, -5), at(10, 5), at(-10, 5), at(-10, -5)];
    const m = buildPiers(TILE, [], [{ rings: [ring], tags: { man_made: 'pier', surface: 'wood' } }], sea);
    expect(Math.max(...ys(m.vertices))).toBeCloseTo(PIER.DECK_M, 5);
    for (const r of m.ramps) expect(r).toBe(colourOf(PIER.WOOD));
    // 2 deck triangles and 4 walls of 2
    expect(m.ramps.length).toBe((2 + 8) * 3);
  });

  it('from OSM: an open pier is a line, a closed one an area, a marina node a point', () => {
    const n = (id: number, x: number, y: number, tags?: Record<string, string>) => ({ type: 'node' as const, id, lon: at(x, y)[0], lat: at(x, y)[1], ...(tags ? { tags } : {}) });
    const d = parseOverpass({
      elements: [
        n(1, 0, 0), n(2, 50, 0), n(3, 50, 20), n(4, 0, 20), n(5, 10, 40, { leisure: 'marina' }),
        { type: 'way', id: 10, nodes: [1, 2], tags: { man_made: 'pier' } },
        { type: 'way', id: 11, nodes: [1, 2, 3, 4, 1], tags: { man_made: 'pier' } },
        { type: 'way', id: 12, nodes: [3, 4], tags: { man_made: 'breakwater' } },
      ],
    });
    expect(d.lines.map((l) => l.tags.man_made).sort()).toEqual(['breakwater', 'pier']);
    expect(d.areas.filter((a) => a.tags.man_made === 'pier').length).toBe(1);
    expect(d.points.some((p) => p.tags.leisure === 'marina')).toBe(true);
    const q = overpassQuery(TILE, 'full');
    expect(q).toContain('way["man_made"~"^(pier|breakwater|groyne)$"];');
    expect(q).toContain('node["leisure"="marina"];');
    expect(REACH_SELECTORS).toContain('way["man_made"="pier"]');
  });

  it('nothing else', () => {
    expect(buildPiers(TILE, [{ points: [at(0, 0), at(10, 0)], tags: { highway: 'footway' } }], [], sea).ramps.length).toBe(0);
  });
});
