/** shared set-up of the road tests: a z14 tile over a relief given in metres, roads in lattice units */
import { enuToLatLon, gridLatLon, tileSizeMeters, type Tile } from '../src/world/geodesy';
import type { LonLat, OsmLine } from '../src/world/osm-types';
import { tinLatticeSampler, type TerrainTin } from '../src/world/terrain-tin';
import type { TileBorders } from '../src/world/terrain-source';
import type { Pad } from '../src/world/aerodrome';
import type { RoadNet } from '../src/world/road-net';

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

/** an OSM way through lattice points of `tile` */
export function road(tags: Record<string, string>, pts: [number, number][], tile: Tile = TILE): OsmLine {
  return { tags, points: pts.map(([x, y]): LonLat => { const ll = gridLatLon(tile, x, y, GRID); return [ll.lon, ll.lat]; }) };
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
