import { describe, expect, it } from 'vitest';
import { colourOf } from '../src/engine/palette';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { bearing, buildMinarets, isMosque, MINARET, minaretSites } from '../src/world/minaret-mesher';
import type { LonLat, OsmBuilding } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

describe('minarets from OSM', () => {
  it('a minaret mapped by its footprint stands at its middle; fetched near', () => {
    const n = (id: number, x: number, y: number) => ({ type: 'node' as const, id, lon: at(x, y)[0], lat: at(x, y)[1] });
    const d = parseOverpass({
      elements: [n(1, 0, 0), n(2, 2, 0), n(3, 2, 2), n(4, 0, 2), { type: 'way', id: 9, nodes: [1, 2, 3, 4, 1], tags: { man_made: 'tower', 'tower:type': 'minaret' } }],
    });
    expect(d.points.length).toBe(1);
    const [x, y] = m(d.points[0].at);
    // the mean of its four corners
    expect(x).toBeCloseTo(1, 3);
    expect(y).toBeCloseTo(1, 3);
    expect(minaretSites(d.points, []).length).toBe(1);
    expect(overpassQuery(TILE, 'full')).toContain('node["man_made"="tower"]["tower:type"="minaret"];');
  });
});

const TILE: Tile = { z: 14, x: 9517, y: 6397 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const m = ([lon, lat]: LonLat): [number, number] => [(lon - c.lon) * KX, (lat - c.lat) * KY];
/** a 20 × 20 m mosque centred on (x, y) m */
const mosque = (x = 0, y = 0, tags: Record<string, string> = { building: 'mosque' }): OsmBuilding => ({
  rings: [[at(x - 10, y - 10), at(x + 10, y - 10), at(x + 10, y + 10), at(x - 10, y + 10), at(x - 10, y - 10)]],
  tags,
});

describe('isMosque', () => {
  it('building=mosque, or a Muslim place of worship that is a building', () => {
    expect(isMosque({ building: 'mosque' })).toBe(true);
    expect(isMosque({ building: 'yes', amenity: 'place_of_worship', religion: 'muslim' })).toBe(true);
    expect(isMosque({ amenity: 'place_of_worship', religion: 'muslim' })).toBe(false);
    expect(isMosque({ building: 'church', amenity: 'place_of_worship', religion: 'christian' })).toBe(false);
  });
});

describe('bearing', () => {
  it('Mecca lies south-east of Fethiye', () => {
    const deg = (bearing([29.11, 36.62], [39.8262, 21.4225]) * 180) / Math.PI;
    expect(deg).toBeGreaterThan(130);
    expect(deg).toBeLessThan(150);
  });
});

describe('minaretSites', () => {
  it('a mapped minaret where it is mapped, with its height', () => {
    const sites = minaretSites([{ at: at(5, 5), tags: { man_made: 'tower', 'tower:type': 'minaret', height: '33' } }], []);
    expect(sites).toEqual([{ at: at(5, 5), height: 33 }]);
  });

  it('a mosque without one gets one at its corner away from Mecca (north-west here), just outside', () => {
    const [site] = minaretSites([], [mosque()]);
    const [x, y] = m(site.at);
    expect(x).toBeLessThan(-10);
    expect(y).toBeGreaterThan(10);
    expect(Math.hypot(x + 10, y - 10)).toBeLessThan(3);
    // 20 × 20 m: 14 + 0.5 × 20 = 24 m
    expect(site.height).toBeCloseTo(24, 3);
  });

  it('no guess where the mosque has a minaret mapped: a point, a building part, or one past the tile', () => {
    const tower = { at: at(12, 12), tags: { man_made: 'tower', 'tower:type': 'minaret' } };
    expect(minaretSites([tower], [mosque()]).length).toBe(1);
    const part: OsmBuilding = { rings: [[at(11, 11), at(13, 11), at(13, 13), at(11, 13)]], tags: { 'building:part': 'minaret', height: '30' } };
    expect(minaretSites([], [mosque(), part]).length).toBe(0);
    expect(minaretSites([], [mosque()], [at(15, -15)]).length).toBe(0);
    // a minaret far away is another mosque's
    expect(minaretSites([], [mosque()], [at(300, 0)]).length).toBe(1);
  });

  it('a guessed minaret keeps to MIN_M..MAX_M', () => {
    const big: OsmBuilding = { rings: [[at(-100, -100), at(100, -100), at(100, 100), at(-100, 100)]], tags: { building: 'mosque' } };
    expect(minaretSites([], [big])[0].height).toBe(MINARET.MAX_M);
    const small: OsmBuilding = { rings: [[at(0, 0), at(3, 0), at(3, 3), at(0, 3)]], tags: { building: 'mosque' } };
    expect(minaretSites([], [small])[0].height).toBe(MINARET.MIN_M);
  });
});

describe('buildMinarets', () => {
  const ys = (v: Float32Array) => { const o: number[] = []; for (let i = 1; i < v.length; i += 6) o.push(v[i]); return o; };

  it('a slender tower from under the ground to its height, a lead cone on top, a far line', () => {
    const md = buildMinarets([{ at: at(0, 0), height: 30 }], TILE, () => 10);
    expect(md.vertices.length).toBe(md.ramps.length * 6);
    expect(Math.max(...ys(md.vertices))).toBeCloseTo(40, 4);
    expect(Math.min(...ys(md.vertices))).toBeCloseTo(9, 4);
    // the cone's apex is lead, the shaft stone
    const top = ys(md.vertices).indexOf(Math.max(...ys(md.vertices)));
    expect(md.ramps[top]).toBe(colourOf(MINARET.LEAD));
    expect(md.ramps).toContain(colourOf(MINARET.STONE));
    // slender: no wider than the balcony's overhang round a 1.5 m shaft
    let r = 0;
    for (let i = 0; i < md.vertices.length; i += 6) r = Math.max(r, Math.hypot(md.vertices[i], md.vertices[i + 2]));
    expect(r).toBeLessThan(1.5 * (1 + MINARET.BALCONY_OUT) + 0.01);
    expect(Array.from(md.lines)).toEqual([expect.closeTo(0, 3), 10, expect.closeTo(0, 3), expect.any(Number), expect.closeTo(0, 3), 40, expect.closeTo(0, 3), expect.any(Number)]);
  });

  it('unit normals, the balcony floor and the shaft facing out', () => {
    const md = buildMinarets([{ at: at(0, 0), height: 25 }], TILE, () => 0);
    let up = 0;
    for (let i = 0; i < md.vertices.length; i += 6) {
      expect(Math.hypot(md.vertices[i + 3], md.vertices[i + 4], md.vertices[i + 5])).toBeCloseTo(1, 5);
      // a side face's normal points away from the axis
      if (Math.abs(md.vertices[i + 4]) < 0.5) expect(md.vertices[i] * md.vertices[i + 3] + md.vertices[i + 2] * md.vertices[i + 5]).toBeGreaterThan(-1e-4); // the cone's apex is on the axis
      if (md.vertices[i + 4] > 0.99) up++;
    }
    expect(up).toBeGreaterThan(0);
  });
});
