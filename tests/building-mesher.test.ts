import { describe, expect, it } from 'vitest';
import { colour, isMaterial, rgbOf, SNOW_FLAG } from '../src/engine/palette';
import { tileBounds, type Tile } from '../src/world/geodesy';
import {
  buildBuildingMesh,
  buildingSeed,
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
    expect(parseLength('3,7')).toBeCloseTo(3.7, 6);
    expect(parseLength('3,7 m')).toBeCloseTo(3.7, 6);
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
  const isRgb = (ramp: number) => !isMaterial(ramp);

  it('parses hex, rgb() and the full CSS name list', () => {
    expect(parseColor('#ff0000')).toEqual([255, 0, 0]);
    expect(parseColor('#f00')).toEqual([255, 0, 0]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
    expect(parseColor('Light Gray')).toEqual([211, 211, 211]);
    expect(parseColor('red;white')).toEqual([255, 0, 0]);
    expect(parseColor('salmon')).toEqual([250, 128, 114]);
    expect(parseColor('nonsense')).toBeUndefined();
  });

  const rgb = (ramp: number) => rgbOf(ramp);
  const sat = (ramp: number) => {
    const c = rgb(ramp), mx = Math.max(...c), mn = Math.min(...c);
    return mx ? (mx - mn) / mx : 0;
  };

  it('takes OSM wall colours, materials and type defaults as exact RGB colours', () => {
    expect(wallRamp({ 'building:colour': '#646464' })).toBe(colour(100, 100, 100));
    expect(wallRamp({ 'building:colour': '#ffffff', 'building:material': 'brick' })).toBe(colour(255, 255, 255));
    expect(wallRamp({ building: 'yes', 'building:material': 'brick' })).toBe(colour(156, 88, 64));
    expect(wallRamp({ 'building:colour': '#7a5c3d' })).toBe(colour(0x7a, 0x5c, 0x3d)); // no palette snap
    expect(isRgb(wallRamp({ building: 'garage' }))).toBe(true);
    expect(isRgb(wallRamp({}))).toBe(true);
  });

  it('takes roof colour, then roof material, from OSM', () => {
    const gabled = { 'roof:shape': 'gabled' };
    expect(roofRamp({ ...gabled, 'roof:colour': '#ff0000' })).toBe(colour(255, 0, 0));
    expect(roofRamp({ ...gabled, 'roof:material': 'slate' })).toBe(colour(72, 76, 84));
    expect(roofRamp({ ...gabled, 'roof:colour': 'red', 'roof:material': 'slate' })).toBe(roofRamp({ ...gabled, 'roof:colour': 'red' }));
  });

  it('mutes a CSS colour name but keeps its hue; an exact hex value stays as tagged', () => {
    const hue = (ramp: number) => {
      const [r, g, b] = rgb(ramp);
      return r > g && r > b ? 'r' : g > r && g > b ? 'g' : b > r && b > g ? 'b' : r === g && g > b ? 'y' : '?';
    };
    for (const [name, h] of [['red', 'r'], ['green', 'g'], ['lime', 'g'], ['blue', 'b'], ['yellow', 'y'], ['maroon', 'r']] as const) {
      for (const ramp of [roofRamp({ 'roof:colour': name }), wallRamp({ 'building:colour': name })]) {
        expect(sat(ramp)).toBeLessThanOrEqual(0.45);
        expect(hue(ramp)).toBe(h);
      }
    }
    // no pure white or black from a name
    expect(rgb(wallRamp({ 'building:colour': 'white' }))[0]).toBeLessThan(255);
    expect(rgb(wallRamp({ 'building:colour': 'black' }))[0]).toBeGreaterThan(0);
    expect(rgb(wallRamp({ 'building:colour': 'white' }))[0]).toBeGreaterThan(rgb(wallRamp({ 'building:colour': 'black' }))[0]);
    // hex is exact, even a loud one
    expect(roofRamp({ 'roof:colour': '#ff0000' })).toBe(colour(255, 0, 0));
    expect(sat(wallRamp({ 'building:colour': '#00ff00' }))).toBe(1);
  });

  const isGrey = (ramp: number) => {
    const [r, g, b] = rgbOf(ramp);
    return r === g && g === b;
  };

  it('lets OSM colour a flat roof; only an untagged flat roof is forced grey', () => {
    expect(isGrey(roofRamp({ 'roof:colour': '#ff0000' }))).toBe(false);
    expect(isGrey(roofRamp({ 'roof:shape': 'flat', 'roof:colour': 'green' }))).toBe(false);
    expect(roofRamp({ 'roof:shape': 'flat', 'roof:material': 'copper' })).toBe(colour(96, 160, 140));
  });

  it('picks an untagged roof deterministically: grey/dark grey, orange only on low-rise pitched roofs', () => {
    const tall = { building: 'apartments', height: '40', 'roof:shape': 'gabled' };
    const low = { building: 'house', height: '6', 'roof:shape': 'gabled' };
    const lowFlat = { building: 'house', height: '6' };
    const tallSet = new Set<number>(), lowSet = new Set<number>(), flatSet = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const seed = i / 200;
      expect(roofRamp(low, seed)).toBe(roofRamp(low, seed));
      tallSet.add(roofRamp(tall, seed));
      lowSet.add(roofRamp(low, seed));
      flatSet.add(roofRamp(lowFlat, seed));
    }
    const orange = (ramp: number) => {
      const [r, g, b] = rgbOf(ramp);
      return r > g + 40 && g > b;
    };
    for (const r of tallSet) expect(isGrey(r)).toBe(true);
    for (const r of flatSet) expect(isGrey(r)).toBe(true);
    expect(flatSet.size).toBeGreaterThan(1);
    expect([...lowSet].some(orange)).toBe(true);
    expect([...lowSet].some((r) => !orange(r))).toBe(true);
  });

  it('seeds from the footprint, not from the tile build', () => {
    expect(buildingSeed(rect())).toBe(buildingSeed(rect()));
    expect(buildingSeed(undefined)).toBe(0.5);
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

  it('winter: snow can lie on a flat roof only (not on walls or a pitched roof)', () => {
    const flagged = (m: { vertices: Float32Array; ramps: Uint32Array; vertexCount: number }, up: boolean) => {
      const out: boolean[] = [];
      for (let i = 0; i < m.vertexCount; i++) {
        const ny = m.vertices[i * 6 + 4];
        if (up ? ny > 0.99 : Math.abs(ny) < 0.01) out.push((m.ramps[i] & SNOW_FLAG) !== 0);
      }
      return out;
    };
    const flat = build([{ rings: [rect()], tags: { building: 'apartments', height: '15' } }]);
    expect(flagged(flat, true).length).toBeGreaterThan(0);
    expect(flagged(flat, true).every(Boolean)).toBe(true);
    expect(flagged(flat, false).some(Boolean)).toBe(false);
    const gabled = build([{ rings: [rect()], tags: { building: 'house', height: '12', 'roof:shape': 'gabled', 'roof:height': '3' } }]);
    for (let i = 0; i < gabled.vertexCount; i++) expect(gabled.ramps[i] & SNOW_FLAG).toBe(0);
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