import { describe, expect, it } from 'vitest';
import { DEFAULT_AREA_STYLES } from '../src/world/area-styles';
import { buildDocks, DOCK, dockFrame } from '../src/world/dock-mesher';
import { tileCenter, type Tile } from '../src/world/geodesy';
import type { LonLat, OsmArea } from '../src/world/osm-types';
import { overpassQuery } from '../src/world/overpass';
import { classifyArea, dockKind, isWetDock } from '../src/world/way-styles';

const TILE: Tile = { z: 14, x: 9545, y: 4771 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
/** a dock 200 m long east–west, 40 m wide */
const ring = [at(-100, -20), at(100, -20), at(100, 20), at(-100, 20), at(-100, -20)];

function col(v: Float32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += 6) out.push(v[i]);
  return out;
}

describe('dock kinds', () => {
  it('a wet or tidal dock is water, a floating one floats on water, a dry dock is a floor', () => {
    expect(dockKind({ waterway: 'dock' })).toBe('wet');
    expect(dockKind({ waterway: 'dock', dock: 'tidal' })).toBe('wet');
    expect(dockKind({ waterway: 'dock', dock: 'drydock' })).toBe('dry');
    expect(dockKind({ waterway: 'dock', dock: 'floating' })).toBe('floating');
    expect(dockKind({ waterway: 'river' })).toBeUndefined();
    expect(isWetDock({ waterway: 'dock', dock: 'floating' })).toBe(true);
    expect(classifyArea({ waterway: 'dock' }, DEFAULT_AREA_STYLES)?.water).toBe(true);
    const dry = classifyArea({ waterway: 'dock', dock: 'drydock' }, DEFAULT_AREA_STYLES);
    expect(dry?.water).toBe(false);
  });

  it('are fetched as ways and multipolygons', () => {
    const q = overpassQuery(TILE, 'full');
    expect(q).toContain('way["waterway"="dock"]');
    expect(q).toContain('relation["waterway"="dock"]');
  });
});

describe('buildDocks', () => {
  it('a dock’s frame: its long axis and extents', () => {
    const f = dockFrame([[-100, 20], [100, 20], [100, -20], [-100, -20], [-100, 20]]);
    expect(Math.abs(f.u[0])).toBeCloseTo(1, 6);
    expect(f.u1 - f.u0).toBeCloseTo(200, 6);
    expect(f.v1 - f.v0).toBeCloseTo(40, 6);
  });

  it('a dry dock: its coping round its edge, keel blocks down its middle; a wet one has nothing', () => {
    const dry: OsmArea = { tags: { waterway: 'dock', dock: 'drydock' }, rings: [ring] };
    const m = buildDocks(TILE, [dry], () => 3);
    const x = col(m.vertices, 0), y = col(m.vertices, 1), z = col(m.vertices, 2);
    expect(Math.max(...y)).toBeCloseTo(3 + Math.max(DOCK.COPING_H, DOCK.BLOCK_M[1]), 3);
    expect(Math.max(...x)).toBeGreaterThan(99);
    expect(Math.max(...z)).toBeGreaterThan(19);
    // the blocks: some faces within a couple of metres of the centre line, away from the coping
    expect(z.some((zz, i) => Math.abs(zz) < 1 && Math.abs(x[i]) < 50)).toBe(true);
    expect(buildDocks(TILE, [{ tags: { waterway: 'dock' }, rings: [ring] }], () => 3).vertices.length).toBe(0);
  });

  it('a floating dock: a pontoon on the water, its wing walls along its long sides', () => {
    const m = buildDocks(TILE, [{ tags: { waterway: 'dock', dock: 'floating' }, rings: [ring] }], () => -2);
    const y = col(m.vertices, 1);
    const wing = Math.max(DOCK.WING_H[0], Math.min(DOCK.WING_H[1], 40 * DOCK.WING_H_SHARE));
    expect(Math.max(...y)).toBeCloseTo(DOCK.DECK_M + wing, 1);
    expect(Math.min(...y)).toBeCloseTo(-DOCK.HULL_SINK_M, 3);
  });

  it('a dock is drawn by the tile holding its middle only', () => {
    const away = ring.map(([lon, lat]): LonLat => [lon + 5000 / KX, lat]);
    expect(buildDocks(TILE, [{ tags: { waterway: 'dock', dock: 'drydock' }, rings: [away] }], () => 0).vertices.length).toBe(0);
  });
});
