import { describe, expect, it } from 'vitest';
import {
  applySunColors, buildLUT, FACADE, FACADE_BLIND, FACADE_RESIDENTIAL, FACADE_SEED_BITS, GLOW_LEVELS, LIGHT, WINDOWS, LUT_SIZE, paletteAt, RAMP, rampGlowLevel, rampIndex, sunColour, withGlow,
} from '../src/engine/palette';
import { POINTS_FS, SKY_FS, TREE_VS, WORLD_FS, WORLD_VS } from '../src/engine/shaders';
import { buildBuildingMesh, buildingNightLights, hasBalconies, TALL_BUILDING_M, WINDOW_ATTR_FLOATS } from '../src/world/building-mesher';
import { latLonToEnu, tileBounds, tileCenter, tileSizeMeters, type Tile } from '../src/world/geodesy';
import {
  applyGlow, applyGlowToTrees, buildingCoverage, GLOW_FULL_COVERAGE, GLOW_MIN_COVERAGE, glowLevel,
} from '../src/world/night-glow';
import { farLightSize } from '../src/world/osm-manager';
import { INSTANCE, LAMP_SHAPE, setTreeColour, treeColour, TREE_STRIDE } from '../src/world/props-mesher';
import { buildGlowGround, buildTerrainMesh, GLOW_GROUND_LIFT_M } from '../src/world/terrain-mesher';
import { buildTerrainTin, tinLocator } from '../src/world/terrain-tin';
import { antennaHeight, beaconHeights, buildMasts, isAntenna } from '../src/world/mast-mesher';
import { parseFilter } from '../src/world/osm-api';
import { buildOsmMesh, isLitRoad, LAMP_HEIGHT_M, lampSide, LAMP_SPACING_M, LIT_ROAD_GLOW, UNLIT_ROAD_GLOW } from '../src/world/osm-mesher';
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
    expect(sunColour(45)).toEqual([255, 255, 255]);
    const low = sunColour(4);
    expect(low[0]).toBe(255);
    expect(low[2]).toBeLessThan(100); // yellow: little blue
    expect(sunColour(10)).toEqual(low); // the "morning" preset puts the sun at +10°
  });

  it('the sky shader draws the sun as one plain disc from the LUT entry applySunColors writes', () => {
    expect(SKY_FS).toContain(`idx = ${LIGHT.SUN}u;`);
    expect(SKY_FS).not.toContain('halo');
    expect(SKY_FS.match(/idx = \d+u;/g)?.filter((m) => m === `idx = ${LIGHT.SUN}u;`)).toHaveLength(1);
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

  it('near: no window points; windows are facade attributes on the walls of lit buildings only', () => {
    expect(quads(buildingNightLights([house], TILE, flat).roofLights)).toHaveLength(0);
    const m = buildBuildingMesh({ tile: TILE, buildings: [house], sampleHeight: flat });
    expect(m.windows.length).toBe(m.vertexCount * WINDOW_ATTR_FLOATS);
    const attrs = Array.from({ length: m.vertexCount }, (_, i) => Array.from(m.windows.subarray(i * WINDOW_ATTR_FLOATS, (i + 1) * WINDOW_ATTR_FLOATS)));
    const walls = attrs.filter((a) => a[3] > 0);
    expect(walls.length).toBeGreaterThan(0);
    for (const [u, v, len, wallH, seed] of walls) {
      expect(wallH).toBeCloseTo(15, 3); // 5 levels between the plinth and the technical floor
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(len + 1e-3);
      // v from the top of the 1 m plinth: the plinth itself is below 0 (no windows)
      expect(v).toBeGreaterThanOrEqual(-1 - 1e-3);
      expect(Number.isInteger(seed)).toBe(true);
    }
    // roofs carry no windows
    expect(attrs.some((a) => a[3] === 0)).toBe(true);
    // deterministic
    expect(buildBuildingMesh({ tile: TILE, buildings: [house], sampleHeight: flat }).windows).toEqual(m.windows);
    const g = buildBuildingMesh({ tile: TILE, buildings: [garage], sampleHeight: flat });
    expect(g.windows.filter((_, i) => i % WINDOW_ATTR_FLOATS === 3).every((h) => h === 0)).toBe(true); // wall height 0: no windows
  });

  it('the world shader lights a share of the windows at night in the window colours', () => {
    expect(WORLD_FS).toContain('bool windowAt(');
    expect(WORLD_FS).toContain(`${LIGHT.WINDOW_YELLOW}u`);
    expect(WORLD_FS).toContain(`${LIGHT.WINDOW_WHITE}u`);
    expect(WORLD_FS).toContain('bool lit = uWindows == 2 && r < share;');
    expect(WORLD_VS).toContain('layout(location=3) in vec2 aWinUV;');
    expect(TREE_VS).toContain('vWinEdge = vec3(0.0);');
  });

  it('balconies: only on residential buildings, glazed or open on some edges, the rest plain windows', () => {
    const styles = (b: OsmBuilding) => {
      const m = buildBuildingMesh({ tile: TILE, buildings: [b], sampleHeight: flat });
      const out = new Set<number>();
      for (let i = 0; i < m.vertexCount; i++) {
        if (m.windows[i * WINDOW_ATTR_FLOATS + 3] > 0) out.add((m.windows[i * WINDOW_ATTR_FLOATS + 4] >> FACADE_SEED_BITS) & 3);
      }
      return out;
    };
    const all = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const block: OsmBuilding = { rings: [rect(0.0003 + i * 0.00001)], tags: { building: 'apartments', 'building:levels': '9' } };
      for (const st of styles(block)) all.add(st);
    }
    expect(all).toEqual(new Set([FACADE.WINDOWS, FACADE.GLAZED_BALCONIES, FACADE.OPEN_BALCONIES]));
    expect(styles({ rings: [rect()], tags: { building: 'office', 'building:levels': '9' } })).toEqual(new Set([FACADE.WINDOWS]));
    expect(hasBalconies({ building: 'yes' }, 15)).toBe(true);
    expect(hasBalconies({ building: 'yes' }, 6)).toBe(false);
    expect(WORLD_FS).toContain(`uint style = (code >> ${FACADE_SEED_BITS}u) & 3u;`);
  });

  it('doors where OSM entrances lie on the outline: on the wall, facing out, at the ground', () => {
    const ring = rect();
    const [lon0, lat0] = ring[0], [lon1] = ring[1];
    const plain = buildBuildingMesh({ tile: TILE, buildings: [house], sampleHeight: flat });
    // on the south wall, a third of the way along; and one far from any building
    const at: [number, number] = [lon0 + (lon1 - lon0) / 3, lat0];
    const withDoor = buildBuildingMesh({
      tile: TILE, buildings: [house], sampleHeight: flat,
      points: [{ at, tags: { entrance: 'staircase' } }, { at: [lon0 - 0.01, lat0], tags: { entrance: 'yes' } }, { at, tags: { entrance: 'no' } }],
    });
    const extra = withDoor.vertexCount - plain.vertexCount;
    expect(extra).toBe(3 * 6); // blind patch over the slot's ground floor, frame, leaf
    const c = tileCenter(TILE);
    const [ex, en] = latLonToEnu(c, at[1], at[0], 0);
    // the door goes in after the walls: the first vertex that differs from the plain mesh
    let first = 0;
    while (first < plain.vertexCount && plain.vertices[first * 6] === withDoor.vertices[first * 6] && plain.vertices[first * 6 + 1] === withDoor.vertices[first * 6 + 1]) first++;
    for (let i = first; i < first + extra; i++) {
      const o = i * 6;
      const [x, y, z, , ny, nz] = Array.from(withDoor.vertices.subarray(o, o + 6));
      expect(ny).toBe(0);
      expect(nz).toBeCloseTo(1, 3); // the south wall faces south (+z)
      expect(z).toBeGreaterThan(-en);
      expect(Math.abs(x - ex)).toBeLessThan(WINDOWS.SPACING_M + 1.5);
      expect(y).toBeGreaterThanOrEqual(GROUND - 1e-3);
      expect(y).toBeLessThan(GROUND + 4.01); // plinth and the ground floor
    }
    // the blind patch carries the facade attributes of its edge, flagged blind; frame and leaf none
    const patch = Array.from({ length: 6 }, (_, i) => Array.from(withDoor.windows.subarray((first + i) * WINDOW_ATTR_FLOATS, (first + i + 1) * WINDOW_ATTR_FLOATS)));
    for (const [, v, , wallH, code] of patch) {
      expect(wallH).toBeCloseTo(15, 3);
      expect(v).toBeGreaterThanOrEqual(-1 - 1e-3);
      expect(v).toBeLessThanOrEqual(3);
      expect(code & FACADE_BLIND).toBe(FACADE_BLIND);
      expect(code & FACADE_RESIDENTIAL).toBe(FACADE_RESIDENTIAL); // apartments
    }
    for (let i = first + 6; i < first + extra; i++) expect(withDoor.windows[i * WINDOW_ATTR_FLOATS + 3]).toBe(0);
  });

  it('the ground floor differs: its own shade, shop windows or full glazing, signs only on residential', () => {
    expect(WORLD_FS).toContain('bool groundFloorAt(');
    expect(WORLD_FS).toContain('bool ground = f == 0.0 && floors >= 2.0;');
    expect(WORLD_FS).toMatch(/if \(resid && winRand\(/);
    expect(WORLD_FS).toContain(`bool resid = (code & ${FACADE_RESIDENTIAL}u) != 0u;`);
    expect(WORLD_VS).toContain('flat out vec3 vRef;');
    expect(TREE_VS).toContain('vRef = vec3(0.0);');
    const office = buildBuildingMesh({ tile: TILE, buildings: [{ rings: [rect()], tags: { building: 'office', 'building:levels': '5' } }], sampleHeight: flat });
    for (let i = 0; i < office.vertexCount; i++) expect(office.windows[i * WINDOW_ATTR_FLOATS + 4] & FACADE_RESIDENTIAL).toBe(0);
  });

  it('far: one yellow or white dot per lit building; garages stay dark', () => {
    const { dots } = buildingNightLights([house, garage], TILE, flat);
    const d = quads(dots);
    expect(d).toHaveLength(1);
    expect([LIGHT.WINDOW_YELLOW, LIGHT.WINDOW_WHITE]).toContain(d[0][3]);
  });

  it(`buildings over ${TALL_BUILDING_M} m get red lights on the roof (near) and in the air at roof height (far)`, () => {
    const { roofLights, dots } = buildingNightLights([tower], TILE, flat);
    const nearRed = quads(roofLights).filter((q) => q[3] === LIGHT.RED);
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

describe('far building lights', () => {
  it('are thin: one device pixel at night instead of the fat day dot', () => {
    expect(farLightSize(3)).toBe(1); // pointSize = 3 device px at devicePixelRatio 1
    expect(farLightSize(6)).toBe(2); // one CSS pixel on a 2x screen
  });
});

describe('night glow by building density', () => {
  // flat lattice: the TIN is the tile square split into two triangles
  const grid = 4;
  const heights = new Float32Array((grid + 1) ** 2).fill(GROUND);
  const tin = buildTerrainTin(TILE, grid, heights);
  const locate = tinLocator(tin, TILE);
  const triArea = (i: number) => {
    const t = tin.tris[i], { vx, vy } = tin;
    const cell = tileSizeMeters(TILE) / grid;
    return (Math.abs((vx[t.b] - vx[t.a]) * (vy[t.c] - vy[t.a]) - (vx[t.c] - vx[t.a]) * (vy[t.b] - vy[t.a])) / 2) * cell * cell;
  };
  // off the tile diagonals (the TIN edges of a flat tile), well inside one triangle
  const b = tileBounds(TILE);
  const at = { lon: b.west + (b.east - b.west) * 0.75, lat: b.south + (b.north - b.south) * 0.625 };
  const box = (w: number, h: number): [number, number][] =>
    [[at.lon - w, at.lat - h], [at.lon + w, at.lat - h], [at.lon + w, at.lat + h], [at.lon - w, at.lat + h], [at.lon - w, at.lat - h]];
  const house: OsmBuilding = { rings: [box(0.0004, 0.0003)], tags: { building: 'apartments' } };
  const part: OsmBuilding = { rings: [box(0.0004, 0.0003)], tags: { 'building:part': 'yes' } };
  const under = locate(at.lon, at.lat)!.tri;

  it('coverage = footprint area / triangle area, for the triangle under the building only', () => {
    const cov = buildingCoverage(tin, TILE, [house, part], locate);
    const footprint = (2 * 0.0004 * 111320 * Math.cos((at.lat * Math.PI) / 180)) * (2 * 0.0003 * 111320);
    expect(cov[under] / (footprint / triArea(under))).toBeCloseTo(1, 2);
    for (let i = 0; i < cov.length; i++) if (i !== under) expect(cov[i]).toBe(0);
  });

  it('the level grows with the built-up share, dark below the threshold, brightest for a dense centre', () => {
    expect(glowLevel(0)).toBe(0);
    expect(glowLevel(GLOW_MIN_COVERAGE / 2)).toBe(0);
    expect(glowLevel(GLOW_MIN_COVERAGE)).toBe(1);
    expect(glowLevel(GLOW_FULL_COVERAGE)).toBe(GLOW_LEVELS);
    expect(glowLevel(0.9)).toBe(GLOW_LEVELS);
    let prev = 0;
    for (let c = 0.005; c <= 0.35; c += 0.01) {
      expect(glowLevel(c)).toBeGreaterThanOrEqual(prev);
      prev = glowLevel(c);
    }
  });

  it('street-lit LUT copies: brighter than the night sky and brighter with the level, unchanged by day', () => {
    const night = buildLUT(paletteAt(-20));
    const lum = (lut: Uint8Array, i: number) => entry(lut, i).reduce((a, b) => a + b, 0);
    const i = rampIndex(RAMP.CONCRETE, 8);
    const plain = lum(night, i);
    let prev = plain;
    for (let k = 1; k <= GLOW_LEVELS; k++) {
      const l = lum(night, k * LUT_SIZE + i);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
    expect(prev).toBeGreaterThan(plain);
    // the top level is a moderate street light: about a third of the day colour (warm tint takes some blue), not near-daylight
    const dayLut = buildLUT(paletteAt(45));
    const top = lum(night, GLOW_LEVELS * LUT_SIZE + rampIndex(RAMP.CONCRETE, 11));
    expect(top / lum(dayLut, rampIndex(RAMP.CONCRETE, 11))).toBeGreaterThan(0.3);
    expect(top / lum(dayLut, rampIndex(RAMP.CONCRETE, 11))).toBeLessThan(0.5);
    const day = buildLUT(paletteAt(45));
    expect(entry(day, GLOW_LEVELS * LUT_SIZE + i)).toEqual(entry(day, i));
    expect(WORLD_VS).toContain(`lvl * ${LUT_SIZE}u`);
    expect(TREE_VS).toContain('uint packed = (uint(aInstFlags) << 24u) | uint(aInstSR.y);');
    expect(TREE_VS).toContain('shadeColour(packed');
  });

  it('the lit ground copies the built-up terrain face, raised a little, its ramp carrying the level', () => {
    const levels = new Uint8Array(tin.tris.length);
    levels[under] = 5;
    const g = buildGlowGround(TILE, tin, levels);
    expect(g.ramps.length).toBe(3);
    const terrain = buildTerrainMesh({ tile: TILE, grid, heights });
    for (let k = 0; k < 3; k++) {
      const o = (under * 3 + k) * 6;
      expect(g.vertices[k * 6]).toBe(terrain.vertices[o]);
      expect(g.vertices[k * 6 + 2]).toBe(terrain.vertices[o + 2]);
      expect(g.vertices[k * 6 + 1]).toBeCloseTo(terrain.vertices[o + 1] + GLOW_GROUND_LIFT_M, 5);
      expect(rampGlowLevel(g.ramps[k])).toBe(5);
      expect(withGlow(g.ramps[k], 0)).toBe(terrain.ramps[under * 3 + k]);
    }
  });

  it('roads, buildings and trees on a lit triangle take its level; elsewhere they stay plain', () => {
    const levels = new Uint8Array(tin.tris.length);
    levels[under] = 3;
    const m = buildBuildingMesh({ tile: TILE, buildings: [house], sampleHeight: flat });
    const ramps = m.ramps.slice();
    applyGlow(m.vertices, ramps, TILE, locate, levels);
    for (let v = 0; v < ramps.length; v++) {
      expect(rampGlowLevel(ramps[v])).toBe(3);
      expect(withGlow(ramps[v], 0)).toBe(m.ramps[v]);
    }
    const dark = m.ramps.slice();
    applyGlow(m.vertices, dark, TILE, locate, new Uint8Array(tin.tris.length));
    expect(dark).toEqual(m.ramps);
    const [e, n] = latLonToEnu(tileCenter(TILE), at.lat, at.lon, 0);
    const trees = new Float32Array(TREE_STRIDE);
    trees.set([e, GROUND, -n, 10]);
    setTreeColour(trees, 0, RAMP.FOREST);
    applyGlowToTrees(trees, TILE, locate, levels);
    expect(treeColour(trees, 0)).toBe(withGlow(RAMP.FOREST, 3));
  });

  it('a face already glowing brighter (a lit street) keeps its own level', () => {
    const levels = new Uint8Array(tin.tris.length);
    levels[under] = 3;
    const m = buildBuildingMesh({ tile: TILE, buildings: [house], sampleHeight: flat });
    const bright = Uint32Array.from(m.ramps, (r) => withGlow(r, 6));
    applyGlow(m.vertices, bright, TILE, locate, levels);
    for (const r of bright) expect(rampGlowLevel(r)).toBe(6);
  });
});

describe('street lighting', () => {
  const b = tileBounds(TILE);
  const c = tileCenter(TILE);
  const flatGround = () => GROUND;
  const road = (tags: Record<string, string>) =>
    buildOsmMesh({
      tile: TILE, detail: 'full', sampleHeight: flatGround, maxEdgeMeters: 60,
      data: { areas: [], lines: [{ points: [[b.west + (b.east - b.west) * 0.2, c.lat], [b.west + (b.east - b.west) * 0.8, c.lat]], tags }], points: [], buildings: [] },
    });

  it('lit roads: residential, motorway/trunk/primary/secondary, and lit=yes', () => {
    for (const hw of ['residential', 'motorway', 'trunk', 'primary', 'secondary']) expect(isLitRoad({ highway: hw })).toBe(true);
    for (const hw of ['tertiary', 'service', 'track', 'unclassified', 'footway']) expect(isLitRoad({ highway: hw })).toBe(false);
    expect(isLitRoad({ highway: 'tertiary', lit: 'yes' })).toBe(true);
    expect(isLitRoad({ highway: 'service', lit: 'no' })).toBe(false);
    expect(isLitRoad({ railway: 'rail', lit: 'yes' })).toBe(false);
  });

  it('a lit road glows and has lamps (its far dotted line too); an unlit one only a little, no lamps', () => {
    const lit = road({ highway: 'residential' });
    const asphalt = lit.roads.ramps.filter((r) => withGlow(r, 0) === RAMP.ASPHALT);
    expect(asphalt.length).toBeGreaterThan(0);
    for (const r of asphalt) expect(rampGlowLevel(r)).toBe(LIT_ROAD_GLOW);
    expect(lit.lamps.length).toBeGreaterThan(0);

    const dark = road({ highway: 'tertiary' });
    for (const r of dark.roads.ramps) expect(rampGlowLevel(r)).toBeLessThanOrEqual(UNLIT_ROAD_GLOW);
    expect(dark.roads.ramps.some((r) => withGlow(r, 0) === RAMP.ASPHALT && rampGlowLevel(r) === UNLIT_ROAD_GLOW)).toBe(true);
    expect(dark.lamps.length).toBe(0);
    expect(dark.roads.vertexCount).toBeGreaterThan(0);
  });

  it('lamps every LAMP_SPACING_M, sides alternating, heads over the road at lamp height', () => {
    const m = road({ highway: 'primary' }); // 14 m wide, runs west to east
    const n = m.lamps.length / 4;
    const [ax] = latLonToEnu(c, c.lat, b.west + (b.east - b.west) * 0.2, 0);
    const [bx] = latLonToEnu(c, c.lat, b.west + (b.east - b.west) * 0.8, 0);
    expect(n).toBe(Math.floor((bx - ax - LAMP_SPACING_M / 2) / LAMP_SPACING_M) + 1);
    for (let i = 0; i < n; i++) {
      const [x, y, z, idx] = m.lamps.subarray(i * 4, i * 4 + 4);
      expect(idx).toBe(LIGHT.STREET);
      if (i > 0) expect(x - m.lamps[(i - 1) * 4]).toBeCloseTo(LAMP_SPACING_M, 1);
      expect(y).toBeGreaterThan(GROUND + LAMP_HEIGHT_M - 1);
      expect(y).toBeLessThan(GROUND + LAMP_HEIGHT_M);
      // pole 1 m beyond the 7 m half-width, arm 2 m back: the head 6 m from the axis
      expect(Math.abs(z)).toBeCloseTo(6, 0);
      if (i > 0) expect(Math.sign(z)).toBe(-Math.sign(m.lamps[(i - 1) * 4 + 2]));
    }
    // one post instance per head: foot on the ground beyond the road, its arm turned to reach the head
    expect(m.lampPosts.length / TREE_STRIDE).toBe(n);
    for (let i = 0; i < n; i++) {
      const [px, py, pz, scale, , type, , yaw] = m.lampPosts.subarray(i * TREE_STRIDE, (i + 1) * TREE_STRIDE);
      const [hx, , hz] = m.lamps.subarray(i * 4, i * 4 + 3);
      expect(type).toBe(INSTANCE.LAMP);
      expect(scale).toBe(1);
      expect(py).toBeCloseTo(GROUND, 3);
      expect(px + Math.cos(yaw) * LAMP_SHAPE.ARM).toBeCloseTo(hx, 3);
      expect(pz + Math.sin(yaw) * LAMP_SHAPE.ARM).toBeCloseTo(hz, 3);
    }
    // the posts are no longer in the road mesh: nothing there stands above the road surface
    for (let i = 0; i < m.roads.vertexCount; i++) expect(m.roads.vertices[i * 6 + 1]).toBeLessThan(GROUND + 3);
  });

  it('one-way roads: oneway=yes lamps only right of the drawing direction, oneway=-1 only left', () => {
    expect(lampSide({ highway: 'primary' })).toBe(0);
    expect(lampSide({ highway: 'primary', oneway: 'no' })).toBe(0);
    expect(lampSide({ highway: 'primary', oneway: 'yes' })).toBe(1);
    expect(lampSide({ highway: 'primary', oneway: '-1' })).toBe(-1);
    // the test road runs west to east; mesh z points south, so its right side is +z
    const zs = (m: ReturnType<typeof road>) => Array.from({ length: m.lamps.length / 4 }, (_, i) => m.lamps[i * 4 + 2]);
    const right = zs(road({ highway: 'primary', oneway: 'yes' }));
    const left = zs(road({ highway: 'primary', oneway: '-1' }));
    expect(right.length).toBe(zs(road({ highway: 'primary' })).length);
    for (const z of right) expect(z).toBeCloseTo(6, 0);
    for (const z of left) expect(z).toBeCloseTo(-6, 0);
  });
});
