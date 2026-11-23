import { describe, expect, it } from 'vitest';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildGroundCover } from '../src/world/ground-cover';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { CLIFF, CLIFF_TAG, cliffBand, cliffBands, cliffWidth } from '../src/world/cliffs';
import { overpassQuery, parseOverpass, REACH_SELECTORS, type OverpassJson } from '../src/world/overpass';
import { classifyArea } from '../src/world/way-styles';
import { DEFAULT_AREA_STYLES } from '../src/world/area-styles';
import type { LonLat } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 9517, y: 6397 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
/** a point (x east, y north) metres from the tile centre */
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const m = ([lon, lat]: LonLat): [number, number] => [(lon - c.lon) * KX, (lat - c.lat) * KY];

describe('cliffWidth', () => {
  it('as high as the cliff, kept to MIN_M..MAX_M, BAND_M without a height', () => {
    expect(cliffWidth({})).toBe(CLIFF.BAND_M);
    expect(cliffWidth({ height: '25' })).toBe(25);
    expect(cliffWidth({ height: '2' })).toBe(CLIFF.MIN_M);
    expect(cliffWidth({ height: '300 m' })).toBe(CLIFF.MAX_M);
  });
});

describe('cliffBand', () => {
  it('lies on the right of the line (the low side), as wide as asked', () => {
    // a line going east: its right is south
    const [ring] = cliffBand([at(-50, 0), at(50, 0)], 15)!;
    const ys = ring.map((p) => m(p)[1]);
    expect(Math.max(...ys)).toBeCloseTo(0, 3);
    expect(Math.min(...ys)).toBeCloseTo(-15, 3);
    // going north: its right is east
    const [up] = cliffBand([at(0, -50), at(0, 50)], 15)!;
    const xs = up.map((p) => m(p)[0]);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(15, 3);
  });

  it('keeps its width round a bend (a mitre), and no farther than MITER_LIMIT widths at a hairpin', () => {
    const [ring] = cliffBand([at(-50, 0), at(0, 0), at(0, -50)], 10)!;
    // the right-angle bend's offset vertex: 10 m from both edges, at (-10, -10)
    const corner = ring.map(m).find(([x, y]) => Math.abs(x + 10) < 1e-3 && Math.abs(y + 10) < 1e-3);
    expect(corner).toBeDefined();
    const [hair] = cliffBand([at(-50, 0), at(0, 0), at(-50, 0.5)], 10)!;
    for (const p of hair) expect(Math.hypot(...m(p))).toBeLessThanOrEqual(50 + CLIFF.MITER_LIMIT * 10 + 1);
  });

  it('a closed cliff: the band between the line and its offset, outer and hole', () => {
    // anticlockwise square: its right is outside, a plateau
    const sq = [at(-50, -50), at(50, -50), at(50, 50), at(-50, 50), at(-50, -50)];
    const rings = cliffBand(sq, 10)!;
    expect(rings.length).toBe(2);
    const ext = (r: LonLat[]) => Math.max(...r.map((p) => Math.abs(m(p)[0])));
    expect(ext(rings[0])).toBeCloseTo(60, 3);
    expect(ext(rings[1])).toBeCloseTo(50, 3);
  });

  it('nothing from a line of one point', () => {
    expect(cliffBand([at(0, 0), at(0, 0)], 10)).toBeUndefined();
  });
});

describe('cliffs from OSM', () => {
  const json = (closed: boolean): OverpassJson => ({
    elements: [
      { type: 'node', id: 1, lon: at(-60, 0)[0], lat: at(-60, 0)[1] },
      { type: 'node', id: 2, lon: at(60, 0)[0], lat: at(60, 0)[1] },
      { type: 'node', id: 3, lon: at(0, 60)[0], lat: at(0, 60)[1] },
      { type: 'node', id: 4, lon: at(200, 200)[0], lat: at(200, 200)[1], tags: { natural: 'peak', ele: '1969' } },
      { type: 'way', id: 10, nodes: closed ? [1, 2, 3, 1] : [1, 2, 3], tags: { natural: 'cliff' } },
    ],
  });

  it('a cliff stays a line, even closed, and gives a bare-rock band; a summit is a point', () => {
    for (const closed of [false, true]) {
      const d = parseOverpass(json(closed));
      expect(d.lines.filter((l) => l.tags.natural === 'cliff').length).toBe(1);
      const bands = d.areas.filter((a) => a.tags[CLIFF_TAG] === 'yes');
      expect(bands.length).toBe(1);
      // a filter of its own (the soft rock filter all but vanished on a wooded slope)
      expect(classifyArea(bands[0].tags, DEFAULT_AREA_STYLES)?.filter).toBe(DEFAULT_AREA_STYLES.cliff);
      expect(classifyArea({ natural: 'bare_rock' }, DEFAULT_AREA_STYLES)?.filter).toBe(DEFAULT_AREA_STYLES.rock);
      expect(d.points.some((p) => p.tags.natural === 'peak')).toBe(true);
    }
  });

  it('the band is a ground cover of the tile, and faces of its surface lie in it', () => {
    const d = parseOverpass(json(false));
    const grid = 64;
    const cover = buildGroundCover(TILE, grid, d);
    const band = cover.shapes.findIndex((s) => (s.source as { tags: Record<string, string> }).tags[CLIFF_TAG] === 'yes');
    expect(band).toBeGreaterThanOrEqual(0);
    const heights = new Float32Array((grid + 1) * (grid + 1)).fill(200);
    const tin = buildSurfaceTin(TILE, grid, heights, { cover });
    // the faces in the band cover it: their area is the band's (lattice units²)
    const triArea = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    let faces = 0;
    tin.tris.forEach((t, f) => {
      if (tin.cover?.[f] === band) faces += triArea(tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]);
    });
    const tris = cover.shapes[band].tris;
    let shape = 0;
    for (let i = 0; i < tris.length; i += 6) shape += triArea(tris[i], tris[i + 1], tris[i + 2], tris[i + 3], tris[i + 4], tris[i + 5]);
    expect(shape).toBeGreaterThan(0);
    expect(faces / shape).toBeGreaterThan(0.95);
    expect(faces / shape).toBeLessThan(1.05);
  });

  it('cliffs come from round the tile like the roads, summits near and far', () => {
    expect(REACH_SELECTORS).toContain('way["natural"="cliff"]');
    expect(overpassQuery(TILE, 'full')).toContain('way["natural"="cliff"];');
    expect(overpassQuery(TILE, 'full')).toContain('node["natural"="peak"];');
    expect(overpassQuery(TILE, 'large')).toContain('node["natural"="peak"];');
    expect(tileBounds(TILE).north).toBeGreaterThan(c.lat);
  });
});

describe('cliffBands', () => {
  it('only natural=cliff lines', () => {
    const lines = [
      { points: [at(0, 0), at(10, 0)], tags: { natural: 'cliff' } },
      { points: [at(0, 0), at(10, 0)], tags: { natural: 'coastline' } },
    ];
    expect(cliffBands(lines).length).toBe(1);
  });
});
