import { describe, expect, it } from 'vitest';
import { colour, isMaterial, rgbOf, SNOW_FLAG } from '../src/engine/palette';
import { tileBounds, type Tile } from '../src/world/geodesy';
import {
  buildBuildingMesh,
  buildingHeights,
  buildingSeed,
  buildingTags,
  footprintHeight,
  computeHeights,
  parseColor,
  parseLength,
  pastelColour,
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

describe('default height and roof', () => {
  it('height without height/levels is the mean bbox side, at least 2.5 m', () => {
    expect(footprintHeight([[0, 0], [10, 0], [10, 6], [0, 6]])).toBe(8);
    expect(footprintHeight([[0, 0], [2, 0], [2, 1], [0, 1]])).toBe(2.5);
    // bbox of a rotated square in the local axes, not its sides
    expect(footprintHeight([[5, 0], [10, 5], [5, 10], [0, 5]])).toBe(10);
  });

  it('building=residential without height/levels: footprint facade, roof on top', () => {
    const big: OsmBuilding = { rings: [rect()], tags: { building: 'residential' } }; // ~50 m mean side
    const t = buildingTags(big);
    const h = buildingHeights(big);
    expect(t.height).toBeUndefined();
    expect(t['roof:shape']).toBeUndefined(); // not low-rise
    expect(h.roof).toBe(0);
    expect(h.wall).toBeCloseTo(Number(t['sim:footprint_wall']), 6);
    const small: OsmBuilding = { rings: [rect(0.00005, 0.00004)], tags: { building: 'residential' } };
    const ts = buildingTags(small);
    const hs = buildingHeights(small);
    expect(ts['roof:shape']).toBe('hipped');
    expect(hs.roof).toBeGreaterThan(0);
    expect(hs.wall).toBeCloseTo(Number(ts['sim:footprint_wall']), 6);
    expect(hs.wall).toBeGreaterThanOrEqual(2.5);
  });

  it('other types without height/levels: 2 floors, whatever the footprint', () => {
    for (const building of ['yes', 'house', 'industrial', 'garage']) {
      const b: OsmBuilding = { rings: [rect()], tags: { building } };
      expect(buildingTags(b)['sim:footprint_wall']).toBeUndefined();
      expect(buildingHeights(b).wall).toBe(6);
    }
    // yes: 2 floors are low-rise → a hipped roof on top of the 6 m facade
    const yes: OsmBuilding = { rings: [rect(0.00005, 0.00004)], tags: { building: 'yes' } };
    expect(buildingTags(yes)['roof:shape']).toBe('hipped');
    expect(buildingHeights(yes).wall).toBe(6);
    expect(buildingHeights(yes).roof).toBeGreaterThan(0);
  });

  it('default hipped only for low-rise yes/residential; OSM tags, other types and parts stay as they are', () => {
    const ring = rect(0.00005, 0.00004);
    const roof = (tags: Record<string, string>) => buildingTags({ rings: [ring], tags })['roof:shape'];
    expect(buildingTags({ rings: [ring], tags: { building: 'yes', 'building:levels': '2' } })).toEqual({ building: 'yes', 'building:levels': '2', 'roof:shape': 'hipped' });
    expect(roof({ building: 'residential', 'building:levels': '3' })).toBe('hipped');
    expect(roof({ building: 'yes', 'building:levels': '5' })).toBeUndefined();
    expect(roof({ building: 'yes', height: '20' })).toBeUndefined();
    expect(roof({ building: 'yes', height: '7', 'roof:shape': 'flat' })).toBe('flat');
    for (const building of ['house', 'detached', 'apartments', 'industrial', 'school', 'garage']) {
      expect(roof({ building, 'building:levels': '2' })).toBeUndefined();
    }
    expect(roof({ 'building:part': 'yes', building: 'yes', height: '7' })).toBeUndefined();
  });
});

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
  it('prefers height, then levels, then 2 floors', () => {
    expect(computeHeights({ height: '20', building: 'house' })).toEqual({ min: 0, wall: 20, roof: 0 });
    expect(computeHeights({ 'building:levels': '4', building: 'house' }).wall).toBe(12);
    expect(computeHeights({ building: 'house' }).wall).toBe(6);
    expect(computeHeights({ building: 'garage' }).wall).toBe(6);
    expect(computeHeights({ building: 'apartments' }).wall).toBe(6);
    expect(computeHeights({}).wall).toBe(6);
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
    expect(roofRamp({ ...gabled, 'roof:colour': '#a06858' })).toBe(colour(0xa0, 0x68, 0x58));
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
    // a loud bright hex becomes a light pastel of its hue; a loud dark one only loses saturation
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffff00']) {
      const r = rgb(wallRamp({ 'building:colour': hex }));
      expect(sat(wallRamp({ 'building:colour': hex }))).toBeLessThanOrEqual(0.31);
      expect(Math.max(...r)).toBeGreaterThanOrEqual(224);
    }
    expect(hue(wallRamp({ 'building:colour': '#00ff00' }))).toBe('g');
    expect(pastelColour([128, 0, 0])[0]).toBe(128);
    expect(sat(colour(...pastelColour([128, 0, 0])))).toBeLessThanOrEqual(0.5);
    expect(pastelColour([0x7a, 0x5c, 0x3d])).toEqual([0x7a, 0x5c, 0x3d]);
  });

  it('untagged walls: a palette per building type, picked by seed', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => (i + 0.5) / 200);
    const colours = (tags: Record<string, string>) => new Set(seeds.map((x) => wallRamp(tags, x)));
    const warm = ([r, , b]: readonly number[]) => r - b > 25;
    const brick = ([r, g, b]: readonly number[]) => r - b > 50 && r < 170 && g < 110;
    for (const type of ['house', 'apartments', 'industrial', 'warehouse', 'retail', 'office', 'school', 'kindergarten', 'yes', 'church']) {
      const set = colours({ building: type });
      expect(set.size).toBeGreaterThan(2);
      for (const c of set) expect(sat(c)).toBeLessThanOrEqual(0.5);
      expect(wallRamp({ building: type }, 0.3)).toBe(wallRamp({ building: type }, 0.3));
    }
    for (const c of colours({ building: 'industrial' })) expect(warm(rgb(c))).toBe(false);
    for (const c of colours({ building: 'commercial' })) expect(brick(rgb(c))).toBe(false);
    for (const c of colours({ building: 'school' })) { const [r, , b] = rgb(c); expect(b).toBeGreaterThanOrEqual(r); }
    const house = [...colours({ building: 'house' })].map(rgb);
    expect(house.filter(warm).length).toBeGreaterThan(house.length / 2);
    expect(house.some(brick)).toBe(true);
    // OSM material still wins over the palette
    expect(wallRamp({ building: 'school', 'building:material': 'brick' }, 0.1)).toBe(colour(156, 88, 64));
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