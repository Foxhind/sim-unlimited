import { describe, expect, it } from 'vitest';
import { LIGHT } from '../src/engine/palette';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildCranes, CRANE, craneKind, craneOnWay, RAIL_TAG } from '../src/world/crane-mesher';
import type { LonLat, OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9545, y: 4771 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const flat = () => 5;

function col(v: Float32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += 6) out.push(v[i]);
  return out;
}

/** every face's normal agrees with its winding (counter-clockwise from outside) */
function windingAgrees(v: Float32Array): boolean {
  for (let t = 0; t < v.length; t += 18) {
    const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
    if (n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5] <= 0) return false;
  }
  return true;
}

/** the sea to the east: a coastline running north–south 40 m east of the tile's centre */
const COAST: OsmLine = { tags: { natural: 'coastline' }, points: [at(40, -300), at(40, 300)] };

describe('craneKind', () => {
  it('by crane:type; untyped, a portal crane by the water and a tower crane inland', () => {
    expect(craneKind({ 'crane:type': 'tower_crane' }, true)).toBe('tower');
    expect(craneKind({ 'crane:type': 'portal_crane' }, false)).toBe('portal');
    expect(craneKind({ 'crane:type': 'gantry_crane' }, true)).toBe('quay_gantry');
    expect(craneKind({ 'crane:type': 'gantry_crane' }, false)).toBe('yard_gantry');
    expect(craneKind({ 'crane:type': 'floor-mounted_crane' }, false)).toBe('jib');
    expect(craneKind({ 'crane:type': 'travel_lift' }, true)).toBe('travel_lift');
    expect(craneKind({}, true)).toBe('portal');
    expect(craneKind({}, false)).toBe('tower');
  });
});

describe('buildCranes', () => {
  it('a tower crane: its mast to the tagged height, its head over it, red lights on top and at the jib’s tip', () => {
    const m = buildCranes(TILE, [{ at: at(0, 0), tags: { man_made: 'crane', 'crane:type': 'tower_crane', height: '50' } }], [], [], flat);
    const y = col(m.vertices, 1);
    expect(Math.max(...y)).toBeCloseTo(5 + 50 + 1.2 + CRANE.TOWER.HEAD_M, 0);
    expect(m.beacons.length).toBe(8);
    expect(m.beacons[3]).toBe(LIGHT.RED);
    // the jib reaches its share of the mast out from it
    const x = col(m.vertices, 0), z = col(m.vertices, 2);
    const reach = Math.max(...x.map((xx, i) => Math.hypot(xx, z[i])));
    expect(reach).toBeGreaterThan(50 * CRANE.TOWER.JIB_SHARE - 1);
    expect(windingAgrees(m.vertices)).toBe(true);
    // a far line from the ground to the top
    expect(m.lines[1]).toBe(5);
    expect(m.lines[5]).toBeCloseTo(Math.max(...y), 0);
  });

  it('an untyped crane by the water is a portal crane, its boom out over the water', () => {
    const m = buildCranes(TILE, [{ at: at(0, 0), tags: { man_made: 'crane' } }], [COAST], [], flat);
    const x = col(m.vertices, 0), y = col(m.vertices, 1);
    // the boom's tip, the highest-reaching far end, is east (toward the coast)
    expect(Math.max(...x)).toBeGreaterThan(25);
    expect(Math.min(...x)).toBeGreaterThan(-15);
    expect(Math.max(...y)).toBeGreaterThan(5 + 25);
    expect(windingAgrees(m.vertices)).toBe(true);
  });

  it('a crane on its rails turns its boom square to them, to the water’s side', () => {
    // rails along the quay (north–south), the coast east
    const rail: OsmPoint = { at: at(0, 0), tags: { man_made: 'crane', 'crane:type': 'portal_crane', [RAIL_TAG]: '0' } };
    const m = buildCranes(TILE, [rail], [{ tags: { natural: 'coastline' }, points: [at(30, -300), at(60, 300)] }], [], flat);
    const z = col(m.vertices, 2), x = col(m.vertices, 0);
    // square to the rails: the boom runs east, not toward the slanted coast's nearest point
    const tip = x.indexOf(Math.max(...x));
    expect(Math.abs(z[tip])).toBeLessThan(3);
  });

  it('a container gantry over the quay: tall, its boom far out over the water; a lone one inland is a yard gantry', () => {
    const quay = buildCranes(TILE, [{ at: at(0, 0), tags: { man_made: 'crane', 'crane:type': 'gantry_crane' } }], [COAST], [], flat);
    const x = col(quay.vertices, 0), y = col(quay.vertices, 1);
    expect(Math.max(...y)).toBeCloseTo(5 + CRANE.QUAY_GANTRY.HEIGHT_M, 0);
    expect(Math.max(...x)).toBeGreaterThan(CRANE.QUAY_GANTRY.GAUGE_M / 2 + CRANE.QUAY_GANTRY.OUTREACH_M - 2);
    expect(windingAgrees(quay.vertices)).toBe(true);
    const yard = buildCranes(TILE, [{ at: at(0, 0), tags: { man_made: 'crane', 'crane:type': 'gantry_crane' } }], [], [], flat);
    expect(Math.max(...col(yard.vertices, 1))).toBeLessThan(5 + CRANE.YARD_GANTRY.HEIGHT_M + 4);
    expect(windingAgrees(yard.vertices)).toBe(true);
  });

  it('water areas and docks count as the water; only the tile’s own cranes', () => {
    const dock: OsmArea = { tags: { waterway: 'dock' }, rings: [[at(20, -50), at(80, -50), at(80, 50), at(20, 50), at(20, -50)]] };
    const m = buildCranes(TILE, [{ at: at(0, 0), tags: { man_made: 'crane' } }], [], [dock], flat);
    expect(Math.max(...col(m.vertices, 0))).toBeGreaterThan(25);
    const far = buildCranes(TILE, [{ at: at(5000, 0), tags: { man_made: 'crane' } }], [], [], flat);
    expect(far.vertices.length).toBe(0);
  });

  it('jib cranes and travel lifts stand too, their faces wound outward', () => {
    for (const t of ['floor-mounted_crane', 'travel_lift']) {
      const m = buildCranes(TILE, [{ at: at(0, 0), tags: { man_made: 'crane', 'crane:type': t } }], [], [], flat);
      expect(m.vertices.length).toBeGreaterThan(0);
      expect(windingAgrees(m.vertices)).toBe(true);
    }
  });
});

describe('cranes from OSM', () => {
  it('are fetched as nodes and ways', () => {
    const q = overpassQuery(TILE, 'full');
    expect(q).toContain('node["man_made"="crane"]');
    expect(q).toContain('way["man_made"="crane"]');
  });

  it('a crane along its rails stands at their middle with their bearing; one by its footprint along its longest edge', () => {
    const rails = craneOnWay([at(0, 0), at(0, 100)], { man_made: 'crane' });
    expect(rails.at[1]).toBeCloseTo(at(0, 50)[1], 7);
    expect(parseFloat(rails.tags[RAIL_TAG])).toBeCloseTo(0, 0);
    const box = craneOnWay([at(0, 0), at(30, 0), at(30, 10), at(0, 10), at(0, 0)], { man_made: 'crane' });
    expect(box.at[0]).toBeCloseTo(at(15, 5)[0], 7);
    expect(parseFloat(box.tags[RAIL_TAG]) % 180).toBeCloseTo(90, 0);
    const d = parseOverpass({ elements: [
      { type: 'node', id: 1, lat: 0, lon: 0 }, { type: 'node', id: 2, lat: 0.001, lon: 0 },
      { type: 'way', id: 10, nodes: [1, 2], tags: { man_made: 'crane', 'crane:type': 'portal_crane' } },
    ] });
    expect(d.points).toHaveLength(1);
    expect(d.points[0].tags[RAIL_TAG]).toBeDefined();
    expect(d.lines).toHaveLength(0);
  });
});
