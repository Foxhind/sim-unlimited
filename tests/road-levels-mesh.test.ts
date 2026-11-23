import { describe, expect, it } from 'vitest';
import { RAMP, withGlow } from '../src/engine/palette';
import { gridLatLon, latLonToEnu, tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { LonLat, OsmLine, OsmTileData } from '../src/world/osm-types';
import { LEVEL_M, LIFT_GRADE } from '../src/world/road-levels';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';
import { buildGroundCover } from '../src/world/ground-cover';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { GRID as COVER_GRID, osmMeshOf, road, TILE as COVER_TILE } from './roads-helpers';

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
const bridge = (tags: Record<string, string> = {}): OsmLine => ({ tags: { highway: 'primary', bridge: 'yes', layer: '1', ...tags }, points: [at(-400, 0), at(400, 0)] });
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

/** the heights of a mesh's triangles over (x, z), tile-centre metres; `strict`: (x, z) inside, not on an edge */
function surfacesOver(m: { vertices: Float32Array; vertexCount: number }, x: number, z: number, strict = false): number[] {
  const v = m.vertices, eps = strict ? -1e-7 : 1e-6, out: number[] = [];
  for (let t = 0; t + 2 < m.vertexCount; t += 3) {
    const p = [0, 1, 2].map((k) => [v[(t + k) * 6], v[(t + k) * 6 + 1], v[(t + k) * 6 + 2]]);
    const det = (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (p[1][2] - p[0][2]);
    if (Math.abs(det) < 1e-9) continue;
    const w1 = ((x - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (z - p[0][2])) / det;
    const w2 = ((p[1][0] - p[0][0]) * (z - p[0][2]) - (x - p[0][0]) * (p[1][2] - p[0][2])) / det;
    if (w1 < -eps || w2 < -eps || w1 + w2 > 1 + eps) continue;
    out.push(p[0][1] * (1 - w1 - w2) + p[1][1] * w1 + p[2][1] * w2);
  }
  return out;
}

/** a lattice point of roads-helpers' tile in its tile-centre metres */
function coverEnu(x: number, y: number): [number, number] {
  const ll = gridLatLon(COVER_TILE, x, y, COVER_GRID);
  const [e, n] = latLonToEnu(tileCenter(COVER_TILE), ll.lat, ll.lon, 0);
  return [e, -n];
}

/** the joints of the deck-step test's bridge (lattice of roads-helpers' tile) */
const DECK_JOINTS: [number, number][] = [[15.9, 30.1], [19.7, 30.1]];

/**
 * At both joints of the deck-step test's bridge, on the axis and a few metres off it: the spread of
 * the road mesh's heights 5 cm either side of the joint (the deck against the approach's face)
 */
function deckEndStep(m: { roads: { vertices: Float32Array; vertexCount: number } }): number {
  let worst = 0;
  for (const j of DECK_JOINTS) {
    const [x, z] = coverEnu(...j);
    for (const across of [-2.5, 0, 2.5]) {
      const hs = [...surfacesOver(m.roads, x - 0.05, z + across), ...surfacesOver(m.roads, x + 0.05, z + across)];
      if (hs.length < 2) return Infinity;
      worst = Math.max(worst, Math.max(...hs) - Math.min(...hs));
    }
  }
  return worst;
}

/**
 * How many surfaces of the road mesh lie over each probe within 4 m along and 2.9 m across of each
 * joint (x, z: tile-centre metres) of a way running east–west: off the seams, so one is one
 */
function surfacesAtJoints(m: { vertices: Float32Array; vertexCount: number }, joints: [number, number][]): number[] {
  const counts: number[] = [];
  for (const [x, z] of joints) {
    for (const along of [-3.93, -2.71, -1.13, -0.37, -0.06, 0.07, 0.41, 1.27, 2.63, 3.89]) {
      for (const across of [-2.87, -1.07, 0.31, 1.83, 2.77]) counts.push(surfacesOver(m, x + along, z + across, true).length);
    }
  }
  return counts;
}

/** the deck-step test's bridge: a tertiary over a river on a slope */
function deckStepLines(): OsmLine[] {
  return [
    road({ highway: 'tertiary', name: 'west' }, [[4.2, 30.1], [15.9, 30.1]]),
    road({ highway: 'tertiary', bridge: 'yes', layer: '1', name: 'bridge' }, [[15.9, 30.1], [19.7, 30.1]]),
    road({ highway: 'tertiary', name: 'east' }, [[19.7, 30.1], [30.3, 30.1]]),
    road({ waterway: 'river' }, [[17.6, 4.3], [17.9, 60.2]]),
  ];
}
const deckRelief = (x: number, y: number) => 300 + x / 25 + 10 * Math.sin(y / 90);

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
    const rail: OsmLine = { tags: { railway: 'rail', bridge: 'yes', layer: '1' }, points: [at(-400, 0), at(400, 0)] };
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
      { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [from(border, C.lat, -300, 0), from(border, C.lat, 300, 0)] },
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
      { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [at(-20, 0), at(20, 0)] },
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
      { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [at(-20, 0), at(20, 0)] },
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

  it('with the cover: only the lifted stretches are ribbons, lifted by nothing more than their lift', () => {
    const lines: OsmLine[] = [
      { tags: { highway: 'primary' }, points: [at(-300, 0), at(-20, 0)] },
      { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [at(-20, 0), at(20, 0)] },
      { tags: { highway: 'primary' }, points: [at(20, 0), at(300, 0)] },
      under,
    ];
    const data: OsmTileData = { areas: [], points: [], buildings: [], lines };
    const cover = buildGroundCover(TILE, GRID, data);
    const tin = buildSurfaceTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(GROUND), { cover });
    const opts = { tile: TILE, detail: 'full' as const, data, sampleHeight: tinSampler(tin, TILE), tin };
    const m = buildOsmMesh({ ...opts, cover }), plain = buildOsmMesh(opts);
    // the approaches far from the bridge are the terrain's faces: at the ground, not over it
    const far = [...heights(m.roads, -300, -150, -10, 10), ...heights(m.roads, 150, 300, -10, 10)];
    expect(far.length).toBeGreaterThan(0);
    for (const h of far) expect(Math.abs(h)).toBeLessThan(1e-3);
    // the bridge at its lift alone (no LINE_BIAS over it), still over the road under it
    const top = Math.max(...heights(m.roads, -3, 3, -8, 8));
    expect(top).toBeGreaterThanOrEqual(LEVEL_M);
    expect(top).toBeLessThan(Math.max(...heights(plain.roads, -3, 3, -8, 8)) - 1.3);
    // the lifted stretch of an approach is a ribbon that climbs to the bridge
    expect(Math.max(...heights(m.roads, -30, -22, -10, 10))).toBeGreaterThan(2.5);
    // the bodies with no bias either
    expect(Math.max(...heights(m.bridges, -1e9, 1e9, -1e9, 1e9))).toBeLessThan(Math.max(...heights(plain.bridges, -1e9, 1e9, -1e9, 1e9)) - 1.3);
  });

  it('meets a bridge’s deck with its approach without a step', () => {
    // the roads with their heights: the approaches on the ground pulled up to the bridge
    const { opts: bridgeOpts, cover } = osmMeshOf({ lines: deckStepLines(), areas: [], points: [] }, deckRelief);
    expect(deckEndStep(buildOsmMesh({ ...bridgeOpts, cover }))).toBeLessThan(0.02);
  });

  it('one surface over every point at a bridge’s joints: square ends, no cap over or under the other', () => {
    // the roads with their heights: the bridge's ribbon against its approaches' faces
    const { opts, cover } = osmMeshOf({ lines: deckStepLines(), areas: [], points: [] }, deckRelief);
    const withHeights = surfacesAtJoints(buildOsmMesh({ ...opts, cover }).roads, DECK_JOINTS.map((j) => coverEnu(...j)));
    expect(withHeights.every((n) => n === 1), `${withHeights}`).toBe(true);
    // plain levels: the bridge's ribbon against its approaches' lifted ribbons
    const lines: OsmLine[] = [
      { tags: { highway: 'primary' }, points: [at(-300, 0), at(-20, 0)] },
      { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [at(-20, 0), at(20, 0)] },
      { tags: { highway: 'primary' }, points: [at(20, 0), at(300, 0)] },
      under,
    ];
    const data: OsmTileData = { areas: [], points: [], buildings: [], lines };
    const plainCover = buildGroundCover(TILE, GRID, data);
    const tin = buildSurfaceTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(GROUND), { cover: plainCover });
    const m = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: tinSampler(tin, TILE), tin, cover: plainCover });
    const plain = surfacesAtJoints(m.roads, [[-20, 0], [20, 0]]);
    expect(plain.every((n) => n === 1), `${plain}`).toBe(true);
  });

  it('the lift keeps the ribbon the colour of the road', () => {
    const m = meshOf([bridge(), under]).roads;
    let asphalt = 0;
    for (let i = 0; i < m.vertexCount; i++) if (withGlow(m.ramps[i], 0) === withGlow(RAMP.ASPHALT, 0) && m.vertices[i * 6 + 1] - GROUND > LEVEL_M) asphalt++;
    expect(asphalt).toBeGreaterThan(0);
  });
});
