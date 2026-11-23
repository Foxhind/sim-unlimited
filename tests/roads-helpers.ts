/** shared set-up of the road tests: a z14 tile over a relief given in metres, roads in lattice units */
import { enuToLatLon, gridLatLon, tileSizeMeters, type Tile } from '../src/world/geodesy';
import type { LonLat, OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { tinLatticeSampler, type TerrainTin } from '../src/world/terrain-tin';
import type { TileBorders } from '../src/world/terrain-source';
import type { Pad } from '../src/world/aerodrome';
import type { RoadNet } from '../src/world/road-net';
import { buildGroundCover, type GroundCover } from '../src/world/ground-cover';
import { buildRoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildSurfaceTin, type SurfaceTin } from '../src/world/surface-tin';
import { classifyLine } from '../src/world/way-styles';
import { colourOf, type RGB } from '../src/engine/palette';
import { tinToWorld, type TerrainMeshData, type TerrainMeshOptions } from '../src/world/terrain-mesher';

export const TILE: Tile = { z: 14, x: 9000, y: 6000 };
/** the tests' own lattice (their geometry is laid out on it) */
export const GRID = 64;
export const SIZE = tileSizeMeters(TILE);
/** lattice cells a metre */
export const M = GRID / SIZE;

/** the lattice of `tile` from a relief over metres east and south of TILE's north-west corner */
export function lattice(fn: (xm: number, ym: number) => number, tile: Tile = TILE): Float32Array {
  const side = GRID + 1;
  const h = new Float32Array(side * side);
  const ox = (tile.x - TILE.x) * SIZE, oy = (tile.y - TILE.y) * SIZE;
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) h[j * side + i] = fn(ox + i / M, oy + j / M);
  return h;
}

/** the shared edge profiles of `tile` over the same relief: bit-identical in two neighbours */
export function bordersOf(fn: (xm: number, ym: number) => number, tile: Tile = TILE): TileBorders {
  const h = lattice(fn, tile), side = GRID + 1;
  return {
    n: Float32Array.from({ length: side }, (_, k) => h[k]),
    s: Float32Array.from({ length: side }, (_, k) => h[GRID * side + k]),
    w: Float32Array.from({ length: side }, (_, k) => h[k * side]),
    e: Float32Array.from({ length: side }, (_, k) => h[k * side + GRID]),
  };
}

/** lattice points of `tile` as lon/lat */
function lonLats(pts: [number, number][], tile: Tile = TILE): LonLat[] {
  return pts.map(([x, y]): LonLat => { const ll = gridLatLon(tile, x, y, GRID); return [ll.lon, ll.lat]; });
}

/** an OSM way through lattice points of `tile` */
export function road(tags: Record<string, string>, pts: [number, number][], tile: Tile = TILE): OsmLine {
  return { tags, points: lonLats(pts, tile) };
}

/** a railway through lattice points of TILE */
export function rail(pts: [number, number][], tags: Record<string, string> = {}): OsmLine {
  return road({ railway: 'rail', ...tags }, pts);
}

/** the OSM of TILE as buildGroundCover takes it; lists of lines among the lines are flattened */
export function data(lines: (OsmLine | OsmLine[])[], areas: OsmArea[] = [], points: OsmPoint[] = []): { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] } {
  return { lines: lines.flat(), areas, points };
}

/** a square ring of lattice points, `h` cells each way round (cx, cy) */
export function square(cx: number, cy: number, h: number): [number, number][] {
  return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
}

/** a park: an outer ring and holes, lattice points of TILE */
export function park(ring: [number, number][], ...holes: [number, number][][]): OsmArea {
  return { tags: { leisure: 'park' }, rings: [ring, ...holes].map((r) => lonLats(r)) };
}

/** a park round the middle of TILE with a pond in a hole of it (pond: the same ring) */
export function parkWithHole(): OsmArea {
  return park(square(32, 32, 12), square(32, 32, 5.5));
}
export function pond(): OsmArea {
  return { tags: { natural: 'water' }, rings: [lonLats(square(32, 32, 5.5))] };
}

/** half the two-way secondary trunk of forkFixture, metres */
export const trunkHalfWidth = classifyLine({ highway: 'secondary' })!.width / 2;
/**
 * A two-way secondary from the west ending at (32, 32), where its two one-way carriageways begin:
 * `branch-right` eastbound to the south (right of the trunk's flow), `branch-left` westbound into the node
 */
export function forkFixture(): OsmLine[] {
  return [
    road({ highway: 'secondary', name: 'trunk' }, [[10, 32], [32, 32]]),
    road({ highway: 'secondary', oneway: 'yes', name: 'branch-right' }, [[32, 32], [54, 33]]),
    road({ highway: 'secondary', oneway: 'yes', name: 'branch-left' }, [[54, 31], [32, 32]]),
  ];
}
/**
 * How far from the trunk's axis (y = 32) the asphalt edge of the named branch lies at the fork node,
 * metres: the farthest point of its carriageway's outline within half a metre of the node along the axis
 */
export function edgeOffsetAtFork(c: GroundCover, name: string): number {
  const s = c.shapes.find((sh) => sh.kind === 'carriageway' && (sh.source as OsmLine).tags.name === name);
  if (!s) throw new Error(`no carriageway ${name}`);
  let best = -Infinity;
  for (const line of s.outline) {
    for (const [x, y] of line) if (Math.abs(x - 32) <= 0.5 * M) best = Math.max(best, Math.abs(y - 32) / M);
  }
  return best;
}

/**
 * A railway over a tertiary road on a short bridge (layer 1) at x = 20: the bridge from x = 19 to 21
 * along y = 16, its approaches to the west and east on the ground, lifted near it (road-levels.ts)
 */
export function railOverRoad(): OsmLine[] {
  return [
    rail([[4, 16], [19, 16]]),
    rail([[19, 16], [21, 16]], { bridge: 'yes', layer: '1' }),
    rail([[21, 16], [60, 16]]),
    road({ highway: 'tertiary' }, [[20, 4], [20, 28]]),
  ];
}
/** on the western approach of railOverRoad, a lattice cell (about 28 m) before its bridge: lifted ~2 m */
export const pointOnLiftedApproach: [number, number] = [18, 16];
/** on the road under the rail bridge of railOverRoad */
export const roadUnderRailBridge: [number, number] = [20, 16];

/** a ring of `sides` lattice points of TILE, `r` cells round (cx, cy), the first at angle `a0` */
export function polygon(cx: number, cy: number, r: number, sides: number, a0 = 0): [number, number][] {
  return Array.from({ length: sides }, (_, k): [number, number] => {
    const a = a0 + (2 * Math.PI * k) / sides;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** an area of TILE with the given tags, its rings lattice points of TILE */
export function areaOf(tags: Record<string, string>, ...rings: [number, number][][]): OsmArea {
  return { tags, rings: rings.map((r) => lonLats([...r, r[0]])) };
}

/**
 * A small town on TILE, every kind of cover: a painted primary through a junction with a residential
 * street, a dead-end service road, a footway, a railway over the street at a level crossing, a river,
 * a park round a pond, a car park and a soccer pitch with its paint. Off the lattice nodes.
 */
export function townFixture(): { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] } {
  const j: [number, number] = [31.9, 32.3];
  const pitch = [[-52.5, -34], [52.5, -34], [52.5, 34], [-52.5, 34]].map(([x, y]): [number, number] => {
    const c = Math.cos(0.3), s = Math.sin(0.3);
    return [15.3 + (x * c - y * s) * M, 23.1 + (x * s + y * c) * M];
  });
  return {
    lines: [
      road({ highway: 'primary' }, [[3.3, 30.7], j, [61.1, 33.9]]),
      road({ highway: 'residential' }, [[30.2, 3.7], j]),
      road({ highway: 'residential' }, [j, [33.4, 60.6]]),
      road({ highway: 'service' }, [[40.3, 34.8], [42.6, 44.1]]),
      road({ highway: 'footway' }, [[10.4, 40.2], [25.7, 52.3]]),
      rail([[2.6, 12.4], [61.4, 18.7]]),
      road({ waterway: 'river' }, [[12.3, 61.5], [20.1, 45.3], [8.2, 35.1]]),
    ],
    areas: [
      areaOf({ leisure: 'park' }, polygon(47.3, 47.6, 9.1, 7, 0.2), polygon(47.3, 47.6, 3.2, 6, 0.1)),
      areaOf({ natural: 'water' }, polygon(47.3, 47.6, 3.2, 6, 0.1)),
      areaOf({ amenity: 'parking' }, [[50.4, 20.6], [58.7, 21.3], [58.1, 27.4], [50.9, 26.8]]),
      areaOf({ leisure: 'pitch', sport: 'soccer' }, pitch),
    ],
    points: [],
  };
}

/**
 * A town of `parks` small parks (twelve-gons in rows across TILE) and a few streets through them:
 * more park edges than the surface's vertex budget holds
 */
export function denseTown(parks: number): { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] } {
  const side = Math.ceil(Math.sqrt(parks)), step = 62 / side;
  const areas = Array.from({ length: parks }, (_, k) =>
    areaOf({ leisure: 'park' }, polygon(1 + step * ((k % side) + 0.5), 1 + step * (Math.floor(k / side) + 0.5), step * 0.35, 12, k * 0.37)));
  const lines = [
    road({ highway: 'primary' }, [[1.3, 30.7], [62.6, 33.9]]),
    ...[8.3, 21.7, 40.2, 55.9].map((x) => road({ highway: 'residential' }, [[x, 1.4], [x + 1.7, 62.2]])),
  ];
  return { lines, areas, points: [] };
}

/**
 * A town of seeded random ways across TILE and beyond: 40 roads of every class, two or three nodes
 * among 30 shared ones (junctions, hairpins, near-parallel and collinear sides), a railway and a
 * river; then 25 areas of every kind, 3 to 11 sides. Seeds 2, 7, 9, 10 and 12 lost fixed edges and
 * cracked in the road-only surface before insertFixedLines ran its lines through the vertices and
 * edges within SNAP of them.
 */
export function randomTown(seed: number): { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] } {
  const rnd = seeded(seed);
  const at = (): [number, number] => [rnd() * 70 - 3, rnd() * 70 - 3];
  const nodes = Array.from({ length: 30 }, at);
  const kinds = ['primary', 'secondary', 'residential', 'residential', 'service', 'footway', 'tertiary', 'track'];
  const lines: OsmLine[] = [];
  for (let k = 0; k < 40; k++) {
    const a = nodes[Math.floor(rnd() * 30)], b = nodes[Math.floor(rnd() * 30)], c = nodes[Math.floor(rnd() * 30)];
    lines.push(road({ highway: kinds[Math.floor(rnd() * kinds.length)] }, rnd() < 0.5 ? [a, b] : [a, b, c]));
  }
  lines.push(rail([at(), at()]), road({ waterway: 'river' }, [at(), at(), at()]));
  const tags: Record<string, string>[] = [{ leisure: 'park' }, { natural: 'water' }, { amenity: 'parking' }, { landuse: 'grass' }, { natural: 'wood' }];
  const areas = Array.from({ length: 25 }, (_, k) => {
    const [x, y] = at();
    return areaOf(tags[k % tags.length], polygon(x, y, 1 + rnd() * 6, 3 + Math.floor(rnd() * 9), rnd() * 6));
  });
  return { lines, areas, points: [] };
}

/**
 * The surface of `tile` with its ground cover over a relief given in metres: the roads' heights from
 * that relief, the cover from the whole OSM (`d`, lattice of TILE)
 */
export function coverTin(d: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }, fn: (xm: number, ym: number) => number, tile: Tile = TILE): { tin: SurfaceTin; cover: GroundCover } {
  const net = buildRoadNet(d.lines), roads = { net, z: solveRoadHeights(net, demOf(net, fn)) };
  const cover = buildGroundCover(tile, GRID, d, roads);
  return { tin: buildSurfaceTin(tile, GRID, lattice(fn, tile), { borders: bordersOf(fn, tile), roads, cover }), cover };
}

/** metres east and south of TILE's north-west corner at lon/lat */
export function metresOf(lon: number, lat: number): [number, number] {
  const n = 2 ** TILE.z;
  const x = ((lon + 180) / 360) * n - TILE.x;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - TILE.y;
  return [(x * GRID) / M, (y * GRID) / M];
}

/** the raw height at every sample of the network from a relief over metres */
export function demOf(net: RoadNet, fn: (xm: number, ym: number) => number): Float64Array {
  return Float64Array.from(net.samples, (s) => fn(...metresOf(s.lon, s.lat)));
}

/** the surface height at metres east and south of the tile's north-west corner */
export function at(tin: TerrainTin, xm: number, ym: number): number {
  return tinLatticeSampler(tin)(xm * M, ym * M);
}

/** a flat aerodrome pad at 500 m, a square `half` metres each way round lattice point (x, y) */
export function padAround(x: number, y: number, half: number): Pad {
  const ll = gridLatLon(TILE, x, y, GRID);
  const origin = { lat: ll.lat, lon: ll.lon };
  const hull: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half]];
  const ring = [...hull, hull[0]].map(([e, n]): LonLat => { const p = enuToLatLon(origin, e, n, 0); return [p.lon, p.lat]; });
  return { key: 'test', origin, hull, ring, h0: 500, ge: 0, gn: 0 };
}

/** a deterministic random number generator in [0, 1) */
export function seeded(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** the summed area of the TIN's faces, lattice cells² */
export function area(tin: TerrainTin): number {
  let a = 0;
  for (const t of tin.tris) {
    a += Math.abs((tin.vx[t.b] - tin.vx[t.a]) * (tin.vy[t.c] - tin.vy[t.a]) - (tin.vx[t.c] - tin.vx[t.a]) * (tin.vy[t.b] - tin.vy[t.a])) / 2;
  }
  return a;
}

/** how many vertices lie inside an edge of a face that does not have them (a T-junction crack) */
export function cracks(tin: TerrainTin): number {
  const cell = 0.5, buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  tin.vx.forEach((x, k) => {
    const kk = key(Math.floor(x / cell), Math.floor(tin.vy[k] / cell));
    (buckets.get(kk) ?? buckets.set(kk, []).get(kk)!).push(k);
  });
  const found = new Set<number>();
  for (const t of tin.tris) for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
    const ax = tin.vx[p], ay = tin.vy[p], bx = tin.vx[q], by = tin.vy[q], len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    for (let i = Math.floor(Math.min(ax, bx) / cell); i <= Math.floor(Math.max(ax, bx) / cell); i++) {
      for (let j = Math.floor(Math.min(ay, by) / cell); j <= Math.floor(Math.max(ay, by) / cell); j++) {
        for (const m of buckets.get(key(i, j)) ?? []) {
          if (m === p || m === q) continue;
          const s = ((tin.vx[m] - ax) * (bx - ax) + (tin.vy[m] - ay) * (by - ay)) / (len * len);
          const d = Math.abs((tin.vx[m] - ax) * (by - ay) - (tin.vy[m] - ay) * (bx - ax)) / len;
          if (s > 1e-6 && s < 1 - 1e-6 && d < 1e-7) found.add(m);
        }
      }
    }
  }
  return found.size;
}

/**
 * `coverTin`'s tile as buildTerrainMesh takes it: the options (with the cover and the roads) and the
 * surface TIN the mesh builds, over the same relief; `faceColor` a flat imagery colour on every face
 */
export function townMesh(d: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }, fn: (xm: number, ym: number) => number, extra: Partial<TerrainMeshOptions> = {}): { opts: TerrainMeshOptions; tin: SurfaceTin; cover: GroundCover; imagery: RGB } {
  const net = buildRoadNet(d.lines), roads = { net, z: solveRoadHeights(net, demOf(net, fn)) };
  const cover = buildGroundCover(TILE, GRID, d, roads);
  const imagery: RGB = [90, 140, 60];
  const opts: TerrainMeshOptions = { tile: TILE, grid: GRID, heights: lattice(fn), borders: bordersOf(fn), roads, cover, faceColor: () => colourOf(imagery), ...extra };
  const tin = buildSurfaceTin(TILE, GRID, opts.heights, { borders: opts.borders, roads, cover });
  return { opts, tin, cover, imagery };
}

/** the mesh's triangles by their centre, 0.1 m cells (once per mesh) */
const centres = new WeakMap<TerrainMeshData, Map<string, number[]>>();
function centresOf(m: TerrainMeshData): Map<string, number[]> {
  let map = centres.get(m);
  if (map) return map;
  map = new Map();
  for (let v = 0; v + 2 < m.vertexCount; v += 3) {
    const x = (m.vertices[v * 6] + m.vertices[(v + 1) * 6] + m.vertices[(v + 2) * 6]) / 3;
    const z = (m.vertices[v * 6 + 2] + m.vertices[(v + 1) * 6 + 2] + m.vertices[(v + 2) * 6 + 2]) / 3;
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    map.set(key, [...(map.get(key) ?? []), v]);
  }
  centres.set(m, map);
  return map;
}

/** the world x, z of a TIN's vertices (once per TIN) */
const worlds = new WeakMap<SurfaceTin, { wx: number[]; wz: number[] }>();

/** the first vertex of the mesh triangle standing on TIN face `face` (matched by its centre) */
export function vertexOfFace(m: TerrainMeshData, tin: SurfaceTin, face: number, tile: Tile = TILE): number {
  const t = tin.tris[face];
  let world = worlds.get(tin);
  if (!world) worlds.set(tin, world = tinToWorld(tile, GRID, tin.vx, tin.vy));
  const { wx, wz } = world;
  const cx = (wx[t.a] + wx[t.b] + wx[t.c]) / 3, cz = (wz[t.a] + wz[t.b] + wz[t.c]) / 3;
  const map = centresOf(m);
  // the nearest centre within 5 cm (thin faces, a paint strip's, lie close to their neighbours')
  let best = -1, bestD = 0.05;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const v of map.get(`${Math.round(cx * 10) + dx},${Math.round(cz * 10) + dz}`) ?? []) {
        const x = (m.vertices[v * 6] + m.vertices[(v + 1) * 6] + m.vertices[(v + 2) * 6]) / 3;
        const z = (m.vertices[v * 6 + 2] + m.vertices[(v + 1) * 6 + 2] + m.vertices[(v + 2) * 6 + 2]) / 3;
        const d = Math.hypot(x - cx, z - cz);
        if (d < bestD) { bestD = d; best = v; }
      }
    }
  }
  return best;
}

/** the cover kinds of the TIN faces standing on the mesh's vertices [from, to) (skirts stand on none) */
export function kindsInRange(m: TerrainMeshData, tin: SurfaceTin, cover: GroundCover, from: number, to: number): Set<string> {
  const kinds = new Set<string>();
  tin.tris.forEach((_, f) => {
    const v = vertexOfFace(m, tin, f);
    if (v >= from && v < to) kinds.add(tin.cover![f] < 0 ? 'ground' : cover.shapes[tin.cover![f]].kind);
  });
  return kinds;
}

/** a primary road through a park, the raw Overpass reply for TILE (the workers' cached OSM) */
export function townOverpassJson(): string {
  const ll = (x: number, y: number) => { const p = gridLatLon(TILE, x, y, GRID); return { lon: p.lon, lat: p.lat }; };
  const ring = [[20, 20], [44, 20], [44, 44], [20, 44]];
  return JSON.stringify({
    elements: [
      { type: 'node', id: 1, ...ll(32, 4) }, { type: 'node', id: 2, ...ll(32, 60) },
      ...ring.map(([x, y], k) => ({ type: 'node', id: 10 + k, ...ll(x, y) })),
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'primary' } },
      { type: 'way', id: 101, nodes: [10, 11, 12, 13, 10], tags: { leisure: 'park' } },
    ],
  });
}

/** a park alone, the raw Overpass reply for TILE (the workers' cached OSM) */
export function parkOverpassJson(): string {
  const ll = (x: number, y: number) => { const p = gridLatLon(TILE, x, y, GRID); return { lon: p.lon, lat: p.lat }; };
  const ring = [[20, 20], [44, 20], [44, 44], [20, 44]];
  return JSON.stringify({
    elements: [
      ...ring.map(([x, y], k) => ({ type: 'node', id: 10 + k, ...ll(x, y) })),
      { type: 'way', id: 101, nodes: [10, 11, 12, 13, 10], tags: { leisure: 'park' } },
    ],
  });
}
