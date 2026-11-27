import { describe, expect, it } from 'vitest';
import { LIGHT as LUT_LIGHT } from '../src/engine/palette';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildLighthouses, buoyLook, FLASH_STRIDE, flashTimes, inSector, LIGHTHOUSE, lightSites, litFlashes, seamarkLight } from '../src/world/lighthouse-mesher';
import type { LonLat, OsmPoint } from '../src/world/osm-types';
import { overpassQuery, parseOverpass } from '../src/world/overpass';

const TILE: Tile = { z: 14, x: 9515, y: 6397 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];

/** Kızıl Adalar: the lighthouse node and its charted light 20 m apart */
const TOWER: OsmPoint = { at: at(0, 0), tags: { man_made: 'lighthouse' } };
const LIGHT: OsmPoint = {
  at: at(12, 16),
  tags: { 'seamark:type': 'light_major', 'seamark:light:character': 'Fl', 'seamark:light:colour': 'white', 'seamark:light:height': '32', 'seamark:light:period': '5', 'seamark:light:sequence': '0.5+(4.5)' },
};

describe('flashTimes', () => {
  it('by the sequence: lit, dark in brackets', () => {
    expect(flashTimes('Fl', 5, undefined, '0.5+(4.5)')).toEqual({ period: 5, on: [[0, 0.5]] });
    expect(flashTimes('Fl', 5, '2', '0.3+(1)+0.3+(3.4)')).toEqual({ period: 5, on: [[0, 0.3], [1.3, 1.6]] });
  });

  it('by the character: fixed, flashing groups, quick, isophase, occulting', () => {
    expect(flashTimes('F', undefined, undefined, undefined).on).toEqual([[0, 1]]);
    const fl2 = flashTimes('Fl', 6, '2', undefined);
    expect(fl2.on).toHaveLength(2);
    expect(fl2.on[1][0]).toBeGreaterThan(fl2.on[0][1]);
    expect(fl2.on[1][1]).toBeLessThanOrEqual(6);
    expect(flashTimes('Q', undefined, undefined, undefined)).toEqual({ period: LIGHTHOUSE.QUICK[0], on: [[0, LIGHTHOUSE.QUICK[1]]] });
    expect(flashTimes('VQ', 10, '6', undefined).on).toHaveLength(6);
    expect(flashTimes('Iso', 3, undefined, undefined)).toEqual({ period: 3, on: [[0, 1.5]] });
    expect(flashTimes('Oc', 4, undefined, undefined)).toEqual({ period: 4, on: [[0, 3]] });
    expect(flashTimes('Fl', undefined, undefined, undefined).period).toBe(LIGHTHOUSE.PERIOD_S);
  });
});

describe('seamarkLight', () => {
  it('its colour, height and flashes; the first of a sectored light; none without a light', () => {
    const l = seamarkLight(LIGHT.tags)!;
    expect(l.colour).toBe(LIGHTHOUSE.COLOURS.white);
    expect(l.height).toBe(32);
    const sectored = seamarkLight({ 'seamark:light:1:colour': 'red', 'seamark:light:1:character': 'Fl', 'seamark:light:1:period': '4', 'seamark:light:2:colour': 'white' })!;
    expect(sectored.colour).toBe(LIGHTHOUSE.COLOURS.red);
    expect(sectored.period).toBe(4);
    expect(seamarkLight({ man_made: 'lighthouse' })).toBeUndefined();
  });
});

describe('lightSites', () => {
  it('a lighthouse and its light a few metres apart are one site, at the tower', () => {
    const sites = lightSites([LIGHT, TOWER, { at: at(500, 0), tags: { amenity: 'cafe' } }]);
    expect(sites).toHaveLength(1);
    expect(sites[0].at).toEqual(TOWER.at);
    expect(sites[0].tags.man_made).toBe('lighthouse');
    expect(sites[0].tags['seamark:light:period']).toBe('5');
  });
});

describe('buildLighthouses', () => {
  it('a tower up to its charted light, the light flashing on top of it', () => {
    const m = buildLighthouses(TILE, [TOWER, LIGHT], () => 10);
    expect(m.ramps.length).toBeGreaterThan(0);
    expect(m.flashes.length).toBe(FLASH_STRIDE);
    // the light at its charted 32 m over the sea, the tower's top under it
    expect(m.flashes[1]).toBeCloseTo(32, 5);
    expect(m.flashes[3]).toBe(LUT_LIGHT.SEA_WHITE);
    let top = -Infinity;
    for (let i = 1; i < m.vertices.length; i += 6) top = Math.max(top, m.vertices[i]);
    expect(top).toBeGreaterThan(32);
    expect(top).toBeCloseTo(32 + LIGHTHOUSE.LANTERN.H / 2 + LIGHTHOUSE.ROOF.H, 4);
  });

  it('the tower of its own height where the charted light is under the ground model', () => {
    const m = buildLighthouses(TILE, [TOWER, LIGHT], () => 40);
    expect(m.flashes[1]).toBeCloseTo(40 + LIGHTHOUSE.TOWER_M.lighthouse + LIGHTHOUSE.GALLERY.H + LIGHTHOUSE.LANTERN.H / 2, 5);
  });

  it('a harbour light’s post, a cardinal beacon’s pole; only the tile it stands in has it', () => {
    const post: OsmPoint = { at: at(50, 0), tags: { 'seamark:type': 'light_minor', 'seamark:light:colour': 'green', 'seamark:light:character': 'Fl', 'seamark:light:period': '5' } };
    const cardinal: OsmPoint = { at: at(-50, 0), tags: { 'seamark:type': 'beacon_cardinal', 'seamark:beacon_cardinal:colour': 'yellow;black', 'seamark:beacon_cardinal:height': '5', 'seamark:light:character': 'VQ', 'seamark:light:colour': 'white' } };
    const m = buildLighthouses(TILE, [post, cardinal], () => 0);
    expect(m.flashes.length).toBe(2 * FLASH_STRIDE);
    expect(buildLighthouses({ ...TILE, x: TILE.x + 1 }, [post, cardinal], () => 0).ramps.length).toBe(0);
  });

  it('every face’s normal agrees with its winding', () => {
    const v = buildLighthouses(TILE, [TOWER, LIGHT], () => 10).vertices;
    for (let t = 0; t < v.length; t += 18) {
      const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
      expect(n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5]).toBeGreaterThan(0);
    }
  });
});

describe('litFlashes', () => {
  it('a light is drawn only while lit in its period', () => {
    const m = buildLighthouses(TILE, [TOWER, LIGHT], () => 10);
    const out = new Float32Array(4);
    expect(litFlashes(m.flashes, 0.2, out)).toBe(1);
    expect(out[1]).toBeCloseTo(32, 5);
    expect(litFlashes(m.flashes, 1, out)).toBe(0);
    expect(litFlashes(m.flashes, 5.2, out)).toBe(1);
  });

  it('a sectored light (Gemiler island): white or red by where it is seen from, dark between', () => {
    // the chart's sectors, bearings from seaward towards the light: white 117°…16° (through north), red 16°…100°
    const gemiler: OsmPoint = {
      at: at(0, 0),
      tags: {
        'seamark:type': 'light_minor',
        'seamark:light:1:character': 'Fl', 'seamark:light:1:colour': 'white', 'seamark:light:1:period': '4', 'seamark:light:1:sector_start': '117', 'seamark:light:1:sector_end': '16',
        'seamark:light:2:character': 'Fl', 'seamark:light:2:colour': 'red', 'seamark:light:2:period': '4', 'seamark:light:2:sector_start': '16', 'seamark:light:2:sector_end': '100',
      },
    };
    expect(seamarkLight(gemiler.tags)!.sectors).toEqual([
      { start: 117, end: 16, colour: LUT_LIGHT.SEA_WHITE }, { start: 16, end: 100, colour: LUT_LIGHT.SEA_RED },
    ]);
    const m = buildLighthouses(TILE, [gemiler], () => 0);
    const out = new Float32Array(4);
    const seen = (bearingFromLight: number) => {
      // an eye 1 km off on that bearing from the light (x east, z south); the light at the tile's frame origin
      const r = (bearingFromLight * Math.PI) / 180;
      const eye: [number, number] = [m.flashes[0] + 1000 * Math.sin(r), m.flashes[2] - 1000 * Math.cos(r)];
      return litFlashes(m.flashes, 0.1, out, eye) ? out[3] : undefined;
    };
    // seen from the south the bearing to it is north (0°): the white sector; from the north-east (45°) 225°: white
    expect(seen(180)).toBe(LUT_LIGHT.SEA_WHITE);
    expect(seen(45)).toBe(LUT_LIGHT.SEA_WHITE);
    // from the south-west (225°) the bearing to it is 45°: red
    expect(seen(225)).toBe(LUT_LIGHT.SEA_RED);
    // from 290° the bearing to it is 110°, between the sectors: dark
    expect(seen(290)).toBeUndefined();
    // no eye: its first sector's colour
    expect(litFlashes(m.flashes, 0.1, out)).toBe(1);
    expect(out[3]).toBe(LUT_LIGHT.SEA_WHITE);
  });

  it('inSector: clockwise, across north too', () => {
    expect(inSector(50, 16, 100)).toBe(true);
    expect(inSector(350, 117, 16)).toBe(true);
    expect(inSector(-10, 117, 16)).toBe(true);
    expect(inSector(110, 117, 16)).toBe(false);
  });
});

describe('fetching the lights', () => {
  it('lighthouses, beacons and the charted lights, near', () => {
    const q = overpassQuery(TILE, 'full');
    expect(q).toContain('node["man_made"~"^(lighthouse|beacon)$"]');
    expect(q).toContain('node["seamark:type"~"^(light_major|light_minor|beacon_|buoy_)"]');
  });

  it('a charted light is a point; a lighthouse mapped by its outline stands at its middle, not as a house', () => {
    const d = parseOverpass({ elements: [
      { type: 'node', id: 1, lat: 0, lon: 0, tags: { 'seamark:type': 'light_minor', 'seamark:light:colour': 'red' } },
      { type: 'node', id: 2, lat: 0.001, lon: 0.001 }, { type: 'node', id: 3, lat: 0.001, lon: 0.0011 }, { type: 'node', id: 4, lat: 0.0011, lon: 0.0011 },
      { type: 'way', id: 10, nodes: [2, 3, 4, 2], tags: { man_made: 'lighthouse', building: 'yes' } },
    ] });
    expect(d.points.map((p) => p.tags['seamark:type'] ?? p.tags.man_made).sort()).toEqual(['light_minor', 'lighthouse']);
    expect(d.buildings).toHaveLength(0);
  });
});

describe('buoys', () => {
  it('their look as charted; untagged, their kind’s: a port can, a starboard cone, a cardinal’s bands and cones', () => {
    expect(buoyLook({ 'seamark:type': 'buoy_lateral', 'seamark:buoy_lateral:category': 'port' })).toEqual({ shape: 'can', colours: ['red'], vertical: false });
    expect(buoyLook({ 'seamark:type': 'buoy_lateral', 'seamark:buoy_lateral:category': 'starboard' })?.shape).toBe('conical');
    const north = buoyLook({ 'seamark:type': 'buoy_cardinal', 'seamark:buoy_cardinal:category': 'north' });
    expect(north).toEqual({ shape: 'pillar', colours: ['black', 'yellow'], vertical: false, topmark: { shape: '2 cones up', colour: 'black' } });
    expect(buoyLook({ 'seamark:type': 'buoy_safe_water' })?.vertical).toBe(true);
    expect(buoyLook({ 'seamark:type': 'buoy_special_purpose', 'seamark:buoy_special_purpose:shape': 'spar', 'seamark:buoy_special_purpose:colour': 'yellow' })).toEqual({ shape: 'spar', colours: ['yellow'], vertical: false });
    expect(buoyLook({ 'seamark:type': 'light_minor' })).toBeUndefined();
  });

  it('a channel’s pair a few metres apart are two buoys; a buoy floats at the sea, its light over its topmark', () => {
    const port: OsmPoint = { at: at(0, 0), tags: { 'seamark:type': 'buoy_lateral', 'seamark:buoy_lateral:category': 'port', 'seamark:light:colour': 'red', 'seamark:light:character': 'Fl' } };
    const stbd: OsmPoint = { at: at(15, 0), tags: { 'seamark:type': 'buoy_lateral', 'seamark:buoy_lateral:category': 'starboard', 'seamark:light:colour': 'green', 'seamark:light:character': 'Fl' } };
    expect(lightSites([port, stbd])).toHaveLength(2);
    const m = buildLighthouses(TILE, [port, stbd], () => -3);
    expect(m.flashes.length).toBe(2 * FLASH_STRIDE);
    const ys: number[] = [];
    for (let i = 1; i < m.vertices.length; i += 6) ys.push(m.vertices[i]);
    // on the sea (0), not on the sea floor under it; no taller than a conical buoy
    expect(Math.min(...ys)).toBeGreaterThan(-1);
    expect(Math.max(...ys)).toBeLessThan(3);
    expect(m.flashes[1]).toBeGreaterThan(1);
  });

  it('a cardinal buoy’s faces are wound outward, its topmark over its body', () => {
    const west: OsmPoint = { at: at(0, 0), tags: { 'seamark:type': 'buoy_cardinal', 'seamark:buoy_cardinal:category': 'west' } };
    const v = buildLighthouses(TILE, [west], () => 0).vertices;
    let top = 0;
    for (let t = 0; t < v.length; t += 18) {
      const a = [v[t], v[t + 1], v[t + 2]], b = [v[t + 6], v[t + 7], v[t + 8]], d = [v[t + 12], v[t + 13], v[t + 14]];
      top = Math.max(top, a[1], b[1], d[1]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
      expect(n[0] * v[t + 3] + n[1] * v[t + 4] + n[2] * v[t + 5]).toBeGreaterThan(0);
    }
    expect(top).toBeGreaterThan(3.6 + 0.35);
  });
});
