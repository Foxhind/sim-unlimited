import { describe, expect, it } from 'vitest';
import { buildGroundCover, COVER_RANK, type CoverShape } from '../src/world/ground-cover';
import { enuToLatLon, gridLatLon, latLonToEnu, tileCenter, tileLattice } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildRoadLevels, coverLifted, LIFT_EPS_M } from '../src/world/road-levels';
import { capSides } from '../src/world/ribbon-shapes';
import { buildRoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { classifyLine } from '../src/world/way-styles';
import { ROAD_TAPER_M } from '../src/engine/palette';
import {
  data, demOf, edgeOffsetAtFork, forkFixture, GRID, M, metresOf, park, parkWithHole, pointOnLiftedApproach, pond, rail, railOverRoad, road,
  roadUnderRailBridge, square, TILE, trunkHalfWidth,
} from './roads-helpers';

/** the roads of `lines` with heights over a flat 100 m relief */
function roadsOf(lines: OsmLine[]) {
  const net = buildRoadNet(lines);
  return { net, z: solveRoadHeights(net, demOf(net, () => 100)) };
}
/** ENU metres (x east, z south) about TILE's centre */
const enuOf = ([lon, lat]: [number, number]): [number, number] => {
  const [e, n] = latLonToEnu(tileCenter(TILE), lat, lon, 0);
  return [e, -n];
};

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
  it('leaves no cover on a lifted bridge, and none past the start of a rail approach', () => {
    // the bridge over a road: lifted (a bridge over nothing the levels leave on the ground)
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'primary', bridge: 'yes' }, [[10, 32], [54, 32]]), road({ highway: 'tertiary' }, [[32, 20], [32, 44]]), railOverRoad()]));
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
  it('rounds a path’s dead ends to 5 cm, a wide road’s with twelve sides', () => {
    const c = buildGroundCover(TILE, GRID, data([road({ highway: 'footway' }, [[10, 32], [20, 32]]), road({ highway: 'service' }, [[10, 40], [20, 40]])]));
    const path = c.shapes.find((sh) => sh.kind === 'path')!, asphalt = c.shapes.find((sh) => sh.kind === 'carriageway')!;
    const half = classifyLine({ highway: 'footway' })!.width / 2;
    expect(path.tris.length / 6).toBe(2 + 2 * capSides(half, 0.05));
    expect(capSides(half, 0.05)).toBeLessThan(12);
    expect(asphalt.tris.length / 6).toBe(2 + 2 * 12);
  });
  it('cuts a road across only where it turns or its paint or width bends, and drops the points its edges run straight through', () => {
    // an unpainted lane through a node on its straight line, then bending at another
    const lane = road({ highway: 'service' }, [[10, 32], [20, 32], [30, 32], [40, 36]]);
    // a painted road (a vertex at its middle, where u turns) narrowing into the way that continues it
    const wide = road({ highway: 'trunk', oneway: 'yes', lanes: '5' }, [[10, 48], [30, 48]]);
    const narrow = road({ highway: 'trunk', oneway: 'yes', lanes: '4' }, [[30, 48], [50, 48]]);
    const c = buildGroundCover(TILE, GRID, data([lane, wide, narrow]));
    const asphalt = (way: OsmLine) => c.shapes.find((sh) => sh.kind === 'carriageway' && sh.source === way)!;
    /** the x of each cut's middle (two points across the centre line's y), between the way's ends */
    const cuts = (way: OsmLine, y: number, from: number, to: number) => asphalt(way).outline
      .filter((l) => l.length === 2 && Math.abs(l[0][0] - l[1][0]) < 0.5 && Math.abs((l[0][1] + l[1][1]) / 2 - y) < 1e-6)
      .map((l) => (l[0][0] + l[1][0]) / 2).filter((x) => x > from + 0.5 && x < to - 0.5).sort((a, b) => a - b);
    expect(cuts(lane, 32, 10, 40)).toEqual([expect.closeTo(30, 9)]);
    // the lane's sides have no point at the straight node
    expect(asphalt(lane).outline.flat().some((p) => Math.abs(p[0] - 20) < 0.5)).toBe(false);
    // the wide road: its middle, and where it starts to narrow (ROAD_TAPER_M before its end)
    expect(cuts(wide, 48, 10, 30)).toEqual([expect.closeTo(20, 9), expect.closeTo(30 - ROAD_TAPER_M * M, 2)]);
    expect(cuts(narrow, 48, 30, 50)).toEqual([expect.closeTo(40, 9)]);
    // an area's ring loses a point on a straight side
    const p = buildGroundCover(TILE, GRID, data([], [park([[10, 10], [15, 10], [20, 10], [20, 20], [10, 20]])])).shapes[0];
    expect(p.outline).toEqual([[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]].map(([x, y]) => [expect.closeTo(x, 9), expect.closeTo(y, 9)])]);
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
  it('lays the pitch paint under every line the mesh draws of it, soccer and baseball', () => {
    const lls = (pts: [number, number][]) => pts.map(([x, y]): [number, number] => { const p = gridLatLon(TILE, x, y, GRID); return [p.lon, p.lat]; });
    const c0 = Math.cos(0.3), s0 = Math.sin(0.3);
    const soccer: OsmArea = { tags: { leisure: 'pitch', sport: 'soccer' }, rings: [lls([[-52.5, -34], [52.5, -34], [52.5, 34], [-52.5, 34]].map(([x, y]): [number, number] => [20 + (x * c0 - y * s0) * M, 20 + (x * s0 + y * c0) * M]))] };
    const baseball: OsmArea = { tags: { leisure: 'pitch', sport: 'baseball' }, rings: [lls([[40, 40], [44, 40.3], [43.5, 43], [41, 44.2], [40.2, 44]])] };
    const areas = [soccer, baseball];
    const tin = buildTerrainTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(100));
    const mesh = buildOsmMesh({ tile: TILE, detail: 'full', tin, sampleHeight: tinSampler(tin, TILE), data: { lines: [], areas, points: [], buildings: [] } });
    const c = buildGroundCover(TILE, GRID, data([], areas));
    const toLattice = tileLattice(TILE, GRID), centre = tileCenter(TILE);
    const lattice = (k: number) => { const ll = enuToLatLon(centre, mesh.pitchLines[k], -mesh.pitchLines[k + 2], 0); return toLattice([ll.lon, ll.lat]); };
    /** metres from (x, y) to the nearest triangle of shape s */
    const off = (s: CoverShape, [x, y]: [number, number]): number => {
      let best = Infinity;
      for (let t = 0; t < s.tris.length; t += 6) {
        const [ax, ay, bx, by, cx, cy] = s.tris.subarray(t, t + 6);
        const sides = [(bx - ax) * (y - ay) - (by - ay) * (x - ax), (cx - bx) * (y - by) - (cy - by) * (x - bx), (ax - cx) * (y - cy) - (ay - cy) * (x - cx)];
        if (sides.every((v) => v >= 0) || sides.every((v) => v <= 0)) return 0;
        for (const [px, py, qx, qy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
          const dx = qx - px, dy = qy - py, f = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy)));
          best = Math.min(best, Math.hypot(x - px - dx * f, y - py - dy * f) / M);
        }
      }
      return best;
    };
    const seen = new Set<number>();
    expect(mesh.pitchLines.length).toBeGreaterThan(100);
    // the mesh's lines come in pairs of vertices: the middle of each piece is on the paint (its ends
    // are on its edge where a strip ends square, and the mesh keeps them in float32)
    for (let k = 0; k < mesh.pitchLines.length; k += 8) {
      const p = lattice(k), q = lattice(k + 4);
      const at = c.locate((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(c.shapes[at].kind).toBe('pitchPaint');
      expect(off(c.shapes[at], p)).toBeLessThan(1e-4);
      expect(off(c.shapes[at], q)).toBeLessThan(1e-4);
      seen.add(at);
    }
    // the lines of both pitches, each on its own paint
    expect(seen.size).toBe(2);
  });
  it('closes the outline of a stretch cut where the lift begins or ends (square there)', () => {
    const lines = railOverRoad();
    const c = buildGroundCover(TILE, GRID, data(lines));
    // the western approach: round where it starts, square where it rises; the eastern: square where it lands, round at its end
    const cut = c.shapes.filter((s) => (s.kind === 'ballast' || s.kind === 'railZone') && (s.source === lines[0] || s.source === lines[2]));
    expect(cut.length).toBe(4);
    for (const s of cut) {
      const ls = loops(s.outline);
      expect(ls.length).toBe(1);
      const [a, b] = [ls[0][0], ls[0][ls[0].length - 1]];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-9);
      // the body and half a 12-gon: the triangles less the half of the cap under the body
      const r = (s.kind === 'ballast' ? 3 : 11) * M;
      expect(shoelace(ls[0])).toBeCloseTo(triArea(s) - 1.5 * r * r, 9);
    }
  });
  it('a bridge the levels leave on the ground is a cover like any way: a taxiway bridge, an aqueduct', () => {
    // (a road bridge is never on the ground: MIN_BRIDGE_LIFT_M)
    const taxiway = road({ aeroway: 'taxiway', bridge: 'yes' }, [[10, 20], [54, 20]]);
    const aqueduct = road({ waterway: 'canal', bridge: 'aqueduct' }, [[10, 44], [54, 44]]);
    for (const roads of [undefined, roadsOf([taxiway, aqueduct])]) {
      const c = buildGroundCover(TILE, GRID, data([taxiway, aqueduct]), roads);
      const lifted = coverLifted(roads, buildRoadLevels([taxiway, aqueduct], [], enuOf));
      expect(lifted(aqueduct, 100) || lifted(taxiway, 100)).toBe(false);
      expect(c.shapes[c.locate(32, 44)].kind).toBe('water');
      expect(c.shapes[c.locate(32, 20)].kind).toBe('runway');
    }
  });

  it('ends a way’s cover where its bridge begins, mitred onto it: nothing of it past the joint', () => {
    const west = road({ highway: 'tertiary', name: 'west' }, [[10, 32], [30, 32]]);
    const lines = [west, road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [[30, 32], [34, 32]]), road({ highway: 'tertiary' }, [[34, 32], [54, 32]]), road({ highway: 'residential' }, [[32, 20], [32, 44]])];
    const c = buildGroundCover(TILE, GRID, data(lines), roadsOf(lines));
    const s = c.shapes.find((sh) => sh.kind === 'carriageway' && sh.source === west)!;
    let east = -Infinity;
    for (let k = 0; k < s.tris.length; k += 2) east = Math.max(east, s.tris[k]);
    expect(east).toBeLessThan(30 + 1e-6);
    expect(east).toBeGreaterThan(30 - 1e-6);
  });

  it('keeps the ends of the ground ways at a junction a bridge ends at: only the lifted way changes', () => {
    // two streets meeting at an angle where a bridge (over a road) begins
    const a = road({ highway: 'tertiary', name: 'a' }, [[10.2, 30.3], [30.1, 32.2]]), b = road({ highway: 'tertiary', name: 'b' }, [[30.1, 32.2], [40.4, 50.1]]);
    const bridged = [a, b, road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [[30.1, 32.2], [36.3, 20.1]]), road({ highway: 'residential' }, [[30.2, 25.3], [37.3, 27.4]])];
    const outlineOf = (lines: OsmLine[], way: OsmLine) => {
      const c = buildGroundCover(TILE, GRID, data(lines), roadsOf(lines));
      return c.shapes.find((sh) => sh.kind === 'carriageway' && sh.source === way)!.outline;
    };
    expect(outlineOf(bridged, a)).toEqual(outlineOf([a, b], a));
    expect(outlineOf(bridged, b)).toEqual(outlineOf([a, b], b));
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
