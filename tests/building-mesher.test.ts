import { describe, expect, it } from 'vitest';
import { RAMP } from '../src/engine/palette';
import { tileBounds, type Tile } from '../src/world/geodesy';
import {
  buildBuildingMesh,
  computeHeights,
  parseColor,
  parseLength,
  roofRamp,
  wallRamp,
} from '../src/world/building-mesher';
import type { OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function rect(w = 0.0004, h = 0.0003): [number, number][] {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
}

function build(buildings: OsmBuilding[], sample: (lon: number, lat: number) => number = () => 100) {
  return buildBuildingMesh({ tile: TILE, buildings, sampleHeight: sample });
}

function ys(m: { vertices: Float32Array; vertexCount: number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.vertexCount; i++) out.push(m.vertices[i * 6 + 1]);
  return out;
}

describe('parseLength', () => {
  it('parses meters, feet and feet-inches', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12 m')).toBe(12);
    expect(parseLength('40 ft')).toBeCloseTo(12.192, 3);
    expect(parseLength("40'")).toBeCloseTo(12.192, 3);
    expect(parseLength('12\'6"')).toBeCloseTo(12 * 0.3048 + 6 * 0.0254, 4);
    expect(parseLength('garbage')).toBeUndefined();
    expect(parseLength(undefined)).toBeUndefined();
  });
});

describe('computeHeights', () => {
  it('prefers height, then levels, then type defaults', () => {
    expect(computeHeights({ height: '20', building: 'house' })).toEqual({ min: 0, wall: 20, roof: 0 });
    expect(computeHeights({ 'building:levels': '4', building: 'house' }).wall).toBe(12);
    expect(computeHeights({ building: 'house' }).wall).toBe(6);
    expect(computeHeights({ building: 'garage' }).wall).toBe(3);
    expect(computeHeights({}).wall).toBe(9);
  });

  it('splits roof height off pitched roofs and honors min_height', () => {
    const h = computeHeights({ height: '15', 'roof:shape': 'gabled', 'roof:height': '4', min_height: '3' });
    expect(h.min).toBe(3);
    expect(h.roof).toBe(4);
    expect(h.wall).toBe(8);
    expect(computeHeights({ 'building:levels': '3', 'roof:levels': '1', 'roof:shape': 'flat' }).wall).toBe(12);
  });
});

describe('colors', () => {
  it('parses hex and CSS names and quantizes to ramps', () => {
    expect(parseColor('#ff0000')).toEqual([255, 0, 0]);
    expect(parseColor('#f00')).toEqual([255, 0, 0]);
    expect(parseColor('white')).toBeDefined();
    expect(wallRamp({ 'building:colour': '#646464' })).toBe(RAMP.CONCRETE);
    expect(wallRamp({ 'building:material': 'brick' })).toBe(RAMP.BRICK);
    expect(wallRamp({ building: 'garage' })).toBe(RAMP.CONCRETE);
    expect(roofRamp({ 'roof:material': 'metal' })).toBe(RAMP.HULL_DARK);
  });
});

describe('buildBuildingMesh', () => {
  it('emits valid interleaved geometry with no NaN', () => {
    const m = build([{ rings: [rect()], tags: { building: 'house', height: '9' } }]);
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(m.vertices.length).toBe(m.vertexCount * 6);
    for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i])).toBe(true);
  });

  it('sits the foundation on the minimum terrain under the footprint', () => {
    const b = tileBounds(TILE);
    const westLon = (b.west + b.east) / 2 - 0.0004;
    const sample = (lon: number) => 100 + (lon - westLon) * 10000;
    const m = build([{ rings: [rect()], tags: { building: 'house', height: '10' } }], sample);
    const minY = Math.min(...ys(m));
    const maxY = Math.max(...ys(m));
    expect(minY).toBeCloseTo(100, 2);
    expect(maxY).toBeCloseTo(110, 2);
  });

  it('raises elevated parts and adds a ceiling (arch)', () => {
    const m = build([{ rings: [rect()], tags: { 'building:part': 'yes', min_height: '4', height: '10' } }]);
    const minY = Math.min(...ys(m));
    expect(minY).toBeCloseTo(104, 3);
    let downFaces = 0;
    for (let i = 0; i < m.vertexCount; i++) if (m.vertices[i * 6 + 4] < -0.9) downFaces++;
    expect(downFaces).toBeGreaterThanOrEqual(3);
  });

  it('building=roof renders a canopy without ground-level walls', () => {
    const m = build([{ rings: [rect()], tags: { building: 'roof', min_height: '4', height: '5' } }]);
    const minY = Math.min(...ys(m));
    expect(minY).toBeGreaterThanOrEqual(103.9);
  });

  it.each(['flat', 'gabled', 'hipped', 'pyramidal', 'dome', 'skillion', 'half-hipped'])('roof %s rises above the walls', (shape) => {
    const m = build([{ rings: [rect()], tags: { building: 'house', height: '12', 'roof:shape': shape, 'roof:height': '3' } }]);
    const maxY = Math.max(...ys(m));
    expect(maxY).toBeGreaterThanOrEqual(110.5);
    expect(maxY).toBeLessThanOrEqual(112.01);
    expect(m.vertexCount).toBeGreaterThan(0);
  });

  it('handles multipolygon footprints with a hole', () => {
    const outer = rect();
    const b = tileBounds(TILE);
    const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    const d = 0.0001;
    const hole: [number, number][] = [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]];
    const m = build([{ rings: [outer, hole], tags: { building: 'yes', height: '8' } }]);
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i])).toBe(true);
  });
});