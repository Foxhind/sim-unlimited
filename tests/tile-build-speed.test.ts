import { describe, expect, it } from 'vitest';
import { tileWorkerCount } from '../src/engine/queue';
import { padAdjust, padDistance, padHeightEnu, PAD_BLEND_M, type Pad } from '../src/world/aerodrome';
import { EARTH_R, latLonToEnu } from '../src/world/geodesy';
import { buildRoadNet, type RoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildingHeights } from '../src/world/building-mesher';
import { demOf, road } from './roads-helpers';
import type { Tile } from '../src/world/geodesy';
import type { TileBorders } from '../src/world/terrain-source';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { roadSurfaceOf, buildSurfaceTin } from '../src/world/surface-tin';
import { buildGroundCover } from '../src/world/ground-cover';
import { coastlineWays } from '../src/world/coast';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { tinSampler } from '../src/world/terrain-tin';
import { buildTerrainMesh, terrainMeshBuffers } from '../src/world/terrain-mesher';
import { terrainMeshKey } from '../src/world/osm-source';
import { SCHEMA_VERSION } from '../src/world/tile-cache';

// The speed-ups of a dense tile's build (central Moscow: 4000 buildings, 84 pitch pads, 35 000 road
// samples) must not change what is built: each is checked against the plain computation here.

describe('tile workers by the cores', () => {
  it('half the cores, 2 to 4', () => {
    expect(tileWorkerCount(2)).toBe(2);
    expect(tileWorkerCount(4)).toBe(2);
    expect(tileWorkerCount(6)).toBe(3);
    expect(tileWorkerCount(8)).toBe(4);
    expect(tileWorkerCount(16)).toBe(4);
    // this machine's: within the bounds
    expect(tileWorkerCount()).toBeGreaterThanOrEqual(2);
    expect(tileWorkerCount()).toBeLessThanOrEqual(4);
  });
});

describe('pads: a far pad skipped before the exact ENU', () => {
  /** a pitch-sized pad: a 60 × 40 m hull on a tilted plane, at lon/lat */
  const pad = (lon: number, lat: number, key: string, blend?: number): Pad => ({
    key, origin: { lat, lon }, hull: [[-30, -20], [30, -20], [30, 20], [-30, 20]], ring: [], h0: 140 + lon, ge: 0.01, gn: -0.02, blend,
  });
  /** padAdjust as it was: every pad weighed by its exact ENU distance */
  const plain = (pads: Pad[], lon: number, lat: number, h: number, grid = 64): number => {
    const flatM = (1.5 * (((2 * Math.PI * EARTH_R) / 2 ** 14) * Math.cos((lat * Math.PI) / 180))) / grid;
    let bestW = 0, bestH = h;
    for (const p of pads) {
      const [e, n] = latLonToEnu(p.origin, lat, lon, 0);
      const d = padDistance(p, e, n) - flatM, blend = p.blend ?? PAD_BLEND_M;
      const t = 1 - d / blend;
      const w = d <= 0 ? 1 : d >= blend ? 0 : t * t * (3 - 2 * t);
      if (w > bestW) { bestW = w; bestH = padHeightEnu(p, e, n); }
    }
    return bestW >= 1 ? bestH : bestW > 0 ? h * (1 - bestW) + bestH * bestW : h;
  };

  it('gives exactly the plain heights, on, near, at the edge of the blend and far from the pads', () => {
    const pads = [pad(37.61, 55.76, 'a'), pad(37.615, 55.762, 'b', 40), pad(37.6, 55.75, 'c'), pad(-122.4, 37.77, 'd'), pad(151.2, -33.87, 'e')];
    let rnd = 12345;
    const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
    let near = 0, far = 0;
    for (const p of pads) {
      for (let k = 0; k < 3000; k++) {
        // out to ~1.5 km: inside, in the blend, just beyond it and well away
        const dist = 1500 * r() ** 2, a = 2 * Math.PI * r();
        const lat = p.origin.lat + (dist * Math.sin(a)) / 111320;
        const lon = p.origin.lon + (dist * Math.cos(a)) / (111320 * Math.cos((p.origin.lat * Math.PI) / 180));
        const h = 100 + 50 * r();
        const want = plain(pads, lon, lat, h);
        expect(padAdjust(pads, lon, lat, h)).toBe(want);
        if (want !== h) near++;
        else far++;
      }
    }
    // both cases exercised
    expect(near).toBeGreaterThan(1000);
    expect(far).toBeGreaterThan(1000);
  });
});

describe('road heights: the typed heap gives the same numbers', () => {
  /** solveRoadHeights as it was (array heap, tuple neighbours) */
  const kernel = (d: number, window: number) => { const u = d / window; return u >= 1 ? 0 : (1 - u * u) * (1 - u * u); };
  function plain(net: RoadNet, dem: ArrayLike<number>, window: number): Float64Array {
    const n = net.samples.length, out = new Float64Array(n).fill(NaN);
    const w = Float64Array.from(net.samples, (s, i) => (net.ways[s.way].tunnel || !Number.isFinite(dem[i]) ? 0 : net.ways[s.way].weight));
    const dist = new Float64Array(n), stamp = new Int32Array(n).fill(-1), done = new Int32Array(n).fill(-1);
    const hd: number[] = [], hi: number[] = [];
    const push = (d: number, i: number) => {
      let k = hd.length;
      hd.push(d); hi.push(i);
      while (k > 0) { const p = (k - 1) >> 1; if (hd[p] <= d) break; hd[k] = hd[p]; hi[k] = hi[p]; k = p; }
      hd[k] = d; hi[k] = i;
    };
    const pop = () => {
      const top = hi[0], d = hd.pop()!, i = hi.pop()!;
      if (hd.length) {
        let k = 0;
        for (;;) {
          let c = 2 * k + 1;
          if (c >= hd.length) break;
          if (c + 1 < hd.length && hd[c + 1] < hd[c]) c++;
          if (hd[c] >= d) break;
          hd[k] = hd[c]; hi[k] = hi[c]; k = c;
        }
        hd[k] = d; hi[k] = i;
      }
      return top;
    };
    for (let q = 0; q < n; q++) {
      let sum = 0, wsum = 0;
      hd.length = hi.length = 0;
      stamp[q] = q; dist[q] = 0; push(0, q);
      while (hd.length) {
        const d0 = hd[0], p = pop();
        if (done[p] === q || d0 > dist[p]) continue;
        done[p] = q;
        if (w[p] > 0) { const k = kernel(d0, window) * w[p]; sum += k * dem[p]; wsum += k; }
        for (const [r, m] of net.next[p]) {
          const d = d0 + m;
          if (d >= window || done[r] === q) continue;
          if (stamp[r] !== q || d < dist[r]) { stamp[r] = q; dist[r] = d; push(d, r); }
        }
      }
      if (wsum > 0) out[q] = sum / wsum;
    }
    return out;
  }

  it('on a street grid with a junction every block, bit for bit', () => {
    const lines = [];
    for (let k = 4; k <= 60; k += 7) {
      lines.push(road({ highway: k % 2 ? 'primary' : 'residential' }, [[2, k], [32, k + 1], [62, k]]));
      lines.push(road({ highway: 'tertiary' }, [[k, 2], [k + 1, 32], [k, 62]]));
    }
    lines.push(road({ highway: 'service', tunnel: 'yes' }, [[10, 10], [50, 50]]));
    const net = buildRoadNet(lines);
    const dem = demOf(net, (x, y) => 140 + 9 * Math.sin(x / 13) + 0.07 * y);
    expect(net.samples.length).toBeGreaterThan(500);
    for (const window of [90, 37.5]) expect(Array.from(solveRoadHeights(net, dem, window))).toEqual(Array.from(plain(net, dem, window)));
  });
});

describe('building heights once a building', () => {
  it('the same frozen numbers each time, as computed', () => {
    const b = { rings: [[[37.6, 55.76], [37.6004, 55.76], [37.6004, 55.7603], [37.6, 55.7603], [37.6, 55.76]] as [number, number][]], tags: { building: 'house', 'roof:shape': 'gabled', 'building:levels': '2' } };
    const first = buildingHeights(b);
    expect(buildingHeights(b)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(buildingHeights({ rings: b.rings, tags: { ...b.tags } })).toEqual(first);
  });
});

describe('the z14 terrain mesh built once, on the OSM worker\'s surface', () => {
  it.each(['surface-14-9517-6397'])('%s: the same bytes as the terrain worker builds alone', async (name) => {
    const fx = (await import(`./fixtures/${name}.json`)).default as {
      tile: Tile; grid: number; heights: number[]; pads: Pad[]; roadDem: number[] | null;
      borders: Record<'n' | 's' | 'w' | 'e', number[]> & { coarse?: Partial<Record<'n' | 's' | 'w' | 'e', number[]>> };
      data: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] };
    };
    const f32 = (a: number[]) => Float32Array.from(a);
    const borders: TileBorders = { n: f32(fx.borders.n), s: f32(fx.borders.s), w: f32(fx.borders.w), e: f32(fx.borders.e) };
    if (fx.borders.coarse) borders.coarse = Object.fromEntries(Object.entries(fx.borders.coarse).map(([k, v]) => [k, f32(v!)]));
    // each worker its own inputs from the same OSM and DEM
    const inputs = () => {
      const net = buildRoadNet(fx.data.lines);
      const roads = fx.roadDem ? roadSurfaceOf(fx.tile, fx.data, net, Float64Array.from(fx.roadDem)) : undefined;
      return { heights: f32(fx.heights), coast: coastlineWays(fx.data.lines), roads, cover: buildGroundCover(fx.tile, fx.grid, fx.data, roads) };
    };
    const t = inputs();
    const alone = buildTerrainMesh({ tile: fx.tile, grid: fx.grid, heights: t.heights, borders, coast: t.coast, pads: fx.pads, roads: t.roads, cover: t.cover });
    // the OSM worker: its surface, its OSM mesh draped on it, then the terrain mesh on that surface
    const o = inputs();
    const tin = buildSurfaceTin(fx.tile, fx.grid, o.heights, { borders, coast: o.coast, pads: fx.pads, roads: o.roads, cover: o.cover });
    buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight: tinSampler(tin, fx.tile), tin, roads: o.roads, cover: o.cover });
    const shared = buildTerrainMesh({ tile: fx.tile, grid: fx.grid, heights: o.heights, borders, coast: o.coast, pads: fx.pads, roads: o.roads, cover: o.cover, surface: tin });
    const a = terrainMeshBuffers(alone, true), b = terrainMeshBuffers(shared, true);
    expect(new Uint8Array(b.vertices)).toEqual(new Uint8Array(a.vertices));
    expect(new Uint32Array(b.ramps)).toEqual(new Uint32Array(a.ramps));
    expect(b.morph && new Float32Array(b.morph)).toEqual(a.morph && new Float32Array(a.morph));
    expect([b.nearCount, b.farCount]).toEqual([a.nearCount, a.farCount]);
  });

  it('one cache key for both workers: the DEM schema, then our tiles\' or Overpass\' raw by its time', () => {
    const tile = { z: 14, x: 9903, y: 5121 };
    expect(terrainMeshKey(tile, undefined, 'pmtiles')).toBe(`dem/14/9903/5121/${SCHEMA_VERSION}`);
    expect(terrainMeshKey(tile, { ts: 42 }, 'pmtiles')).toBe(`dem/14/9903/5121/${SCHEMA_VERSION}/op@42`);
    expect(terrainMeshKey(tile, { ts: 42 }, 'overpass')).toBe(`dem/14/9903/5121/${SCHEMA_VERSION}/o@42`);
  });
});
