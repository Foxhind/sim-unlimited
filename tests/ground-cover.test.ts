import { describe, expect, it } from 'vitest';
import { buildGroundCover, COVER_RANK, type CoverShape } from '../src/world/ground-cover';
import { gridLatLon, latLonToEnu, tileCenter } from '../src/world/geodesy';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildRoadLevels, coverLifted, LIFT_EPS_M } from '../src/world/road-levels';
import { buildRoadNet } from '../src/world/road-net';
import {
  data, edgeOffsetAtFork, forkFixture, GRID, M, metresOf, park, parkWithHole, pointOnLiftedApproach, pond, rail, railOverRoad, road,
  roadUnderRailBridge, square, TILE, trunkHalfWidth,
} from './roads-helpers';

/** the summed area of a shape's triangles, lattice cells² */
function triArea(s: CoverShape): number {
  let a = 0;
  for (let k = 0; k < s.tris.length; k += 6) {
    const [ax, ay, bx, by, cx, cy] = s.tris.subarray(k, k + 6);
    a += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return a;
}

/** the outline's polylines chained end to end into closed loops (each piece used once) */
function loops(outline: [number, number][][]): [number, number][][] {
  const rest = outline.map((l) => [...l]);
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  const out: [number, number][][] = [];
  while (rest.length) {
    const loop = rest.shift()!;
    for (let found = true; found && !near(loop[0], loop[loop.length - 1]);) {
      found = false;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i];
        if (near(l[0], loop[loop.length - 1])) loop.push(...l.slice(1));
        else if (near(l[l.length - 1], loop[loop.length - 1])) loop.push(...[...l].reverse().slice(1));
        else continue;
        rest.splice(i, 1);
        found = true;
        break;
      }
    }
    out.push(loop);
  }
  return out;
}
const shoelace = (r: [number, number][]): number => {
  let a = 0;
  for (let i = 0; i < r.length; i++) a += r[i][0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * r[i][1];
  return Math.abs(a) / 2;
};

describe('ground cover', () => {
  it('orders the shapes senior first', () => {
    const c = buildGroundCover(TILE, GRID, data([rail([[4, 32], [60, 32]]), road({ highway: 'primary' }, [[32, 4], [32, 60]])], [park(square(20, 20, 10))]));
    expect(c.shapes.map((s) => s.kind)).toEqual(['ballast', 'carriageway', 'shoulder', 'railZone', 'area']);
  });
  it('runs the rails over the road at a level crossing', () => {
    const c = buildGroundCover(TILE, GRID, data([rail([[4, 32], [60, 32]]), road({ highway: 'primary' }, [[32, 4], [32, 60]])]));
    expect(c.shapes[c.locate(32, 32)].kind).toBe('ballast');
  });
  it('lays the senior of two roads over the junior where they cross', () => {
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'residential' }, [[4, 32], [60, 32]]), road({ highway: 'primary' }, [[32, 4], [32, 60]])]));
    expect((c.shapes[c.locate(32, 32)].source as OsmLine).tags.highway).toBe('primary');
  });
  it('puts the asphalt edge of a fork branch on the trunk’s edge', () => {
    const c = buildGroundCover(TILE, GRID, data(forkFixture()));   // two-way trunk ending where two one-way branches begin
    expect(edgeOffsetAtFork(c, 'branch-right')).toBeCloseTo(trunkHalfWidth, 1);
  });
  it('leaves no cover on a bridge, and none past the start of a rail approach', () => {
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'primary', bridge: 'yes' }, [[10, 32], [54, 32]]), railOverRoad()]));
    expect(c.shapes.some((s) => (s.source as OsmLine).tags?.bridge === 'yes')).toBe(false);
    expect(c.locate(...pointOnLiftedApproach)).toBe(-1);   // Review Focus 3
    expect(c.shapes[c.locate(...roadUnderRailBridge)].kind).toBe('carriageway');
  });
  it('leaves the hole of a park with a pond to the pond', () => {   // Review Focus 2
    const c = buildGroundCover(TILE, GRID, data([], [parkWithHole(), pond()]));
    expect(c.shapes[c.locate(32, 32)].kind).toBe('water');
    expect(c.locate(32.01, 37.5)).not.toBe(-1);
  });
  it('gives a painted road’s faces the segment under them', () => {
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'primary' }, [[4, 32], [30, 32], [60, 40]])]));
    const p: [number, number] = [40, 32 + 8 / 3];   // on the second segment's centre line
    const s = c.shapes[c.locate(...p)];
    expect(s.kind).toBe('carriageway');
    // painted() splits the way at its middle (28.5 cells along, early in the second segment), so the
    // second segment is painted segments 1 and 2: p lies past the middle, q before it
    expect(s.attr!.segAt(...p)).toBe(2);
    const q: [number, number] = [31, 32 + 8 / 30];
    expect(c.shapes[c.locate(...q)]).toBe(s);
    expect(s.attr!.segAt(...q)).toBe(1);
  });

  it('leaves the hole of a park out of the park’s own triangles', () => {
    const c = buildGroundCover(TILE, GRID, data([], [parkWithHole()]));
    expect(c.shapes.map((s) => s.kind)).toEqual(['area']);
    expect(c.locate(32, 32)).toBe(-1);
    expect(c.locate(32, 40)).toBe(0);
    expect(triArea(c.shapes[0])).toBeCloseTo(24 * 24 - 11 * 11, 6);
    // an outline of the outer ring and one of the hole
    expect(loops(c.shapes[0].outline).map(shoelace).sort((a, b) => a - b)).toEqual([expect.closeTo(121, 6), expect.closeTo(576, 6)]);
  });
  it('closes the outline of a straight road with round caps round exactly its triangles', () => {
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'service' }, [[10, 32], [50, 32]])]));
    const s = c.shapes.find((sh) => sh.kind === 'carriageway')!;
    expect(s.outline.length).toBeGreaterThan(0);
    const ls = loops(s.outline);
    expect(ls.length).toBe(1);
    // the body and a half 12-gon at each end: 2 r L + 3 r²
    const r = 2 * M;
    expect(shoelace(ls[0])).toBeCloseTo(2 * r * 40 + 3 * r * r, 6);
    expect(s.attr).toBeUndefined();
    expect(s.prio).toBeGreaterThan(0);
  });
  it('ends the ballast where the approach starts to rise, square', () => {
    const lines = railOverRoad();
    const c = buildGroundCover(TILE, GRID, data(lines));
    const west = c.shapes.find((s) => s.kind === 'ballast' && s.source === lines[0])!;
    expect(west.outline.length).toBeGreaterThan(0);
    // where the lift starts on the western approach (metres along it)
    const enu = (lon: number, lat: number): [number, number] => { const [e, n] = latLonToEnu(tileCenter(TILE), lat, lon, 0); return [e, -n]; };
    const levels = buildRoadLevels(lines, [], ([lon, lat]) => enu(lon, lat));
    const [x0] = metresOf(...lines[0].points[0]);
    let d = 0;
    while (levels.liftAt(lines[0], d) < LIFT_EPS_M) d += 0.05;
    let east = -Infinity;
    for (let k = 0; k < west.tris.length; k += 2) east = Math.max(east, west.tris[k]);
    expect(Math.abs(east / M - (x0 + d))).toBeLessThan(0.6);
    // the way's last 2.8 cells or so are lifted: the ballast stops well short of the bridge
    expect(east).toBeLessThan(18);
    // and the zone ends with it
    const zone = c.shapes.find((s) => s.kind === 'railZone' && s.source === lines[0])!;
    let zEast = -Infinity;
    for (let k = 0; k < zone.tris.length; k += 2) zEast = Math.max(zEast, zone.tris[k]);
    expect(Math.abs(zEast - east)).toBeLessThan(1e-9);
  });
  it('gives the ballast the track’s attributes, segment by segment', () => {
    const c = buildGroundCover(TILE, GRID, data([rail([[4, 20], [30, 20], [60, 26]])]));
    const s = c.shapes[c.locate(45, 23)];
    expect(s.kind).toBe('ballast');
    expect(s.attr!.segs.length).toBe(2);
    expect(s.attr!.segAt(45, 23)).toBe(1);
    expect(s.attr!.segAt(10, 20)).toBe(0);
  });
  it('a pitch carries its paint, a helipad point a 16 m square', () => {
    const w = 100 * M, h = 64 * M;
    const pitch: OsmArea = { tags: { leisure: 'pitch', sport: 'soccer' }, rings: [[[30, 30], [30 + w, 30], [30 + w, 30 + h], [30, 30 + h]].map(([x, y]) => { const ll = gridLatLon(TILE, x, y, GRID); return [ll.lon, ll.lat]; })] };
    const ll = gridLatLon(TILE, 20, 32, GRID);
    const pad: OsmPoint = { at: [ll.lon, ll.lat], tags: { aeroway: 'helipad' } };
    const c = buildGroundCover(TILE, GRID, data([], [pitch], [pad]));
    expect(c.shapes.map((s) => s.kind)).toEqual(['aeroArea', 'pitchPaint', 'pitch']);
    expect(triArea(c.shapes[0])).toBeCloseTo(256 * M * M, 4);
    const paint = c.shapes[1];
    expect(paint.source).toBe(pitch);
    // the touch lines: 0.12 m strips along the pitch's sides
    expect(c.locate(30 + w / 4, 30 + 0.03 * M)).toBe(1);
    expect(c.locate(30 + w / 4, 30 + h / 4)).toBe(2);
    expect(paint.outline.length).toBeGreaterThan(0);
  });
  it('skips what lies wholly outside the tile', () => {
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'primary' }, [[-40, -10], [-20, -10]]), rail([[70, 70], [90, 70]])], [park(square(-20, 30, 5))]));
    expect(c.shapes).toEqual([]);
    expect(c.locate(32, 32)).toBe(-1);
  });
  it('ranks the covers as the plan does', () => {
    expect(Object.entries(COVER_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k)).toEqual([
      'runway', 'ballast', 'carriageway', 'shoulder', 'path', 'water', 'railZone', 'aeroArea', 'carPark', 'pitchPaint', 'pitch', 'area',
    ]);
  });
});

describe('coverLifted', () => {
  const enu = (lon: number, lat: number): [number, number] => { const [e, n] = latLonToEnu(tileCenter(TILE), lat, lon, 0); return [e, -n]; };
  const lines = railOverRoad();
  const plain = buildRoadLevels(lines, [], ([lon, lat]) => enu(lon, lat));
  it('without the roads’ heights: lifted where the levels lift it', () => {
    const lifted = coverLifted(undefined, plain);
    expect(lifted(lines[0], 0)).toBe(false);
    expect(lifted(lines[1], 10)).toBe(true);
    const len = metresOf(...lines[0].points[1])[0] - metresOf(...lines[0].points[0])[0];
    expect(lifted(lines[0], len - 1)).toBe(true);
  });
  it('a way of the network with heights: lifted only on a bridge', () => {
    const roadBridge = road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [[30, 6], [30, 8]]);
    const approach = road({ highway: 'tertiary' }, [[30, 8], [30, 20]]);
    const under = road({ highway: 'primary' }, [[25, 7], [35, 7]]);
    const all = [roadBridge, approach, under];
    const levels = buildRoadLevels(all, [], ([lon, lat]) => enu(lon, lat));
    expect(levels.liftAt(approach, 1)).toBeGreaterThan(LIFT_EPS_M);
    const net = buildRoadNet(all);
    const lifted = coverLifted({ net, z: new Float64Array(net.samples.length).fill(100) }, levels);
    expect(lifted(approach, 1)).toBe(false);
    expect(lifted(roadBridge, 1)).toBe(true);
    // without a height the network's way lifts as without them
    const holed = new Float64Array(net.samples.length).fill(100);
    const k = net.ways.findIndex((w) => w.line === approach);
    holed[net.ways[k].first] = NaN;
    expect(coverLifted({ net, z: holed }, levels)(approach, 1)).toBe(true);
  });
});
