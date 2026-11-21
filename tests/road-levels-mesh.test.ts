import { describe, expect, it } from 'vitest';
import { RAMP, withGlow } from '../src/engine/palette';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { LonLat, OsmLine, OsmTileData } from '../src/world/osm-types';
import { LEVEL_M, LIFT_GRADE } from '../src/world/road-levels';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };
const GRID = 16;
const GROUND = 100;
/** the road ribbons lie this far over the ground at most (LINE_BIAS and the priority steps) */
const RIBBON_M = 2;

function meshOf(lines: OsmLine[], tile: Tile = TILE) {
  const tin = buildTerrainTin(tile, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(GROUND));
  const data: OsmTileData = { areas: [], points: [], buildings: [], lines };
  return buildOsmMesh({ tile, detail: 'full', data, sampleHeight: tinSampler(tin, tile), tin });
}

const C = tileCenter(TILE);
const M_LAT = 1 / 111320, M_LON = M_LAT / Math.cos((C.lat * Math.PI) / 180);
/** a point `east`, `north` metres from (lon, lat) */
const from = (lon: number, lat: number, east: number, north: number): LonLat => [lon + east * M_LON, lat + north * M_LAT];
const at = (east: number, north: number): LonLat => from(C.lon, C.lat, east, north);

/** a bridge west to east through the tile's centre and a road under its middle */
const bridge = (tags: Record<string, string> = {}): OsmLine => ({ tags: { highway: 'primary', bridge: 'yes', ...tags }, points: [at(-400, 0), at(400, 0)] });
const under: OsmLine = { tags: { highway: 'secondary' }, points: [at(0, -150), at(0, 150)] };
const LOWER_HALF = 5.5;

/** heights over the ground of the road vertices in a box of tile-centre metres (x east, z south) */
function heights(m: { vertices: Float32Array; vertexCount: number }, x0: number, x1: number, z0: number, z1: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const x = m.vertices[i * 6], z = m.vertices[i * 6 + 2];
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) out.push(m.vertices[i * 6 + 1] - GROUND);
  }
  return out;
}

describe('lifted roads in the mesh', () => {
  it('a road without crossings is unchanged, whatever is lifted elsewhere', () => {
    const road: OsmLine = { tags: { highway: 'primary' }, points: [at(-400, 300), at(400, 300)] };
    const alone = meshOf([road]).roads, among = meshOf([road, bridge(), under]).roads;
    expect(alone.vertexCount).toBeGreaterThan(0);
    expect(Math.max(...heights(alone, -1e9, 1e9, -1e9, 1e9))).toBeLessThan(RIBBON_M);
    expect(Array.from(among.vertices.subarray(0, alone.vertices.length))).toEqual(Array.from(alone.vertices));
    expect(Array.from(among.ramps.subarray(0, alone.ramps.length))).toEqual(Array.from(alone.ramps));
  });

  it('the bridge deck is 6 m over the road under it', () => {
    const m = meshOf([bridge(), under]).roads;
    expect(Math.max(...heights(m, -3, 3, -8, 8))).toBeGreaterThanOrEqual(LEVEL_M + 1.4);
    // the road under it stays on the ground
    const lower = heights(m, -6, 6, 20, 150);
    expect(lower.length).toBeGreaterThan(0);
    expect(Math.max(...lower)).toBeLessThan(RIBBON_M);
    // and the bridge's far ends too
    expect(Math.max(...heights(m, 300, 400, -8, 8))).toBeLessThan(RIBBON_M);
  });

  it('the deck falls along the approach at the grade', () => {
    const m = meshOf([bridge(), under]).roads;
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const top = Math.max(...heights(m, -3, 3, -8, 8));
    const down = heights(m, 45, 55, -8, 8);
    expect(down.length).toBeGreaterThan(0);
    expect(Math.abs(top - mean(down) - LIFT_GRADE * (50 - LOWER_HALF))).toBeLessThan(0.5);
  });

  it('lamps stand on the deck', () => {
    const lamps = meshOf([bridge({ lit: 'yes' }), under]).lamps;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < lamps.length; i += 4) {
      lo = Math.min(lo, lamps[i + 1]);
      hi = Math.max(hi, lamps[i + 1]);
    }
    expect(hi - lo).toBeGreaterThan(5);
  });

  it('far road lines rise with the deck', () => {
    const lines = meshOf([bridge(), under]).roadLines;
    let hi = -Infinity;
    for (let i = 0; i < lines.length; i += 4) hi = Math.max(hi, lines[i + 1] - GROUND);
    expect(hi).toBeGreaterThanOrEqual(LEVEL_M);
  });

  it('rails rise too', () => {
    const rail: OsmLine = { tags: { railway: 'rail', bridge: 'yes' }, points: [at(-400, 0), at(400, 0)] };
    expect(Math.max(...heights(meshOf([rail, under]).roads, -3, 3, -4, 4))).toBeGreaterThanOrEqual(LEVEL_M + 1.4);
  });

  it('the far tiles are not lifted', () => {
    const tin = buildTerrainTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(GROUND));
    const data: OsmTileData = { areas: [], points: [], buildings: [], lines: [bridge({ highway: 'motorway' }), under] };
    const m = buildOsmMesh({ tile: TILE, detail: 'large', data, sampleHeight: tinSampler(tin, TILE), tin });
    expect(Math.max(...heights(m.roads, -1e9, 1e9, -1e9, 1e9))).toBeLessThan(RIBBON_M);
  });

  it('both tiles of a border draw the deck at the same heights there', () => {
    const east: Tile = { ...TILE, x: TILE.x + 1 };
    const border = tileBounds(TILE).east;
    // the bridge crosses the border; what it crosses lies 30 m into the eastern tile
    const lines: OsmLine[] = [
      { tags: { highway: 'primary', bridge: 'yes' }, points: [from(border, C.lat, -300, 0), from(border, C.lat, 300, 0)] },
      { tags: { highway: 'secondary' }, points: [from(border, C.lat, 30, -150), from(border, C.lat, 30, 150)] },
    ];
    const edge = (tile: Tile): number[] => {
      const c = tileCenter(tile);
      const x = latLonToEnu(c, C.lat, border, 0)[0];
      const hs = heights(meshOf(lines, tile).roads, x - 0.01, x + 0.01, -20, 20);
      return [...new Set(hs.map((h) => Math.round(h * 100)))].sort((a, b) => a - b);
    };
    const west = edge(TILE), eastSide = edge(east);
    expect(west.length).toBeGreaterThan(0);
    expect(Math.min(...west)).toBeGreaterThan(300);
    expect(eastSide).toEqual(west);
  });

  it('the bridge has a body with piers, none of them on the road under it', () => {
    const b = meshOf([bridge(), under]).bridges;
    expect(b.vertexCount).toBeGreaterThan(0);
    expect(b.vertices.length).toBe(b.vertexCount * 6);
    let concrete = 0, feet = 0;
    for (let i = 0; i < b.vertexCount; i++) {
      const x = b.vertices[i * 6], y = b.vertices[i * 6 + 1] - GROUND;
      if (b.ramps[i] === RAMP.CONCRETE) concrete++;
      if (y < 0) feet++;
      // nothing of the body lower than the clearance over the road under it
      if (Math.abs(x) < LOWER_HALF) expect(y).toBeGreaterThan(LEVEL_M - 1.5);
    }
    expect(concrete).toBe(b.vertexCount);
    expect(feet).toBeGreaterThan(0);
  });

  it('the approaches of a short bridge are embankments', () => {
    const lines: OsmLine[] = [
      { tags: { highway: 'primary' }, points: [at(-300, 0), at(-20, 0)] },
      { tags: { highway: 'primary', bridge: 'yes' }, points: [at(-20, 0), at(20, 0)] },
      { tags: { highway: 'primary' }, points: [at(20, 0), at(300, 0)] },
      under,
    ];
    const m = meshOf(lines);
    let earth = 0, concrete = 0;
    for (let i = 0; i < m.bridges.vertexCount; i++) {
      const x = m.bridges.vertices[i * 6];
      if (m.bridges.ramps[i] === RAMP.CONCRETE) {
        concrete++;
        expect(Math.abs(x)).toBeLessThan(21);
      } else {
        earth++;
        expect(Math.abs(x)).toBeGreaterThan(19);
      }
    }
    expect(earth).toBeGreaterThan(0);
    expect(concrete).toBeGreaterThan(0);
    // the approach's ribbon climbs to the bridge
    expect(Math.max(...heights(m.roads, -30, -22, -10, 10))).toBeGreaterThan(4);
  });

  it('the body starts where the lift does: no stretch of the approach hangs in the air', () => {
    const lines: OsmLine[] = [
      { tags: { highway: 'primary' }, points: [at(-300, 0), at(-20, 0)] },
      { tags: { highway: 'primary', bridge: 'yes' }, points: [at(-20, 0), at(20, 0)] },
      under,
    ];
    const m = meshOf(lines);
    // the westernmost ribbon vertex lifted half a metre or more, and the embankment's western end
    let ribbon = Infinity, body = Infinity;
    for (let i = 0; i < m.roads.vertexCount; i++) {
      if (m.roads.vertices[i * 6 + 1] - GROUND > RIBBON_M + 0.5) ribbon = Math.min(ribbon, m.roads.vertices[i * 6]);
    }
    for (let i = 0; i < m.bridges.vertexCount; i++) body = Math.min(body, m.bridges.vertices[i * 6]);
    expect(body).toBeLessThanOrEqual(ribbon + 0.01);
  });

  it('a road on the ground has no body', () => {
    expect(meshOf([under]).bridges.vertexCount).toBe(0);
  });

  it('the lift keeps the ribbon the colour of the road', () => {
    const m = meshOf([bridge(), under]).roads;
    let asphalt = 0;
    for (let i = 0; i < m.vertexCount; i++) if (withGlow(m.ramps[i], 0) === withGlow(RAMP.ASPHALT, 0) && m.vertices[i * 6 + 1] - GROUND > LEVEL_M) asphalt++;
    expect(asphalt).toBeGreaterThan(0);
  });
});
