import { describe, expect, it } from 'vitest';
import type { LonLat, OsmArea, OsmLine } from '../src/world/osm-types';
import { buildRoadLevels, LEVEL_M, LIFT_EPS_M, LIFT_GRADE, LIFT_REACH_M, STREAM_CLEAR_M, WATER_CLEAR_M } from '../src/world/road-levels';

/** points are given in metres (x east, y north) and stored as "degrees" of 1e-5 */
const P = (x: number, y: number): LonLat => [x / 1e5, y / 1e5];
const xz = ([lon, lat]: LonLat): [number, number] => [lon * 1e5, -lat * 1e5];
const way = (tags: Record<string, string>, ...pts: [number, number][]): OsmLine => ({ tags, points: pts.map(([x, y]) => P(x, y)) });
const levels = (lines: OsmLine[], areas: OsmArea[] = []) => buildRoadLevels(lines, areas, xz);

const BRIDGE = { highway: 'primary', bridge: 'yes' };
/** half the width of the secondary road under the bridges below */
const LOWER_HALF = 5.5;
const lowerRoad = (x: number, tags: Record<string, string> = { highway: 'secondary' }) => way(tags, [x, -100], [x, 100]);

describe('road levels', () => {
  it('no bridge, no lift', () => {
    const a = way({ highway: 'primary' }, [0, 0], [400, 0]), b = lowerRoad(200);
    const l = levels([a, b]);
    expect(l.maxLift(a)).toBe(0);
    expect(l.maxLift(b)).toBe(0);
  });

  it('a bridge over a road is LEVEL_M up at the crossing', () => {
    const bridge = way(BRIDGE, [0, 0], [400, 0]), lower = lowerRoad(200);
    const l = levels([bridge, lower]);
    expect(l.liftAt(bridge, 200)).toBeCloseTo(LEVEL_M, 2);
    expect(l.liftAt(bridge, 200 + LOWER_HALF)).toBeCloseTo(LEVEL_M, 2);
    expect(Math.abs(l.liftAt(bridge, 250) - (LEVEL_M - LIFT_GRADE * (50 - LOWER_HALF)))).toBeLessThan(0.05);
    expect(l.liftAt(bridge, 0)).toBe(0);
    expect(l.maxLift(lower)).toBe(0);
    expect(l.maxLift(bridge)).toBeCloseTo(LEVEL_M, 2);
  });

  it('the approach carries the lift onto the next way', () => {
    const west = way({ highway: 'primary' }, [-20, 0], [180, 0]);
    const bridge = way(BRIDGE, [180, 0], [220, 0]);
    const east = way({ highway: 'primary' }, [220, 0], [420, 0]);
    const l = levels([west, bridge, east, lowerRoad(200)]);
    expect(l.liftAt(west, 190)).toBeGreaterThan(3);
    expect(l.liftAt(west, 190)).toBeLessThan(LEVEL_M);
    expect(l.liftAt(west, 100)).toBe(0);
    expect(l.liftAt(west, 200)).toBeCloseTo(l.liftAt(bridge, 0), 6);
    expect(l.liftAt(east, 0)).toBeCloseTo(l.liftAt(bridge, 40), 6);
    expect(l.liftAt(east, 10)).toBeCloseTo(l.liftAt(west, 190), 6);
  });

  it('water: 4 m over a river, 1.5 m over a stream, none over a ditch', () => {
    const over = (tags: Record<string, string>) => {
      const bridge = way(BRIDGE, [0, 0], [400, 0]);
      return levels([bridge, way(tags, [200, -100], [200, 100])]).maxLift(bridge);
    };
    expect(over({ waterway: 'river' })).toBeCloseTo(WATER_CLEAR_M, 2);
    expect(over({ waterway: 'canal' })).toBeCloseTo(WATER_CLEAR_M, 2);
    expect(over({ waterway: 'stream' })).toBeCloseTo(STREAM_CLEAR_M, 2);
    expect(over({ waterway: 'ditch' })).toBe(0);
  });

  it('water area: held across the whole span', () => {
    const bridge = way(BRIDGE, [0, 0], [600, 0]);
    const lake: OsmArea = { tags: { natural: 'water' }, rings: [[P(200, -80), P(400, -80), P(400, 80), P(200, 80), P(200, -80)]] };
    const l = levels([bridge], [lake]);
    expect(l.liftAt(bridge, 300)).toBeGreaterThanOrEqual(3.5);
    expect(l.liftAt(bridge, 200)).toBeCloseTo(WATER_CLEAR_M, 2);
    expect(l.liftAt(bridge, 100)).toBe(0);
  });

  it('stacked: a level-2 bridge over a level-1 bridge is 12 m up', () => {
    const top = way({ ...BRIDGE, layer: '2' }, [0, 0], [400, 0]);
    const lower = lowerRoad(200, { highway: 'secondary', bridge: 'yes' });
    const l = levels([top, lower]);
    expect(l.liftAt(top, 200)).toBeCloseTo(2 * LEVEL_M, 2);
    expect(l.maxLift(lower)).toBeLessThanOrEqual(LEVEL_M);
  });

  it('steeper past 12 m so the reach stays LIFT_REACH_M', () => {
    const top = way({ ...BRIDGE, layer: '3' }, [0, 0], [800, 0]);
    const lower = lowerRoad(400, { highway: 'secondary', bridge: 'yes', layer: '2' });
    const l = levels([top, lower]);
    expect(l.liftAt(top, 400)).toBeCloseTo(3 * LEVEL_M, 2);
    expect(l.liftAt(top, 400 + LOWER_HALF + (2 * LEVEL_M * LIFT_REACH_M) / (3 * LEVEL_M))).toBeCloseTo(LEVEL_M, 1);
    expect(l.liftAt(top, 400 + LOWER_HALF + LIFT_REACH_M)).toBeCloseTo(0, 6);
    expect(l.liftAt(top, 400 + LOWER_HALF + LIFT_REACH_M + 20)).toBe(0);
  });

  it('a way cut into pieces lifts like the whole way', () => {
    const whole = way(BRIDGE, [0, 0], [130, 0], [270, 0], [400, 0]);
    const pieces = [way(BRIDGE, [0, 0], [130, 0]), way(BRIDGE, [130, 0], [270, 0]), way(BRIDGE, [270, 0], [400, 0])];
    const a = levels([whole, lowerRoad(200)]), b = levels([...pieces, lowerRoad(200)]);
    for (const [piece, start] of [[0, 0], [1, 130], [2, 270]] as const) {
      for (const d of [0, 40, 70, 100, 130]) {
        expect(b.liftAt(pieces[piece], d)).toBeCloseTo(a.liftAt(whole, start + d), 6);
      }
    }
  });

  it('a junction on the bridge asks for nothing', () => {
    const bridge = way(BRIDGE, [0, 0], [200, 0], [400, 0]);
    const joining = way({ highway: 'secondary' }, [200, 0], [200, 100]);
    expect(levels([bridge, joining]).maxLift(bridge)).toBe(0);
  });

  it('tunnels, paths, ditches and piped water under a bridge ask for nothing', () => {
    for (const tags of [
      { highway: 'secondary', tunnel: 'yes', layer: '-1' }, { highway: 'footway' }, { highway: 'path' }, { highway: 'steps' },
      { waterway: 'drain' }, { waterway: 'stream', tunnel: 'culvert' }, { waterway: 'river', location: 'underground' },
    ] as Record<string, string>[]) {
      const bridge = way(BRIDGE, [0, 0], [400, 0]);
      expect(levels([bridge, way(tags, [200, -100], [200, 100])]).maxLift(bridge), JSON.stringify(tags)).toBe(0);
    }
  });

  it('roads of the same or a higher level under a bridge ask for nothing', () => {
    const bridge = way(BRIDGE, [0, 0], [400, 0]);
    expect(levels([bridge, lowerRoad(200, { highway: 'secondary', bridge: 'yes' })]).maxLift(bridge)).toBe(0);
    expect(levels([bridge, lowerRoad(200, { highway: 'secondary', layer: '2' })]).maxLift(bridge)).toBe(0);
  });

  it('survives repeated points and closed ways', () => {
    const repeated = way(BRIDGE, [0, 0], [100, 0], [100, 0], [400, 0]);
    const ring = way({ ...BRIDGE, junction: 'roundabout' }, [150, -50], [250, -50], [250, 50], [150, 50], [150, -50]);
    const lower = way({ highway: 'secondary' }, [0, -20], [400, -20.5]);
    const l = levels([repeated, ring, lower, lowerRoad(200)]);
    for (const line of [repeated, ring]) {
      for (let d = -10; d <= 420; d += 7) expect(Number.isFinite(l.liftAt(line, d))).toBe(true);
    }
    expect(l.maxLift(repeated)).toBeCloseTo(LEVEL_M, 2);
    expect(l.maxLift(ring)).toBeCloseTo(LEVEL_M, 2);
    expect(l.liftAt({ tags: {}, points: [] }, 5)).toBe(0);
  });

  it('paths bridge too', () => {
    const foot = way({ highway: 'footway', bridge: 'yes' }, [0, 0], [400, 0]);
    expect(levels([foot, lowerRoad(200, { highway: 'primary' })]).maxLift(foot)).toBeCloseTo(LEVEL_M, 2);
  });

  it('rails: over a road and under one', () => {
    const rail = way({ railway: 'rail', bridge: 'yes' }, [0, 0], [400, 0]);
    expect(levels([rail, lowerRoad(200)]).maxLift(rail)).toBeCloseTo(LEVEL_M, 2);
    const bridge = way(BRIDGE, [0, 0], [400, 0]);
    expect(levels([bridge, way({ railway: 'rail' }, [200, -100], [200, 100])]).maxLift(bridge)).toBeCloseTo(LEVEL_M, 2);
  });

  it('steps and paths do not carry a road\'s lift down to the road under the bridge', () => {
    const bridge = way(BRIDGE, [0, 0], [185, 0], [400, 0]);
    const lower = way({ highway: 'secondary' }, [200, -100], [200, -15], [200, 100]);
    const steps = way({ highway: 'steps' }, [185, 0], [200, -15]);
    const l = levels([bridge, lower, steps]);
    expect(l.maxLift(bridge)).toBeCloseTo(LEVEL_M, 2);
    expect(l.maxLift(lower)).toBe(0);
    expect(l.maxLift(steps)).toBe(0);
  });

  it('a footbridge lifts the paths that join it, not the roads', () => {
    const foot = way({ highway: 'footway', bridge: 'yes' }, [180, 0], [220, 0]);
    const path = way({ highway: 'footway' }, [100, 0], [180, 0]);
    const street = way({ highway: 'residential' }, [220, 0], [300, 0]);
    const l = levels([foot, path, street, lowerRoad(200, { highway: 'primary' })]);
    expect(l.liftAt(path, 80)).toBeGreaterThan(4);
    expect(l.maxLift(street)).toBe(0);
  });

  it('roads and railways do not carry each other\'s lift over a level crossing', () => {
    const bridge = way(BRIDGE, [0, 0], [170, 0], [400, 0]);
    const rail = way({ railway: 'rail' }, [170, -100], [170, 0], [170, 100]);
    const l = levels([bridge, rail, lowerRoad(200)]);
    expect(l.liftAt(bridge, 170)).toBeGreaterThan(3);
    expect(l.maxLift(rail)).toBe(0);
  });

  it('a bridge holds its height between two crossings near each other', () => {
    const bridge = way(BRIDGE, [0, 0], [600, 0]);
    const l = levels([bridge, lowerRoad(200), lowerRoad(270)]);
    for (let d = 200; d <= 270; d += 10) expect(l.liftAt(bridge, d), `at ${d}`).toBeGreaterThan(LEVEL_M - 0.01);
    // past the last crossing it comes down at the grade as ever
    expect(Math.abs(l.liftAt(bridge, 320) - (LEVEL_M - LIFT_GRADE * (50 - LOWER_HALF)))).toBeLessThan(0.05);
  });

  it('held across the ways a bridge is split into, and sloping evenly between unlike crossings', () => {
    const a = way(BRIDGE, [0, 0], [250, 0]), b = way(BRIDGE, [250, 0], [600, 0]);
    const river = way({ waterway: 'river', width: '2' }, [300, -100], [300, 100]);
    const l = levels([a, b, lowerRoad(240), river]);
    // 6 m over the road and level on to the bridge's next vertex (250), 4 m at the river's near
    // bank (299): even in between
    const at = (d: number) => (d <= 250 ? l.liftAt(a, d) : l.liftAt(b, d - 250));
    const even = (d: number) => (d <= 250 ? LEVEL_M : LEVEL_M + ((WATER_CLEAR_M - LEVEL_M) * (d - 250)) / (299 - 250));
    // (the far bank's ask, 2 m on, bends the last metres by up to 0.07 m)
    for (const d of [245, 250, 265, 280, 299]) expect(Math.abs(at(d) - even(d)), `at ${d}`).toBeLessThan(0.1);
    expect(l.liftAt(a, 250)).toBeCloseTo(l.liftAt(b, 0), 6);
  });

  it('a short bridge is level from end to end: the approaches do the climbing', () => {
    const west = way({ highway: 'primary' }, [-100, 0], [180, 0]);
    const bridge = way(BRIDGE, [180, 0], [220, 0]);
    const east = way({ highway: 'primary' }, [220, 0], [500, 0]);
    const l = levels([west, bridge, east, lowerRoad(200)]);
    for (let d = 0; d <= 40; d += 10) expect(l.liftAt(bridge, d), `at ${d}`).toBeCloseTo(LEVEL_M, 2);
    expect(l.liftAt(west, 280 - 25)).toBeCloseTo(LEVEL_M - LIFT_GRADE * 25, 2);
    // the level stretch and the fall after it stay within the reach
    expect(l.liftAt(east, LEVEL_M / LIFT_GRADE)).toBe(0);
    expect(220 - 205.5 + LEVEL_M / LIFT_GRADE).toBeLessThanOrEqual(LIFT_REACH_M);
  });

  it('a long bridge is level only as far as the reach allows', () => {
    const bridge = way(BRIDGE, [0, 0], [100, 0], [300, 0], [400, 0]);
    const l = levels([bridge, lowerRoad(200)]);
    // its ends are 200 m from the crossing: beyond what a tile by them could see
    expect(l.liftAt(bridge, 0)).toBe(0);
    expect(l.liftAt(bridge, 100)).toBeLessThan(1);
  });

  it('a higher bridge has less room to stay level (the fall takes more of the reach)', () => {
    const west = way({ highway: 'primary' }, [-100, 0], [140, 0]);
    const top = way({ ...BRIDGE, layer: '2' }, [140, 0], [270, 0]);
    const l = levels([west, top, lowerRoad(200, { highway: 'secondary', bridge: 'yes' })]);
    expect(l.liftAt(top, 60)).toBeCloseTo(2 * LEVEL_M, 2);
    expect(l.liftAt(top, 0)).toBeLessThan(2 * LEVEL_M - 3);
    expect(l.liftAt(west, 240 - 100)).toBe(0);
  });

  it('crossings further apart than the reach are two humps', () => {
    const bridge = way(BRIDGE, [0, 0], [800, 0]);
    const l = levels([bridge, lowerRoad(200), lowerRoad(500)]);
    expect(l.liftAt(bridge, 350)).toBe(0);
  });

  it('nothing is held along a road that is not a bridge', () => {
    const west = way(BRIDGE, [0, 0], [210, 0]), mid = way({ highway: 'primary' }, [210, 0], [310, 0]), east = way(BRIDGE, [310, 0], [600, 0]);
    const l = levels([west, mid, east, lowerRoad(200), lowerRoad(320)]);
    expect(l.liftAt(mid, 50)).toBeLessThan(LEVEL_M - 2);
  });

  it('liftNear: by the tags object and a point beside the way', () => {
    const bridge = way(BRIDGE, [0, 0], [400, 0]);
    const l = levels([bridge, lowerRoad(200)]);
    expect(l.liftNear(bridge.tags, 200, 3)).toBeCloseTo(LEVEL_M, 2);
    expect(l.liftNear(bridge.tags, 250, -4)).toBeCloseTo(l.liftAt(bridge, 250), 6);
    expect(l.liftNear({ highway: 'primary' }, 200, 0)).toBe(0);
  });
});

describe('clearance between the roads’ own heights', () => {
  const bridge = way(BRIDGE, [0, 0], [400, 0]), under = lowerRoad(200);
  it('reaches 90 m along the roads', () => { expect(LIFT_REACH_M).toBe(90); });
  it('lifts a bridge by what is left to the clearance over the road under it', () => {
    // the bridge's own height 3 m over the lower road's at the crossing: 3 m more makes LEVEL_M
    const l = buildRoadLevels([bridge, under], [], xz, { height: (line) => (line === bridge ? 503 : 500) });
    expect(l.maxLift(bridge)).toBeCloseTo(LEVEL_M - 3, 2);
  });
  it('lifts nothing where the bridge already clears the road under it', () => {
    const l = buildRoadLevels([bridge, under], [], xz, { height: (line) => (line === bridge ? 510 : 500) });
    expect(l.maxLift(bridge)).toBeLessThan(LIFT_EPS_M);
  });
  it('reads the heights where the two cross', () => {
    // the lower road climbs north at 10 %: at the crossing (100 m from its start) it is at 510
    const l = buildRoadLevels([bridge, under], [], xz, { height: (line, d) => (line === bridge ? 500 : 500 + 0.1 * d) });
    expect(l.liftAt(bridge, 200)).toBeCloseTo(10 + LEVEL_M, 1);
  });
  it('lifts as before without heights, or where a height is missing', () => {
    expect(buildRoadLevels([bridge, under], [], xz).maxLift(bridge)).toBeCloseTo(LEVEL_M, 2);
    expect(buildRoadLevels([bridge, under], [], xz, { height: () => NaN }).maxLift(bridge)).toBeCloseTo(LEVEL_M, 2);
  });
});
