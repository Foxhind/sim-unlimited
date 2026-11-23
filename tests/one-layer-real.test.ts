/**
 * The one-layer ground of real dense tiles (the fixtures of surface-real.test.ts), the terrain mesh
 * and the OSM mesh together: the road and water faces on the terrain's own vertices, and what the
 * vertex budget drops (Innsbruck 14/8710/5744) still drawn whole, under its seniors
 */
import { describe, expect, it } from 'vitest';
import { coastlineWays } from '../src/world/coast';
import { buildGroundCover } from '../src/world/ground-cover';
import type { Pad } from '../src/world/aerodrome';
import type { Tile } from '../src/world/geodesy';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin, roadSurfaceOf } from '../src/world/surface-tin';
import { buildTerrainMesh } from '../src/world/terrain-mesher';
import { tinSampler } from '../src/world/terrain-tin';
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
