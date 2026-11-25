import { describe, expect, it } from 'vitest';
import { coastSeaTest, coastlineWays, joinLines, toLatticeLine } from '../src/world/coast';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { parseFilter } from '../src/world/osm-api';
import { osmFilter, parseOverpass, type OverpassJson } from '../src/world/overpass';
import { buildTerrainTin, isSeaFace, LAND_MIN_M } from '../src/world/terrain-tin';

// lattice coordinates: x east, y south
describe('coastSeaTest (OSM: land left of the way)', () => {
  it('a coast running east has the land north (small y) and the sea south', () => {
    const sea = coastSeaTest([[{ x: 0, y: 5 }, { x: 10, y: 5 }]]);
    expect(sea({ x: 5, y: 2 })).toBe(false);
    expect(sea({ x: 5, y: 8 })).toBe(true);
    // nearest to a loose end: the coastline goes on somewhere not downloaded, no verdict
    expect(sea({ x: -3, y: 4 })).toBeUndefined();
    expect(sea({ x: 13, y: 9 })).toBeUndefined();
  });

  it('at a bend the vertex decides by the turn, both ways', () => {
    // east, then north: the line turns left on the map (towards the land), the sea is the outer side
    const left = coastSeaTest([[{ x: 0, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 0 }]]);
    expect(left({ x: 7, y: 7 })).toBe(true); // outside the corner, nearest the vertex
    expect(left({ x: 3, y: 3 })).toBe(false);
    // east, then south: turns towards the sea, the sea is inside the corner
    const right = coastSeaTest([[{ x: 0, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }]]);
    expect(right({ x: 3, y: 7 })).toBe(true);
    expect(right({ x: 7, y: 3 })).toBe(false);
  });

  it('an island (closed, anticlockwise on the map) is land inside, sea around', () => {
    // anticlockwise on the map = clockwise in lattice (y down): west→south→east→north on the map
    const ring = [{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 0, y: 0 }];
    const sea = coastSeaTest([ring]);
    expect(sea({ x: 2, y: 2 })).toBe(false);
    expect(sea({ x: 6, y: 2 })).toBe(true);
    expect(sea({ x: -1, y: -1 })).toBe(true);
  });

  it('joinLines joins ways at their shared end nodes', () => {
    const a = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const b = [{ x: 1, y: 0 }, { x: 2, y: 1 }];
    const c = [{ x: 5, y: 5 }, { x: 6, y: 5 }];
    const out = joinLines([b, c, a]);
    expect(out).toHaveLength(2);
    expect(out.find((l) => l.length === 3)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }]);
  });
});

describe('OSM coastline data', () => {
  it('is fetched at full detail and kept as a line even when it closes (an island)', () => {
    const sel = parseFilter(osmFilter('full'));
    expect(sel.some((s) => s.type === 'way' && s.clauses.some((c) => c.key === 'natural' && c.value === 'coastline'))).toBe(true);
    const json: OverpassJson = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 }, { type: 'node', id: 2, lat: 0, lon: 1 },
        { type: 'node', id: 3, lat: 1, lon: 1 }, { type: 'node', id: 4, lat: 1, lon: 0 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { natural: 'coastline' } },
      ],
    };
    const d = parseOverpass(json);
    expect(d.areas).toHaveLength(0);
    expect(coastlineWays(d.lines)).toHaveLength(1);
  });
});

describe('TIN with the OSM coastline', () => {
  const TILE: Tile = { z: 14, x: 9516, y: 6395 };
  const GRID = 48, side = GRID + 1;
  const b = tileBounds(TILE), c = tileCenter(TILE);
  // a coastal plain the DEM has at sea level, with noise of ±1.5 m: the DEM alone floods it
  const heights = Float32Array.from({ length: side * side }, (_, k) => 1.5 * Math.sin(k * 1.7));
  // coast running east across the middle, from beyond the west border to beyond the east one
  const lonW = b.west - (b.east - b.west) * 0.2, lonE = b.east + (b.east - b.west) * 0.2;
  const coast = [[[lonW, c.lat], [c.lon, c.lat + (b.north - b.south) * 0.05], [lonE, c.lat]] as [number, number][]];

  const seaShare = (tin: ReturnType<typeof buildTerrainTin>, north: boolean) => {
    let sea = 0, all = 0;
    tin.tris.forEach((t, i) => {
      const y = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      if ((y < GRID * 0.4) !== north) return;
      const area = Math.abs((tin.vx[t.b] - tin.vx[t.a]) * (tin.vy[t.c] - tin.vy[t.a]) - (tin.vx[t.c] - tin.vx[t.a]) * (tin.vy[t.b] - tin.vy[t.a]));
      all += area;
      if (isSeaFace(tin, i)) sea += area;
    });
    return sea / all;
  };

  it('without it the DEM floods the plain; with it land is north of the coast and sea south', () => {
    const dem = buildTerrainTin(TILE, GRID, heights);
    expect(seaShare(dem, true)).toBeGreaterThan(0.3); // land flooded
    const osm = buildTerrainTin(TILE, GRID, heights, { coast });
    expect(seaShare(osm, true)).toBe(0);
    expect(seaShare(osm, false)).toBeGreaterThan(0.9);
  });

  it('land stands at LAND_MIN_M or more, sea at 0 m, the shore vertices at 0 m', () => {
    const tin = buildTerrainTin(TILE, GRID, heights, { coast });
    tin.tris.forEach((t, i) => {
      const hs = [tin.vh[t.a], tin.vh[t.b], tin.vh[t.c]];
      if (isSeaFace(tin, i)) for (const h of hs) expect(h).toBeLessThanOrEqual(0);
      else expect(Math.max(...hs)).toBeGreaterThanOrEqual(0);
    });
    // vertices well inland (y < 0.3 grid) are land at LAND_MIN_M at least
    for (let k = 0; k < tin.vx.length; k++) if (tin.vy[k] < GRID * 0.3) expect(tin.vh[k]).toBeGreaterThanOrEqual(LAND_MIN_M);
  });

  it('never floods relief: high ground the coastline puts on its sea side stays land, unchanged', () => {
    // mountains everywhere, and a coastline whose sea side covers the whole tile
    const hills = Float32Array.from({ length: side * side }, (_, k) => 300 + 200 * Math.sin((k % side) / 6) * Math.cos(Math.floor(k / side) / 7));
    const wrong = [[[lonW, b.north + (b.north - b.south) * 2], [lonE, b.north + (b.north - b.south) * 2]] as [number, number][]];
    const plain = buildTerrainTin(TILE, GRID, hills);
    const tin = buildTerrainTin(TILE, GRID, hills, { coast: wrong });
    tin.tris.forEach((_, i) => expect(isSeaFace(tin, i)).toBe(false));
    expect(Math.max(...tin.vh)).toBeCloseTo(Math.max(...plain.vh), 0);
  });

  it('a false shore the DEM holds at 5–12 m just off the coastline is sea (Netanya, 14/9777/6635)', () => {
    // land north of the coast at 30 m; on its sea side a DEM bank at 10 m reaching 8 cells (~200 m) out
    const bank = Float32Array.from({ length: side * side }, (_, k) => {
      const j = Math.floor(k / side);
      return j < GRID / 2 - 2 ? 30 : j < GRID / 2 + 8 ? 10 : 0;
    });
    const tin = buildTerrainTin(TILE, GRID, bank, { coast });
    expect(seaShare(tin, false)).toBeGreaterThan(0.9);
    tin.tris.forEach((t, i) => {
      const y = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      if (y > GRID * 0.6 && y < GRID / 2 + 8) expect(isSeaFace(tin, i)).toBe(true);
    });
  });

  it('a coastline stub that only passes round the tile leaves it whole: no DEM land patch in its sea (14/9777/6634)', () => {
    // open sea with a 3 m DEM bank in the south-east corner; the coastline is a stub beyond that corner
    const corner = Float32Array.from({ length: side * side }, (_, k) => {
      const i = k % side, j = Math.floor(k / side);
      return i + j > GRID * 1.6 ? 3 : 0;
    });
    const w = b.east - b.west, h = b.north - b.south;
    const stub = [[[b.east + w * 0.12, b.south - h * 0.03], [b.east + w * 0.1, b.south - h * 0.12]] as [number, number][]];
    const tin = buildTerrainTin(TILE, GRID, corner, { coast: stub });
    tin.tris.forEach((_, i) => expect(isSeaFace(tin, i)).toBe(true));
  });

  it('beyond a loose end of a way the DEM decides, not a half-plane of sea', () => {
    // a way ending just west of the tile, its continuation not downloaded; the tile is low land at
    // 2 m (below COAST_SEA_MAX_M, so only the loose-end rule keeps it dry)
    const land = new Float32Array(side * side).fill(2);
    const loose = [[[lonW - (b.east - b.west), c.lat], [b.west - (b.east - b.west) * 0.01, c.lat]] as [number, number][]];
    const tin = buildTerrainTin(TILE, GRID, land, { coast: loose });
    tin.tris.forEach((_, i) => expect(isSeaFace(tin, i)).toBe(false));
  });

  it('OSM loaded, no coastline: an inland depression below sea level is land, not a sea', () => {
    // hills at 40 m with a basin at −2 m in the middle (14/9515/6394)
    const basin = Float32Array.from({ length: side * side }, (_, k) => {
      const i = k % side, j = Math.floor(k / side);
      return Math.hypot(i - 24, j - 24) < 10 ? -2 : 40;
    });
    const dem = buildTerrainTin(TILE, GRID, basin);
    expect(dem.tris.some((_, i) => isSeaFace(dem, i))).toBe(true); // the DEM alone floods it
    const tin = buildTerrainTin(TILE, GRID, basin, { coast: [] });
    tin.tris.forEach((_, i) => expect(isSeaFace(tin, i)).toBe(false));
    expect(Math.min(...tin.vh)).toBeGreaterThanOrEqual(LAND_MIN_M);
  });

  it('OSM loaded, no coastline, the DEM mostly at sea level: all of it is sea', () => {
    // open sea with a few noisy pixels above 0.5 m
    const sea = Float32Array.from({ length: side * side }, (_, k) => (k % 97 === 0 ? 1.2 : 0));
    const tin = buildTerrainTin(TILE, GRID, sea, { coast: [] });
    tin.tris.forEach((_, i) => expect(isSeaFace(tin, i)).toBe(true));
    expect(Math.max(...tin.vh)).toBeLessThanOrEqual(0);
  });

  it('a z14 relief true to 5 m puts no land height in the sea: a shore the DEM blurs past the coastline stays flat water', () => {
    // 14/9516/6398: the DEM falls from 9 m at the coastline to the sea over three cells, so the
    // nodes just off it, on the sea side, stand at 5–8 m; the pocket between the coastline and the
    // DEM's own shore is sea by its area, and its nodes, added as relief, tilted its water faces
    const shore = (i: number) => {
      const line = toLatticeLine(TILE, GRID, coast[0]);
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1], q = line[k];
        if ((a.x - i) * (q.x - i) <= 0 && a.x !== q.x) return a.y + ((q.y - a.y) * (i - a.x)) / (q.x - a.x);
      }
      return GRID / 2;
    };
    const blurred = Float32Array.from({ length: side * side }, (_, k) => {
      const i = k % side, d = Math.floor(k / side) - shore(i);
      return d <= 0 ? 9 + 6 * Math.min(-d, 4) : Math.max(0, 9 * (1 - d / 3));
    });
    const tin = buildTerrainTin(TILE, GRID, blurred, { coast, reliefTol: 5 });
    let sea = 0;
    tin.tris.forEach((t, i) => {
      if (!isSeaFace(tin, i)) return;
      sea++;
      for (const k of [t.a, t.b, t.c]) expect(tin.vh[k]).toBeLessThanOrEqual(0);
    });
    expect(sea).toBeGreaterThan(0);
  });

  it('two coastline ways meeting at a node still separate sea from land', () => {
    const [w] = coast;
    const split = [w.slice(0, 2), w.slice(1)];
    const tin = buildTerrainTin(TILE, GRID, heights, { coast: split });
    expect(seaShare(tin, true)).toBe(0);
    expect(seaShare(tin, false)).toBeGreaterThan(0.9);
  });
});
