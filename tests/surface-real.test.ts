/**
 * The surface of real dense z14 tiles with their ground covers (fixtures: the inputs of
 * buildSurfaceTin as the OSM worker had them): within the vertex budget in one build, and which
 * ways the budget leaves to their ribbons
 */
import { describe, expect, it } from 'vitest';
import { coastlineWays } from '../src/world/coast';
import { buildGroundCover } from '../src/world/ground-cover';
import type { Pad } from '../src/world/aerodrome';
import type { Tile } from '../src/world/geodesy';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin, MAX_SURFACE_VERTS, roadSurfaceOf, type SurfaceStats } from '../src/world/surface-tin';
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

/** the tile's surface with its covers, as the OSM worker builds it */
async function surfaceOf(name: string) {
  const fx = (await import(`./fixtures/${name}.json`)).default as Fixture;
  const f32 = (a: number[]) => Float32Array.from(a);
  const borders: TileBorders = { n: f32(fx.borders.n), s: f32(fx.borders.s), w: f32(fx.borders.w), e: f32(fx.borders.e) };
  if (fx.borders.coarse) borders.coarse = Object.fromEntries(Object.entries(fx.borders.coarse).map(([k, v]) => [k, f32(v!)]));
  const net = buildRoadNet(fx.data.lines);
  const roads = fx.roadDem ? roadSurfaceOf(fx.tile, fx.data, net, Float64Array.from(fx.roadDem)) : undefined;
  const cover = buildGroundCover(fx.tile, fx.grid, fx.data, roads);
  const stats = {} as SurfaceStats;
  const tin = buildSurfaceTin(fx.tile, fx.grid, f32(fx.heights), { borders, coast: coastlineWays(fx.data.lines), pads: fx.pads, roads, cover, stats });
  return { tin, cover, stats };
}

/** the roads above a service road */
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|living_street)$/;

describe('real dense tiles in the surface budget', () => {
  it('Fethiye 14/9517/6397: every way and pool in the surface, in one build', async () => {
    const { tin, cover, stats } = await surfaceOf('surface-14-9517-6397');
    expect(stats.builds).toBe(1);
    expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
    expect(tin.loose).toBeUndefined();
    expect(stats.picked).toBe(stats.units);
    expect(cover.shapes.filter((s) => s.kind === 'water').length).toBeGreaterThan(50);
  });

  it('Innsbruck 14/8710/5744: the budget filled in one build, no road above a service road nor a track’s ballast left out', async () => {
    const { tin, cover, stats } = await surfaceOf('surface-14-8710-5744');
    expect(stats.builds).toBe(1);
    expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
    expect(tin.vx.length).toBeGreaterThan(0.9 * MAX_SURFACE_VERTS);
    const loose = tin.loose ?? new Set<OsmLine>();
    expect([...loose].filter((l) => MAJOR.test(l.tags.highway ?? ''))).toEqual([]);
    expect(cover.shapes.filter((s) => s.kind === 'ballast' && loose.has(s.source as OsmLine))).toEqual([]);
  });
});
