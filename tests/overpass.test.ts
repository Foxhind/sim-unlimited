import { describe, expect, it } from 'vitest';
import { tileBounds } from '../src/world/geodesy';
import { overpassQuery, parseOverpass, type OverpassJson } from '../src/world/overpass';

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
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'church', height: '20' } },
        { type: 'way', id: 11, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'yes', height: '30' } },
        { type: 'way', id: 12, nodes: [5, 2, 3, 6, 5], tags: { 'building:part': 'yes', height: '15' } },
        // a building elsewhere keeps its outline
        { type: 'way', id: 13, nodes: [20, 21, 22, 20], tags: { building: 'yes' } },
      ],
    });
    expect(d.buildings.map((b) => b.tags.height ?? b.tags.building).sort()).toEqual(['15', '30', 'yes']);
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