import { describe, expect, it } from 'vitest';
import { buildFarOsm, FAR_OSM_RADIUS_M, farOsmTiles, mvtBuildings, mvtRoads } from '../src/world/far-osm';
import { tileBounds, tileForLatLon, type Tile } from '../src/world/geodesy';
import { decodeMvt, ringArea, type MvtValue } from '../src/world/mvt';
import { DETAIL_RADIUS_M, DETAIL_Z, selectLeaves } from '../src/world/chunks';

// --- a tiny MVT encoder for the tests ---
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
};
const field = (f: number, wire: number) => varint((f << 3) | wire);
const bytes = (f: number, b: number[]) => [...field(f, 2), ...varint(b.length), ...b];
const str = (f: number, s: string) => bytes(f, [...new TextEncoder().encode(s)]);
const zz = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);

interface F { type: 1 | 2 | 3; props: Record<string, MvtValue>; parts: Array<Array<[number, number]>> }

function geometry(type: number, parts: Array<Array<[number, number]>>): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  for (const part of parts) {
    const pts = type === 3 ? part.slice(0, -1) : part; // polygons: ClosePath instead of the repeated first point
    out.push((1 << 3) | 1, zz(pts[0][0] - x), zz(pts[0][1] - y));
    [x, y] = pts[0];
    out.push(((pts.length - 1) << 3) | 2);
    for (const [px, py] of pts.slice(1)) { out.push(zz(px - x), zz(py - y)); x = px; y = py; }
    if (type === 3) out.push((1 << 3) | 7);
  }
  return out.flatMap((v) => varint(v));
}

function layer(name: string, features: F[], extent = 4096): number[] {
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const idx = <T>(list: T[], v: T) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
  const feats = features.map((f) => {
    const tags = Object.entries(f.props).flatMap(([k, v]) => [idx(keys, k), idx(values, v)]);
    return bytes(2, [...bytes(2, tags.flatMap((t) => varint(t))), ...field(3, 0), ...varint(f.type), ...bytes(4, geometry(f.type, f.parts))]);
  });
  const vals = values.map((v) => bytes(4, typeof v === 'string' ? str(1, v) : typeof v === 'boolean' ? [...field(7, 0), v ? 1 : 0] : [...field(5, 0), ...varint(v)]));
  return bytes(3, [...field(15, 0), 2, ...str(1, name), ...feats.flat(), ...keys.flatMap((k) => str(3, k)), ...vals.flat(), ...field(5, 0), ...varint(extent)]);
}

const mvt = (...layers: number[][]) => new Uint8Array(layers.flat());
const square = (x: number, y: number, s: number): Array<[number, number]> => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

const TILE: Tile = { z: 14, x: 8710, y: 5744 };

describe('MVT reader', () => {
  it('reads layers, properties and rings (exteriors with positive area)', () => {
    const data = mvt(layer('building', [{ type: 3, props: { render_height: 12, colour: '#ff0000', hide_3d: false }, parts: [square(100, 100, 50)] }]));
    const [l] = decodeMvt(data);
    expect(l.name).toBe('building');
    expect(l.extent).toBe(4096);
    expect(l.features[0].props).toEqual({ render_height: 12, colour: '#ff0000', hide_3d: false });
    expect(l.features[0].parts[0]).toEqual(square(100, 100, 50));
    expect(ringArea(l.features[0].parts[0])).toBe(2500);
  });

  it('skips layers that are not wanted', () => {
    const data = mvt(layer('poi', [{ type: 1, props: {}, parts: [[[1, 1]]] }]), layer('building', []));
    expect(decodeMvt(data, new Set(['building'])).map((l) => l.name)).toEqual(['building']);
  });
});

describe('far OSM ring data', () => {
  it('one building per exterior ring with its centroid in the tile; outlines of part-drawn buildings left out', () => {
    const [l] = decodeMvt(mvt(layer('building', [
      { type: 3, props: { render_height: 9, colour: 'white' }, parts: [square(100, 100, 40), square(300, 300, 40)] },
      { type: 3, props: { render_height: 9 }, parts: [square(4080, 100, 40)] }, // centroid past the east edge: the neighbour's
      { type: 3, props: { render_height: 30, hide_3d: true }, parts: [square(600, 600, 40)] },
    ])));
    const b = mvtBuildings(l, TILE);
    expect(b).toHaveLength(2);
    expect(b[0].tags).toMatchObject({ building: 'yes', height: '9', 'building:colour': 'white' });
    const bb = tileBounds(TILE);
    for (const [lon, lat] of b[0].rings[0]) {
      expect(lon).toBeGreaterThanOrEqual(bb.west);
      expect(lon).toBeLessThanOrEqual(bb.east);
      expect(lat).toBeGreaterThanOrEqual(bb.south);
      expect(lat).toBeLessThanOrEqual(bb.north);
    }
  });

  it('roads: the drawn classes, no tunnels, no paths', () => {
    const line: Array<[number, number]> = [[0, 0], [1000, 1000]];
    const [l] = decodeMvt(mvt(layer('transportation', [
      { type: 2, props: { class: 'primary' }, parts: [line] },
      { type: 2, props: { class: 'minor' }, parts: [line] },
      { type: 2, props: { class: 'motorway', brunnel: 'tunnel' }, parts: [line] },
      { type: 2, props: { class: 'path' }, parts: [line] },
    ])));
    expect(mvtRoads(l, TILE)).toHaveLength(2);
  });

  it('builds wall + roof dot pairs, night lights and road segments on the DEM', () => {
    const data = mvt(
      layer('building', [{ type: 3, props: { render_height: 10 }, parts: [square(100, 100, 40)] }]),
      layer('transportation', [{ type: 2, props: { class: 'primary' }, parts: [[[0, 2000], [4096, 2000]]] }]),
    );
    const out = buildFarOsm(data, TILE, () => 600);
    expect(out.dots.length).toBe(8); // two points
    expect(out.dots[1]).toBeCloseTo(605); // half-way up the 10 m building
    expect(out.nightDots.length).toBe(4); // one light, no windows
    // the 1.6 km road split into ≤ 150 m pieces, each a vertex pair at the DEM height
    expect(out.roadLines.length / 8).toBeGreaterThanOrEqual(11);
    for (let i = 1; i < out.roadLines.length; i += 4) expect(out.roadLines[i]).toBe(600);
  });
});

describe('far OSM ring tiles', () => {
  const cam = { lat: 47.26, lon: 11.34 };
  it('are z14 tiles within the far radius, without the detailed ones', () => {
    const detail = selectLeaves(cam, 2000).filter((t) => t.z === DETAIL_Z);
    const keys = new Set(detail.map((t) => `${t.z}/${t.x}/${t.y}`));
    const ring = farOsmTiles(cam, 2000, keys);
    expect(ring.length).toBeGreaterThan(300);
    for (const t of ring) {
      expect(t.z).toBe(14);
      expect(keys.has(`${t.z}/${t.x}/${t.y}`)).toBe(false);
    }
    // the tile under the camera is detailed, not in the ring
    const home = tileForLatLon(cam.lat, cam.lon, 14);
    expect(ring.some((t) => t.x === home.x && t.y === home.y)).toBe(false);
    expect(DETAIL_RADIUS_M).toBeLessThan(FAR_OSM_RADIUS_M);
  });

  it('none above the far radius', () => {
    expect(farOsmTiles(cam, FAR_OSM_RADIUS_M + 100, new Set())).toEqual([]);
  });
});
