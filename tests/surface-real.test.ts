/**
 * The surface of real dense z14 tiles with their ground covers (fixtures: the inputs of
 * buildSurfaceTin as the OSM worker had them): within the vertex budget in one build, and which
 * ways the budget leaves to their ribbons
 */
import { describe, expect, it } from 'vitest';
import { coastlineWays } from '../src/world/coast';
import { buildGroundCover } from '../src/world/ground-cover';
import type { Pad } from '../src/world/aerodrome';
import { latLonToEnu, tileCenter, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildOsmMesh, classifyLine, type OsmMeshOptions } from '../src/world/osm-mesher';
import { tinSampler } from '../src/world/terrain-tin';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin, MAX_SURFACE_VERTS, roadSurfaceOf, type SurfaceStats } from '../src/world/surface-tin';
import type { TileBorders } from '../src/world/terrain-source';
import type { TinDebug } from '../src/world/terrain-tin';
import { cracks } from './roads-helpers';

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
  const stats = {} as SurfaceStats, debug = {} as TinDebug;
  const tin = buildSurfaceTin(fx.tile, fx.grid, f32(fx.heights), { borders, coast: coastlineWays(fx.data.lines), pads: fx.pads, roads, cover, stats, debug });
  return { tin, cover, stats, debug, roads, fx };
}

/** Fethiye's tile */
const fixtureTile: Tile = { z: 14, x: 9517, y: 6397 };

/** the roads above a service road */
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|living_street)$/;

describe('real dense tiles in the surface budget', () => {
  it('Fethiye 14/9517/6397: every way and pool in the surface, in one build, every fixed edge in and no crack', async () => {
    const { tin, cover, stats, debug } = await surfaceOf('surface-14-9517-6397');
    expect(cracks(tin)).toBe(0);
    expect(debug.missing).toBe(0);
    expect(stats.builds).toBe(1);
    expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
    expect(tin.loose).toBeUndefined();
    expect(stats.picked).toBe(stats.units);
    expect(cover.shapes.filter((s) => s.kind === 'water').length).toBeGreaterThan(50);
  });

  it('Fethiye 14/9517/6397: each face lies in its own cover (the canal along the bank roads at 36.64774, 29.12803 included)', async () => {
    const { tin, cover } = await surfaceOf('surface-14-9517-6397');
    // the shape under each face's centre (a road's bank is the ground's, in the water's shape)
    const coverAt = (x: number, y: number): number => cover.locate(x, y);
    // halfway from a face's centre to each corner: in the face's cover, but in faces the fixed lines'
    // snapping (insertFixedLines, 1e-3 lattice: 3 cm here) left a sliver of another cover in. At
    // most four reach further, carriageway, shoulder or path, none 20 cm: before the tuning some 750
    // faces did (dropped pools and areas painted by their centre, loose footways); the round end of a
    // cover's stretch shorter than its width reached past its square end (a bridge's cover cut where
    // its deck lifts) until its caps were halves
    const SNAP = 1.1e-3, mPer = 1 / (tin.grid / tileSizeMeters(fixtureTile));
    const off: { kind: string; reach: number }[] = [];
    tin.tris.forEach((t, f) => {
      const cx = (tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, cy = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      const own = tin.cover![f] < 0 ? coverAt(cx, cy) : tin.cover![f];
      if (![t.a, t.b, t.c].some((v) => coverAt((cx + tin.vx[v]) / 2, (cy + tin.vy[v]) / 2) !== own)) return;
      // how far into the face the other cover reaches (from its sides), lattice cells
      const P = [t.a, t.b, t.c].map((v) => [tin.vx[v], tin.vy[v]]);
      let reach = 0;
      for (let i = 0; i <= 30; i++) for (let j = 0; i + j <= 30; j++) {
        const a = i / 30, b = j / 30, c = 1 - a - b, x = a * P[0][0] + b * P[1][0] + c * P[2][0], y = a * P[0][1] + b * P[1][1] + c * P[2][1];
        if (coverAt(x, y) === own) continue;
        reach = Math.max(reach, Math.min(...[0, 1, 2].map((e) => {
          const [ax, ay] = P[e], [bx, by] = P[(e + 1) % 3], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          return Math.hypot(x - ax - dx * u, y - ay - dy * u);
        })));
      }
      off.push({ kind: own < 0 ? 'ground' : cover.shapes[own].kind, reach });
    });
    const deep = off.filter((o) => o.reach > SNAP);
    expect(deep.length).toBeLessThanOrEqual(4);
    expect(deep.filter((o) => !['carriageway', 'shoulder', 'path'].includes(o.kind))).toEqual([]);
    expect(Math.max(0, ...off.map((o) => o.reach)) * mPer).toBeLessThan(0.2);
    expect(off.length).toBeLessThanOrEqual(12);
  });

  it('Fethiye 14/9517/6397: over the deck of Celal Bayar Caddesi (its bridge over the canal) one asphalt within 0.3 m of the deck, no step where it lifts', async () => {
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6397');
    const c = tileCenter(fx.tile);
    const enu = (lon: number, lat: number): [number, number] => { const [e, n] = latLonToEnu(c, lat, lon, 0); return [e, -n]; };
    const m = buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight: tinSampler(tin, fx.tile), tin, buildings: false, roads, cover, faceColor: () => 0 } as OsmMeshOptions).roads;
    const net = roads!.net, w = net.ways.find((x) => x.bridge && Math.abs(x.line.points[0][1] - 36.64778) < 2e-4 && Math.abs(x.line.points[0][0] - 29.12805) < 2e-4)!;
    const deck = Array.from(roads!.z.subarray(w.first, w.first + w.count));
    const [a, b] = [w.line.points[0], w.line.points[w.line.points.length - 1]].map(([lon, lat]) => enu(lon, lat));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len, half = classifyLine(w.line.tags)!.width / 2 - 0.1;
    const off: string[] = [];
    let worstStep = 0;
    for (let o = -half; o <= half + 1e-9; o += half / 4) {
      let prev: number | undefined;
      for (let d = 0.05; d < len - 0.05; d += 0.1) {
        const hs = surfacesOver(m, a[0] + ux * d - uz * o, a[1] + uz * d + ux * o);
        // the deck's own height there (its samples' along it)
        const f = (d / len) * (deck.length - 1), i = Math.min(deck.length - 2, Math.floor(f)), here = deck[i] + (deck[i + 1] - deck[i]) * (f - i);
        if (hs.length !== 1 || hs[0] < here - 0.3 || hs[0] > here + 0.05) off.push(`${d.toFixed(1)} ${o.toFixed(1)}: ${hs.map((h) => h.toFixed(2))} deck ${here.toFixed(2)}`);
        if (hs.length === 1 && prev !== undefined) worstStep = Math.max(worstStep, Math.abs(hs[0] - prev));
        prev = hs.length === 1 ? hs[0] : undefined;
      }
    }
    expect(off).toEqual([]);
    expect(worstStep).toBeLessThanOrEqual(0.05);
  }, 30_000);

  it('Innsbruck 14/8710/5744: the budget filled in one build, no road above a service road nor a track’s ballast left out, no crack', async () => {
    const { tin, cover, stats, debug } = await surfaceOf('surface-14-8710-5744');
    expect(cracks(tin)).toBe(0);
    expect(debug.missing).toBe(0);
    expect(stats.builds).toBe(1);
    expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
    expect(tin.vx.length).toBeGreaterThan(0.9 * MAX_SURFACE_VERTS);
    const loose = tin.loose ?? new Set<OsmLine>();
    expect([...loose].filter((l) => MAJOR.test(l.tags.highway ?? ''))).toEqual([]);
    expect(cover.shapes.filter((s) => s.kind === 'ballast' && loose.has(s.source as OsmLine))).toEqual([]);
  });
});

/** the heights of the mesh's triangles over (x, z) (tile-centre metres), on none of their sides */
function surfacesOver(m: { vertices: Float32Array; vertexCount: number }, x: number, z: number): number[] {
  const v = m.vertices, out: number[] = [];
  for (let t = 0; t + 2 < m.vertexCount; t += 3) {
    const p = [0, 1, 2].map((k) => [v[(t + k) * 6], v[(t + k) * 6 + 1], v[(t + k) * 6 + 2]]);
    const det = (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (p[1][2] - p[0][2]);
    if (Math.abs(det) < 1e-9) continue;
    const w1 = ((x - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (z - p[0][2])) / det;
    const w2 = ((p[1][0] - p[0][0]) * (z - p[0][2]) - (x - p[0][0]) * (p[1][2] - p[0][2])) / det;
    if (w1 < 1e-7 || w2 < 1e-7 || w1 + w2 > 1 - 1e-7) continue;
    out.push(p[0][1] * (1 - w1 - w2) + p[1][1] * w1 + p[2][1] * w2);
  }
  return out;
}
