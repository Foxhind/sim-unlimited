import { describe, expect, it } from 'vitest';
import { tileBounds } from '../src/world/geodesy';
import { overpassQuery, parseOverpass, REACH_SELECTORS, ROAD_REACH_M, roadReachBounds, type OverpassJson } from '../src/world/overpass';
import { LIFT_REACH_M } from '../src/world/road-levels';
import { roofRamp, styleSeed, wallRamp } from '../src/world/building-mesher';
import { STYLE_AT_TAG, STYLE_TYPE_TAG } from '../src/world/osm-types';

const TILE = { z: 14, x: 8800, y: 5500 };

function json(): OverpassJson {
  return {
    elements: [
      { type: 'node', id: 1, lat: 47.0, lon: 11.0 },
      { type: 'node', id: 2, lat: 47.0, lon: 11.01 },
      { type: 'node', id: 3, lat: 47.01, lon: 11.01 },
      { type: 'node', id: 4, lat: 47.01, lon: 11.0 },
      { type: 'node', id: 5, lat: 47.005, lon: 11.005 },
      { type: 'node', id: 6, lat: 47.2, lon: 11.2 },
      { type: 'node', id: 7, lat: 47.21, lon: 11.21 },
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { natural: 'wood' } },
      { type: 'way', id: 11, nodes: [6, 7], tags: { highway: 'primary' } },
      { type: 'way', id: 12, nodes: [1, 2], tags: { natural: 'water' } },
      { type: 'way', id: 13, nodes: [2, 3], tags: { natural: 'water' } },
      { type: 'way', id: 14, nodes: [3, 4], tags: { natural: 'water' } },
      { type: 'way', id: 15, nodes: [4, 1], tags: { natural: 'water' } },
      { type: 'way', id: 16, nodes: [5, 5, 5, 5], tags: { natural: 'water' } },
      {
        type: 'relation',
        id: 20,
        members: [
          { type: 'way', ref: 12, role: 'outer' },
          { type: 'way', ref: 13, role: 'outer' },
          { type: 'way', ref: 14, role: 'outer' },
          { type: 'way', ref: 15, role: 'outer' },
          { type: 'way', ref: 16, role: 'inner' },
        ],
        tags: { type: 'multipolygon', natural: 'water' },
      },
      { type: 'node', id: 8, lat: 47.3, lon: 11.3, tags: { aeroway: 'helipad' } },
    ],
  };
}

describe('overpassQuery', () => {
  it('embeds the tile bbox and detail-dependent filters', () => {
    const b = tileBounds(TILE);
    const full = overpassQuery(TILE, 'full');
    const large = overpassQuery(TILE, 'large');
    expect(full).toContain(`[bbox:${b.south},${b.west},${b.north},${b.east}]`);
    expect(full).toContain('way["building"]');
    expect(full).toContain('highway');
    expect(large).toContain('motorway|trunk');
    expect(large).not.toContain('tertiary');
  });

  it('fetches orchards and vineyards near (their trees and filters), not far', () => {
    expect(overpassQuery(TILE, 'full')).toContain('way["landuse"~"^(orchard|vineyard)$"]; relation["landuse"~"^(orchard|vineyard)$"];');
    expect(overpassQuery(TILE, 'large')).not.toContain('orchard');
  });

  it('fetches the land zones near, ways and multipolygons; a town’s and its quarries far too', () => {
    const full = overpassQuery(TILE, 'full'), large = overpassQuery(TILE, 'large');
    for (const v of ['residential', 'commercial', 'retail', 'industrial', 'cemetery', 'quarry', 'landfill', 'construction', 'brownfield', 'grass', 'meadow']) {
      expect(full).toMatch(new RegExp(`way\\["landuse"~"[^"]*\\b${v}\\b`));
      expect(full).toMatch(new RegExp(`relation\\["landuse"~"[^"]*\\b${v}\\b`));
    }
    expect(full).toContain('way["natural"~"^(grassland|heath)$"]');
    expect(full).toContain('way["amenity"="grave_yard"]');
    for (const v of ['residential', 'industrial', 'quarry']) expect(large).toMatch(new RegExp(`way\\["landuse"~"[^"]*\\b${v}\\b`));
    expect(large).not.toContain('cemetery');
    expect(large).not.toContain('meadow');
  });

  it('a closed grave yard is an area', () => {
    const d = parseOverpass({ elements: [
      ...[[0, 0], [0, 1e-3], [1e-3, 1e-3], [1e-3, 0]].map(([lat, lon], i) => ({ type: 'node' as const, id: i + 1, lat, lon })),
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { amenity: 'grave_yard' } },
    ] });
    expect(d.areas.map((a) => a.tags.amenity)).toEqual(['grave_yard']);
  });
});

describe('what a near tile sees round itself', () => {
  it('reaches as far as a lift does (road-levels.ts)', () => {
    expect(ROAD_REACH_M).toBeGreaterThanOrEqual(LIFT_REACH_M);
    const b = tileBounds(TILE), r = roadReachBounds(b);
    expect((r.north - b.north) * 111320).toBeCloseTo(ROAD_REACH_M, 0);
    expect((b.south - r.south) * 111320).toBeCloseTo(ROAD_REACH_M, 0);
  });

  it('roads, railways, waterways, water and summits in the grown bbox; only the summits for the far tiles', () => {
    const r = roadReachBounds(tileBounds(TILE));
    const box = `(${r.south},${r.west},${r.north},${r.east})`;
    const full = overpassQuery(TILE, 'full');
    expect(REACH_SELECTORS.some((s) => s.includes('"railway"'))).toBe(true);
    expect(REACH_SELECTORS.some((s) => s.includes('"waterway"'))).toBe(true);
    expect(REACH_SELECTORS.some((s) => s.includes('"natural"="water"'))).toBe(true);
    for (const s of REACH_SELECTORS) expect(full, s).toContain(`${s}${box};`);
    expect(REACH_SELECTORS).toContain('node["natural"="peak"]');
    const large = overpassQuery(TILE, 'large');
    expect(large).toContain(`node["natural"="peak"]${box};`);
    expect(large.split(box)).toHaveLength(2);
  });
});

describe('parseOverpass', () => {
  it('extracts closed area ways, open lines and tagged points', () => {
    const d = parseOverpass(json());
    const wood = d.areas.find((a) => a.tags.natural === 'wood');
    expect(wood?.rings).toHaveLength(1);
    expect(wood?.rings[0]).toHaveLength(5);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].points).toHaveLength(2);
    expect(d.points).toHaveLength(1);
    expect(d.points[0].tags.aeroway).toBe('helipad');
  });

  it('turns a mast mapped as a footprint way into a point at its vertex mean', () => {
    const d = parseOverpass({
      elements: [
        { type: 'node', id: 1, lat: 55.79280, lon: 37.89165 },
        { type: 'node', id: 2, lat: 55.79283, lon: 37.89170 },
        { type: 'node', id: 3, lat: 55.79283, lon: 37.89165 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 1], tags: { man_made: 'mast', height: '442' } },
        { type: 'way', id: 11, nodes: [1, 2, 3, 1], tags: { man_made: 'mast', building: 'yes' } },
      ],
    });
    expect(d.points).toHaveLength(1);
    expect(d.points[0].tags.height).toBe('442');
    expect(d.points[0].at[0]).toBeCloseTo((37.89165 + 37.8917 + 37.89165) / 3, 8);
    expect(d.points[0].at[1]).toBeCloseTo((55.7928 + 55.79283 * 2) / 3, 8);
    expect(d.areas).toHaveLength(0);
    expect(d.buildings).toHaveLength(1);
  });

  it('assembles multipolygon outer segments and attaches inner holes', () => {
    const d = parseOverpass(json());
    const water = d.areas.filter((a) => a.tags.natural === 'water');
    expect(water).toHaveLength(1);
    expect(water[0].rings).toHaveLength(2);
    expect(water[0].rings[0].length).toBeGreaterThanOrEqual(5);
    expect(water[0].rings[1]).toHaveLength(4);
  });

  it('keeps closed highway loops as lines', () => {
    const d = parseOverpass({
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 0, lon: 1 },
        { type: 'node', id: 3, lat: 1, lon: 1 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 1], tags: { highway: 'residential', junction: 'roundabout' } },
      ],
    });
    expect(d.areas).toHaveLength(0);
    expect(d.lines).toHaveLength(1);
  });

  it('routes open runway/taxiway ways to lines and closed aprons to areas', () => {
    const d = parseOverpass({
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 0, lon: 1 },
        { type: 'node', id: 3, lat: 1, lon: 1 },
        { type: 'node', id: 4, lat: 1, lon: 0 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { aeroway: 'runway', width: '45' } },
        { type: 'way', id: 11, nodes: [2, 3], tags: { aeroway: 'taxiway' } },
        { type: 'way', id: 12, nodes: [1, 2, 3, 4, 1], tags: { aeroway: 'apron' } },
      ],
    });
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0].tags.aeroway).toBe('runway');
    expect(d.lines[1].tags.aeroway).toBe('taxiway');
    expect(d.areas).toHaveLength(1);
    expect(d.areas[0].tags.aeroway).toBe('apron');
  });
});

describe('parseOverpass buildings', () => {
  const square = [
    { type: 'node', id: 1, lat: 0, lon: 0 },
    { type: 'node', id: 2, lat: 0, lon: 1 },
    { type: 'node', id: 3, lat: 1, lon: 1 },
    { type: 'node', id: 4, lat: 1, lon: 0 },
  ] as OverpassJson['elements'];

  it('routes closed building ways to buildings, not areas', () => {
    const d = parseOverpass({
      elements: [...square, { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'house', height: '8' } }],
    });
    expect(d.buildings).toHaveLength(1);
    expect(d.buildings[0].tags.height).toBe('8');
    expect(d.areas).toHaveLength(0);
  });

  it('type=building relation draws parts instead of the outline', () => {
    const d = parseOverpass({
      elements: [
        ...square,
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes' } },
        { type: 'way', id: 11, nodes: [1, 2, 3, 1], tags: { 'building:part': 'yes', height: '12' } },
        {
          type: 'relation', id: 20,
          members: [
            { type: 'way', ref: 10, role: 'outline' },
            { type: 'way', ref: 11, role: 'part' },
          ],
          tags: { type: 'building' },
        },
      ],
    });
    expect(d.buildings).toHaveLength(1);
    expect(d.buildings[0].tags['building:part']).toBe('yes');
  });

  it('hides an outline whose parts lie inside it, without a relation (S3DB)', () => {
    const d = parseOverpass({
      elements: [
        ...square,
        { type: 'node', id: 5, lat: 0, lon: 0.5 },
        { type: 'node', id: 6, lat: 1, lon: 0.5 },
        { type: 'node', id: 20, lat: 2, lon: 2 },
        { type: 'node', id: 21, lat: 2, lon: 3 },
        { type: 'node', id: 22, lat: 3, lon: 3 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', height: '20' } },
        { type: 'way', id: 11, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'yes', height: '30' } },
        { type: 'way', id: 12, nodes: [5, 2, 3, 6, 5], tags: { 'building:part': 'yes', height: '15' } },
        // a building elsewhere keeps its outline
        { type: 'way', id: 13, nodes: [20, 21, 22, 20], tags: { building: 'yes' } },
      ],
    });
    expect(d.buildings.map((b) => b.tags.height ?? b.tags.building).sort()).toEqual(['15', '30', 'yes']);
  });

  describe('the parts of one building share its style', () => {
    const parts = (outline: Record<string, string>, a: Record<string, string>, b: Record<string, string>) => parseOverpass({
      elements: [
        ...square,
        { type: 'node', id: 5, lat: 0, lon: 0.5 },
        { type: 'node', id: 6, lat: 1, lon: 0.5 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'apartments', ...outline } },
        { type: 'way', id: 11, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'yes', ...a } },
        { type: 'way', id: 12, nodes: [5, 2, 3, 6, 5], tags: { 'building:part': 'yes', ...b } },
      ],
    }).buildings;

    it('untagged parts take the outline colours and materials, one seed vertex and one palette type', () => {
      const [p, q] = parts({ 'building:colour': '#d8c8a8', 'roof:material': 'metal' }, {}, {});
      for (const t of [p.tags, q.tags]) {
        expect(t['building:colour']).toBe('#d8c8a8');
        expect(t['roof:material']).toBe('metal');
        expect(t[STYLE_TYPE_TAG]).toBe('apartments');
      }
      expect(p.tags[STYLE_AT_TAG]).toBe('0,0');
      expect(q.tags[STYLE_AT_TAG]).toBe(p.tags[STYLE_AT_TAG]);
    });

    it("a part's own tag of a family wins over the whole family of the outline", () => {
      const [p, q] = parts({ 'building:colour': 'beige', 'roof:colour': 'grey' }, { 'building:material': 'brick' }, { 'roof:color': 'red' });
      expect(p.tags['building:colour']).toBeUndefined();
      expect(p.tags['roof:colour']).toBe('grey');
      expect(q.tags['building:colour']).toBe('beige');
      expect(q.tags['roof:colour']).toBeUndefined();
    });

    it('parts of a type=building relation share the outline way tags; loose parts sharing a vertex one seed', () => {
      const d = parseOverpass({
        elements: [
          ...square,
          { type: 'node', id: 5, lat: 0, lon: 0.5 },
          { type: 'node', id: 6, lat: 1, lon: 0.5 },
          { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', 'building:colour': 'white' } },
          { type: 'way', id: 11, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'retail' } },
          { type: 'way', id: 12, nodes: [5, 2, 3, 6, 5], tags: { 'building:part': 'yes' } },
          { type: 'relation', id: 20, members: [{ type: 'way', ref: 10, role: 'outline' }, { type: 'way', ref: 11, role: 'part' }, { type: 'way', ref: 12, role: 'part' }], tags: { type: 'building' } },
        ],
      });
      expect(d.buildings).toHaveLength(2);
      for (const b of d.buildings) {
        expect(b.tags['building:colour']).toBe('white');
        expect(b.tags[STYLE_TYPE_TAG]).toBe('retail');
        expect(b.tags[STYLE_AT_TAG]).toBe('0,0');
      }
      const loose = parseOverpass({
        elements: [
          ...square,
          { type: 'node', id: 5, lat: 0, lon: 0.5 },
          { type: 'node', id: 6, lat: 1, lon: 0.5 },
          { type: 'way', id: 11, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'yes' } },
          { type: 'way', id: 12, nodes: [5, 2, 3, 6, 5], tags: { 'building:part': 'yes' } },
        ],
      }).buildings;
      expect(loose[0].tags[STYLE_AT_TAG]).toBe(loose[1].tags[STYLE_AT_TAG]);
      // two outlines sharing a wall: their parts stay two buildings
      const block = parseOverpass({
        elements: [
          ...square,
          { type: 'node', id: 5, lat: 0, lon: 0.5 },
          { type: 'node', id: 6, lat: 1, lon: 0.5 },
          { type: 'way', id: 10, nodes: [1, 5, 6, 4, 1], tags: { building: 'yes' } },
          { type: 'way', id: 13, nodes: [5, 2, 3, 6, 5], tags: { building: 'yes' } },
          { type: 'way', id: 11, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'yes' } },
          { type: 'way', id: 12, nodes: [5, 2, 3, 6, 5], tags: { 'building:part': 'yes' } },
        ],
      }).buildings;
      expect(block).toHaveLength(2);
      expect(block[0].tags[STYLE_AT_TAG]).not.toBe(block[1].tags[STYLE_AT_TAG]);
    });

    it('the mesher draws such parts in one wall and roof colour', () => {
      const [p, q] = parts({}, { height: '60' }, { height: '20' });
      expect(wallRamp(p.tags, styleSeed(p))).toBe(wallRamp(q.tags, styleSeed(q)));
      expect(roofRamp(p.tags, styleSeed(p))).toBe(roofRamp(q.tags, styleSeed(q)));
    });
  });

  it('type=building relation: multipolygon parts hide the outline; without parts the outline way keeps its tags', () => {
    const withRelPart = parseOverpass({
      elements: [
        ...square,
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes' } },
        { type: 'way', id: 11, nodes: [1, 2, 3, 1] },
        { type: 'relation', id: 30, members: [{ type: 'way', ref: 11, role: 'outer' }], tags: { type: 'multipolygon', 'building:part': 'yes', height: '9' } },
        { type: 'relation', id: 31, members: [{ type: 'way', ref: 10, role: 'outline' }, { type: 'relation', ref: 30, role: 'part' }], tags: { type: 'building' } },
      ],
    });
    expect(withRelPart.buildings).toHaveLength(1);
    expect(withRelPart.buildings[0].tags.height).toBe('9');
    const outlineOnly = parseOverpass({
      elements: [
        ...square,
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', height: '22', 'roof:shape': 'hipped' } },
        { type: 'relation', id: 31, members: [{ type: 'way', ref: 10, role: 'outline' }], tags: { type: 'building', name: 'X' } },
      ],
    });
    expect(outlineOnly.buildings).toHaveLength(1);
    expect(outlineOnly.buildings[0].tags).toMatchObject({ height: '22', 'roof:shape': 'hipped', name: 'X' });
    expect(outlineOnly.buildings[0].tags.type).toBeUndefined();
  });

  it('skips underground and negative-layer buildings', () => {
    const d = parseOverpass({
      elements: [
        ...square,
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', location: 'underground' } },
        { type: 'way', id: 11, nodes: [1, 2, 3, 1], tags: { building: 'yes', layer: '-1' } },
      ],
    });
    expect(d.buildings).toHaveLength(0);
  });

  it('parses building multipolygons with holes', () => {
    const d = parseOverpass({
      elements: [
        ...square,
        { type: 'node', id: 5, lat: 0.5, lon: 0.5 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: {} },
        { type: 'way', id: 11, nodes: [5, 5, 5, 5], tags: {} },
        {
          type: 'relation', id: 20,
          members: [
            { type: 'way', ref: 10, role: 'outer' },
            { type: 'way', ref: 11, role: 'inner' },
          ],
          tags: { type: 'multipolygon', building: 'yes' },
        },
      ],
    });
    expect(d.buildings).toHaveLength(1);
    expect(d.buildings[0].rings).toHaveLength(2);
    expect(d.areas).toHaveLength(0);
  });
});