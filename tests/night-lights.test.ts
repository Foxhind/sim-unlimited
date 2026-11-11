import { describe, expect, it } from 'vitest';
import { applySunColors, buildLUT, LIGHT, paletteAt, sunColors } from '../src/engine/palette';
import { POINTS_FS, SKY_FS } from '../src/engine/shaders';
import { buildingNightLights, TALL_BUILDING_M } from '../src/world/building-mesher';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { antennaHeight, beaconHeights, buildMasts, isAntenna } from '../src/world/mast-mesher';
import { parseFilter } from '../src/world/osm-api';
import { osmFilter } from '../src/world/overpass';
import type { OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };
const GROUND = 100;
const flat = () => GROUND;

function rect(w = 0.0004, h = 0.0003): [number, number][] {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
}
const entry = (lut: Uint8Array, i: number) => [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]];
/** x, y, z, index quadruples */
const quads = (a: Float32Array) => Array.from({ length: a.length / 4 }, (_, i) => Array.from(a.subarray(i * 4, i * 4 + 4)));

describe('sun colour', () => {
  it('is white by day and yellow in the morning and evening', () => {
    expect(sunColors(45).sun).toEqual([255, 255, 255]);
    const low = sunColors(4).sun;
    expect(low[0]).toBe(255);
    expect(low[2]).toBeLessThan(100); // yellow: little blue
    expect(sunColors(10).sun).toEqual(low); // the "morning" preset puts the sun at +10°
  });

  it('the sky shader draws the sun from the LUT entries applySunColors writes', () => {
    expect(SKY_FS).toContain(`idx = ${LIGHT.SUN}u;`);
    expect(SKY_FS).toContain(`idx = ${LIGHT.SUN_HALO}u;`);
    const lut = buildLUT(paletteAt(45));
    applySunColors(lut, 45);
    expect(entry(lut, LIGHT.SUN)).toEqual([255, 255, 255]);
    applySunColors(lut, 3);
    expect(entry(lut, LIGHT.SUN)[2]).toBeLessThan(100);
  });

  it('light colours do not darken at night', () => {
    const day = buildLUT(paletteAt(45));
    const night = buildLUT(paletteAt(-20));
    for (const i of [LIGHT.WINDOW_YELLOW, LIGHT.WINDOW_WHITE, LIGHT.RED]) expect(entry(night, i)).toEqual(entry(day, i));
    expect(entry(night, LIGHT.RED)[0]).toBe(255);
  });

  it('the point pass can also draw unrounded lines', () => {
    expect(POINTS_FS).toMatch(/if \(uRound == 1\) \{[\s\S]*gl_PointCoord/);
  });
});

describe('building night lights', () => {
  const house: OsmBuilding = { rings: [rect()], tags: { building: 'apartments', 'building:levels': '5' } };
  const tower: OsmBuilding = { rings: [rect(0.0002, 0.0002)], tags: { building: 'office', height: '80' } };
  const garage: OsmBuilding = { rings: [rect(0.0001, 0.0001)], tags: { building: 'garage' } };

  it('lights some windows on the walls in yellow and white, between the floors', () => {
    const { windows } = buildingNightLights([house], TILE, flat);
    const w = quads(windows);
    expect(w.length).toBeGreaterThan(20);
    const colours = new Set(w.map((q) => q[3]));
    expect(colours).toEqual(new Set([LIGHT.WINDOW_YELLOW, LIGHT.WINDOW_WHITE]));
    for (const [, y] of w) {
      expect(y).toBeGreaterThan(GROUND);
      expect(y).toBeLessThan(GROUND + 15);
    }
    // deterministic
    expect(buildingNightLights([house], TILE, flat).windows).toEqual(windows);
  });

  it('far: one yellow or white dot per lit building; garages stay dark', () => {
    const { dots, windows } = buildingNightLights([house, garage], TILE, flat);
    const d = quads(dots);
    expect(d).toHaveLength(1);
    expect([LIGHT.WINDOW_YELLOW, LIGHT.WINDOW_WHITE]).toContain(d[0][3]);
    expect(buildingNightLights([garage], TILE, flat).windows.length).toBe(0);
    expect(windows.length).toBeGreaterThan(0);
  });

  it(`buildings over ${TALL_BUILDING_M} m get red lights on the roof (near) and in the air at roof height (far)`, () => {
    const { windows, dots } = buildingNightLights([tower], TILE, flat);
    const nearRed = quads(windows).filter((q) => q[3] === LIGHT.RED);
    expect(nearRed.length).toBe(4);
    for (const q of nearRed) expect(q[1]).toBeCloseTo(GROUND + 80.5, 3);
    const farRed = quads(dots).filter((q) => q[3] === LIGHT.RED);
    expect(farRed).toHaveLength(1);
    expect(farRed[0][1]).toBeCloseTo(GROUND + 80, 3);
    expect(quads(buildingNightLights([house], TILE, flat).dots).some((q) => q[3] === LIGHT.RED)).toBe(false);
  });
});

describe('antenna masts', () => {
  const c = tileCenter(TILE);
  const mast = { at: [c.lon, c.lat] as [number, number], tags: { man_made: 'mast', height: '110' } };

  it('recognises antenna point objects', () => {
    expect(isAntenna({ man_made: 'mast' })).toBe(true);
    expect(isAntenna({ man_made: 'antenna' })).toBe(true);
    expect(isAntenna({ man_made: 'tower', 'tower:type': 'communication' })).toBe(true);
    expect(isAntenna({ man_made: 'tower', 'tower:type': 'cooling' })).toBe(false);
    expect(isAntenna({ man_made: 'water_tower' })).toBe(false);
    expect(antennaHeight({ man_made: 'mast', height: '110 m' })).toBe(110);
  });

  it('fetches antenna nodes from OSM (Overpass and the API filter)', () => {
    const sel = parseFilter(osmFilter('full'));
    expect(sel.some((s) => s.type === 'node' && s.clauses.some((k) => k.key === 'man_made' && k.re?.test('mast')))).toBe(true);
    expect(sel.some((s) => s.type === 'node' && s.clauses.some((k) => k.key === 'tower:type' && k.value === 'communication'))).toBe(true);
  });

  it('red beacons every 25 m of height', () => {
    expect(beaconHeights(110)).toEqual([25, 50, 75, 100]);
    expect(beaconHeights(20)).toEqual([]);
    const { beacons } = buildMasts([mast], TILE, flat);
    const b = quads(beacons);
    expect(b.map((q) => Math.round(q[1] - GROUND))).toEqual([25, 50, 75, 100]);
    expect(b.every((q) => q[3] === LIGHT.RED)).toBe(true);
  });

  it('a square lattice truss up to the mast height near, a vertical line far', () => {
    const m = buildMasts([mast], TILE, flat);
    expect(m.ramps.length).toBe(m.vertices.length / 6);
    expect(m.ramps.length % 6).toBe(0);
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < m.vertices.length; i += 6) {
      minX = Math.min(minX, m.vertices[i]);
      maxX = Math.max(maxX, m.vertices[i]);
      maxY = Math.max(maxY, m.vertices[i + 1]);
    }
    expect(maxY).toBeGreaterThan(GROUND + 109);
    expect(maxY).toBeLessThan(GROUND + 111);
    expect(maxX - minX).toBeGreaterThan(1.5); // four legs apart, not a single pole
    const line = quads(m.lines);
    expect(line).toHaveLength(2);
    expect(line[0][0]).toBe(line[1][0]);
    expect(line[0][2]).toBe(line[1][2]);
    expect(line[1][1] - line[0][1]).toBeCloseTo(110, 3);
  });

  it('ignores other point objects', () => {
    const m = buildMasts([{ at: mast.at, tags: { aeroway: 'helipad' } }], TILE, flat);
    expect(m.vertices.length + m.lines.length + m.beacons.length).toBe(0);
  });
});
