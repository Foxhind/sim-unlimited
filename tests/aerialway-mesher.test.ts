import { describe, expect, it } from 'vitest';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { AERIALWAY, buildAerialways, liftKind } from '../src/world/aerialway-mesher';
import type { LonLat, OsmLine, OsmPoint } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9518, y: 6400 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const flat = () => 100;

/** a gondola 400 m east from (−200, 0): pylons at 100 m and 300 m, a bend at 200 m (no pylon) */
const LINE: OsmLine = { tags: { aerialway: 'gondola' }, points: [at(-200, 0), at(-100, 0), at(0, 0), at(100, 0), at(200, 0)] };
const PYLONS: OsmPoint[] = [{ at: LINE.points[1], tags: { aerialway: 'pylon' } }, { at: LINE.points[3], tags: { aerialway: 'pylon' } }];

function col(v: Float32Array, k: number, stride: number): number[] {
  const out: number[] = [];
  for (let i = k; i < v.length; i += stride) out.push(v[i]);
  return out;
}

describe('liftKind', () => {
  it('the lifts that hang from ropes; none for the drag lifts or a station', () => {
    expect(liftKind({ aerialway: 'gondola' })).toBe('gondola');
    expect(liftKind({ aerialway: 'chair_lift' })).toBe('chair_lift');
    for (const a of ['drag_lift', 't-bar', 'station', 'pylon']) expect(liftKind({ aerialway: a })).toBeUndefined();
  });
});

describe('buildAerialways', () => {
  const m = buildAerialways(TILE, [LINE], PYLONS, flat);
  const rx = col(m.ropes, 0, 4), ry = col(m.ropes, 1, 4), rz = col(m.ropes, 2, 4);

  it('two ropes GAUGE_M apart, from station to station, at the stations STATION_ROPE_M up', () => {
    const g = AERIALWAY.GAUGE_M.gondola;
    expect(new Set(rz.map((z) => z.toFixed(2)))).toEqual(new Set([(-g / 2).toFixed(2), (g / 2).toFixed(2)]));
    expect(Math.min(...rx)).toBeCloseTo(-200, 0);
    expect(Math.max(...rx)).toBeCloseTo(200, 0);
    const atEnd = ry.filter((_, i) => Math.abs(rx[i] + 200) < 0.5);
    for (const y of atEnd) expect(y).toBeCloseTo(100 + AERIALWAY.STATION_ROPE_M, 3);
  });

  it('over a pylon the rope is at its top; over the bend (no pylon) it sags on, not lifted', () => {
    const over = (x: number) => ry.filter((_, i) => Math.abs(rx[i] - x) < 0.5);
    const top = 100 + AERIALWAY.PYLON_M.gondola - 0.5;
    for (const y of over(-100)) expect(y).toBeCloseTo(top, 1);
    // the span from the pylon at −100 to the one at 100 sags most at the bend, mid-span
    for (const y of over(0)) expect(y).toBeCloseTo(top - AERIALWAY.SAG * 200, 1);
  });

  it('a pylon stands at each mapped one, none at the bend; the stations at the ends', () => {
    const x = col(m.vertices, 0, 6), y = col(m.vertices, 1, 6);
    const tallNear = (px: number) => x.some((v, i) => Math.abs(v - px) < 1 && y[i] > 100 + AERIALWAY.PYLON_M.gondola - 1);
    expect(tallNear(-100)).toBe(true);
    expect(tallNear(100)).toBe(true);
    // the bend: only cabins pass by it, nothing stands up from the ground there
    expect(x.some((v, i) => Math.abs(v) < 1 && y[i] < 101)).toBe(false);
    // the station blocks: STATION.HEIGHT_M high at the ends
    expect(x.some((v, i) => Math.abs(v + 200) < AERIALWAY.STATION.LENGTH_M / 2 + 0.01 && Math.abs(y[i] - (100 + AERIALWAY.STATION.HEIGHT_M)) < 1e-3)).toBe(true);
  });

  it('cabins hang under the ropes every SPACING_M, none in the stations', () => {
    // a cabin's roof: the steel-coloured top face of a box HANGER_M under the rope, up to 8 m off the line
    const C = AERIALWAY.CABIN, v = m.vertices, top = new Set<string>();
    for (let i = 0; i < v.length; i += 6) {
      const x = v[i], y = v[i + 1], z = v[i + 2], ny = v[i + 4];
      if (ny > 0.99 && Math.abs(Math.abs(z) - AERIALWAY.GAUGE_M.gondola / 2) <= C.W / 2 + 1e-3 && y > 101 && y < 100 + AERIALWAY.PYLON_M.gondola - 2 && Math.abs(x) < 200 - AERIALWAY.STATION.LENGTH_M / 2) {
        top.add(`${Math.round(x / 10)},${Math.sign(z)}`);
      }
    }
    // 400 m at 80 m on each rope, out of step by half, none within half a station of the ends
    expect(top.size).toBe(9);
  });

  it('every face’s normal agrees with its winding', () => {
    const v = m.vertices;
    for (let t = 0; t < v.length; t += 18) {
      const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-9) continue;
      expect(n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5]).toBeGreaterThan(0);
    }
  });

  it('a line without mapped pylons has one at every inner vertex', () => {
    const bare = buildAerialways(TILE, [LINE], [], flat);
    const x = col(bare.vertices, 0, 6), y = col(bare.vertices, 1, 6);
    expect(x.some((v, i) => Math.abs(v) < 1 && y[i] > 100 + AERIALWAY.PYLON_M.gondola - 1)).toBe(true);
  });

  it('a pylon and a station by the border: drawn by the tile they stand in; each rope piece by one tile only', () => {
    const b = tileBounds(TILE);
    const lon = b.east; // the border to the east tile
    const cross: OsmLine = { tags: { aerialway: 'chair_lift' }, points: [[lon - 0.002, c.lat], [lon - 0.0005, c.lat], [lon + 0.0005, c.lat], [lon + 0.002, c.lat]] };
    const here = buildAerialways(TILE, [cross], [], flat), east = buildAerialways({ ...TILE, x: TILE.x + 1 }, [cross], [], flat);
    const pieces = (r: Float32Array) => r.length / 8;
    const all = buildAerialways(TILE, [cross], [], flat);
    expect(pieces(here.ropes) + pieces(east.ropes)).toBeGreaterThan(pieces(all.ropes));
    expect(here.vertices.length).toBeGreaterThan(0);
    expect(east.vertices.length).toBeGreaterThan(0);
  });
});

describe('fetching the lifts', () => {
  it('the lifts and their pylons and stations, near only', () => {
    expect(overpassQuery(TILE, 'full')).toContain('way["aerialway"~"^(gondola|cable_car|chair_lift|mixed_lift)$"]; node["aerialway"~"^(pylon|station)$"];');
    expect(overpassQuery(TILE, 'large')).not.toContain('aerialway');
  });

  it('a lift is a line, its pylons points', () => {
    const d = parseOverpass({ elements: [
      { type: 'node', id: 1, lat: 0, lon: 0, tags: { aerialway: 'station' } },
      { type: 'node', id: 2, lat: 0, lon: 0.001, tags: { aerialway: 'pylon' } },
      { type: 'node', id: 3, lat: 0, lon: 0.002 },
      { type: 'way', id: 10, nodes: [1, 2, 3], tags: { aerialway: 'gondola' } },
    ] });
    expect(d.lines.map((l) => l.tags.aerialway)).toEqual(['gondola']);
    expect(d.points.map((p) => p.tags.aerialway).sort()).toEqual(['pylon', 'station']);
  });
});
