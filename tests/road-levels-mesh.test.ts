import { describe, expect, it } from 'vitest';
import { RAMP, withGlow } from '../src/engine/palette';
import { enuToLatLon, gridLatLon, latLonToEnu, tileBounds, tileCenter, tileLattice, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildOsmMesh, classifyLine } from '../src/world/osm-mesher';
import type { LonLat, OsmLine, OsmTileData } from '../src/world/osm-types';
import { LEVEL_M, LIFT_GRADE } from '../src/world/road-levels';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';
import { buildGroundCover } from '../src/world/ground-cover';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { GRID as COVER_GRID, osmMeshOf, road, seeded, TILE as COVER_TILE } from './roads-helpers';

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

/**
 * Probes over the carriageways meeting at `joint` (tile-centre metres): along each leg (its unit
 * direction away from the joint, metres x east and z south, and its half width) up to 6 m out,
 * across it to 0.1 m short of its edges
 */
function unionProbes(joint: [number, number], legs: { dir: [number, number]; half: number }[], rnd: () => number): [number, number][] {
  const out: [number, number][] = [];
  for (const { dir: [dx, dz], half } of legs) {
    for (let k = 0; k < 40; k++) {
      const s = rnd() * 6, t = (rnd() * 2 - 1) * (half - 0.1);
      out.push([joint[0] + dx * s - dz * t, joint[1] + dz * s + dx * t]);
    }
  }
  return out;
}

/**
 * The mesh of `lines` on TILE's flat ground with plain levels and the cover, and whether a point
 * (tile-centre metres) lies on a path's face of the surface (the terrain draws those)
 */
function plainCoverMesh(lines: OsmLine[]) {
  const data: OsmTileData = { areas: [], points: [], buildings: [], lines };
  const cover = buildGroundCover(TILE, GRID, data);
  const tin = buildSurfaceTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(GROUND), { cover });
  const m = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: tinSampler(tin, TILE), tin, cover });
  const toLattice = tileLattice(TILE, GRID);
  const pathAt = (x: number, z: number): boolean => {
    const ll = enuToLatLon(C, x, -z, 0);
    const [px, py] = toLattice([ll.lon, ll.lat]);
    return tin.tris.some((t, f) => {
      const s = tin.cover![f];
      if (s < 0 || cover.shapes[s].kind !== 'path') return false;
      const [ax, ay, bx, by, cx, cy] = [tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]];
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / d, w2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
      return w1 > 0 && w2 > 0 && w1 + w2 < 1;
    });
  };
  return { m, pathAt };
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

  for (const deg of [5, 30]) {
    it(`one surface and no gap over the two carriageways at a bridge's joints turning ${deg}°`, () => {
      const th = (deg * Math.PI) / 180, rnd = seeded(deg);
      // the roads with their heights: a tertiary turning θ at each end of its bridge over a river
      const j1: [number, number] = [15.9, 30.1], len = 3.8, j2: [number, number] = [j1[0] + len * Math.cos(th), j1[1] + len * Math.sin(th)];
      const xm = (j1[0] + j2[0]) / 2;
      const lines = [
        road({ highway: 'tertiary' }, [[4.2, 30.1], j1]),
        road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [j1, j2]),
        road({ highway: 'tertiary' }, [j2, [j2[0] + 10 * Math.cos(2 * th), j2[1] + 10 * Math.sin(2 * th)]]),
        road({ waterway: 'river' }, [[xm - 0.3, 4.3], [xm + 0.3, 60.2]]),
      ];
      const { opts, cover } = osmMeshOf({ lines, areas: [], points: [] }, deckRelief);
      const m = buildOsmMesh({ ...opts, cover }).roads;
      const half = classifyLine({ highway: 'tertiary' })!.width / 2;
      // lattice directions → metres (x east, z south: the lattice's y runs south too)
      const dir = (a: number): [number, number] => [Math.cos(a), Math.sin(a)];
      const withHeights = [
        ...unionProbes(coverEnu(...j1), [{ dir: dir(Math.PI), half }, { dir: dir(th), half }], rnd),
        ...unionProbes(coverEnu(...j2), [{ dir: dir(th + Math.PI), half }, { dir: dir(2 * th), half }], rnd),
      ].map(([x, z]) => surfacesOver(m, x, z, true).length);
      expect(withHeights.every((n) => n === 1), `${withHeights}`).toBe(true);
      // plain levels: the bridge's ribbon against its approaches' lifted ribbons
      const k1: [number, number] = [-20, 0], k2: [number, number] = [-20 + 40 * Math.cos(th), 40 * Math.sin(th)];
      const pm = (k1[0] + k2[0]) / 2;
      const plain = plainCoverMesh([
        { tags: { highway: 'primary' }, points: [at(-300, 0), at(...k1)] },
        { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [at(...k1), at(...k2)] },
        { tags: { highway: 'primary' }, points: [at(...k2), at(k2[0] + 280 * Math.cos(2 * th), k2[1] + 280 * Math.sin(2 * th))] },
        { tags: { highway: 'secondary' }, points: [at(pm, -150), at(pm, 150)] },
      ]);
      const ph = classifyLine({ highway: 'primary' })!.width / 2;
      // north is −z
      const dirN = (a: number): [number, number] => [Math.cos(a), -Math.sin(a)];
      const counts = [
        ...unionProbes([k1[0], -k1[1]], [{ dir: dirN(Math.PI), half: ph }, { dir: dirN(th), half: ph }], rnd),
        ...unionProbes([k2[0], -k2[1]], [{ dir: dirN(th + Math.PI), half: ph }, { dir: dirN(2 * th), half: ph }], rnd),
      ].map(([x, z]) => surfacesOver(plain.m.roads, x, z, true).length);
      expect(counts.every((n) => n === 1), `${counts}`).toBe(true);
    });
  }

  it('one surface and no gap where a bridge ends on the middle of the bank road', () => {
    // the roads with their heights: the bank road on the ground through the bridge's western end
    const n: [number, number] = [15.9, 30.1];
    const lines = [
      road({ highway: 'residential', name: 'bank' }, [[15.9, 10.2], n, [15.9, 50.3]]),
      road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [n, [19.7, 30.1]]),
      road({ highway: 'tertiary' }, [[19.7, 30.1], [30.3, 30.1]]),
      road({ waterway: 'river' }, [[17.6, 4.3], [17.9, 60.2]]),
    ];
    const { opts, cover } = osmMeshOf({ lines, areas: [], points: [] }, deckRelief);
    const m = buildOsmMesh({ ...opts, cover }).roads;
    const bank = classifyLine({ highway: 'residential' })!.width / 2, half = classifyLine({ highway: 'tertiary' })!.width / 2;
    const counts = unionProbes(coverEnu(...n), [{ dir: [0, -1], half: bank }, { dir: [0, 1], half: bank }, { dir: [1, 0], half }], seeded(3))
      .map(([x, z]) => surfacesOver(m, x, z, true).length);
    expect(counts.every((c) => c === 1), `${counts}`).toBe(true);
  });

  it('one surface and no gap where a path ends on the foot of a lifted approach', () => {
    // plain levels: the approach lifted towards the bridge at LIFT_GRADE, ~0.4 m where the footway meets it
    const foot = -20 - (LEVEL_M - 0.4) / LIFT_GRADE;
    const lines: OsmLine[] = [
      { tags: { highway: 'primary' }, points: [at(-300, 0), at(foot, 0), at(-20, 0)] },
      { tags: { highway: 'primary', bridge: 'yes', layer: '1' }, points: [at(-20, 0), at(20, 0)] },
      { tags: { highway: 'primary' }, points: [at(20, 0), at(300, 0)] },
      under,
      { tags: { highway: 'footway' }, points: [at(foot, -60), at(foot, 0)] },
    ];
    const { m, pathAt } = plainCoverMesh(lines);
    const ph = classifyLine({ highway: 'primary' })!.width / 2, fh = classifyLine({ highway: 'footway' })!.width / 2;
    // the footway's paving is the terrain's face; the approach's ribbon is the road mesh's
    const counts = unionProbes([foot, 0], [{ dir: [1, 0], half: ph }, { dir: [-1, 0], half: ph }, { dir: [0, 1], half: fh }], seeded(4))
      .map(([x, z]) => surfacesOver(m.roads, x, z, true).length + (pathAt(x, z) ? 1 : 0));
    expect(counts.every((c) => c === 1), `${counts}`).toBe(true);
  });

  it('the lift keeps the ribbon the colour of the road', () => {
    const m = meshOf([bridge(), under]).roads;
    let asphalt = 0;
    for (let i = 0; i < m.vertexCount; i++) if (withGlow(m.ramps[i], 0) === withGlow(RAMP.ASPHALT, 0) && m.vertices[i * 6 + 1] - GROUND > LEVEL_M) asphalt++;
    expect(asphalt).toBeGreaterThan(0);
  });

  it('a bridge’s deck level with the bank roads over an oblique canal: its asphalt at the deck’s height over its whole footprint, no step where the deck lifts, no face within 0.3 m under a lifted piece', () => {
    // flat ground at 500 m: a tertiary bridge running south over a canal (8 m wide, its water 2.5 m
    // down) crossing it at 45°, from a street along one bank (12 m off the canal) to one along the other
    const M = COVER_GRID / tileSizeMeters(COVER_TILE), k = (12 * M) / Math.SQRT2, s = 2 * k;
    const lines = [
      road({ highway: 'tertiary' }, [[32, 4], [32, 32 - s]]), road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [[32, 32 - s], [32, 32 + s]]),
      road({ highway: 'tertiary' }, [[32, 32 + s], [32, 60]]), road({ waterway: 'canal' }, [[4, 4], [60, 60]]),
      road({ highway: 'residential' }, [[4 + k, 4 - k], [32, 32 - s], [60 + k, 60 - k]]), road({ highway: 'residential' }, [[4 - k, 4 + k], [32, 32 + s], [60 - k, 60 + k]]),
    ];
    const { opts, cover } = osmMeshOf({ lines, areas: [], points: [] }, () => 500);
    const net = opts.roads!.net, b = net.ways.findIndex((w) => w.line === lines[1]);
    const deck = Math.max(...Array.from(opts.roads!.z.subarray(net.ways[b].first, net.ways[b].first + net.ways[b].count)));
    const m = buildOsmMesh({ ...opts, cover }).roads;
    const [ax, az] = coverEnu(32, 32 - s), [bx, bz] = coverEnu(32, 32 + s), len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
    const half = classifyLine({ highway: 'tertiary' })!.width / 2 - 0.1;
    const off: string[] = [], near: string[] = [], c = tileCenter(COVER_TILE);
    let worstStep = 0, lifted = 0, brows = 0;
    for (const o of [-half, -half / 2, 0, half / 2, half]) {
      let prev: number | undefined;
      for (let d = 0.05; d < len - 0.05; d += 0.1) {
        const x = ax + ux * d - uz * o, z = az + uz * d + ux * o, hs = surfacesOver(m, x, z);
        // one surface: the deck's ribbon or the bridge's asphalt on the ground pulled to it
        if (hs.length !== 1 || Math.abs(hs[0] - deck) > 0.3) off.push(`${d.toFixed(1)} ${o.toFixed(1)}: ${hs.map((h) => h.toFixed(2))}`);
        // a lifted piece clears the face under it by the deck's floor, whatever the face (a shoulder's, the ground's, a bank's)
        const { lon, lat } = enuToLatLon(c, x, -z, 0), ground = opts.sampleHeight(lon, lat);
        for (const h of hs) {
          if (Math.abs(h - ground) < 1e-3) continue;
          lifted++;
          if (h - ground < 0.3) near.push(`${d.toFixed(1)} ${o.toFixed(1)}: ${h.toFixed(2)} over ${ground.toFixed(2)}`);
        }
        // but on a bank's brow: under its floor the deck lies on the face, down to the floor under its height
        const brow = hs.length === 1 && hs[0] < deck - 0.05 && Math.abs(hs[0] - ground) < 1e-3;
        if (brow) brows++;
        if (hs.length === 1 && !brow && prev !== undefined) worstStep = Math.max(worstStep, Math.abs(hs[0] - prev));
        prev = hs.length === 1 && !brow ? hs[0] : undefined;
      }
    }
    expect(off).toEqual([]);
    expect(worstStep).toBeLessThanOrEqual(0.05);
    expect(lifted).toBeGreaterThan(100);
    expect(near).toEqual([]);
    // 10 of some 1700 probes: one or three stations a row at a bank
    expect(brows).toBeLessThanOrEqual(10);
  });
});
