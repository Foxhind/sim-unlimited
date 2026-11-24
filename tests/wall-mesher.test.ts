import { describe, expect, it } from 'vitest';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { colourOf, snowy } from '../src/engine/palette';
import { buildWalls, WALL, wallKind } from '../src/world/wall-mesher';
import type { LonLat, OsmLine } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9517, y: 6398 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const flat = () => 20;

function col(v: Float32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += 6) out.push(v[i]);
  return out;
}

function windingAgrees(v: Float32Array): void {
  for (let t = 0; t < v.length; t += 18) {
    const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
    expect(n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5]).toBeGreaterThan(0);
  }
}

describe('wallKind', () => {
  it('walls, retaining walls, town walls, fences; not hedges or gates', () => {
    expect(wallKind({ barrier: 'wall' })).toBe('wall');
    expect(wallKind({ barrier: 'retaining_wall' })).toBe('retaining_wall');
    expect(wallKind({ barrier: 'city_wall' })).toBe('city_wall');
    expect(wallKind({ barrier: 'fence' })).toBe('fence');
    for (const b of ['hedge', 'gate']) expect(wallKind({ barrier: b })).toBeUndefined();
  });
});

describe('buildWalls', () => {
  it('a garden wall round a corner: on the ground, HEIGHT_M high, THICK_M thick, mitred (no gap at the corner)', () => {
    const l: OsmLine = { tags: { barrier: 'wall' }, points: [at(0, 0), at(20, 0), at(20, 20)] };
    const m = buildWalls(TILE, [l], flat);
    const y = col(m.vertices, 1), x = col(m.vertices, 0);
    expect(Math.min(...y)).toBeCloseTo(20 - WALL.SINK_M, 4);
    expect(Math.max(...y)).toBeCloseTo(20 + WALL.HEIGHT_M.wall, 4);
    // the outer corner reaches out half the thickness on both faces at once (the mitre)
    expect(Math.max(...x)).toBeCloseTo(20 + WALL.THICK_M.wall / 2, 1);
    windingAgrees(m.vertices);
  });

  it('a dry-stone wall lower and thicker; a tagged height wins', () => {
    const dry = buildWalls(TILE, [{ tags: { barrier: 'wall', wall: 'dry_stone' }, points: [at(0, 0), at(20, 0)] }], flat);
    expect(Math.max(...col(dry.vertices, 1))).toBeCloseTo(20 + WALL.DRY.HEIGHT_M, 4);
    const tall = buildWalls(TILE, [{ tags: { barrier: 'wall', height: '3' }, points: [at(0, 0), at(20, 0)] }], flat);
    expect(Math.max(...col(tall.vertices, 1))).toBeCloseTo(23, 4);
  });

  it('a retaining wall: from the lower ground on its right up over the higher on its left', () => {
    // the line runs east; its left is north, where the ground is 4 m higher
    const step = (_lon: number, lat: number) => (lat > c.lat ? 24 : 20);
    const m = buildWalls(TILE, [{ tags: { barrier: 'retaining_wall' }, points: [at(0, 0), at(20, 0)] }], step);
    const y = col(m.vertices, 1);
    expect(Math.min(...y)).toBeCloseTo(20 - WALL.SINK_M, 4);
    expect(Math.max(...y)).toBeCloseTo(24 + WALL.RETAIN_OVER_M, 4);
  });

  it('a town wall crenellated: merlons over its walk', () => {
    const m = buildWalls(TILE, [{ tags: { barrier: 'city_wall' }, points: [at(0, 0), at(40, 0)] }], flat);
    const y = col(m.vertices, 1);
    expect(Math.max(...y)).toBeCloseTo(20 + WALL.HEIGHT_M.city_wall + WALL.MERLON.HIGH_M, 4);
    const merlons = new Set(col(m.vertices, 0).filter((_, i) => y[i] > 20 + WALL.HEIGHT_M.city_wall + 0.5).map((x) => Math.floor(x / WALL.MERLON.EVERY_M)));
    expect(merlons.size).toBeGreaterThanOrEqual(14);
    windingAgrees(m.vertices);
  });

  it('a piece by the tile holding its middle only; nothing for a hedge', () => {
    const b = tileBounds(TILE);
    const across: OsmLine = { tags: { barrier: 'wall' }, points: [[b.east - 0.0002, c.lat], [b.east + 0.0001, c.lat]] };
    const here = buildWalls(TILE, [across], flat).ramps.length, east = buildWalls({ ...TILE, x: TILE.x + 1 }, [across], flat).ramps.length;
    expect(here === 0).not.toBe(east === 0);
    expect(buildWalls(TILE, [{ tags: { barrier: 'hedge' }, points: [at(0, 0), at(20, 0)] }], flat).ramps.length).toBe(0);
  });

  it('a fence: a thin panel FENCE height high, its tagged height within FENCE_MAX_M, coloured by its type; a stone one a dry-stone wall', () => {
    const fence = (tags: Record<string, string>) => buildWalls(TILE, [{ tags: { barrier: 'fence', ...tags }, points: [at(0, 0), at(20, 0)] }], flat);
    const plain = fence({});
    expect(Math.max(...col(plain.vertices, 1))).toBeCloseTo(20 + WALL.HEIGHT_M.fence, 4);
    expect(Math.max(...col(plain.vertices, 2).map(Math.abs))).toBeCloseTo(WALL.THICK_M.fence / 2, 3);
    expect(plain.ramps[0]).toBe(snowy(colourOf(WALL.FENCE)));
    expect(Math.max(...col(fence({ height: '9.9' }).vertices, 1))).toBeCloseTo(20 + WALL.FENCE_MAX_M, 4);
    expect(fence({ fence_type: 'wood' }).ramps[0]).toBe(snowy(colourOf(WALL.COLOURS.wood)));
    expect(fence({ fence_type: 'chain_link' }).ramps[0]).toBe(snowy(colourOf(WALL.COLOURS.chain_link)));
    const stone = fence({ fence_type: 'stone' });
    expect(Math.max(...col(stone.vertices, 1))).toBeCloseTo(20 + WALL.DRY.HEIGHT_M, 4);
    expect(stone.ramps[0]).toBe(snowy(colourOf(WALL.COLOURS.dry_stone)));
  });
});

describe('fetching the walls', () => {
  it('walls, retaining and town walls and fences, near; no hedges', () => {
    const q = overpassQuery(TILE, 'full');
    expect(q).toContain('way["barrier"~"^(wall|retaining_wall|city_wall|fence)$"];');
    expect(q).not.toContain('hedge');
    expect(overpassQuery(TILE, 'large')).not.toContain('barrier');
  });

  it('a wall closed round a garden is a line, not an area', () => {
    const nodes = [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]].map(([lat, lon], i) => ({ type: 'node' as const, id: i + 1, lat, lon }));
    const d = parseOverpass({ elements: [...nodes, { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { barrier: 'wall' } }] });
    expect(d.lines.map((l) => l.tags.barrier)).toEqual(['wall']);
    expect(d.areas).toHaveLength(0);
  });
});
