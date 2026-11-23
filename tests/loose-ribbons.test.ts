/**
 * The ribbons of the ways the TIN's budget dropped on a real dense tile (Innsbruck 14/8710/5744, the
 * fixture of surface-real.test.ts): on the ground's faces, ordered by few depth levels
 */
import { describe, expect, it } from 'vitest';
import { coastlineWays } from '../src/world/coast';
import { buildGroundCover } from '../src/world/ground-cover';
import type { Pad } from '../src/world/aerodrome';
import { enuToLatLon, latLonToEnu, tileCenter, tileLattice, tileSizeMeters, type Tile } from '../src/world/geodesy';
import type { LonLat, OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildOsmMesh, classifyLine, RAIL_ZONE_M } from '../src/world/osm-mesher';
import { buildRoadLevels, LIFT_EPS_M } from '../src/world/road-levels';
import { isBridge } from '../src/world/way-styles';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin, roadSurfaceOf, type SurfaceTin } from '../src/world/surface-tin';
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

/** the tile's drape with its covers, as the OSM worker builds it */
async function meshOf(name: string) {
  const fx = (await import(`./fixtures/${name}.json`)).default as Fixture;
  const f32 = (a: number[]) => Float32Array.from(a);
  const borders: TileBorders = { n: f32(fx.borders.n), s: f32(fx.borders.s), w: f32(fx.borders.w), e: f32(fx.borders.e) };
  if (fx.borders.coarse) borders.coarse = Object.fromEntries(Object.entries(fx.borders.coarse).map(([k, v]) => [k, f32(v!)]));
  const net = buildRoadNet(fx.data.lines);
  const roads = fx.roadDem ? roadSurfaceOf(fx.tile, fx.data, net, Float64Array.from(fx.roadDem)) : undefined;
  const cover = buildGroundCover(fx.tile, fx.grid, fx.data, roads);
  const tin = buildSurfaceTin(fx.tile, fx.grid, f32(fx.heights), { borders, coast: coastlineWays(fx.data.lines), pads: fx.pads, roads, cover });
  const sampleHeight = tinSampler(tin, fx.tile);
  const mesh = buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight, tin, roads, cover });
  return { mesh, tin, tile: fx.tile, sampleHeight, data: fx.data };
}

/**
 * Whether a point (tile-centre ENU) is on a ribbon of a dropped way the road levels may lift: within
 * reach of the centre line of one road levels lift (maxLift) or of a bridge (the roads' own heights
 * lift their bridges: osm-mesher bridgeLevels)
 */
function onLifted(tile: Tile, data: Fixture['data'], loose: Set<OsmLine>): (x: number, z: number) => boolean {
  const c = tileCenter(tile);
  const enu = ([lon, lat]: LonLat): [number, number] => {
    const [e, n] = latLonToEnu(c, lat, lon, 0);
    return [e, -n];
  };
  const levels = buildRoadLevels(data.lines, data.areas, enu);
  const segs: { a: [number, number]; b: [number, number]; reach: number }[] = [];
  for (const line of loose) {
    if (levels.maxLift(line) < LIFT_EPS_M && !isBridge(line.tags)) continue;
    const style = classifyLine(line.tags);
    if (!style) continue;
    const reach = (style.width / 2 + (style.shoulder ?? 0) + (style.rail ? RAIL_ZONE_M : 0)) * Math.SQRT2 + 1;
    const p = line.points.map(enu);
    for (let i = 0; i + 1 < p.length; i++) segs.push({ a: p[i], b: p[i + 1], reach });
  }
  return (x, z) => segs.some(({ a, b, reach }) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < reach;
  });
}

/**
 * How far each triangle's vertices lie from the plane of the TIN face under its centre, metres, less
 * what the float32 vertex position alone explains (its rounding times the face's slope)
 */
function offFaces(m: { vertices: Float32Array }, levels: Float32Array, tin: SurfaceTin, tile: Tile): { off: number; x: number; z: number }[] {
  const c = tileCenter(tile), toLattice = tileLattice(tile, tin.grid), perMetre = tin.grid / tileSizeMeters(tile);
  const locate = tinLocator(tin, tile);
  const h = tin.vh.map((v) => Math.max(v, 0));
  const offs: { off: number; x: number; z: number }[] = [];
  for (let v = 0; v + 2 < levels.length; v += 3) {
    if (levels[v] === 0) continue;
    const pts = [0, 1, 2].map((k) => {
      const ll = enuToLatLon(c, m.vertices[(v + k) * 6], -m.vertices[(v + k) * 6 + 2], 0);
      return { ll, xy: toLattice([ll.lon, ll.lat]), y: m.vertices[(v + k) * 6 + 1], x: m.vertices[(v + k) * 6], z: m.vertices[(v + k) * 6 + 2] };
    });
    const mid = enuToLatLon(c, (pts[0].x + pts[1].x + pts[2].x) / 3, -(pts[0].z + pts[1].z + pts[2].z) / 3, 0);
    const r = locate(mid.lon, mid.lat);
    if (!r) continue;
    const t = tin.tris[r.tri];
    const [ax, ay, bx, by, cx, cy] = [tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]];
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    // the face's plane over the lattice, and its slope in metres per metre
    const gx = ((h[t.b] - h[t.a]) * (cy - ay) - (h[t.c] - h[t.a]) * (by - ay)) / det;
    const gy = ((h[t.c] - h[t.a]) * (bx - ax) - (h[t.b] - h[t.a]) * (cx - ax)) / det;
    const slope = Math.hypot(gx, gy) * perMetre;
    for (const p of pts) {
      const plane = h[t.a] + gx * (p.xy[0] - ax) + gy * (p.xy[1] - ay);
      // float32 rounding of x and z (|x| < 2048 m) and of y
      const rounding = 2 ** -12 * slope + 2 ** -13;
      offs.push({ off: Math.sign(p.y - plane) * Math.max(0, Math.abs(p.y - plane) - rounding), x: p.x, z: p.z });
    }
  }
  return offs;
}

describe('the dropped ways’ ribbons on a real dense tile', () => {
  it('Innsbruck 14/8710/5744: every piece of a way not lifted on the face under it, in few depth levels', async () => {
    const { mesh, tin, tile, data } = await meshOf('surface-14-8710-5744');
    expect(tin.loose!.size).toBeGreaterThan(500);
    const offs = offFaces(mesh, mesh.depthLevels, tin, tile)
      .concat(offFaces(mesh.roads, mesh.roadDepthLevels, tin, tile), offFaces(mesh.water, mesh.waterDepthLevels, tin, tile));
    const lifted = onLifted(tile, data, tin.loose!);
    const flat = offs.filter((o) => !lifted(o.x, o.z));
    expect(offs.length).toBeGreaterThan(100000);
    // the lifted ways’ ribbons and what lies within their reach: about a tenth of the pieces
    expect(flat.length / offs.length).toBeGreaterThan(0.85);
    // every other one on its face (to 0.1 mm past what float32 positions explain)
    expect(flat.filter((o) => Math.abs(o.off) >= 1e-4)).toEqual([]);
    // and nothing anywhere under its face
    expect(offs.filter((o) => o.off <= -1e-4)).toEqual([]);
    const top = [mesh.depthLevels, mesh.roadDepthLevels, mesh.waterDepthLevels].reduce((m, a) => a.reduce((x, l) => Math.max(x, l), m), 0);
    expect(top).toBeLessThanOrEqual(12);
  });
});
