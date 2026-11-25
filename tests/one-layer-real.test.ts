/**
 * The one-layer ground of real dense tiles (the fixtures of surface-real.test.ts), the terrain mesh
 * and the OSM mesh together: the road and water faces on the terrain's own vertices, and what the
 * vertex budget drops (Innsbruck 14/8710/5744) still drawn whole, under its seniors
 */
import { describe, expect, it } from 'vitest';
import { coastlineWays } from '../src/world/coast';
import { DEFAULT_AREA_STYLES } from '../src/world/area-styles';
import { buildGroundCover, coverRamp, type CoverKind } from '../src/world/ground-cover';
import type { Pad } from '../src/world/aerodrome';
import { enuToLatLon, gridLatLon, tileCenter, tileLattice, tileSizeMeters, type Tile } from '../src/world/geodesy';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildOsmMesh, type OsmMeshData } from '../src/world/osm-mesher';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin, roadSurfaceOf, type SurfaceTin } from '../src/world/surface-tin';
import { buildTerrainMesh } from '../src/world/terrain-mesher';
import { tinLocator, tinSampler } from '../src/world/terrain-tin';
import type { TileBorders } from '../src/world/terrain-source';

interface Fixture {
  tile: Tile;
  grid: number;
  heights: number[];
  borders: Record<'n' | 's' | 'w' | 'e', number[]> & { coarse?: Partial<Record<'n' | 's' | 'w' | 'e', number[]>> };
  pads: Pad[];
  roadDem: number[] | null;
  data: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] };
}

/** the tile's surface, its drape and its terrain mesh with their covers, as the two workers build them */
async function build(name: string) {
  const fx = (await import(`./fixtures/${name}.json`)).default as Fixture;
  const f32 = (a: number[]) => Float32Array.from(a);
  const borders: TileBorders = { n: f32(fx.borders.n), s: f32(fx.borders.s), w: f32(fx.borders.w), e: f32(fx.borders.e) };
  if (fx.borders.coarse) borders.coarse = Object.fromEntries(Object.entries(fx.borders.coarse).map(([k, v]) => [k, f32(v!)]));
  const net = buildRoadNet(fx.data.lines);
  const roads = fx.roadDem ? roadSurfaceOf(fx.tile, fx.data, net, Float64Array.from(fx.roadDem)) : undefined;
  const cover = buildGroundCover(fx.tile, fx.grid, fx.data, roads);
  const heights = f32(fx.heights), coast = coastlineWays(fx.data.lines);
  const tin = buildSurfaceTin(fx.tile, fx.grid, heights, { borders, coast, pads: fx.pads, roads, cover });
  const mesh = buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight: tinSampler(tin, fx.tile), tin, roads, cover });
  const terrain = () => buildTerrainMesh({ tile: fx.tile, grid: fx.grid, heights, borders, coast, pads: fx.pads, roads, cover });
  return { fx, tin, cover, mesh, terrain };
}

/** the positions of vertices [from, to) of a mesh, as float32 bit patterns */
function positions(vertices: Float32Array, from: number, to: number): Set<string> {
  const bits = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
  const set = new Set<string>();
  for (let v = from; v < to; v++) set.add(`${bits[v * 6]},${bits[v * 6 + 1]},${bits[v * 6 + 2]}`);
  return set;
}

describe('the road and water faces of the two meshes', () => {
  it.each(['surface-14-9517-6397', 'surface-14-8710-5744'])('%s: on bit-identical vertices', async (name) => {
    const { mesh, terrain } = await build(name);
    const t = terrain();
    // the terrain's road, rail and runway faces (drawn far) and its water faces (never drawn): terrain-mesher
    const groups: [Float32Array, number, number][] = [[mesh.roads.vertices, t.nearCount!, t.farCount!], [mesh.water.vertices, t.farCount!, t.vertexCount]];
    for (const [osm, from, to] of groups) {
      expect(to - from).toBeGreaterThan(1000);
      // the OSM mesh's faces come first in its meshes, in the surface's order: the same vertices, bit for bit
      const own = positions(osm, 0, osm.length / 6);
      const missing = [...positions(t.vertices, from, to)].filter((k) => !own.has(k));
      expect(missing.length).toBe(0);
      expect(new Uint32Array(osm.buffer, osm.byteOffset, (to - from) * 6).filter((_, k) => k % 6 < 3))
        .toEqual(new Uint32Array(t.vertices.buffer, t.vertices.byteOffset + from * 24, (to - from) * 6).filter((_, k) => k % 6 < 3));
    }
  });
});

/** a triangle of the OSM mesh with a depth level: what lies on the ground's faces over them (osm-mesher flushLoose) */
interface Piece {
  mesh: 'main' | 'roads' | 'water';
  ramp: number;
  level: number;
  /** its corners on the lattice, and their heights */
  p: [number, number][];
  y: number[];
}

/** the triangles of the OSM mesh with a depth level, on the tile's lattice */
function levelled(mesh: OsmMeshData, tile: Tile, grid: number): Piece[] {
  const c = tileCenter(tile), toLattice = tileLattice(tile, grid);
  const out: Piece[] = [];
  const take = (name: Piece['mesh'], m: { vertices: Float32Array; ramps: Uint32Array }, levels: Float32Array) => {
    for (let v = 0; v + 2 < levels.length; v += 3) {
      if (levels[v] === 0) continue;
      const p: [number, number][] = [], y: number[] = [];
      for (let k = 0; k < 3; k++) {
        const ll = enuToLatLon(c, m.vertices[(v + k) * 6], -m.vertices[(v + k) * 6 + 2], 0);
        p.push(toLattice([ll.lon, ll.lat]));
        y.push(m.vertices[(v + k) * 6 + 1]);
      }
      out.push({ mesh: name, ramp: m.ramps[v], level: levels[v], p, y });
    }
  };
  take('main', mesh, mesh.depthLevels);
  take('roads', mesh.roads, mesh.roadDepthLevels);
  take('water', mesh.water, mesh.waterDepthLevels);
  return out;
}

/** the area of a lattice triangle, cells² */
const areaOf = (p: [number, number][]): number => Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) / 2;

/** the face of the surface under a lattice point, or −1 */
function faceAt(tin: SurfaceTin, tile: Tile): (x: number, y: number) => number {
  const locate = tinLocator(tin, tile);
  return (x, y) => {
    const ll = gridLatLon(tile, x, y, tin.grid);
    return locate(ll.lon, ll.lat)?.tri ?? -1;
  };
}

describe('what the vertex budget drops on a real dense tile (Innsbruck 14/8710/5744)', () => {
  /** the covers drawn as areas: dropped, their faces only where a face lies wholly in them */
  const AREAS: CoverKind[] = ['water', 'aeroArea', 'carPark', 'pitchPaint', 'pitch', 'area'];

  it('draws every dropped area and water whole: its faces and, over the rest of it, its pieces on the faces', async () => {
    const { fx, tin, cover, mesh } = await build('surface-14-8710-5744');
    const g = fx.grid, face = faceAt(tin, fx.tile);
    expect(tin.looseShapes!.length).toBeGreaterThan(100);
    // the pieces over the ground by the lattice cell
    const pieces = levelled(mesh, fx.tile, g).filter((q) => q.mesh !== 'roads');
    const cells: number[][] = Array.from({ length: g * g }, () => []);
    const cell = (v: number) => Math.max(0, Math.min(g - 1, Math.floor(v)));
    pieces.forEach((q, qi) => {
      const xs = q.p.map((r) => r[0]), ys = q.p.map((r) => r[1]);
      for (let j = cell(Math.min(...ys)); j <= cell(Math.max(...ys)); j++) for (let i = cell(Math.min(...xs)); i <= cell(Math.max(...xs)); i++) cells[j * g + i].push(qi);
    });
    const holds = (p: [number, number][], x: number, y: number): boolean => {
      const s = (a: [number, number], b: [number, number]) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      const d = [s(p[0], p[1]), s(p[1], p[2]), s(p[2], p[0])];
      return d.every((v) => v >= 0) || d.every((v) => v <= 0);
    };
    // probes over the tile: where an area or water is the senior cover, it is what is drawn there
    const N = 900, tally = new Map<CoverKind, { all: number; drawn: number }>();
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * g, y = ((j + 0.5) / N) * g;
      const si = cover.locate(x, y);
      if (si < 0 || !AREAS.includes(cover.shapes[si].kind)) continue;
      const f = face(x, y);
      // a road's bank is the ground's, whatever water lies over it (surface-tin)
      if (f < 0 || (cover.shapes[si].kind === 'water' && tin.bank?.(f))) continue;
      const kind = cover.shapes[si].kind, t = tally.get(kind) ?? { all: 0, drawn: 0 };
      tally.set(kind, t);
      t.all++;
      // the piece over the others here, or the face itself
      let top: Piece | undefined;
      for (const qi of cells[cell(y) * g + cell(x)]) if (holds(pieces[qi].p, x, y) && (!top || pieces[qi].level > top.level)) top = pieces[qi];
      if (top ? top.mesh === (kind === 'water' ? 'water' : 'main') && top.ramp === coverRamp(cover.shapes[si], DEFAULT_AREA_STYLES, undefined) : tin.cover![f] === si) t.drawn++;
    }
    const share = Object.fromEntries([...tally].map(([k, t]) => [k, t.drawn / t.all]));
    expect(tally.get('water')!.all).toBeGreaterThan(5000);
    expect(tally.get('area')!.all).toBeGreaterThan(5000);
    expect([...tally.keys()].sort()).toEqual(['area', 'carPark', 'pitch', 'pitchPaint', 'water']);
    for (const kind of tally.keys()) expect([kind, share[kind] >= 0.99]).toEqual([kind, true]);
  });

  it('lays nothing dropped over the face of a senior cover', async () => {
    const { fx, tin, cover, mesh } = await build('surface-14-8710-5744');
    const face = faceAt(tin, fx.tile), m2 = (tileSizeMeters(fx.tile) / fx.grid) ** 2;
    const h = tin.vh.map((v) => Math.max(v, 0));
    /** the area of the pieces on faces of each kind (not lifted over them: a bridge), m² */
    const over = { main: new Map<CoverKind, number>(), roads: new Map<CoverKind, number>(), water: new Map<CoverKind, number>() };
    for (const q of levelled(mesh, fx.tile, fx.grid)) {
      const x = (q.p[0][0] + q.p[1][0] + q.p[2][0]) / 3, y = (q.p[0][1] + q.p[1][1] + q.p[2][1]) / 3;
      const f = face(x, y);
      if (f < 0 || tin.cover![f] < 0) continue;
      const t = tin.tris[f], [ax, ay, bx, by, cx, cy] = [tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]];
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      const w1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det, w2 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
      const lift = (q.y[0] + q.y[1] + q.y[2]) / 3 - (h[t.a] * (1 - w1 - w2) + h[t.b] * w1 + h[t.c] * w2);
      if (lift >= 0.5) continue;
      const kind = cover.shapes[tin.cover![f]].kind;
      over[q.mesh].set(kind, (over[q.mesh].get(kind) ?? 0) + areaOf(q.p) * m2);
    }
    const on = (mesh: keyof typeof over, kinds: CoverKind[]) => kinds.reduce((s, k) => s + (over[mesh].get(k) ?? 0), 0);
    // the budget drops the juniors first: every way left to its ribbon is junior to every road, railway and runway in the faces
    // (to a sliver along a face's edge, its centre found on the neighbour: under 2 cm² in all; 1.3
    // since the railways' beds are pulled as the roads' are)
    for (const m of ['main', 'water'] as const) expect([m, on(m, ['runway', 'ballast', 'carriageway']) < 2e-4]).toEqual([m, true]);
    // the roads' too, but the low corners of a deck's pieces: a piece lifted JUNCTION_LIFT_M or more
    // on average over a street's face is drawn whole (osm-mesher underSenior), its triangle at the
    // low end under that — where a footbridge's ramp, a deck since (NetWay.approach), comes down by
    // a street (Herzog-Siegmund-Ufer, the Innbrücke): 1.4 m² in all
    expect(on('roads', ['runway', 'ballast', 'carriageway'])).toBeLessThan(2);
    // the right-of-way strips and the areas (the drape) are junior to a shoulder, a path and the water; the water to the first two
    expect(on('main', ['shoulder', 'path', 'water'])).toBeLessThan(1e-4);
    expect(on('water', ['shoulder', 'path'])).toBeLessThan(1e-4);
    // and they do lie on their juniors
    expect(on('roads', ['area', 'pitch', 'carPark', 'railZone'])).toBeGreaterThan(1000);
  });
});
