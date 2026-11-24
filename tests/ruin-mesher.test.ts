import { describe, expect, it } from 'vitest';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh, isLitBuilding, isRuin } from '../src/world/building-mesher';
import { buildRuins, RUIN, ruinHeight } from '../src/world/ruin-mesher';
import type { LonLat, OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 9516, y: 6400 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const flat = () => 100;

/** a 10 × 6 m house, its corners counter-clockwise from (x0, y0) */
const house = (tags: Record<string, string>, x0 = 0, y0 = 0): OsmBuilding => ({
  rings: [[at(x0, y0), at(x0 + 10, y0), at(x0 + 10, y0 + 6), at(x0, y0 + 6), at(x0, y0)]],
  tags,
});
const KAYAKOY = { building: 'yes', historic: 'ruins' };

function columns(v: Float32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += 6) out.push(v[i]);
  return out;
}

describe('isRuin', () => {
  it('building=ruins, or a building tagged historic=ruins or ruins=*; dark at night', () => {
    for (const tags of [{ building: 'ruins' }, KAYAKOY, { building: 'church', historic: 'ruins' }, { building: 'yes', ruins: 'yes' }, { building: 'ruins', ruins: 'monastery' }] as Record<string, string>[]) {
      expect(isRuin(tags), JSON.stringify(tags)).toBe(true);
      expect(isLitBuilding(tags)).toBe(false);
    }
    for (const tags of [{ building: 'yes' }, { building: 'yes', ruins: 'no' }, { building: 'church', historic: 'church' }] as Record<string, string>[]) {
      expect(isRuin(tags), JSON.stringify(tags)).toBe(false);
    }
  });

  it('a ruin is no house: no roof, no window, nothing in the building mesh', () => {
    const m = buildBuildingMesh({ tile: TILE, buildings: [house(KAYAKOY)], sampleHeight: flat });
    expect(m.vertices.length).toBe(0);
    expect(buildBuildingMesh({ tile: TILE, buildings: [house({ building: 'yes' })], sampleHeight: flat }).vertices.length).toBeGreaterThan(0);
  });
});

describe('ruinHeight', () => {
  it('the tags’ height or storeys, else two storeys', () => {
    expect(ruinHeight({ height: '8' })).toBe(8);
    expect(ruinHeight({ 'building:levels': '1' })).toBe(3);
    expect(ruinHeight({})).toBe(RUIN.HEIGHT_M);
  });
});

describe('buildRuins', () => {
  const m = buildRuins(TILE, [house(KAYAKOY), house({ building: 'yes' }, 30, 0)], flat);
  const x = columns(m.vertices, 0), y = columns(m.vertices, 1), z = columns(m.vertices, 2), ny = columns(m.vertices, 4);

  it('walls only round the ruin, none for the house beside it', () => {
    expect(m.ramps.length).toBeGreaterThan(0);
    expect(m.vertices.length).toBe(m.ramps.length * 6);
    expect(Math.max(...x)).toBeLessThan(10.5);
  });

  it('open to the sky: no face over the middle of the house', () => {
    // the house spans x 0..10, z −6..0 (z south); its middle stays clear of every face
    for (let i = 0; i < x.length; i++) {
      const inMiddle = x[i] > 1.5 && x[i] < 8.5 && z[i] < -1.5 && z[i] > -4.5;
      expect(inMiddle).toBe(false);
    }
  });

  it('walls WALL_M thick from the ground into it down to the broken top, never lower than MIN_M, never over the house’s height and gable', () => {
    expect(Math.min(...y)).toBeCloseTo(100 - RUIN.SINK_M, 5);
    const tops = y.filter((v) => v > 100);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(100 + RUIN.MIN_M - 1e-4);
    // the gable on the 6 m ends: at most 3 m × GABLE over the full height
    expect(Math.max(...y)).toBeLessThanOrEqual(100 + RUIN.HEIGHT_M + 3 * RUIN.GABLE + 1e-4);
    // the top is broken: more than a few heights
    expect(new Set(tops.map((v) => v.toFixed(2))).size).toBeGreaterThan(4);
    // the inner face: WALL_M in from the outline
    const inner = x.filter((v) => Math.abs(v - RUIN.WALL_M) < 1e-3);
    expect(inner.length).toBeGreaterThan(0);
  });

  it('the top faces up, every wall face is vertical', () => {
    for (let i = 0; i < ny.length; i++) expect(ny[i] > 1e-3 || Math.abs(ny[i]) < 1e-3).toBe(true);
  });

  it('the same ruin comes out the same, in every tile that builds it', () => {
    const again = buildRuins(TILE, [house(KAYAKOY)], flat);
    expect(Array.from(again.vertices)).toEqual(Array.from(m.vertices));
  });

  it('on a slope the walls stand on the ground under them, the uphill one lower', () => {
    // the ground rises 1 m per metre northward (y): the north wall (y = 6) stands 6 m higher
    const slope = (_lon: number, lat: number) => 100 + (lat - c.lat) * KY;
    const s = buildRuins(TILE, [house(KAYAKOY)], slope);
    const sy = columns(s.vertices, 1), sz = columns(s.vertices, 2);
    const south = sy.filter((_, i) => sz[i] > -0.3), north = sy.filter((_, i) => sz[i] < -5.7);
    expect(Math.min(...south)).toBeCloseTo(100 - RUIN.SINK_M, 3);
    expect(Math.min(...north)).toBeCloseTo(106 - RUIN.SINK_M, 3);
    const rise = (v: number[], foot: number) => Math.max(...v) - foot;
    expect(rise(north, 106)).toBeLessThan(rise(south, 100));
  });
});
