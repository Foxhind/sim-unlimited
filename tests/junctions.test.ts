/**
 * At-grade junctions as surfaces of their own (junctions.ts, ground-cover buildJunction): the
 * roads trimmed back from the node, the surface between them with rounded kerbs, the paint of a road
 * through it carried across but for its edge line where the others join; and the regression set of
 * real junctions round Moscow (fixtures/junctions.json: tools/junction-fixtures.ts), from plain
 * crossings to dual carriageways, roundabouts and clusters of nodes
 */
import { describe, expect, it } from 'vitest';
import { ROAD_EDGE_OFF, ROAD_MARK } from '../src/engine/palette';
import { latLonToEnu, tileCenter, tileLattice, type Tile } from '../src/world/geodesy';
import { buildGroundCover, type GroundCover } from '../src/world/ground-cover';
import { junctionPieces, junctionShape, unionOutline, type JunctionArm } from '../src/world/junctions';
import type { OsmLine } from '../src/world/osm-types';
import { lineNetwork, type P2 } from '../src/world/ribbon-shapes';
import { classifyLine, isTunnel, roadLayer } from '../src/world/way-styles';
import { data, GRID, M, road, TILE } from './roads-helpers';

/** the cover's shape at a lattice point: its index and itself */
const shapeAt = (c: GroundCover, x: number, y: number) => { const si = c.locate(x, y); return si < 0 ? undefined : c.shapes[si]; };
/** the paint code (aWinEdge.z) at a lattice point, from the shape there, or undefined */
const codeAt = (c: GroundCover, tile: Tile, x: number, y: number): number | undefined => {
  const sh = shapeAt(c, x, y);
  if (!sh?.attr) return undefined;
  const ll = tileLatLonOf(tile, x, y), [e, n] = latLonToEnu(tileCenter(tile), ll[1], ll[0], 0);
  return sh.attr.segs[sh.attr.segAt(x, y)]({ x: e, z: -n })[4];
};
/** a lattice point of a tile as lon/lat (by bisection of tileLattice: it is monotone both ways) */
function tileLatLonOf(tile: Tile, x: number, y: number): [number, number] {
  const to = tileLattice(tile, GRID), c = tileCenter(tile);
  let lon = c.lon, lat = c.lat;
  for (let k = 0; k < 60; k++) {
    const [px, py] = to([lon, lat]);
    const [ex] = to([lon + 1e-6, lat]), [, ny] = to([lon, lat + 1e-6]);
    lon += ((x - px) / (ex - px)) * 1e-6;
    lat += ((y - py) / (ny - py)) * 1e-6;
  }
  return [lon, lat];
}
const closed = (l: P2[]) => Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1e-7;

describe('a junction’s shape', () => {
  const arm = (dx: number, dy: number, half: number): JunctionArm => ({ c: [[0, 0], [dx * 40, dy * 40]], half, shoulder: 0, maxTrim: 25 });
  it('rounds the kerbs of a crossing and trims each road past the corner', () => {
    const arms = [arm(1, 0, 5), arm(0, 1, 3.5), arm(-1, 0, 5), arm(0, -1, 3.5)];
    const shape = junctionShape(arms, [0, 0], 1)!;
    expect(shape.corners.every((c) => c.kind === 'fillet')).toBe(true);
    // past the other road's edge, by the fillet (0.6 of the narrower road's width) as well
    for (const k of [0, 2]) expect(shape.trims[k]).toBeCloseTo(3.5 + 0.6 * 7, 6);
    for (const k of [1, 3]) expect(shape.trims[k]).toBeCloseTo(5 + 0.6 * 7, 6);
    const ends = arms.map((a, k): [P2, P2] => {
      const [dx, dy] = [a.c[1][0] / 40, a.c[1][1] / 40], t = shape.trims[k];
      return [[dx * t + dy * a.half, dy * t - dx * a.half], [dx * t - dy * a.half, dy * t + dx * a.half]];
    });
    const outline = unionOutline(junctionPieces(shape, arms, ends, () => 0, 1, (r) => [r]));
    // one ring through every trimmed corner
    expect(outline).toHaveLength(1);
    expect(closed(outline[0])).toBe(true);
    for (const [r, l] of ends) for (const p of [r, l]) expect(outline[0].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9)).toBe(true);
  });
  it('leaves the straight side of a T open, round the node', () => {
    const shape = junctionShape([arm(1, 0, 5), arm(0, 1, 3.5), arm(-1, 0, 5)], [0, 0], 1)!;
    expect(shape.corners.map((c) => c.kind).sort()).toEqual(['fillet', 'fillet', 'open']);
  });
});

describe('junctions in the ground cover', () => {
  const ew = road({ highway: 'secondary' }, [[8, 32], [32, 32], [56, 32]]);
  it('a street joining a road: the street stops short, the road’s paint goes on across but for its edge line on the street’s side', () => {
    const street = road({ highway: 'tertiary' }, [[32, 32], [32, 56]]);
    const cover = buildGroundCover(TILE, GRID, data([ew, street]));
    const node = shapeAt(cover, 32, 32);
    expect(node?.junction).toBe(true);
    expect(node?.kind).toBe('carriageway');
    // the street's own ribbon starts past the road and the fillets
    const half = classifyLine(ew.tags)!.width / 2;
    expect(shapeAt(cover, 32, 32 + (half + 1) * M)?.junction).toBe(true);
    expect(shapeAt(cover, 32, 32 + 20 * M)?.junction).toBeFalsy();
    // across the junction: the road's lanes, its edge line off on the south (its right, driving east)
    const code = codeAt(cover, TILE, 32, 32)!;
    expect(code & ROAD_MARK.EDGES).toBeTruthy();
    expect(code & ROAD_EDGE_OFF.RIGHT).toBeTruthy();
    expect(code & ROAD_EDGE_OFF.LEFT).toBeFalsy();
    // the street's paint (a two-lane tertiary) runs to its trim: no gap at the junction's end
    expect(((codeAt(cover, TILE, 32, 32 + 20 * M)! >> 7) & 63) + ((codeAt(cover, TILE, 32, 32 + 20 * M)! >> 13) & 63)).toBe(0);
  });
  it('two equal roads crossing: neither paints across the junction', () => {
    const ns = road({ highway: 'secondary' }, [[32, 8], [32, 32], [32, 56]]);
    const cover = buildGroundCover(TILE, GRID, data([ew, ns]));
    expect(shapeAt(cover, 32, 32)?.junction).toBe(true);
    expect(codeAt(cover, TILE, 32, 32)).toBeUndefined();
    for (const sh of cover.shapes.filter((s) => s.junction)) for (const l of sh.outline) expect(closed(l)).toBe(true);
  });
  it('a driveway joining a road makes no junction (only roads of standing do)', () => {
    const drive = road({ highway: 'service' }, [[32, 32], [32, 50]]);
    const cover = buildGroundCover(TILE, GRID, data([ew, drive]));
    expect(cover.shapes.some((s) => s.junction)).toBe(false);
  });
});

interface Fixture { name: string; at: [number, number]; span: number; note: string; tile: Tile; lines: OsmLine[] }
const fixtures = (await import('./fixtures/junctions.json')).default as unknown as Fixture[];

describe('the regression set of real junctions (fixtures/junctions.json)', () => {
  for (const fx of fixtures) {
    it(`${fx.name} ${fx.at.join(',')}: ${fx.note}`, () => {
      const cover = buildGroundCover(fx.tile, GRID, { lines: fx.lines, areas: [], points: [] }, undefined, false);
      const to = tileLattice(fx.tile, GRID), centre = to([fx.at[1], fx.at[0]]);
      const perM = GRID / (40075016.686 * Math.cos((fx.at[0] * Math.PI) / 180) / 2 ** 14);
      const junctions = cover.shapes.filter((s) => s.junction && s.kind === 'carriageway');
      // a junction's surface within 40 m of the point
      const near = junctions.filter((s) => {
        for (let k = 0; k < s.tris.length; k += 2) if (Math.hypot(s.tris[k] - centre[0], s.tris[k + 1] - centre[1]) < 40 * perM) return true;
        return false;
      });
      expect(near.length, 'junctions near').toBeGreaterThan(0);
      // each junction's outline in rings (its union's edge): a line that does not close runs between
      // points of the others (a hole touching the outer ring), no loose end
      for (const s of junctions) {
        const open = s.outline.filter((l) => !closed(l)), rest = s.outline.filter((l) => closed(l)).flat();
        for (const l of open) for (const e of [l[0], l[l.length - 1]]) {
          expect(Math.min(...rest.map((q) => Math.hypot(q[0] - e[0], q[1] - e[1]))), `${fx.name}: a loose end`).toBeLessThan(1e-7);
        }
      }
      // no hole: every point of a carriageway on the ground within 120 m lies on a carriageway's cover
      // (but a fork's branches: laid onto the trunk, off their own lines)
      const tc = tileCenter(fx.tile);
      const net = lineNetwork(fx.lines, (lon, lat) => { const [e, n] = latLonToEnu(tc, lat, lon, 0); return [e, -n]; }, to, perM);
      const holes: string[] = [];
      for (const line of fx.lines) {
        const st = line.tags.highway ? classifyLine(line.tags) : undefined;
        if (!st || st.path || isTunnel(line.tags) || roadLayer(line.tags) !== 0 || line.tags.bridge) continue;
        if ([line.points[0], line.points[line.points.length - 1]].some((p) => net.isFork(p, 0))) continue;
        const c = line.points.map(to);
        for (let i = 0; i + 1 < c.length; i++) {
          const n = Math.ceil(Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]) / (0.5 * perM));
          for (let k = 0; k <= n; k++) {
            const x = c[i][0] + ((c[i + 1][0] - c[i][0]) * k) / n, y = c[i][1] + ((c[i + 1][1] - c[i][1]) * k) / n;
            if (x < 0.5 || y < 0.5 || x > GRID - 0.5 || y > GRID - 0.5 || Math.hypot(x - centre[0], y - centre[1]) > 120 * perM) continue;
            const sh = shapeAt(cover, x, y);
            // (a railway's ballast lies over a level crossing)
            if (sh?.kind !== 'carriageway' && sh?.kind !== 'ballast') holes.push(`${line.tags.highway} at ${x.toFixed(3)},${y.toFixed(3)}: ${sh?.kind ?? 'nothing'}`);
          }
        }
      }
      expect(holes, `${fx.name}: holes`).toEqual([]);
    });
  }
});
