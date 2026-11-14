import { describe, expect, it } from 'vitest';
import { clipPolyline, clipRing, clipTileData } from '../src/world/clip';
import { tileBounds, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildProps, TREE_STRIDE } from '../src/world/props-mesher';
import type { LonLat, OsmTileData } from '../src/world/osm-types';

const B = { west: 0, south: 0, east: 1, north: 1 };

describe('clipPolyline', () => {
  it('keeps inside lines as they are and cuts crossings at the border', () => {
    expect(clipPolyline([[0.2, 0.2], [0.8, 0.5]], B)).toEqual([[[0.2, 0.2], [0.8, 0.5]]]);
    expect(clipPolyline([[-1, 0.5], [0.5, 0.5], [2, 0.5]], B)).toEqual([[[0, 0.5], [0.5, 0.5], [1, 0.5]]]);
  });
  it('a line leaving and re-entering becomes two pieces; one entirely outside is dropped', () => {
    const pieces = clipPolyline([[0.5, 0.5], [0.5, 2], [0.7, 2], [0.7, 0.5]], B);
    expect(pieces).toEqual([[[0.5, 0.5], [0.5, 1]], [[0.7, 1], [0.7, 0.5]]]);
    expect(clipPolyline([[2, 2], [3, 3]], B)).toEqual([]);
  });
});

describe('clipRing', () => {
  it('cuts a polygon overhanging the box and keeps it closed', () => {
    const r = clipRing([[0.5, 0.5], [2, 0.5], [2, 0.8], [0.5, 0.8], [0.5, 0.5]], B);
    expect(r).toEqual([[0.5, 0.5], [1, 0.5], [1, 0.8], [0.5, 0.8], [0.5, 0.5]]);
    expect(clipRing([[2, 2], [3, 2], [3, 3]], B)).toEqual([]);
  });
});

describe('clipTileData', () => {
  it('buildings and points belong to the tile holding them, exactly one of two neighbours', () => {
    const a: Tile = { z: 14, x: 9516, y: 6398 };
    const b: Tile = { z: 14, x: 9517, y: 6398 };
    const edge = tileBounds(a).east;
    const lat = (tileBounds(a).north + tileBounds(a).south) / 2;
    const d = 1e-4;
    const data: OsmTileData = {
      areas: [], lines: [],
      points: [{ at: [edge, lat], tags: { aeroway: 'helipad' } }],
      buildings: [{ rings: [[[edge - d, lat], [edge + d / 2, lat], [edge + d / 2, lat + d], [edge - d, lat + d]]], tags: { building: 'yes' } }],
    };
    const ca = clipTileData(data, a), cb = clipTileData(data, b);
    expect(ca.points.length + cb.points.length).toBe(1);
    expect(ca.buildings).toHaveLength(1);
    expect(cb.buildings).toHaveLength(0);
  });
});

describe('drape stays on its own tile', () => {
  // a road running across three tiles, sampled by a drape that only knows the middle one
  const tile: Tile = { z: 14, x: 9516, y: 6398 };
  const tb = tileBounds(tile);
  const lat = (tb.north + tb.south) / 2;
  const w = tb.east - tb.west;
  const road: LonLat[] = [[tb.west - w, lat], [tb.east + w, lat + (tb.north - tb.south) * 0.2]];
  const forest: LonLat[] = [[tb.west - w, tb.south], [tb.east + w, tb.south], [tb.east + w, tb.north], [tb.west - w, tb.north], [tb.west - w, tb.south]];
  const data: OsmTileData = {
    lines: [{ points: road, tags: { highway: 'trunk' } }, { points: road, tags: { aeroway: 'runway' } }],
    areas: [{ rings: [forest], tags: { landuse: 'forest' } }],
    points: [], buildings: [],
  };
  const sampleHeight = () => 100;
  const half = tileSizeMeters(tile) / 2;

  it('mesh vertices stay inside the tile (plus half a road width)', () => {
    const mesh = buildOsmMesh({ tile, detail: 'full', data, sampleHeight });
    expect(mesh.vertexCount).toBeGreaterThan(0);
    let maxX = 0, maxZ = 0;
    for (let i = 0; i < mesh.vertices.length; i += 6) {
      maxX = Math.max(maxX, Math.abs(mesh.vertices[i]));
      maxZ = Math.max(maxZ, Math.abs(mesh.vertices[i + 2]));
    }
    expect(maxX).toBeLessThan(half * 1.02 + 30);
    expect(maxZ).toBeLessThan(half * 1.02 + 30);
  });

  it('trees and runway lights stay inside the tile', () => {
    const props = buildProps({ tile, detail: 'full', data, sampleHeight });
    expect(props.trees.length).toBeGreaterThan(0);
    expect(props.lights.length).toBeGreaterThan(0);
    for (let i = 0; i < props.trees.length; i += TREE_STRIDE) expect(Math.abs(props.trees[i])).toBeLessThan(half * 1.02);
    for (let i = 0; i < props.lights.length; i += 4) expect(Math.abs(props.lights[i])).toBeLessThan(half * 1.02);
  });
});
