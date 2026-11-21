import { describe, expect, it } from 'vitest';
import { RAMP, withGlow } from '../src/engine/palette';
import { WORLD_FS } from '../src/engine/shaders';
import { WINDOW_ATTR_FLOATS } from '../src/world/building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { parseFilter } from '../src/world/osm-api';
import {
  BALLAST_RAMP, BALLAST_WIDTH_M, buildOsmMesh, CAR_PARK_BIAS, classifyLine, DIRT_ROAD_RAMP, GRAVEL_ROAD_RAMP, RAIL_ZONE_M, RAIL_ZONE_RAMP, ROAD_EDGE, ROAD_MARK, ROAD_MARK_END_M, ROAD_TAPER_M, ROAD_U_BASE, roadLayer, roadMarks, roadRank,
  PAVING_RAMP, SHOULDER_RAMP, TRACK_EDGE, TRAIL_RAMP,
} from '../src/world/osm-mesher';
import type { OsmTileData } from '../src/world/osm-types';
import { osmFilter, parseOverpass } from '../src/world/overpass';
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
  it('draws service roads, tracks, living streets, pedestrian streets, links, footways and paths', () => {
    for (const hw of ['service', 'track', 'living_street', 'pedestrian', 'road', 'busway', 'motorway_link', 'tertiary_link',
      'footway', 'path', 'cycleway', 'bridleway', 'steps']) {
      expect(classifyLine({ highway: hw }), hw).toBeDefined();
    }
    for (const hw of ['corridor', 'services', 'proposed', 'construction']) {
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

  it('footways are narrow paving, paths beaten earth, both minor, unpainted and without shoulders', () => {
    expect(classifyLine({ highway: 'footway' })).toMatchObject({ ramp: PAVING_RAMP, width: 2, shoulder: 0, minor: true, marks: 0, path: true });
    expect(classifyLine({ highway: 'path' })).toMatchObject({ ramp: TRAIL_RAMP, width: 1.5 });
    expect(classifyLine({ highway: 'path', surface: 'paving_stones' })?.ramp).toBe(PAVING_RAMP);
    expect(classifyLine({ highway: 'footway', surface: 'gravel' })?.ramp).toBe(TRAIL_RAMP);
    expect(classifyLine({ highway: 'cycleway', surface: 'asphalt' })?.ramp).toBe(RAMP.ASPHALT);
    expect(classifyLine({ highway: 'footway', width: '3' })?.width).toBe(3);
    // under every road where they meet
    expect(roadRank({ highway: 'footway' })).toBeLessThan(roadRank({ highway: 'service' }));
  });

  it('a lit footway gets no street lamps', () => {
    expect(meshOf({ highway: 'footway', lit: 'yes' }).lampPosts.length).toBe(0);
    expect(meshOf({ highway: 'residential' }).lampPosts.length).toBeGreaterThan(0);
  });

  it('the full-detail query fetches them (anchored: not highway=services or footway)', () => {
    const sel = parseFilter(osmFilter('full'));
    const fetched = (v: string) => sel.some((s) => s.type === 'way' && s.clauses.some((c) => c.key === 'highway' && c.re?.test(v)));
    for (const hw of ['motorway', 'motorway_link', 'primary_link', 'residential', 'service', 'track', 'living_street', 'pedestrian',
      'footway', 'path', 'cycleway', 'bridleway', 'steps']) expect(fetched(hw), hw).toBe(true);
    for (const hw of ['services', 'corridor', 'footway_link', 'proposed']) expect(fetched(hw), hw).toBe(false);
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

describe('road paint', () => {
  it('lanes, one-way, edge lines and a double centre by class and tags', () => {
    expect(roadMarks('primary', {})).toBe(4 | ROAD_MARK.EDGES | ROAD_MARK.DOUBLE);
    expect(roadMarks('secondary', {})).toBe(2 | ROAD_MARK.EDGES);
    expect(roadMarks('unclassified', {})).toBe(2);
    expect(roadMarks('motorway', { lanes: '3' })).toBe(3 | ROAD_MARK.ONEWAY | ROAD_MARK.EDGES);
    expect(roadMarks('primary_link', {})).toBe(1 | ROAD_MARK.ONEWAY | ROAD_MARK.EDGES);
    expect(roadMarks('trunk', { oneway: 'yes' })).toBe(2 | ROAD_MARK.ONEWAY | ROAD_MARK.EDGES);
    for (const hw of ['residential', 'service', 'track', 'living_street', 'pedestrian']) expect(roadMarks(hw, {}), hw).toBe(0);
    expect(classifyLine({ highway: 'tertiary', surface: 'gravel' })?.marks).toBe(0);
  });

  it('a painted road carries u from its nearer end, v from its left edge, its width and code', () => {
    const m = meshOf({ highway: 'secondary' });
    let n = 0, dMax = 0;
    for (let i = 0; i < m.roads.vertexCount; i++) {
      if (withGlow(m.roads.ramps[i], 0) !== RAMP.ASPHALT) continue;
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      expect(a[2]).toBe(ROAD_EDGE); // no taper
      expect(a[3]).toBe(11 / 0.25); // the full width, no narrowing
      expect(a[4]).toBe(2 | ROAD_MARK.EDGES); // no junction gaps
      expect(a[1]).toBeGreaterThanOrEqual(-0.05);
      expect(a[1]).toBeLessThanOrEqual(11 + 0.05);
      dMax = Math.max(dMax, Math.abs(a[0]) - ROAD_U_BASE);
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(dMax).toBeGreaterThan(400); // half of the ~930 m way
    expect(dMax).toBeLessThan(480);
    for (let i = 0; i < m.roads.vertexCount; i++) {
      if (withGlow(m.roads.ramps[i], 0) === withGlow(SHOULDER_RAMP, 0)) expect(m.roadAttrs[i * WINDOW_ATTR_FLOATS + 2]).toBe(0);
    }
  });

  it('the world shader paints vertices marked ROAD_EDGE', () => {
    expect(WORLD_FS).toContain('vec3 roadMarkAt(');
    expect(WORLD_FS).toContain('if (d < gap) return c;');
  });
});

describe('junctions', () => {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const west = b.west + (b.east - b.west) * 0.2, east = b.west + (b.east - b.west) * 0.8, mid = (west + east) / 2;
  const south = c.lat - (b.north - b.south) * 0.3;
  /** a secondary road west→east through `mid`, and a tertiary from the south ending on it there */
  const tee = (minor: Record<string, string> = { highway: 'tertiary' }): OsmTileData => ({
    areas: [], points: [], buildings: [],
    lines: [
      { points: [[west, c.lat], [mid, c.lat], [east, c.lat]], tags: { highway: 'secondary' } },
      { points: [[mid, south], [mid, c.lat]], tags: minor },
    ],
  });
  const build = (data: OsmTileData) => buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: surface, tin });
  /**
   * the painted asphalt vertices of the road of full width `half` · 2: distance from their end less
   * that end's gap (no paint below 0), height, distance from the left edge, the width there
   */
  const painted = (m: ReturnType<typeof build>, half: number) => {
    const out: { u: number; y: number; vl: number; w: number; x: number }[] = [];
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      if (a[2] > ROAD_EDGE + 0.5 || ((a[3] & 1023) * 0.25) !== half * 2) continue;
      const atEnd = a[0] < 0, d = Math.abs(a[0]) - ROAD_U_BASE;
      const gap = ((atEnd ? a[4] >> 13 : a[4] >> 7) & 63) * 0.5;
      const narrow = ((atEnd ? a[3] >> 15 : a[3] >> 10) & 31) * 0.5;
      const tp = Math.round(ROAD_EDGE - a[2]), taper = (atEnd ? tp & 63 : tp >> 6) * 2;
      const w = half * 2 - (taper > 0 ? narrow * (1 - Math.min(1, d / taper)) : 0);
      out.push({ u: d - gap, y: m.roads.vertices[i * 6 + 1], vl: a[1], w, x: m.roads.vertices[i * 6] });
    }
    return out;
  };

  it('ranks by class, links yield; bridges and layers lie over the ground', () => {
    expect(roadRank({ highway: 'motorway' })).toBeGreaterThan(roadRank({ highway: 'primary' }));
    expect(roadRank({ highway: 'motorway_link' })).toBeLessThan(roadRank({ highway: 'tertiary' }));
    expect(roadRank({ highway: 'residential' })).toBeGreaterThan(roadRank({ highway: 'service' }));
    expect(roadLayer({ highway: 'primary', bridge: 'yes' })).toBe(1);
    expect(roadLayer({ highway: 'primary', layer: '2' })).toBe(2);
    expect(roadLayer({ highway: 'primary', layer: '-1' })).toBe(0);
  });

  it('the road that yields lies under the other and stops its paint short of it', () => {
    const m = build(tee());
    const major = painted(m, 5.5), minor = painted(m, 4.5);
    expect(Math.min(...major.map((p) => p.y))).toBeGreaterThan(Math.max(...minor.map((p) => p.y)));
    // the through road paints on through the junction (its middle node is no end)
    // the tertiary: no paint within the secondary's half width (+ ROAD_MARK_END_M) of the junction
    const atJunction = minor.filter((p) => p.u < 0);
    expect(atJunction.length).toBeGreaterThan(0);
    expect(Math.min(...atJunction.map((p) => p.u))).toBeLessThanOrEqual(-(5.5 + ROAD_MARK_END_M) + 0.5);
  });

  it('a road split in two paints on through the split', () => {
    const m = build({
      areas: [], points: [], buildings: [],
      lines: [
        { points: [[west, c.lat], [mid, c.lat]], tags: { highway: 'secondary' } },
        { points: [[mid, c.lat], [east, c.lat]], tags: { highway: 'secondary' } },
      ],
    });
    // each half's u at the split end: no gap there
    const us = painted(m, 5.5).map((p) => p.u);
    expect(Math.min(...us)).toBeGreaterThan(-5.5 - 0.1); // only the round cap past the end
  });
});

describe('lane tapers', () => {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const west = b.west + (b.east - b.west) * 0.2, east = b.west + (b.east - b.west) * 0.8, mid = (west + east) / 2;
  const centre = tileCenter(TILE);
  it('a 5-lane way narrows to the 4-lane way that continues it, over ROAD_TAPER_M, lanes from the left edge', () => {
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [
          { points: [[west, c.lat], [mid, c.lat]], tags: { highway: 'trunk', oneway: 'yes', lanes: '5' } },
          { points: [[mid, c.lat], [east, c.lat]], tags: { highway: 'trunk', oneway: 'yes', lanes: '4' } },
        ],
      },
    });
    const [midX] = latLonToEnu(centre, c.lat, mid, 0);
    // the wide way's asphalt: full 17.5 m away from the node, 14 m at it
    const xs: { x: number; z: number }[] = [];
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      if (a[2] > ROAD_EDGE + 0.5 || (a[3] & 1023) * 0.25 !== 17.5) continue;
      xs.push({ x: m.roads.vertices[i * 6], z: m.roads.vertices[i * 6 + 2] });
    }
    const spread = (sel: (x: number) => boolean) => {
      const zs = xs.filter((p) => sel(p.x)).map((p) => p.z);
      return Math.max(...zs) - Math.min(...zs);
    };
    expect(spread((x) => x < midX - ROAD_TAPER_M - 20 && x > midX - 300)).toBeCloseTo(17.5, 0);
    expect(spread((x) => Math.abs(x - (midX - 1)) < 1.5)).toBeLessThan(15);
    // the narrow way keeps its width up to the node
    const narrow: number[] = [];
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      if (a[2] <= ROAD_EDGE + 0.5 && (a[3] & 1023) * 0.25 === 14) {
        expect(a[2]).toBe(ROAD_EDGE); // no taper of its own
        narrow.push(m.roads.vertices[i * 6 + 2]);
      }
    }
    expect(Math.max(...narrow) - Math.min(...narrow)).toBeCloseTo(14, 0);
  });
});

describe('dual carriageway forks', () => {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const centre = tileCenter(TILE);
  const dLon = (b.east - b.west) * 0.15, dLat = (b.north - b.south) * 0.03;
  const node: [number, number] = [(b.west + b.east) / 2, c.lat];

  it('a one-way carriageway is half the road wide without width or lanes', () => {
    expect(classifyLine({ highway: 'secondary', oneway: 'yes' })?.width).toBeCloseTo(5.5, 6);
    expect(classifyLine({ highway: 'motorway' })?.width).toBeCloseTo(10, 6); // oneway by default
    expect(classifyLine({ highway: 'secondary', oneway: 'yes', lanes: '3' })?.width).toBeCloseTo(10.5, 6);
  });

  it('each branch starts on its side of the two-way road, outer edge on its edge, and no paint gap', () => {
    // a two-way secondary from the west ends at the node; eastbound and westbound carriageways fan out east
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [
          { points: [[node[0] - dLon, c.lat], node], tags: { highway: 'secondary' } },
          { points: [node, [node[0] + dLon, c.lat - dLat]], tags: { highway: 'secondary', oneway: 'yes' } },
          { points: [[node[0] + dLon, c.lat + dLat], node], tags: { highway: 'secondary', oneway: 'yes' } },
        ],
      },
    });
    const [nx, nzRaw] = latLonToEnu(centre, node[1], node[0], 0);
    const nz = -nzRaw;
    // the branches' asphalt (with their caps) at the node: one each side of the axis, outer edges on the road's
    const near: { z: number }[] = [];
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      const x = m.roads.vertices[i * 6], z = m.roads.vertices[i * 6 + 2];
      if (a[2] > ROAD_EDGE + 0.5 || (a[3] & 1023) * 0.25 !== 5.5 || Math.abs(x - nx) > 3) continue;
      expect(a[4] >> 7).toBe(0); // no junction gaps at a fork
      near.push({ z: z - nz });
    }
    expect(near.length).toBeGreaterThan(0);
    const zs = near.map((p) => p.z);
    // together they span the two-way road's 11 m, each on its own side
    expect(Math.min(...zs)).toBeLessThan(-5);
    expect(Math.max(...zs)).toBeGreaterThan(5);
    expect(Math.min(...zs)).toBeGreaterThan(-5.8);
    expect(Math.max(...zs)).toBeLessThan(5.8);
    // and none of it crosses to the other side: each branch is a 5.5 m band, so nothing spans the axis
    expect(zs.some((z) => z > 0.2) && zs.some((z) => z < -0.2)).toBe(true);
  });
});

describe('one-way splits and merges', () => {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const centre = tileCenter(TILE);
  const dLon = (b.east - b.west) * 0.15, dLat = (b.north - b.south) * 0.03;
  const node: [number, number] = [(b.west + b.east) / 2, c.lat];
  it('a one-way road splitting in three: the branches lie across it in order, outer edges on its edges', () => {
    // a 10.5 m trunk from the west; 3 m, 4 m and 5 m branches fan out north-east, east and south-east
    const branch = (dl: number, width: string) => ({ points: [node, [node[0] + dLon, c.lat + dl]] as [number, number][], tags: { highway: 'primary', oneway: 'yes', lanes: '1', width } });
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [
          { points: [[node[0] - dLon, c.lat], node], tags: { highway: 'primary', oneway: 'yes', lanes: '3' } },
          branch(dLat, '3'), branch(0, '4'), branch(-dLat, '5'),
        ],
      },
    });
    const [nx, nn] = latLonToEnu(centre, node[1], node[0], 0);
    const zsOf = (w: number) => {
      const zs: number[] = [];
      for (let i = 0; i < m.roads.vertexCount; i++) {
        const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
        if (a[2] > ROAD_EDGE + 0.5 || (a[3] & 1023) * 0.25 !== w || Math.abs(m.roads.vertices[i * 6] - nx) > 1) continue;
        zs.push(m.roads.vertices[i * 6 + 2] + nn);
      }
      return zs;
    };
    // 12 m of branches on the 10.5 m trunk: 0.5 m of overlap at each seam, the outer edges on ±5.25
    const span = (w: number) => { const zs = zsOf(w); expect(zs.length, `${w} m`).toBeGreaterThan(0); return [Math.min(...zs), Math.max(...zs)]; };
    const [n0, n1] = span(3), [m0, m1] = span(4), [s0, s1] = span(5);
    expect(n0).toBeCloseTo(-5.25, 0); expect(n1).toBeCloseTo(-2.25, 0);
    expect(m0).toBeCloseTo(-3, 0); expect(m1).toBeCloseTo(1, 0);
    expect(s0).toBeCloseTo(0.25, 0); expect(s1).toBeCloseTo(5.25, 0);
  });

  it('a one-way road splitting in two: each branch has its outer edge on the trunk edge', () => {
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [
          { points: [[node[0] - dLon, c.lat], node], tags: { highway: 'primary', oneway: 'yes', lanes: '2' } },
          { points: [node, [node[0] + dLon, c.lat - dLat]], tags: { highway: 'primary', oneway: 'yes', lanes: '1' } },
          { points: [node, [node[0] + dLon, c.lat + dLat]], tags: { highway: 'primary_link', oneway: 'yes', lanes: '3' } },
        ],
      },
    });
    const [nx, nn] = latLonToEnu(centre, node[1], node[0], 0);
    const zsOf = (w: number) => {
      const zs: number[] = [];
      for (let i = 0; i < m.roads.vertexCount; i++) {
        const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
        const x = m.roads.vertices[i * 6];
        if (a[2] > ROAD_EDGE + 0.5 || (a[3] & 1023) * 0.25 !== w || Math.abs(x - nx) > 2) continue;
        zs.push(m.roads.vertices[i * 6 + 2] + nn);
      }
      return zs;
    };
    // the 3.5 m primary south (+z: it heads south-east), shifted 1.75 m: its outer edge on the 7 m
    // trunk's at +3.5; the 10.5 m link, wider than the trunk, on the trunk's line (it overlaps both sides)
    const primary = zsOf(3.5), link = zsOf(10.5);
    expect(primary.length).toBeGreaterThan(0);
    expect(link.length).toBeGreaterThan(0);
    expect(Math.min(...primary)).toBeGreaterThan(-0.3);
    expect(Math.max(...primary)).toBeLessThan(3.5 + 0.3);
    expect(Math.max(...link)).toBeGreaterThan(5);
    expect(Math.min(...link)).toBeLessThan(-5);
    expect(Math.max(...link)).toBeLessThan(5.25 + 0.3);
    expect(Math.min(...link)).toBeGreaterThan(-5.25 - 0.3);
    // the trunk keeps its width up to the node (no taper to either branch)
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      if (a[2] <= ROAD_EDGE + 0.5 && (a[3] & 1023) * 0.25 === 7 && m.roads.vertices[i * 6] < nx - 1) expect(a[2]).toBe(ROAD_EDGE);
    }
  });
});

describe('lanes merging', () => {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const centre = tileCenter(TILE);
  const dLon = (b.east - b.west) * 0.15, dLat = (b.north - b.south) * 0.03;
  const node: [number, number] = [(b.west + b.east) / 2, c.lat];
  it('two 3-lane roads merging into one 3-lane road meet on its line, no step out of its edges', () => {
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [
          { points: [[node[0] - dLon, c.lat - dLat], node], tags: { highway: 'secondary', oneway: 'yes', lanes: '3' } },
          { points: [[node[0] - dLon, c.lat + dLat], node], tags: { highway: 'secondary', oneway: 'yes', lanes: '3' } },
          { points: [node, [node[0] + dLon, c.lat]], tags: { highway: 'secondary', oneway: 'yes', lanes: '3' } },
        ],
      },
    });
    const [nx, nn] = latLonToEnu(centre, node[1], node[0], 0);
    const zs: number[] = [];
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const a = m.roadAttrs.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS);
      if (a[2] > ROAD_EDGE + 0.5 || Math.abs(m.roads.vertices[i * 6] - nx) > 0.5) continue;
      zs.push(m.roads.vertices[i * 6 + 2] + nn);
    }
    expect(zs.length).toBeGreaterThan(0);
    // at the node everything lies within the 10.5 m road
    expect(Math.max(...zs.map(Math.abs))).toBeLessThan(5.25 + 0.4);
  });
});

describe('sharp turns', () => {
  it('a way turning a little more than a right angle keeps its full width up to the corner', () => {
    const c = tileCenter(TILE);
    const latPerM = 1 / 111320, lonPerM = 1 / (111320 * Math.cos((c.lat * Math.PI) / 180));
    // south to the corner, then east and a little north (a turn of ~93°): the inside of the turn is north-east
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [{ points: [[c.lon, c.lat + 100 * latPerM], [c.lon, c.lat], [c.lon + 100 * lonPerM, c.lat + 5 * latPerM]], tags: { highway: 'service' } }],
      },
    });
    const [cx, cn] = latLonToEnu(c, c.lat, c.lon, 0);
    /** is (east, north) metres from the corner on the asphalt? */
    const covered = (e: number, n: number): boolean => {
      const px = cx + e, pz = -(cn + n);
      for (let v = 0; v + 2 < m.roads.vertexCount; v += 3) {
        if (withGlow(m.roads.ramps[v], 0) !== RAMP.ASPHALT) continue;
        const p = [0, 1, 2].map((k) => [m.roads.vertices[(v + k) * 6], m.roads.vertices[(v + k) * 6 + 2]]);
        const d = (a: number[], b: number[]) => (b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0]);
        const s1 = d(p[0], p[1]), s2 = d(p[1], p[2]), s3 = d(p[2], p[0]);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
      }
      return false;
    };
    // 1.8 m off each leg's line on the inside, a few metres from the corner: still on the 4 m road
    for (const along of [3, 6, 10]) {
      expect(covered(along, along * 0.05 + 1.8)).toBe(true); // the east leg, north of its line
      expect(covered(1.8, along)).toBe(true); // the north leg, east of its line
    }
  });
});

describe('bends between legs of unequal length', () => {
  it('a 100 m leg and a 20 m leg at a right-ish angle: the short leg keeps its width up to the corner', () => {
    const c = tileCenter(TILE);
    const latPerM = 1 / 111320, lonPerM = 1 / (111320 * Math.cos((c.lat * Math.PI) / 180));
    // south 100 m to the corner, then 20 m east and 3.5 m south (a turn of ~80°, mitred)
    const m = buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: surface, tin,
      data: {
        areas: [], points: [], buildings: [],
        lines: [{ points: [[c.lon, c.lat + 100 * latPerM], [c.lon, c.lat], [c.lon + 20 * lonPerM, c.lat - 3.5 * latPerM]], tags: { highway: 'service' } }],
      },
    });
    const [cx, cn] = latLonToEnu(c, c.lat, c.lon, 0);
    const covered = (e: number, n: number): boolean => {
      const px = cx + e, pz = -(cn + n);
      for (let v = 0; v + 2 < m.roads.vertexCount; v += 3) {
        if (withGlow(m.roads.ramps[v], 0) !== RAMP.ASPHALT) continue;
        const p = [0, 1, 2].map((k) => [m.roads.vertices[(v + k) * 6], m.roads.vertices[(v + k) * 6 + 2]]);
        const d = (a: number[], b: number[]) => (b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0]);
        const s1 = d(p[0], p[1]), s2 = d(p[1], p[2]), s3 = d(p[2], p[0]);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
      }
      return false;
    };
    // 1.8 m either side of the short leg's line, 3..10 m from the corner: on the 4 m road
    for (const along of [3, 6, 10]) {
      const n = -along * 0.175;
      expect(covered(along, n + 1.8)).toBe(true);
      expect(covered(along, n - 1.8)).toBe(true);
    }
  });
});

describe('car parks', () => {
  const c = tileCenter(TILE), b = tileBounds(TILE);
  const d = (b.east - b.west) * 0.1;
  const ring: [number, number][] = [[c.lon - d, c.lat - d / 2], [c.lon + d, c.lat - d / 2], [c.lon + d, c.lat + d / 2], [c.lon - d, c.lat + d / 2], [c.lon - d, c.lat - d / 2]];
  const meshOfArea = (tags: Record<string, string>) =>
    buildOsmMesh({ tile: TILE, detail: 'full', data: { areas: [{ rings: [ring], tags }], lines: [], points: [], buildings: [] }, sampleHeight: surface, tin });

  it('an open car park is asphalt, above the ground and under the roads', () => {
    const a = band(meshOfArea({ amenity: 'parking', parking: 'surface' }), RAMP.ASPHALT);
    expect(a.n).toBeGreaterThan(0);
    expect(a.y).toBeCloseTo(CAR_PARK_BIAS, 1);
    expect(band(meshOfArea({ amenity: 'parking' }), RAMP.ASPHALT).n).toBeGreaterThan(0);
  });

  it('one under the ground, in a building or on a roof is not drawn', () => {
    for (const parking of ['underground', 'multi-storey', 'rooftop']) expect(band(meshOfArea({ amenity: 'parking', parking }), RAMP.ASPHALT).n, parking).toBe(0);
    expect(band(meshOfArea({ amenity: 'parking', layer: '-1' }), RAMP.ASPHALT).n).toBe(0);
  });

  it('is fetched and parsed as an area, a closed way or a multipolygon', () => {
    const sel = parseFilter(osmFilter('full'));
    for (const type of ['way', 'relation'] as const) {
      expect(sel.some((s) => s.type === type && s.clauses.some((k) => k.key === 'amenity' && k.value === 'parking'))).toBe(true);
    }
    const nodes = ring.slice(0, 4).map(([lon, lat], i) => ({ type: 'node' as const, id: i + 1, lon, lat }));
    const data = parseOverpass({ elements: [...nodes, { type: 'way', id: 9, nodes: [1, 2, 3, 4, 1], tags: { amenity: 'parking' } }] });
    expect(data.areas).toHaveLength(1);
    expect(data.lines).toHaveLength(0);
  });
});
