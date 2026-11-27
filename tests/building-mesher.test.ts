import { describe, expect, it } from 'vitest';
import { colour, isMaterial, rgbOf, SNOW_FLAG, WOOD_FLAG } from '../src/engine/palette';
import { tileBounds, type Tile } from '../src/world/geodesy';
import {
  buildBuildingMesh,
  buildingHeights,
  buildingSeed,
  buildingTags,
  BOOTH_TAG,
  FACADE_ZONES,
  footprintHeight,
  GARAGES,
  garageDoors,
  CARPORT_M,
  SHED,
  withDefaultTags,
  GREENHOUSE,
  lineInside,
  PARAPET,
  CHIMNEY,
  ROOFTOP,
  computeHeights,
  parseColor,
  parseLength,
  PLINTH_MAX_M,
  pastelColour,
  roofRamp,
  wallRamp,
} from '../src/world/building-mesher';
import type { OsmBuilding } from '../src/world/osm-types';
import { AC_SIZE, INSTANCE, TREE_STRIDE } from '../src/world/props-mesher';
import { WINDOWS } from '../src/engine/palette';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function rect(w = 0.0004, h = 0.0003): [number, number][] {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
}

function build(buildings: OsmBuilding[], sample: (lon: number, lat: number) => number = () => 100) {
  return buildBuildingMesh({ tile: TILE, buildings, sampleHeight: sample });
}

/** the top of the outline (walls, parapet) at the footprint's east edge: rooftop structures stay off it */
function edgeTop(m: { vertices: Float32Array; vertexCount: number }): number {
  let maxX = -Infinity, top = -Infinity;
  for (let i = 0; i < m.vertexCount; i++) maxX = Math.max(maxX, m.vertices[i * 6]);
  for (let i = 0; i < m.vertexCount; i++) if (m.vertices[i * 6] > maxX - 0.01) top = Math.max(top, m.vertices[i * 6 + 1]);
  return top;
}

function ys(m: { vertices: Float32Array; vertexCount: number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.vertexCount; i++) out.push(m.vertices[i * 6 + 1]);
  return out;
}

describe('default height and roof', () => {
  it('height without height/levels is the mean bbox side, at least 2.5 m', () => {
    expect(footprintHeight([[0, 0], [10, 0], [10, 6], [0, 6]])).toBe(8);
    expect(footprintHeight([[0, 0], [2, 0], [2, 1], [0, 1]])).toBe(2.5);
    // bbox of a rotated square in the local axes, not its sides
    expect(footprintHeight([[5, 0], [10, 5], [5, 10], [0, 5]])).toBe(10);
  });

  it('building=residential without height/levels: footprint facade, roof on top', () => {
    const big: OsmBuilding = { rings: [rect()], tags: { building: 'residential' } }; // ~50 m mean side
    const t = buildingTags(big);
    const h = buildingHeights(big);
    expect(t.height).toBeUndefined();
    expect(t['roof:shape']).toBeUndefined(); // not low-rise
    expect(h.roof).toBe(0);
    expect(h.wall).toBeCloseTo(Number(t['sim:footprint_wall']), 6);
    const small: OsmBuilding = { rings: [rect(0.00005, 0.00004)], tags: { building: 'residential' } };
    const ts = buildingTags(small);
    const hs = buildingHeights(small);
    expect(ts['roof:shape']).toBe('hipped');
    expect(hs.roof).toBeGreaterThan(0);
    expect(hs.wall).toBeCloseTo(Number(ts['sim:footprint_wall']), 6);
    expect(hs.wall).toBeGreaterThanOrEqual(2.5);
  });

  it('other types without height/levels: 2 floors (plus the plinth and the technical floor), whatever the footprint', () => {
    // flat roofs: 1 m plinth + 2 × 3 m + 1.5 m technical floor; a barn has no facade zones
    for (const [building, wall] of [['yes', 8.5], ['house', 8.5], ['industrial', 8.5], ['barn', 6]] as const) {
      const b: OsmBuilding = { rings: [rect()], tags: { building } };
      expect(buildingTags(b)['sim:footprint_wall']).toBeUndefined();
      expect(buildingHeights(b).wall).toBe(wall);
    }
    // a garage is one storey (GARAGES), a shed low (SHED)
    expect(buildingHeights({ rings: [rect()], tags: { building: 'shed' } }).wall).toBeCloseTo(SHED.WALL_M);
    expect(buildingHeights({ rings: [rect()], tags: { building: 'garage' } }).wall).toBeCloseTo(GARAGES.WALL_M);
    // yes: 2 floors are low-rise → a hipped roof on top of the 1 m plinth and 6 m of floors
    const yes: OsmBuilding = { rings: [rect(0.00005, 0.00004)], tags: { building: 'yes' } };
    expect(buildingTags(yes)['roof:shape']).toBe('hipped');
    expect(buildingHeights(yes).wall).toBe(7);
    expect(buildingHeights(yes).roof).toBeGreaterThan(0);
  });

  it('a small yes/residential without height/levels is a one-storey outbuilding under a flat roof', () => {
    const shed = rect(0.00004, 0.00003); // ~ 40 m², over a booth (BOOTH_MAX_AREA_M2), under OUTBUILDING
    for (const building of ['yes', 'residential']) {
      const b: OsmBuilding = { rings: [shed], tags: { building } };
      expect(buildingTags(b)['roof:shape']).toBe('flat');
      expect(buildingTags(b)[BOOTH_TAG]).toBeUndefined();
      expect(buildingHeights(b)).toMatchObject({ min: 0, wall: 3, roof: 0 });
    }
    // OSM levels, height or roof shape win; other types and the ~ 80 m² house keep their defaults
    expect(buildingHeights({ rings: [shed], tags: { building: 'yes', 'building:levels': '2' } }).wall).toBeCloseTo(7, 6);
    expect(buildingTags({ rings: [shed], tags: { building: 'yes', 'roof:shape': 'gabled' } })['roof:shape']).toBe('gabled');
    // a house that small is still two floors over its plinth, under a pitched roof (HOUSE_ROOFS)
    expect(buildingHeights({ rings: [shed], tags: { building: 'house' } }).wall).toBeCloseTo(7, 6);
    expect(buildingTags({ rings: [shed], tags: { building: 'house' } })['roof:shape']).toBe('hipped');
    expect(buildingTags({ rings: [rect(0.00005, 0.00004)], tags: { building: 'yes' } })['roof:shape']).toBe('hipped');
  });

  it('default hipped only for low-rise yes/residential (and houses); OSM tags, other types and parts stay as they are', () => {
    const ring = rect(0.00005, 0.00004);
    const roof = (tags: Record<string, string>) => buildingTags({ rings: [ring], tags })['roof:shape'];
    expect(buildingTags({ rings: [ring], tags: { building: 'yes', 'building:levels': '2' } })).toEqual({ building: 'yes', 'building:levels': '2', 'roof:shape': 'hipped' });
    expect(roof({ building: 'residential', 'building:levels': '3' })).toBe('hipped');
    expect(roof({ building: 'yes', 'building:levels': '5' })).toBeUndefined();
    expect(roof({ building: 'yes', height: '20' })).toBeUndefined();
    expect(roof({ building: 'yes', height: '7', 'roof:shape': 'flat' })).toBe('flat');
    for (const building of ['apartments', 'industrial', 'school', 'garage']) {
      expect(roof({ building, 'building:levels': '2' })).toBeUndefined();
    }
    for (const building of ['house', 'detached']) expect(roof({ building, 'building:levels': '2' })).toBe('hipped');
    expect(roof({ 'building:part': 'yes', building: 'yes', height: '7' })).toBeUndefined();
    // a large footprint (~ 63 × 67 m) keeps the flat default; the small one above (~ 6 × 9 m) is hipped
    expect(buildingTags({ rings: [rect()], tags: { building: 'yes' } })['roof:shape']).toBeUndefined();
    expect(buildingTags({ rings: [rect()], tags: { building: 'residential', 'building:levels': '2' } })['roof:shape']).toBeUndefined();
    expect(buildingHeights({ rings: [rect()], tags: { building: 'yes' } }).roof).toBe(0);
  });
});

describe('parapet', () => {
  const upAt = (m: ReturnType<typeof build>, y: number) => {
    const out: number[] = [];
    for (let i = 0; i < m.vertexCount; i++) {
      if (Math.abs(m.vertices[i * 6 + 1] - y) < 1e-3 && m.vertices[i * 6 + 4] > 0.99) out.push(m.vertices[i * 6]);
    }
    return out;
  };

  it('a flat roof sits 50 cm under the wall top behind a parapet 20 cm wide; the top stays at height', () => {
    const m = build([{ rings: [rect()], tags: { building: 'industrial', height: '10' } }]);
    expect(edgeTop(m)).toBeCloseTo(110, 4);
    const maxX = Math.max(...Array.from({ length: m.vertexCount }, (_, i) => m.vertices[i * 6]));
    // parapet top: from the wall face to 20 cm inside; the roof surface ends 20 cm inside, 50 cm lower
    expect(Math.min(...upAt(m, 110).filter((x) => x > maxX - 1))).toBeCloseTo(maxX - PARAPET.WIDTH_M, 3);
    expect(Math.max(...upAt(m, 110 - PARAPET.HEIGHT_M))).toBeCloseTo(maxX - PARAPET.WIDTH_M, 3);
    expect(m.windows.length / 5).toBe(m.vertexCount);
  });

  it('one storey (a shed, a garage, an outbuilding) has its flat roof on the walls, no parapet; a one-level shop keeps it', () => {
    const small = rect(0.00006, 0.00005);
    const cases: Record<string, string>[] = [{ building: 'shed' }, { building: 'garages' }, { building: 'garage' }, { building: 'yes' }, { building: 'industrial', height: '3' }];
    for (const tags of cases) {
      const m = build([{ rings: [tags.building === 'yes' ? rect(0.00004, 0.00003) : small], tags }]);
      // the top of the whole mesh (a garage's doors stand out of its east wall: not edgeTop)
      const top = Math.max(...ys(m));
      // the roof is the top: nothing up there sits PARAPET.HEIGHT_M under it
      expect(upAt(m, top - PARAPET.HEIGHT_M)).toHaveLength(0);
      expect(upAt(m, top).length).toBeGreaterThan(0);
    }
    const shop = build([{ rings: [small], tags: { building: 'retail', 'building:levels': '1' } }]);
    expect(upAt(shop, Math.max(...ys(shop)) - PARAPET.HEIGHT_M).length).toBeGreaterThan(0);
  });

  it('a chimney is open: a 50 cm rim, a soot-black shaft, its floor sunk 80% of the wall', () => {
    // OSM way 53521351: a 250 m power station chimney mapped as building=industrial
    const m = build([{ rings: [rect()], tags: { building: 'industrial', man_made: 'chimney', height: '250' } }]);
    expect(edgeTop(m)).toBeCloseTo(350, 3);
    const maxX = Math.max(...Array.from({ length: m.vertexCount }, (_, i) => m.vertices[i * 6]));
    const floorY = 350 - CHIMNEY.DEPTH * 250;
    expect(Math.max(...upAt(m, floorY))).toBeCloseTo(maxX - CHIMNEY.WALL_M, 3);
    expect(Math.min(...upAt(m, 350).filter((x) => x > maxX - 2))).toBeCloseTo(maxX - CHIMNEY.WALL_M, 3);
    // the floor and the shaft's inner faces are soot, the rim keeps the wall's colour
    const soot = colour(...CHIMNEY.SOOT);
    let sootFaces = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const y = m.vertices[i * 6 + 1];
      if (Math.abs(y - floorY) < 1e-3 && m.vertices[i * 6 + 4] > 0.99) expect(m.ramps[i] & 0xffffff).toBe(soot);
      if (Math.abs(y - 350) < 1e-3 && m.vertices[i * 6 + 4] > 0.99) expect(m.ramps[i] & 0xffffff).not.toBe(soot);
      if (Math.abs(m.vertices[i * 6 + 4]) < 0.01 && y > floorY - 1e-3 && (m.ramps[i] & 0xffffff) === soot) sootFaces++;
    }
    expect(sootFaces).toBeGreaterThan(0);
    // nothing on the roof: no up-facing surface between the floor and the rim
    for (let i = 0; i < m.vertexCount; i++) {
      const y = m.vertices[i * 6 + 1];
      if (m.vertices[i * 6 + 4] > 0.99) expect(Math.abs(y - floorY) < 1e-3 || Math.abs(y - 350) < 1e-3).toBe(true);
    }
  });

  it('no parapet on a canopy, a pitched roof or a too low building', () => {
    expect(upAt(build([{ rings: [rect()], tags: { building: 'roof', height: '4' } }]), 103.5)).toHaveLength(0);
    expect(upAt(build([{ rings: [rect()], tags: { building: 'shed', height: '2' } }]), 101.5)).toHaveLength(0);
    expect(upAt(build([{ rings: [rect()], tags: { building: 'shed', height: '2' } }]), 102).length).toBeGreaterThan(0);
  });

  it('a courtyard gets a parapet on its edge too', () => {
    const hole = rect(0.0001, 0.0001).reverse();
    const m = build([{ rings: [rect(), hole], tags: { building: 'apartments', height: '10' } }]);
    const flat = build([{ rings: [rect()], tags: { building: 'apartments', height: '10' } }]);
    expect(m.vertexCount).toBeGreaterThan(flat.vertexCount);
    expect(edgeTop(m)).toBeCloseTo(110, 4);
  });
});

describe('rooftop structures and air conditioners', () => {
  const tops = (m: ReturnType<typeof build>, roofY: number) => {
    // distinct heights of up-facing faces above the roof surface, below the parapet top excluded
    const s = new Set<number>();
    for (let i = 0; i < m.vertexCount; i++) {
      const y = m.vertices[i * 6 + 1];
      if (m.vertices[i * 6 + 4] > 0.99 && y > roofY + 0.6) s.add(Math.round((y - roofY) * 10) / 10);
    }
    return s;
  };

  it('a large flat roof carries grey structures of the four kinds; a small one none', () => {
    const big = build([{ rings: [rect()], tags: { building: 'industrial', height: '10' } }]);
    const heights = tops(big, 109.5);
    expect(heights.size).toBeGreaterThan(0);
    for (const h of heights) expect(ROOFTOP.UNITS.map((u) => u[2])).toContain(h);
    for (const [, , , [r, g, b]] of ROOFTOP.UNITS) expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(6);
    const small = build([{ rings: [rect(0.0001, 0.00008)], tags: { building: 'industrial', height: '10' } }]); // ~ 13 × 18 m
    expect(tops(small, 109.5).size).toBe(0);
    // deterministic
    expect(build([{ rings: [rect()], tags: { building: 'industrial', height: '10' } }]).vertices).toEqual(big.vertices);
  });

  it('structures stand inside the parapet', () => {
    const m = build([{ rings: [rect()], tags: { building: 'industrial', height: '10' } }]);
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < m.vertexCount; i++) { minX = Math.min(minX, m.vertices[i * 6]); maxX = Math.max(maxX, m.vertices[i * 6]); }
    for (let i = 0; i < m.vertexCount; i++) {
      if (m.vertices[i * 6 + 1] > 110.01) {
        expect(m.vertices[i * 6]).toBeGreaterThan(minX + PARAPET.WIDTH_M + ROOFTOP.MARGIN_M - 0.01);
        expect(m.vertices[i * 6]).toBeLessThan(maxX - PARAPET.WIDTH_M - ROOFTOP.MARGIN_M + 0.01);
      }
    }
  });

  it('air conditioners: instances on the walls of homes, turned to face out; none on industry', () => {
    const tall = { building: 'apartments', 'building:levels': '9' };
    const m = build([{ rings: [rect()], tags: tall }]);
    const n = m.acs.length / TREE_STRIDE;
    expect(n).toBeGreaterThan(0);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < m.vertexCount; i++) {
      minX = Math.min(minX, m.vertices[i * 6]); maxX = Math.max(maxX, m.vertices[i * 6]);
      minZ = Math.min(minZ, m.vertices[i * 6 + 2]); maxZ = Math.max(maxZ, m.vertices[i * 6 + 2]);
    }
    for (let i = 0; i < n; i++) {
      const [x, y, z, scale, , type, , yaw] = m.acs.subarray(i * TREE_STRIDE, (i + 1) * TREE_STRIDE);
      expect(type).toBe(INSTANCE.AC);
      expect(scale).toBe(1);
      // under a pane of the window grid (1 m plinth, 9 floors of 3 m), never on the ground floor
      const fh = 3, inFloor = (y - 101) - Math.floor((y - 101) / fh) * fh;
      expect(y).toBeGreaterThanOrEqual(101 + fh);
      expect(inFloor + AC_SIZE.HEIGHT).toBeLessThanOrEqual(0.55 * fh - Math.min(0.75, 0.27 * fh) + 1e-3);
      expect(y + AC_SIZE.HEIGHT).toBeLessThan(128);
      // on the outline, facing away from the building
      const onEast = Math.abs(x - maxX) < 0.01, onWest = Math.abs(x - minX) < 0.01;
      const onSouth = Math.abs(z - maxZ) < 0.01, onNorth = Math.abs(z - minZ) < 0.01;
      expect(onEast || onWest || onSouth || onNorth).toBe(true);
      const [dx, dz] = [Math.cos(yaw), Math.sin(yaw)];
      if (onEast) expect(dx).toBeCloseTo(1, 3);
      if (onWest) expect(dx).toBeCloseTo(-1, 3);
      if (onSouth) expect(dz).toBeCloseTo(1, 3);
      if (onNorth) expect(dz).toBeCloseTo(-1, 3);
      // at a slot centre along its edge
      const [lo, hi, at] = onEast || onWest ? [minZ, maxZ, z] : [minX, maxX, x];
      const len = hi - lo, slots = Math.max(1, Math.floor(len / WINDOWS.SPACING_M));
      const k = ((at - lo) / len) * slots - 0.5;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-3);
    }
    expect(build([{ rings: [rect()], tags: tall }]).acs).toEqual(m.acs);
    expect(build([{ rings: [rect()], tags: { building: 'industrial', 'building:levels': '9' } }]).acs.length).toBe(0);
  });
});

describe('facade zones', () => {
  const facade = (m: ReturnType<typeof build>) =>
    Array.from({ length: m.vertexCount }, (_, i) => ({ y: m.vertices[i * 6 + 1], a: Array.from(m.windows.subarray(i * 5, i * 5 + 5)) }))
      .filter((p) => p.a[3] > 0);

  it('windows run from the top of a 1 m plinth to under a 1.5 m technical floor on a flat roof', () => {
    const m = build([{ rings: [rect()], tags: { building: 'apartments', 'building:levels': '5' } }]);
    const f = facade(m);
    expect(f.length).toBeGreaterThan(0);
    for (const { y, a: [, v, , winH] } of f) {
      expect(winH).toBeCloseTo(15, 4);
      // v counts from the plinth top (ground 100 + 1 m)
      expect(y - v).toBeCloseTo(100 + FACADE_ZONES.PLINTH_M, 3);
    }
    // the wall reaches past the windows by the technical floor
    expect(edgeTop(m)).toBeCloseTo(100 + FACADE_ZONES.PLINTH_M + 15 + FACADE_ZONES.TECH_FLOOR_M, 3);
  });

  it('a pitched roof: no technical floor; a booth: no windows and no zones at all', () => {
    const m = build([{ rings: [rect(0.0001, 0.00008)], tags: { building: 'house', 'building:levels': '2', 'roof:shape': 'gabled' } }]);
    for (const { a: [, , , winH] } of facade(m)) expect(winH).toBeCloseTo(6, 4);
    const booth = { rings: [rect(0.00002, 0.00002)], tags: { building: 'yes' } }; // ~ 2.5 × 4.5 m
    expect(buildingTags(booth)[BOOTH_TAG]).toBe('yes');
    expect(facade(build([booth]))).toHaveLength(0);
    expect(buildingHeights(booth).wall).toBe(3); // a booth of building=yes is an outbuilding (OUTBUILDING)
  });
});

describe('the foot of a roof', () => {
  it('faces without windows carry their height over the ground the building stands on', () => {
    const m = build([{ rings: [rect()], tags: { building: 'apartments', 'building:levels': '5' } }]);
    let roofs = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const a = m.windows.subarray(i * 5, i * 5 + 5);
      if (a[2] !== 0 || a[3] !== 0 || a[4] !== 0 || a[0] !== 0) continue;
      // ground 100: the shader takes the climate at y - v
      expect(m.vertices[i * 6 + 1] - a[1]).toBeCloseTo(100, 3);
      if (m.vertices[i * 6 + 4] > 0.99 && m.vertices[i * 6 + 1] > 110) roofs++;
    }
    expect(roofs).toBeGreaterThan(0);
  });
});

describe('parseLength', () => {
  it('parses meters, feet and feet-inches', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12 m')).toBe(12);
    expect(parseLength('3,7')).toBeCloseTo(3.7, 6);
    expect(parseLength('3,7 m')).toBeCloseTo(3.7, 6);
    expect(parseLength('40 ft')).toBeCloseTo(12.192, 3);
    expect(parseLength("40'")).toBeCloseTo(12.192, 3);
    expect(parseLength('12\'6"')).toBeCloseTo(12 * 0.3048 + 6 * 0.0254, 4);
    expect(parseLength('garbage')).toBeUndefined();
    expect(parseLength(undefined)).toBeUndefined();
  });
});

describe('computeHeights', () => {
  it('prefers height, then levels, then 2 floors; counted levels get the plinth and the technical floor', () => {
    expect(computeHeights({ height: '20', building: 'house' })).toEqual({ min: 0, wall: 20, roof: 0 });
    expect(computeHeights({ 'building:levels': '4', building: 'house' }).wall).toBe(14.5);
    expect(computeHeights({ building: 'house' }).wall).toBe(8.5);
    expect(computeHeights({ building: 'garage' }).wall).toBe(6);
    expect(computeHeights({ building: 'apartments' }).wall).toBe(8.5);
    expect(computeHeights({ building: 'apartments', 'roof:shape': 'gabled', 'roof:height': '3' }).wall).toBe(7);
    expect(computeHeights({ building: 'apartments', 'sim:booth': 'yes' }).wall).toBe(6);
    expect(computeHeights({}).wall).toBe(8.5);
  });

  it('splits roof height off pitched roofs and honors min_height', () => {
    const h = computeHeights({ height: '15', 'roof:shape': 'gabled', 'roof:height': '4', min_height: '3' });
    expect(h.min).toBe(3);
    expect(h.roof).toBe(4);
    expect(h.wall).toBe(8);
    expect(computeHeights({ 'building:levels': '3', 'roof:levels': '1', 'roof:shape': 'flat' }).wall).toBe(14.5);
  });

  it('stacks building:part levels without overlaps: each part lifted by the plinth, no technical floor', () => {
    // OSM relation 7036075: a ground floor, a body from level 1 to 7, a crown from level 7 to 8
    const ground = computeHeights({ 'building:part': 'yes', 'building:levels': '1' });
    const body = computeHeights({ 'building:part': 'yes', building: 'apartments', 'building:min_level': '1', 'building:levels': '7' });
    const crown = computeHeights({ 'building:part': 'yes', 'building:min_level': '7', 'building:levels': '8' });
    expect(ground.min).toBe(0);
    expect(ground.min + ground.wall).toBe(3 + FACADE_ZONES.PLINTH_M);
    expect(body.min).toBe(ground.min + ground.wall);
    expect(body.min + body.wall).toBe(21 + FACADE_ZONES.PLINTH_M);
    expect(crown.min).toBe(body.min + body.wall);
    expect(crown.min + crown.wall).toBe(24 + FACADE_ZONES.PLINTH_M);
  });
});

describe('colors', () => {
  const isRgb = (ramp: number) => !isMaterial(ramp);

  it('parses hex, rgb() and the full CSS name list', () => {
    expect(parseColor('#ff0000')).toEqual([255, 0, 0]);
    expect(parseColor('#f00')).toEqual([255, 0, 0]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
    expect(parseColor('Light Gray')).toEqual([211, 211, 211]);
    expect(parseColor('red;white')).toEqual([255, 0, 0]);
    expect(parseColor('salmon')).toEqual([250, 128, 114]);
    expect(parseColor('nonsense')).toBeUndefined();
  });

  const rgb = (ramp: number) => rgbOf(ramp);
  const sat = (ramp: number) => {
    const c = rgb(ramp), mx = Math.max(...c), mn = Math.min(...c);
    return mx ? (mx - mn) / mx : 0;
  };

  it('takes OSM wall colours, materials and type defaults as exact RGB colours', () => {
    expect(wallRamp({ 'building:colour': '#646464' })).toBe(colour(100, 100, 100));
    expect(wallRamp({ 'building:colour': '#ffffff', 'building:material': 'brick' })).toBe(colour(255, 255, 255));
    expect(wallRamp({ building: 'yes', 'building:material': 'brick' })).toBe(colour(156, 88, 64));
    expect(wallRamp({ 'building:colour': '#7a5c3d' })).toBe(colour(0x7a, 0x5c, 0x3d)); // no palette snap
    expect(isRgb(wallRamp({ building: 'garage' }))).toBe(true);
    expect(isRgb(wallRamp({}))).toBe(true);
  });

  it('takes roof colour, then roof material, from OSM', () => {
    const gabled = { 'roof:shape': 'gabled' };
    expect(roofRamp({ ...gabled, 'roof:colour': '#a06858' })).toBe(colour(0xa0, 0x68, 0x58));
    expect(roofRamp({ ...gabled, 'roof:material': 'slate' })).toBe(colour(72, 76, 84));
    expect(roofRamp({ ...gabled, 'roof:colour': 'red', 'roof:material': 'slate' })).toBe(roofRamp({ ...gabled, 'roof:colour': 'red' }));
  });

  it('mutes a CSS colour name but keeps its hue; an exact hex value stays as tagged', () => {
    const hue = (ramp: number) => {
      const [r, g, b] = rgb(ramp);
      return r > g && r > b ? 'r' : g > r && g > b ? 'g' : b > r && b > g ? 'b' : r === g && g > b ? 'y' : '?';
    };
    for (const [name, h] of [['red', 'r'], ['green', 'g'], ['lime', 'g'], ['blue', 'b'], ['yellow', 'y'], ['maroon', 'r']] as const) {
      for (const ramp of [roofRamp({ 'roof:colour': name }), wallRamp({ 'building:colour': name })]) {
        expect(sat(ramp)).toBeLessThanOrEqual(0.45);
        expect(hue(ramp)).toBe(h);
      }
    }
    // no pure white or black from a name
    expect(rgb(wallRamp({ 'building:colour': 'white' }))[0]).toBeLessThan(255);
    expect(rgb(wallRamp({ 'building:colour': 'black' }))[0]).toBeGreaterThan(0);
    expect(rgb(wallRamp({ 'building:colour': 'white' }))[0]).toBeGreaterThan(rgb(wallRamp({ 'building:colour': 'black' }))[0]);
    // a loud bright hex becomes a light pastel of its hue; a loud dark one only loses saturation
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffff00']) {
      const r = rgb(wallRamp({ 'building:colour': hex }));
      expect(sat(wallRamp({ 'building:colour': hex }))).toBeLessThanOrEqual(0.31);
      expect(Math.max(...r)).toBeGreaterThanOrEqual(224);
    }
    expect(hue(wallRamp({ 'building:colour': '#00ff00' }))).toBe('g');
    expect(pastelColour([128, 0, 0])[0]).toBe(128);
    expect(sat(colour(...pastelColour([128, 0, 0])))).toBeLessThanOrEqual(0.5);
    expect(pastelColour([0x7a, 0x5c, 0x3d])).toEqual([0x7a, 0x5c, 0x3d]);
  });

  it('untagged walls: a palette per building type, picked by seed', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => (i + 0.5) / 200);
    const colours = (tags: Record<string, string>) => new Set(seeds.map((x) => wallRamp(tags, x)));
    const warm = ([r, , b]: readonly number[]) => r - b > 25;
    const brick = ([r, g, b]: readonly number[]) => r - b > 50 && r < 170 && g < 110;
    for (const type of ['house', 'apartments', 'industrial', 'warehouse', 'retail', 'office', 'school', 'kindergarten', 'yes', 'church']) {
      const set = colours({ building: type });
      expect(set.size).toBeGreaterThan(2);
      for (const c of set) expect(sat(c)).toBeLessThanOrEqual(0.5);
      expect(wallRamp({ building: type }, 0.3)).toBe(wallRamp({ building: type }, 0.3));
    }
    for (const c of colours({ building: 'industrial' })) expect(warm(rgb(c))).toBe(false);
    for (const c of colours({ building: 'commercial' })) expect(brick(rgb(c))).toBe(false);
    for (const c of colours({ building: 'school' })) { const [r, , b] = rgb(c); expect(b).toBeGreaterThanOrEqual(r); }
    const house = [...colours({ building: 'house' })].map(rgb);
    expect(house.filter(warm).length).toBeGreaterThan(house.length / 2);
    expect(house.some(brick)).toBe(true);
    // OSM material still wins over the palette
    expect(wallRamp({ building: 'school', 'building:material': 'brick' }, 0.1)).toBe(colour(156, 88, 64));
  });

  const isGrey = (ramp: number) => {
    const [r, g, b] = rgbOf(ramp);
    return r === g && g === b;
  };

  it('lets OSM colour a flat roof; only an untagged flat roof is forced grey', () => {
    expect(isGrey(roofRamp({ 'roof:colour': '#ff0000' }))).toBe(false);
    expect(isGrey(roofRamp({ 'roof:shape': 'flat', 'roof:colour': 'green' }))).toBe(false);
    expect(roofRamp({ 'roof:shape': 'flat', 'roof:material': 'copper' })).toBe(colour(96, 160, 140));
  });

  it('in a warm climate an untagged roof is terracotta or pale concrete, never dark; OSM still wins', () => {
    const low = { building: 'house', height: '6', 'roof:shape': 'gabled' };
    const flat = { building: 'apartments', height: '15' };
    const lum = (ramp: number) => { const [r, g, b] = rgbOf(ramp); return 0.299 * r + 0.587 * g + 0.114 * b; };
    const terracotta = (ramp: number) => { const [r, g, b] = rgbOf(ramp); return r > g + 40 && g > b; };
    let orange = 0;
    for (let i = 0; i < 200; i++) {
      const seed = i / 200;
      const fethiye = roofRamp(low, seed, 36.6);
      if (terracotta(fethiye)) orange++;
      else expect(lum(fethiye)).toBeGreaterThan(150);
      expect(terracotta(roofRamp(flat, seed, 36.6))).toBe(false);
      expect(lum(roofRamp(flat, seed, 36.6))).toBeGreaterThan(150);
      // a cool climate keeps the old mix, as does no latitude at all
      expect(roofRamp(low, seed, 55.7)).toBe(roofRamp(low, seed));
    }
    expect(orange / 200).toBeGreaterThan(0.5);
    expect(roofRamp({ ...low, 'roof:colour': '#404040' }, 0.1, 36.6)).toBe(colour(0x40, 0x40, 0x40));
  });

  it('picks an untagged roof deterministically: grey/dark grey, orange only on low-rise pitched roofs', () => {
    const tall = { building: 'apartments', height: '40', 'roof:shape': 'gabled' };
    const low = { building: 'house', height: '6', 'roof:shape': 'gabled' };
    const lowFlat = { building: 'house', height: '6' };
    const tallSet = new Set<number>(), lowSet = new Set<number>(), flatSet = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const seed = i / 200;
      expect(roofRamp(low, seed)).toBe(roofRamp(low, seed));
      tallSet.add(roofRamp(tall, seed));
      lowSet.add(roofRamp(low, seed));
      flatSet.add(roofRamp(lowFlat, seed));
    }
    const orange = (ramp: number) => {
      const [r, g, b] = rgbOf(ramp);
      return r > g + 40 && g > b;
    };
    for (const r of tallSet) expect(isGrey(r)).toBe(true);
    for (const r of flatSet) expect(isGrey(r)).toBe(true);
    expect(flatSet.size).toBeGreaterThan(1);
    expect([...lowSet].some(orange)).toBe(true);
    expect([...lowSet].some((r) => !orange(r))).toBe(true);
  });

  it('seeds from the footprint, not from the tile build', () => {
    expect(buildingSeed(rect())).toBe(buildingSeed(rect()));
    expect(buildingSeed(undefined)).toBe(0.5);
  });
});

describe('buildBuildingMesh', () => {
  it('emits valid interleaved geometry with no NaN', () => {
    const m = build([{ rings: [rect()], tags: { building: 'house', height: '9' } }]);
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(m.vertices.length).toBe(m.vertexCount * 6);
    for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i])).toBe(true);
  });

  it('stands PLINTH_MAX_M over the lowest ground where the ground under it rises more, its plinth down into the ground', () => {
    const b = tileBounds(TILE);
    const westLon = (b.west + b.east) / 2 - 0.0004;
    const sample = (lon: number) => 100 + (lon - westLon) * 10000; // 8 m across
    const m = build([{ rings: [rect()], tags: { building: 'house', height: '10' } }], sample);
    const minY = Math.min(...ys(m));
    expect(minY).toBeCloseTo(100 - 0.5, 2);
    expect(edgeTop(m)).toBeCloseTo(100 + PLINTH_MAX_M + 10, 2);
  });

  it('raises elevated parts and adds a ceiling (arch)', () => {
    const m = build([{ rings: [rect()], tags: { 'building:part': 'yes', min_height: '4', height: '10' } }]);
    const minY = Math.min(...ys(m));
    expect(minY).toBeCloseTo(104, 3);
    let downFaces = 0;
    for (let i = 0; i < m.vertexCount; i++) if (m.vertices[i * 6 + 4] < -0.9) downFaces++;
    expect(downFaces).toBeGreaterThanOrEqual(3);
  });

  it('building=roof renders a canopy without ground-level walls', () => {
    const m = build([{ rings: [rect()], tags: { building: 'roof', min_height: '4', height: '5' } }]);
    const minY = Math.min(...ys(m));
    expect(minY).toBeGreaterThanOrEqual(103.9);
  });

  it.each(['flat', 'gabled', 'hipped', 'pyramidal', 'dome', 'skillion', 'half-hipped'])('roof %s rises above the walls', (shape) => {
    // a small footprint: no rooftop structures on the flat one
    const m = build([{ rings: [rect(0.0001, 0.00008)], tags: { building: 'house', height: '12', 'roof:shape': shape, 'roof:height': '3' } }]);
    const maxY = Math.max(...ys(m));
    expect(maxY).toBeGreaterThanOrEqual(110.5);
    expect(maxY).toBeLessThanOrEqual(112.01);
    expect(m.vertexCount).toBeGreaterThan(0);
  });

  it('winter: snow can lie on a flat roof only (not on walls or a pitched roof)', () => {
    const flagged = (m: { vertices: Float32Array; ramps: Uint32Array; vertexCount: number }, up: boolean) => {
      const out: boolean[] = [];
      for (let i = 0; i < m.vertexCount; i++) {
        const ny = m.vertices[i * 6 + 4];
        if (up ? ny > 0.99 : Math.abs(ny) < 0.01) out.push((m.ramps[i] & SNOW_FLAG) !== 0);
      }
      return out;
    };
    const flat = build([{ rings: [rect()], tags: { building: 'apartments', height: '15' } }]);
    expect(flagged(flat, true).length).toBeGreaterThan(0);
    expect(flagged(flat, true).every(Boolean)).toBe(true);
    expect(flagged(flat, false).some(Boolean)).toBe(false);
    const gabled = build([{ rings: [rect()], tags: { building: 'house', height: '12', 'roof:shape': 'gabled', 'roof:height': '3' } }]);
    for (let i = 0; i < gabled.vertexCount; i++) expect(gabled.ramps[i] & SNOW_FLAG).toBe(0);
  });

  it('handles multipolygon footprints with a hole', () => {
    const outer = rect();
    const b = tileBounds(TILE);
    const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    const d = 0.0001;
    const hole: [number, number][] = [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]];
    const m = build([{ rings: [outer, hole], tags: { building: 'yes', height: '8' } }]);
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i])).toBe(true);
  });
});
describe('a house on a slope stands on a plinth', () => {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2;
  const mPerLon = 111320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);
  /** ground rising east at `grade`, 100 m at the footprint's centre */
  const slope = (grade: number) => (lon: number) => 100 + grade * (lon - cx) * mPerLon;
  const house: OsmBuilding = { rings: [rect(0.0001, 0.0001)], tags: { building: 'yes', 'building:levels': '2', 'roof:shape': 'flat' } };
  const h = buildingHeights(house);
  const halfW = 0.0001 * mPerLon;
  const EARTH = colour(90, 80, 60);
  const meshOn = (grade: number) => buildBuildingMesh({ tile: TILE, buildings: [house], sampleHeight: slope(grade), groundColour: () => EARTH });
  const top = (m: { vertices: Float32Array; vertexCount: number }) => { let y = -Infinity; for (let i = 0; i < m.vertexCount; i++) y = Math.max(y, m.vertices[i * 6 + 1]); return y; };

  it('stands at the highest ground under it: nothing of it is buried', () => {
    const grade = 0.2; // 3 m across a 15 m house
    expect(top(meshOn(grade))).toBeCloseTo(100 + grade * halfW + h.min + h.wall + h.roof, 1);
  });
  it('is never lifted more than PLINTH_MAX_M over the lowest ground', () => {
    const grade = 1; // 15 m across
    expect(top(meshOn(grade))).toBeCloseTo(100 - halfW + PLINTH_MAX_M + h.min + h.wall + h.roof, 1);
  });
  it('closes the gap under it with a plinth of the ground’s colour, down into the ground', () => {
    const m = meshOn(0.2);
    let lo = Infinity, hi = -Infinity, n = 0;
    for (let i = 0; i < m.vertexCount; i++) if (m.ramps[i] === EARTH) { n++; lo = Math.min(lo, m.vertices[i * 6 + 1]); hi = Math.max(hi, m.vertices[i * 6 + 1]); }
    expect(n).toBeGreaterThan(0);
    expect(lo).toBeLessThan(100 - 0.2 * halfW);
    expect(hi).toBeCloseTo(100 + 0.2 * halfW, 1);
  });
  it('has no plinth on flat ground', () => {
    const m = meshOn(0);
    for (let i = 0; i < m.vertexCount; i++) expect(m.ramps[i]).not.toBe(EARTH);
  });
});

describe('greenhouses (building=greenhouse)', () => {
  // ~70 × 45 m: a multi-span greenhouse of Fethiye
  const gh = (extra: Record<string, string> = {}): OsmBuilding => ({ rings: [rect(0.0004, 0.0002)], tags: { building: 'greenhouse', ...extra } });

  it('untagged: a low shed with a shallow gabled roof, whatever the footprint', () => {
    expect(buildingTags(gh())['roof:shape']).toBe('gabled');
    const h = buildingHeights(gh());
    expect(h.min).toBe(0);
    expect(h.wall + h.roof).toBeCloseTo(GREENHOUSE.HEIGHT_M, 5);
    expect(h.roof).toBeCloseTo(GREENHOUSE.ROOF_M, 5);
  });

  it('OSM tags win over the defaults', () => {
    const tagged = buildingTags(gh({ height: '6', 'roof:shape': 'round' }));
    expect(tagged['roof:shape']).toBe('round');
    const h = buildingHeights(gh({ height: '6', 'roof:shape': 'round' }));
    expect(h.wall + h.roof).toBeCloseTo(6, 5);
    expect(buildingTags(gh({ 'building:levels': '2' })).height).toBeUndefined();
    expect(buildingTags(gh({ 'roof:height': '3' }))['roof:height']).toBe('3');
  });

  it('glass-tinted walls and roof unless OSM gives a colour or material', () => {
    const near = (c: number, rgb: readonly number[]) => rgbOf(c).every((v, i) => Math.abs(v - rgb[i]) <= 1);
    for (const s of [0.05, 0.4, 0.9]) {
      expect(near(wallRamp(buildingTags(gh()), s), GREENHOUSE.GLASS)).toBe(true);
      expect(near(roofRamp(buildingTags(gh()), s), GREENHOUSE.GLASS)).toBe(true);
    }
    expect(roofRamp(buildingTags(gh({ 'roof:colour': '#a06858' })))).toBe(colour(0xa0, 0x68, 0x58));
    expect(wallRamp(buildingTags(gh({ 'building:material': 'glass' })))).toBe(colour(150, 190, 210));
  });

  it('walls and roof go to the glass mesh, the opaque mesh keeps only the frame', () => {
    const m = build([gh()]);
    const frame = colour(...GREENHOUSE.FRAME);
    const glassRamp = colour(...GREENHOUSE.GLASS);
    expect(m.glass.vertexCount).toBeGreaterThan(0);
    expect(m.glass.vertices.length).toBe(m.glass.vertexCount * 6);
    for (const r of m.glass.ramps) expect(rgbOf(r)).toEqual(rgbOf(glassRamp));
    expect(m.vertexCount).toBeGreaterThan(0);
    // the frame is a small part (the far LOD draws the glass alone); nothing of it is glass-coloured
    expect(m.coreVertexCount).toBe(0);
    for (const r of m.ramps) expect(rgbOf(r)).toEqual(rgbOf(frame));
    expect(m.windows.length).toBe(m.vertexCount * 5);
  });

  it('the frame stays on the glass: up to the ridge, from the ground', () => {
    const m = build([gh()]);
    const top = Math.max(...ys({ vertices: m.glass.vertices, vertexCount: m.glass.vertexCount }));
    const frameYs = ys(m);
    expect(Math.min(...frameYs)).toBeCloseTo(100, 5);
    expect(Math.max(...frameYs)).toBeGreaterThan(top);
    expect(Math.max(...frameYs)).toBeLessThanOrEqual(top + GREENHOUSE.LIFT_M + 1e-3);
  });

  it('a bar every BAY_M or closer: the frame grows with the greenhouse', () => {
    const small = build([{ rings: [rect(0.0001, 0.00005)], tags: { building: 'greenhouse' } }]).vertexCount;
    const big = build([gh()]).vertexCount;
    // a footprint 4× as long each way: posts grow with the perimeter, rafters and purlins with the area
    expect(big).toBeGreaterThan(small * 2.5);
    // no more than a few bars per bay: posts, beams, rafters and purlins, 6 vertices a bar
    const perimeter = 2 * (70 + 45), area = 70 * 45;
    expect(big).toBeLessThan(6 * 2 * (perimeter / GREENHOUSE.BAY_M + area / (GREENHOUSE.BAY_M * 20) + 40));
  });

  it('other buildings have no glass', () => {
    expect(build([{ rings: [rect()], tags: { building: 'yes' } }]).glass.vertexCount).toBe(0);
  });
});

describe('lineInside', () => {
  it('gives the stretches of a line inside a ring', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(lineInside([-5, 5], [1, 0], sq)).toEqual([[5, 15]]);
    expect(lineInside([5, -5], [0, 1], sq)).toEqual([[5, 15]]);
    expect(lineInside([-5, 20], [1, 0], sq)).toEqual([]);
    // a U: the line through both arms comes out twice
    const u: [number, number][] = [[0, 0], [9, 0], [9, 9], [6, 9], [6, 3], [3, 3], [3, 9], [0, 9]];
    expect(lineInside([-1, 6], [1, 0], u)).toEqual([[1, 4], [7, 10]]);
  });
});

describe('garages', () => {
  // 30 × 6 m, z south; edges: 0 north, 1 east, 2 south, 3 west ((dz, -dx) outward)
  const row: [number, number][] = [[0, 0], [30, 0], [30, 6], [0, 6]];
  const line = (z: number): [number, number][] => [[-20, z], [50, z]];

  it('one storey without height or levels; told levels stand', () => {
    const t = withDefaultTags({ building: 'garages' }, row);
    expect(computeHeights(t).wall).toBeCloseTo(GARAGES.WALL_M);
    expect(computeHeights(withDefaultTags({ building: 'garage' }, row)).wall).toBeCloseTo(GARAGES.WALL_M);
    expect(computeHeights(withDefaultTags({ building: 'garages', 'building:levels': '2' }, row)).wall).toBeCloseTo(6);
  });

  it('a row of doors, one per box, on the long wall facing the road', () => {
    const north = garageDoors(row, [line(-8)], true)!;
    expect(north.edge).toBe(0);
    expect(north.us).toHaveLength(Math.floor(30 / GARAGES.BOX_M));
    expect(north.width).toBe(GARAGES.DOOR_W);
    expect(garageDoors(row, [line(14)], true)!.edge).toBe(2);
    // the nearer of two roads
    expect(garageDoors(row, [line(-30), line(9)], true)!.edge).toBe(2);
  });

  it('a row keeps to its long walls; a single garage may face the road with its end', () => {
    const east: [number, number][] = [[40, -20], [40, 30]];
    expect(garageDoors(row, [east], true)!.edge).toBe(0); // no long wall faces it: the longest
    const single: [number, number][] = [[0, 0], [6, 0], [6, 4], [0, 4]];
    const at = garageDoors(single, [[[20, -20], [20, 30]]], false)!;
    expect(at.edge).toBe(1);
    expect(at.us).toHaveLength(1);
  });

  it('a road behind the building or too far does not count', () => {
    expect(garageDoors(row, [line(-8 - GARAGES.ROAD_REACH_M)], true)!.edge).toBe(0); // the longest, first
    expect(garageDoors(row, [line(3)], true)!.edge).toBe(0); // through the building: not in front of either wall
  });

  it('the mesh puts the doors on the wall facing the road; mapped entrances replace them', () => {
    const b = tileBounds(TILE);
    const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    const garages: OsmBuilding = { rings: [rect(0.0002, 0.00004)], tags: { building: 'garages' } };
    const road = (lat: number): [number, number][] => [[cx - 0.001, lat], [cx + 0.001, lat]];
    /** vertices of the small parts facing north (-z) and south (+z) */
    const facing = (roads: [number, number][][], points = []) => {
      const m = buildBuildingMesh({ tile: TILE, buildings: [garages], sampleHeight: () => 100, roads, points });
      let n = 0, s = 0;
      for (let i = m.coreVertexCount; i < m.vertexCount; i++) {
        const nz = m.vertices[i * 6 + 5];
        if (nz < -0.9) n++;
        else if (nz > 0.9) s++;
      }
      return { n, s };
    };
    const north = facing([road(cy + 0.0002)]);
    const south = facing([road(cy - 0.0002)]);
    expect(north.n - south.n).toBeGreaterThan(0);
    expect(south.s - north.s).toBe(north.n - south.n);
    const mapped = facing([road(cy + 0.0002)], [{ at: [cx, cy + 0.00004], tags: { entrance: 'garage' } }] as never);
    expect(mapped.n).toBeLessThan(north.n);
  });
});

describe('houses, sheds and carports', () => {
  const tagsOf = (building: string, extra: Record<string, string> = {}, w = 0.00008, h = 0.00006) =>
    buildingTags({ rings: [rect(w, h)], tags: { building, ...extra } });

  it('a house of any size gets a pitched roof when low-rise (a terrace gabled), not the outbuilding rule', () => {
    for (const b of ['house', 'detached', 'semidetached_house', 'bungalow']) expect(tagsOf(b)['roof:shape']).toBe('hipped');
    expect(tagsOf('terrace')['roof:shape']).toBe('gabled');
    // a small house is still two storeys (not a one-storey outbuilding)
    const small = tagsOf('house', {}, 0.00003, 0.00003);
    expect(small['sim:footprint_wall']).toBeUndefined();
    expect(small['roof:shape']).toBe('hipped');
    // told shapes and tall ones stand
    expect(tagsOf('house', { 'roof:shape': 'flat' })['roof:shape']).toBe('flat');
    expect(tagsOf('house', { 'building:levels': '5' })['roof:shape']).toBeUndefined();
  });

  it('a bungalow is one storey over its plinth; a shed and a hut are low', () => {
    expect(buildingHeights({ rings: [rect(0.00008, 0.00006)], tags: { building: 'bungalow' } }).wall).toBeCloseTo(FACADE_ZONES.PLINTH_M + 3);
    for (const b of ['shed', 'hut']) {
      const h = buildingHeights({ rings: [rect()], tags: { building: b } });
      expect(h.wall).toBeCloseTo(SHED.WALL_M);
      expect(h.roof).toBe(0);
    }
    expect(buildingHeights({ rings: [rect()], tags: { building: 'shed', 'building:levels': '2' } }).wall).toBe(6);
  });

  it('a carport is a canopy CARPORT_M high: a roof and no walls', () => {
    expect(buildingHeights({ rings: [rect()], tags: { building: 'carport' } }).wall).toBeCloseTo(CARPORT_M);
    const m = build([{ rings: [rect()], tags: { building: 'carport' } }]);
    // no wall faces: every normal is up or down
    for (let i = 0; i < m.vertexCount; i++) expect(Math.abs(m.vertices[i * 6 + 4])).toBeGreaterThan(0.9);
    expect(m.vertexCount).toBeGreaterThan(0);
  });
});

describe('wood', () => {
  const wood = (ramp: number) => (ramp & WOOD_FLAG) !== 0;

  it('wooden walls and roofs are boards (WOOD_FLAG) in shades that vary by building', () => {
    const shades = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const w = wallRamp({ building: 'house', 'building:material': 'wood' }, i / 40);
      expect(wood(w)).toBe(true);
      shades.add(w & 0xffffff);
    }
    expect(shades.size).toBeGreaterThanOrEqual(4);
    for (const m of ['timber', 'log', 'Wood;stone']) expect(wood(wallRamp({ building: 'house', 'building:material': m }))).toBe(true);
    expect(wood(roofRamp({ building: 'house', 'roof:material': 'wood' }, 0.3))).toBe(true);
    // a wooden wall says nothing of the roof, and other materials are no boards
    expect(wood(roofRamp({ building: 'house', 'building:material': 'wood' }, 0.3))).toBe(false);
    for (const m of ['brick', 'timber_framing', 'stone']) expect(wood(wallRamp({ building: 'house', 'building:material': m }))).toBe(false);
    expect(wood(wallRamp({ building: 'house' }))).toBe(false);
  });

  it('a painted wooden house keeps its colour and its boards', () => {
    const w = wallRamp({ building: 'house', 'building:material': 'wood', 'building:colour': '#336699' });
    expect(wood(w)).toBe(true);
    expect(w & 0xffffff).toBe(wallRamp({ building: 'house', 'building:colour': '#336699' }));
  });

  it('the flag reaches the mesh: wall faces of a wooden building carry it', () => {
    const m = build([{ rings: [rect(0.0001, 0.00008)], tags: { building: 'house', 'building:material': 'wood', 'building:levels': '1' } }]);
    let flagged = 0;
    for (let i = 0; i < m.vertexCount; i++) if (wood(m.ramps[i]) && Math.abs(m.vertices[i * 6 + 4]) < 0.1) flagged++;
    expect(flagged).toBeGreaterThan(0);
  });
});
