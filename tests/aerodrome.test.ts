import { describe, expect, it, vi } from 'vitest';
import { enuToLatLon, latLonToEnu, mercatorYToLat, type LatLon, type Tile } from '../src/world/geodesy';
import type { LonLat, OsmArea, OsmLine } from '../src/world/osm-types';

/** the DEM the pads are fitted on: a tilted plane with a bump and some noise */
const PLANE = { h0: 180, ge: 0.012, gn: -0.006 };
const CENTRE: LatLon = { lat: 55.97, lon: 37.41 };
function relief(lon: number, lat: number): number {
  const [e, n] = latLonToEnu(CENTRE, lat, lon, 0);
  return PLANE.h0 + PLANE.ge * e + PLANE.gn * n + 40 * Math.sin(e / 700) * Math.cos(n / 900);
}
vi.mock('../src/world/terrain-source', async (orig) => ({
  ...(await orig<typeof import('../src/world/terrain-source')>()),
  demHeights: async (pts: ReadonlyArray<readonly [number, number]>) => {
    return Float64Array.from(pts, ([lon, lat]) => {
      const [e, n] = latLonToEnu(CENTRE, lat, lon, 0);
      return PLANE.h0 + PLANE.ge * e + PLANE.gn * n + (((Math.round(e * 7 + n * 13) % 5) + 5) % 5) - 2;
    });
  },
}));

const { applyPads, buildPad, isPitchGround, neighbourPads, padDistance, padHeight, padSources, PAD_BLEND_M, PITCH_PAD } = await import('../src/world/aerodrome');
const { buildTerrainTin, tinSampler } = await import('../src/world/terrain-tin');

const GRID = 48;
const Z = 14;
const n = 2 ** Z;
/** the z14 tile under CENTRE and its east neighbour: the aerodrome straddles their seam */
const A: Tile = { z: Z, x: Math.floor(((CENTRE.lon + 180) / 360) * n), y: 0 };
{
  const s = Math.sin((CENTRE.lat * Math.PI) / 180);
  A.y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
}
const B: Tile = { ...A, x: A.x + 1 };
const seamLon = ((A.x + 1) / n) * 360 - 180;
const tileLat = (mercatorYToLat(A.y / n) + mercatorYToLat((A.y + 1) / n)) / 2;

/** an aerodrome outline (concave, an L) around the seam of A and B */
function aerodrome(): OsmArea {
  const o = { lat: tileLat, lon: seamLon };
  const pts: [number, number][] = [[-600, -300], [500, -300], [500, 50], [0, 50], [0, 250], [-600, 250], [-600, -300]];
  const ring: LonLat[] = pts.map(([e, nn]) => {
    const p = enuToLatLon(o, e, nn, 0);
    return [p.lon, p.lat];
  });
  return { rings: [ring], tags: { aeroway: 'aerodrome', icao: 'XXXX' } };
}

function lattice(t: Tile) {
  const side = GRID + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const N = n * GRID;
      heights[j * side + i] = relief(((t.x * GRID + i) / N) * 360 - 180, mercatorYToLat((t.y * GRID + j) / N));
    }
  }
  const borders = {
    n: Float32Array.from({ length: side }, (_, k) => heights[k]),
    s: Float32Array.from({ length: side }, (_, k) => heights[GRID * side + k]),
    w: Float32Array.from({ length: side }, (_, k) => heights[k * side]),
    e: Float32Array.from({ length: side }, (_, k) => heights[k * side + GRID]),
  };
  return { heights, borders };
}

describe('aerodrome pads', () => {
  it('fits one plane to the DEM under the whole aerodrome', async () => {
    const [src] = padSources({ areas: [aerodrome()], lines: [] });
    const pad = (await buildPad(src))!;
    expect(pad).not.toBeNull();
    // the fitted plane is the DEM's plane (noise ±2 m averages out)
    for (const [e, nn] of [[-500, -200], [400, 0], [-300, 200]]) {
      const p = enuToLatLon(pad.origin, e, nn, 0);
      const [ce, cn] = latLonToEnu(CENTRE, p.lat, p.lon, 0);
      expect(padHeight(pad, p.lon, p.lat)).toBeCloseTo(PLANE.h0 + PLANE.ge * ce + PLANE.gn * cn, 0);
    }
    // the territory is convex and covers the outline with its margin
    for (const [lon, lat] of aerodrome().rings[0]) {
      const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
      expect(padDistance(pad, e, nn)).toBeLessThan(-15);
    }
  });

  it('a runway inside the aerodrome gets no pad of its own, one outside does', () => {
    const o = { lat: tileLat, lon: seamLon };
    const line = (e0: number, e1: number): OsmLine => {
      const a = enuToLatLon(o, e0, -100, 0), b = enuToLatLon(o, e1, -100, 0);
      return { points: [[a.lon, a.lat], [b.lon, b.lat]], tags: { aeroway: 'runway', width: '45' } };
    };
    expect(padSources({ areas: [aerodrome()], lines: [line(-500, 400)] })).toHaveLength(1);
    expect(padSources({ areas: [aerodrome()], lines: [line(3000, 4500)] })).toHaveLength(2);
  });

  it('puts both tiles of a seam on the same plane, with no bend anywhere inside the territory', async () => {
    const pad = (await buildPad(padSources({ areas: [aerodrome()], lines: [] })[0]))!;
    const built = [A, B].map((t) => {
      const dem = lattice(t);
      const before = dem.heights.slice();
      applyPads(dem, t, GRID, [pad]);
      const tin = buildTerrainTin(t, GRID, dem.heights, { borders: dem.borders, pads: [pad] });
      return { t, dem, before, tin, surface: tinSampler(tin, t) };
    });
    // the seam profiles agree bit for bit and stay the lattice's edge rows
    expect(Array.from(built[0].dem.borders.e)).toEqual(Array.from(built[1].dem.borders.w));
    const side = GRID + 1;
    expect(Array.from(built[0].dem.borders.e)).toEqual(Array.from({ length: side }, (_, k) => built[0].dem.heights[k * side + GRID]));

    let inside = 0;
    for (const { t, tin, surface, dem, before } of built) {
      // every TIN vertex on or inside the territory sits on the plane
      for (let k = 0; k < tin.vx.length; k++) {
        const lon = ((t.x + tin.vx[k] / GRID) / n) * 360 - 180;
        const lat = mercatorYToLat((t.y + tin.vy[k] / GRID) / n);
        const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
        if (padDistance(pad, e, nn) <= 0) expect(tin.vh[k]).toBeCloseTo(padHeight(pad, lon, lat), 3);
      }
      // and so does the surface between them: sample the territory densely
      for (let j = 0; j <= 200; j++) {
        for (let i = 0; i <= 200; i++) {
          const lon = ((t.x + i / 200) / n) * 360 - 180;
          const lat = mercatorYToLat((t.y + j / 200) / n);
          const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
          if (padDistance(pad, e, nn) > -0.5) continue;
          inside++;
          expect(Math.abs(surface(lon, lat) - padHeight(pad, lon, lat))).toBeLessThan(0.05);
        }
      }
      // far from the pad the relief is untouched
      for (let k = 0; k < before.length; k++) {
        const i = k % side, j = Math.floor(k / side);
        const lon = ((t.x * GRID + i) / (n * GRID)) * 360 - 180;
        const lat = mercatorYToLat((t.y * GRID + j) / (n * GRID));
        const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
        if (padDistance(pad, e, nn) > PAD_BLEND_M + 100) expect(dem.heights[k]).toBe(before[k]);
      }
    }
    expect(inside).toBeGreaterThan(1000);
  });

  it('does not bend the pad towards a coarser neighbour', async () => {
    const pad = (await buildPad(padSources({ areas: [aerodrome()], lines: [] })[0]))!;
    const dem = lattice(A);
    // a parent whose border lines miss the pad by metres on every edge
    const up = (p: Float32Array) => Float32Array.from(p, (h) => h + 6);
    const coarse = { n: up(dem.borders.n), s: up(dem.borders.s), w: up(dem.borders.w), e: up(dem.borders.e) };
    applyPads(dem, A, GRID, [pad]);
    const tin = buildTerrainTin(A, GRID, dem.heights, { borders: { ...dem.borders, coarse }, pads: [pad] });
    expect(tin.coarse).toBeDefined();
    let onPad = 0, offPad = 0;
    for (let k = 0; k < tin.vx.length; k++) {
      const onBorder = tin.vx[k] === 0 || tin.vx[k] === GRID || tin.vy[k] === 0 || tin.vy[k] === GRID;
      if (!onBorder) continue;
      const lon = ((A.x + tin.vx[k] / GRID) / n) * 360 - 180;
      const lat = mercatorYToLat((A.y + tin.vy[k] / GRID) / n);
      const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
      if (padDistance(pad, e, nn) <= 0) {
        onPad++;
        expect(tin.coarse!.edges[k]).toBe(0);
        expect(tin.coarse!.dh[k]).toBe(0);
      } else if (tin.coarse!.edges[k]) offPad++;
    }
    expect(onPad).toBeGreaterThan(0);
    // elsewhere the seam is still stitched
    expect(offPad).toBeGreaterThan(0);
  });

  it('a sports ground: a pad of its own, level within MAX_GRADE, its margin and blend narrow', async () => {
    // a football pitch, 105 × 68 m, on the DEM's 1.3 % slope
    const o = { lat: tileLat, lon: seamLon };
    const ring: LonLat[] = [[-52, -34], [53, -34], [53, 34], [-52, 34], [-52, -34]].map(([e, nn]) => {
      const p = enuToLatLon(o, e, nn, 0);
      return [p.lon, p.lat];
    });
    const pitch: OsmArea = { rings: [ring], tags: { leisure: 'pitch', sport: 'soccer' } };
    const srcs = padSources({ areas: [pitch], lines: [] });
    expect(srcs).toHaveLength(1);
    // a pitch's pad stays within its tile: it rebuilds no neighbour (neighbourPads); an aerodrome's does
    expect(srcs[0].kind).toBe('pitch');
    expect(neighbourPads({ areas: [pitch], lines: [] })).toHaveLength(0);
    expect(neighbourPads({ areas: [pitch, aerodrome()], lines: [] }).map((p) => p.kind)).toEqual(['aerodrome']);
    expect(srcs[0]).toMatchObject({ margin: PITCH_PAD.MARGIN_M, blend: PITCH_PAD.BLEND_M, maxGrade: PITCH_PAD.MAX_GRADE });
    const pad = (await buildPad(srcs[0]))!;
    expect(Math.hypot(pad.ge, pad.gn)).toBeCloseTo(PITCH_PAD.MAX_GRADE, 6);
    expect(pad.blend).toBe(PITCH_PAD.BLEND_M);
    // its flat territory: the outline and a few metres, not an aerodrome's 30
    for (const [lon, lat] of ring) {
      const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
      expect(padDistance(pad, e, nn)).toBeLessThan(-PITCH_PAD.MARGIN_M + 1.5);
      expect(padDistance(pad, e, nn)).toBeGreaterThan(-PITCH_PAD.MARGIN_M - 1.5);
    }
    // a lattice far beyond its blend is left as it was
    const t = lattice(A), before = t.heights.slice();
    applyPads(t, A, GRID, [pad]);
    let changed = 0, far = 0;
    const side = GRID + 1, N = n * GRID;
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
      const lon = ((A.x * GRID + i) / N) * 360 - 180, lat = mercatorYToLat((A.y * GRID + j) / N);
      const [e, nn] = latLonToEnu(pad.origin, lat, lon, 0);
      if (padDistance(pad, e, nn) > 60 + PITCH_PAD.BLEND_M) { far++; if (t.heights[j * side + i] !== before[j * side + i]) changed++; }
    }
    expect(far).toBeGreaterThan(0);
    expect(changed).toBe(0);
  });

  it('a ground on a roof, indoors or in a building is no pad', () => {
    expect(isPitchGround({ leisure: 'pitch' })).toBe(true);
    expect(isPitchGround({ leisure: 'track' })).toBe(true);
    expect(isPitchGround({ leisure: 'stadium' })).toBe(true);
    for (const tags of [{ leisure: 'pitch', location: 'roof' }, { leisure: 'pitch', indoor: 'yes' }, { leisure: 'pitch', building: 'yes' }, { leisure: 'pitch', layer: '1' }, { leisure: 'park' }] as Record<string, string>[]) {
      expect(isPitchGround(tags), JSON.stringify(tags)).toBe(false);
    }
  });
});
