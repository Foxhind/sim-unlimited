import { describe, expect, it } from 'vitest';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildTombs, TOMB, tombFacing, tombKind } from '../src/world/tomb-mesher';
import type { LonLat, OsmPoint } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9516, y: 6398 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const flat = () => 50;
/** a hillside rising northward, 0.5 m per metre */
const hill = (_lon: number, lat: number) => 50 + (lat - c.lat) * KY * 0.5;

const AMYNTAS: OsmPoint = { at: at(0, 0), tags: { historic: 'archaeological_site', archaeological_site: 'tomb', 'historic:civilization': 'lycian', tomb: 'rock-cut' } };

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

describe('tombKind', () => {
  it('rock-cut (either spelling), the sarcophagi, the pillar tombs; nothing for an unknown or built one', () => {
    expect(tombKind({ tomb: 'rock-cut' })).toBe('rock-cut');
    expect(tombKind({ tomb: 'rock_cut' })).toBe('rock-cut');
    expect(tombKind({ tomb: 'lycian_sarcophagus' })).toBe('sarcophagus');
    expect(tombKind({ tomb: 'pillar_tomb' })).toBe('pillar');
    for (const t of ['mausoleum', 'turbe', 'vault', 'yes']) expect(tombKind({ tomb: t })).toBeUndefined();
    expect(tombKind({ historic: 'tomb' })).toBeUndefined();
  });
});

describe('tombFacing', () => {
  it('down the slope: a hill rising north, the front faces south (+z)', () => {
    const [fx, fz] = tombFacing(AMYNTAS.at, hill);
    expect(fx).toBeCloseTo(0, 3);
    expect(fz).toBeCloseTo(1, 3);
  });

  it('on flat ground by its hash: a unit direction, the same each time', () => {
    const f = tombFacing(AMYNTAS.at, flat);
    expect(Math.hypot(f[0], f[1])).toBeCloseTo(1, 6);
    expect(tombFacing(AMYNTAS.at, flat)).toEqual(f);
  });
});

describe('buildTombs', () => {
  it('a rock-cut front on a hillside: its rock block behind it uphill, its front out of the slope, up to its pediment', () => {
    const m = buildTombs(TILE, [AMYNTAS], hill);
    expect(m.ramps.length).toBeGreaterThan(0);
    const y = col(m.vertices, 1), z = col(m.vertices, 2);
    // the rock wedge reaches BLOCK_BACK_M back (north, −z) into the slope; the front's relief a little out (south)
    expect(Math.min(...z)).toBeCloseTo(-TOMB.ROCK.BLOCK_BACK_M, 3);
    expect(Math.max(...z)).toBeLessThan(1.5);
    // its brow broken: under the outcrop's full height, by at most BROW_DROP_M
    expect(Math.max(...y)).toBeLessThanOrEqual(50 + TOMB.ROCK.H + TOMB.ROCK.BLOCK_UP_M + 1e-4);
    expect(Math.max(...y)).toBeGreaterThan(50 + TOMB.ROCK.H + TOMB.ROCK.BLOCK_UP_M - TOMB.ROCK.BROW_DROP_M);
    windingAgrees(m.vertices);
  });

  it('a Lycian sarcophagus: base, chest and pointed lid; a pillar tomb', () => {
    const S = TOMB.SARCOPHAGUS;
    const s = buildTombs(TILE, [{ at: at(10, 10), tags: { historic: 'tomb', tomb: 'sarcophagus' } }], flat);
    expect(Math.max(...col(s.vertices, 1))).toBeCloseTo(50 + S.BASE_M + S.CHEST_M + S.LID_M + 0.3, 3);
    windingAgrees(s.vertices);
    const p = buildTombs(TILE, [{ at: at(10, 10), tags: { historic: 'tomb', tomb: 'pillar_tomb' } }], flat);
    expect(Math.max(...col(p.vertices, 1))).toBeCloseTo(50 + TOMB.PILLAR.H + TOMB.PILLAR.CHAMBER_M + 0.4, 3);
    windingAgrees(p.vertices);
  });

  it('only the tile it stands in, nothing for an unknown kind', () => {
    expect(buildTombs({ ...TILE, x: TILE.x + 1 }, [AMYNTAS], flat).ramps.length).toBe(0);
    expect(buildTombs(TILE, [{ at: at(0, 0), tags: { historic: 'tomb' } }], flat).ramps.length).toBe(0);
  });
});

describe('fetching the tombs', () => {
  it('every node and way with tomb=*, near', () => {
    expect(overpassQuery(TILE, 'full')).toContain('node["tomb"]; way["tomb"];');
    expect(overpassQuery(TILE, 'large')).not.toContain('tomb');
  });

  it('a tomb is a point; one mapped by its outline at its middle; a built one stays a building', () => {
    const nodes = [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]].map(([lat, lon], i) => ({ type: 'node' as const, id: i + 1, lat, lon }));
    const d = parseOverpass({ elements: [
      ...nodes,
      { type: 'node', id: 9, lat: 0.002, lon: 0.002, tags: { historic: 'tomb', tomb: 'sarcophagus' } },
      { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { historic: 'archaeological_site', archaeological_site: 'tomb', tomb: 'rock-cut' } },
      { type: 'way', id: 11, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', historic: 'tomb', tomb: 'mausoleum' } },
    ] });
    const tombs = d.points.filter((p) => p.tags.tomb);
    expect(tombs.map((p) => p.tags.tomb).sort()).toEqual(['rock-cut', 'sarcophagus']);
    const outline = tombs.find((p) => p.tags.tomb === 'rock-cut')!;
    expect(outline.at[0]).toBeCloseTo(0.0005, 9);
    expect(outline.at[1]).toBeCloseTo(0.0005, 9);
    expect(d.buildings.map((b) => b.tags.tomb)).toEqual(['mausoleum']);
  });
});
