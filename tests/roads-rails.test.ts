import { describe, expect, it } from 'vitest';
import { RAMP, withGlow } from '../src/engine/palette';
import { WORLD_FS } from '../src/engine/shaders';
import { WINDOW_ATTR_FLOATS } from '../src/world/building-mesher';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { parseFilter } from '../src/world/osm-api';
import {
  BALLAST_RAMP, BALLAST_WIDTH_M, buildOsmMesh, classifyLine, DIRT_ROAD_RAMP, GRAVEL_ROAD_RAMP, RAIL_ZONE_M, RAIL_ZONE_RAMP, SHOULDER_RAMP, TRACK_EDGE,
} from '../src/world/osm-mesher';
import type { OsmTileData } from '../src/world/osm-types';
import { osmFilter } from '../src/world/overpass';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };
const GRID = 16;
const GROUND = 100;
const tin = buildTerrainTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(GROUND));
const surface = tinSampler(tin, TILE);

/** one west→east way across the middle of the tile on flat ground */
function meshOf(tags: Record<string, string>) {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const data: OsmTileData = {
    areas: [], points: [], buildings: [],
    lines: [{ points: [[b.west + (b.east - b.west) * 0.2, c.lat], [b.west + (b.east - b.west) * 0.8, c.lat]], tags }],
  };
  return buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: surface, tin });
}

/** north–south spread and height above the ground of a mesh's vertices of one face colour */
function band(m: { vertices: Float32Array; ramps: Uint32Array; vertexCount: number }, ramp: number) {
  let lo = Infinity, hi = -Infinity, y = NaN, n = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    if (withGlow(m.ramps[i], 0) !== withGlow(ramp, 0)) continue; // the night glow level aside
    lo = Math.min(lo, m.vertices[i * 6 + 2]);
    hi = Math.max(hi, m.vertices[i * 6 + 2]);
    y = m.vertices[i * 6 + 1] - GROUND;
    n++;
  }
  return { width: hi - lo, y, n };
}

describe('road kinds', () => {
  it('draws service roads, tracks, living streets, pedestrian streets and links; no footways or paths', () => {
    for (const hw of ['service', 'track', 'living_street', 'pedestrian', 'road', 'busway', 'motorway_link', 'tertiary_link']) {
      expect(classifyLine({ highway: hw }), hw).toBeDefined();
    }
    for (const hw of ['footway', 'path', 'cycleway', 'bridleway', 'steps', 'corridor', 'services', 'proposed']) {
      expect(classifyLine({ highway: hw }), hw).toBeUndefined();
    }
    expect(classifyLine({ highway: 'pedestrian', area: 'yes' })).toBeUndefined();
  });

  it('tracks and unpaved roads are gravel or earth without shoulders; paved ones asphalt', () => {
    expect(classifyLine({ highway: 'track' })).toMatchObject({ ramp: GRAVEL_ROAD_RAMP, shoulder: 0 });
    expect(classifyLine({ highway: 'track', tracktype: 'grade5' })?.ramp).toBe(DIRT_ROAD_RAMP);
    expect(classifyLine({ highway: 'unclassified', surface: 'dirt' })).toMatchObject({ ramp: DIRT_ROAD_RAMP, shoulder: 0 });
    expect(classifyLine({ highway: 'track', surface: 'asphalt' })?.ramp).toBe(RAMP.ASPHALT);
    expect(classifyLine({ highway: 'service', service: 'parking_aisle' })).toMatchObject({ width: 3, shoulder: 0 });
    expect(classifyLine({ highway: 'primary', bridge: 'yes' })?.shoulder).toBe(0);
  });

  it('the full-detail query fetches them (anchored: not highway=services or footway)', () => {
    const sel = parseFilter(osmFilter('full'));
    const fetched = (v: string) => sel.some((s) => s.type === 'way' && s.clauses.some((c) => c.key === 'highway' && c.re?.test(v)));
    for (const hw of ['motorway', 'motorway_link', 'primary_link', 'residential', 'service', 'track', 'living_street', 'pedestrian']) expect(fetched(hw), hw).toBe(true);
    for (const hw of ['footway', 'path', 'services', 'cycleway', 'steps']) expect(fetched(hw), hw).toBe(false);
    const rail = (v: string) => sel.some((s) => s.clauses.some((c) => c.key === 'railway' && c.re?.test(v)));
    expect(rail('rail') && rail('narrow_gauge') && rail('light_rail')).toBe(true);
    expect(rail('abandoned')).toBe(false);
  });
});

describe('shoulders', () => {
  it('a tertiary road has 1.5 m shoulders under its carriageway', () => {
    const m = meshOf({ highway: 'tertiary' });
    const asphalt = band(m.roads, RAMP.ASPHALT), shoulder = band(m.roads, SHOULDER_RAMP);
    expect(asphalt.width).toBeCloseTo(9, 1);
    expect(shoulder.width).toBeCloseTo(12, 1);
    expect(shoulder.y).toBeLessThan(asphalt.y);
  });

  it('none on a bridge or a track', () => {
    expect(band(meshOf({ highway: 'tertiary', bridge: 'yes' }).roads, SHOULDER_RAMP).n).toBe(0);
    expect(band(meshOf({ highway: 'track' }).roads, SHOULDER_RAMP).n).toBe(0);
  });
});

describe('railways', () => {
  it('ballast with the track coordinates, over a right-of-way strip', () => {
    const m = meshOf({ railway: 'rail' });
    const ballast = band(m.roads, BALLAST_RAMP);
    expect(ballast.width).toBeCloseTo(BALLAST_WIDTH_M, 1);
    const zone = band(m, RAIL_ZONE_RAMP);
    expect(zone.width).toBeCloseTo(BALLAST_WIDTH_M + 2 * RAIL_ZONE_M, 1);
    expect(zone.y).toBeLessThan(ballast.y);
    // every road vertex has its attributes; the ballast's say "track" with u along and v across
    expect(m.roadAttrs.length).toBe(m.roads.vertexCount * WINDOW_ATTR_FLOATS);
    let uMax = 0;
    for (let i = 0; i < m.roads.vertexCount; i++) {
      if (m.roads.ramps[i] !== BALLAST_RAMP) continue;
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      expect(a[2]).toBe(TRACK_EDGE);
      expect(a[3]).toBe(0); // no windows
      // the lattice's metre is the tile centre's: a hair off at the ribbon's edge
      expect(Math.abs(a[1])).toBeLessThanOrEqual(BALLAST_WIDTH_M / 2 + 0.05);
      uMax = Math.max(uMax, a[0]);
    }
    expect(uMax).toBeGreaterThan(900); // the line is 60% of the tile, about 930 m here
  });

  it('no strip on a bridge; abandoned lines not drawn', () => {
    expect(band(meshOf({ railway: 'rail', bridge: 'yes' }), RAIL_ZONE_RAMP).n).toBe(0);
    expect(classifyLine({ railway: 'abandoned' })).toBeUndefined();
  });

  it('the world shader draws the track on vertices marked TRACK_EDGE', () => {
    expect(WORLD_FS).toContain('vec3 trackAt(');
    expect(WORLD_FS).toContain('if (vWinEdge.x < -0.5)');
  });
});
