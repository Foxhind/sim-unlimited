import earcut from 'earcut';
import { LIGHT, RAMP, TERRAIN_RAMP_BASE, nearestVga, rampIndex, type RGB } from '../engine/palette';
import { enuToLatLon, latLonToEnu, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmBuilding } from './osm-types';
import type { HeightSampler } from './terrain-source';
import type { TerrainMeshData } from './terrain-mesher';

export interface BuildingMeshOptions {
  tile: Tile;
  buildings: OsmBuilding[];
  sampleHeight: HeightSampler;
}

type XZ = [number, number];

const CSS_COLORS: Record<string, RGB> = {
  white: [244, 248, 252], black: [20, 24, 28], gray: [172, 172, 172], grey: [172, 172, 172],
  red: [168, 92, 56], brown: [148, 132, 112], beige: [208, 188, 120], yellow: [208, 188, 120],
  orange: [168, 92, 56], green: [64, 148, 60], blue: [36, 84, 148], purple: [148, 132, 112],
  pink: [168, 92, 56], cream: [208, 188, 120], tan: [208, 188, 120],
};

export function parseColor(v: string | undefined): RGB | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (CSS_COLORS[s]) return CSS_COLORS[s];
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
  }
  return undefined;
}

/** Parse OSM length values: "12", "12 m", "40 ft", "40'", '12\'6"'. Returns meters. */
export function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  const feetInch = s.match(/^(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)?"?$/);
  if (feetInch) return parseFloat(feetInch[1]) * 0.3048 + (feetInch[2] ? parseFloat(feetInch[2]) * 0.0254 : 0);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|ft|'|")?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === 'ft' || unit === "'") return n * 0.3048;
  if (unit === '"') return n * 0.0254;
  return n;
}

const TYPE_HEIGHT: Record<string, number> = {
  house: 6, detached: 6, residential: 9, apartments: 12, garage: 3, garages: 3,
  industrial: 8, warehouse: 8, commercial: 9, retail: 6, office: 12, church: 12,
  cathedral: 15, chapel: 6, hospital: 12, school: 9, university: 12, hotel: 12,
  roof: 3, shed: 3, hut: 3, cabin: 3, barn: 6, farm: 6,
};

export function computeHeights(tags: Record<string, string>): { min: number; wall: number; roof: number } {
  const type = tags['building:part'] || tags.building || 'yes';
  let height = parseLength(tags.height);
  if (height === undefined) {
    const levels = parseLength(tags['building:levels']);
    const roofLevels = parseLength(tags['roof:levels']) ?? 0;
    if (levels !== undefined) height = levels * 3 + roofLevels * 3;
  }
  if (height === undefined) height = TYPE_HEIGHT[type] ?? 9;

  let min = parseLength(tags.min_height) ?? 0;
  const minLevel = parseLength(tags['building:min_level']);
  if (min === 0 && minLevel !== undefined) min = minLevel * 3;

  const shape = tags['roof:shape'] ?? 'flat';
  let roof = 0;
  if (shape !== 'flat') {
    roof = parseLength(tags['roof:height']) ?? (parseLength(tags['roof:levels']) ?? 1) * 3;
  }
  height = Math.max(height, min + 0.3);
  roof = Math.min(roof, Math.max(0, height - min));
  const wall = Math.max(0, height - roof - min);
  return { min, wall, roof };
}

const MATERIAL_RAMP: Record<string, number> = {
  brick: RAMP.BRICK, concrete: RAMP.CONCRETE, cement: RAMP.CONCRETE, glass: RAMP.HULL_LIGHT,
  metal: RAMP.HULL_DARK, steel: RAMP.HULL_DARK, tile: RAMP.BRICK, tiles: RAMP.BRICK,
  wood: RAMP.SAND, timber: RAMP.SAND, stone: RAMP.ROCK, plaster: RAMP.SAND, stucco: RAMP.SAND,
  copper: RAMP.HULL_LIGHT, slate: RAMP.HULL_DARK, grass: RAMP.GRASS,
};

const TYPE_WALL: Record<string, number> = {
  house: RAMP.BRICK, detached: RAMP.BRICK, residential: RAMP.SAND, apartments: RAMP.CONCRETE,
  garage: RAMP.CONCRETE, garages: RAMP.CONCRETE, industrial: RAMP.HULL_DARK, warehouse: RAMP.HULL_DARK,
  commercial: RAMP.CONCRETE, retail: RAMP.BRICK, office: RAMP.HULL_LIGHT, church: RAMP.SAND,
  cathedral: RAMP.SAND, chapel: RAMP.SAND, hospital: RAMP.CONCRETE, school: RAMP.BRICK,
  hotel: RAMP.SAND, roof: RAMP.HULL_DARK, shed: RAMP.HULL_DARK, barn: RAMP.BRICK,
};

/** an OSM colour → its nearest default-VGA colour, shaded through the LUT like the terrain */
const vgaRamp = (c: RGB) => TERRAIN_RAMP_BASE + nearestVga(c[0], c[1], c[2]);

export function wallRamp(tags: Record<string, string>): number {
  const c = parseColor(tags['building:colour'] ?? tags.colour);
  if (c) return vgaRamp(c);
  const mat = tags['building:material'];
  if (mat && MATERIAL_RAMP[mat] !== undefined) return MATERIAL_RAMP[mat];
  const type = tags['building:part'] || tags.building || 'yes';
  return TYPE_WALL[type] ?? RAMP.BRICK;
}

export function roofRamp(tags: Record<string, string>): number {
  const c = parseColor(tags['roof:colour']);
  if (c) return vgaRamp(c);
  const mat = tags['roof:material'];
  if (mat && MATERIAL_RAMP[mat] !== undefined) return MATERIAL_RAMP[mat];
  return RAMP.BRICK;
}

function ringAreaXZ(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function normalizeRing(ring: XZ[], ccw: boolean): XZ[] {
  const area = ringAreaXZ(ring);
  if ((area > 0) !== ccw) return [...ring].reverse();
  return ring;
}

export function buildBuildingMesh(opts: BuildingMeshOptions): TerrainMeshData {
  const { tile, buildings, sampleHeight } = opts;
  const center = tileCenter(tile);
  const verts: number[] = [];
  const ramps: number[] = [];

  const toXZ = (ll: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, ll[1], ll[0], 0);
    return [e, -n];
  };
  const emitTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number], ramp: number, up: boolean): void => {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (up ? ny < 0 : ny > 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) {
      verts.push(p[0], p[1], p[2], nx, ny, nz);
      ramps.push(ramp);
    }
  };

  for (const b of buildings) {
    const tags = b.tags;
    if (!b.rings.length || !b.rings[0].length) continue;
    const outerLL = b.rings[0];
    const outer = normalizeRing(outerLL.map(toXZ), true);
    if (outer.length < 3) continue;
    const holes = b.rings.slice(1).map((r) => normalizeRing(r.map(toXZ), false)).filter((r) => r.length >= 3);

    // foundation sits on the lowest terrain under the footprint
    let minTerrain = Infinity;
    for (const [x, z] of outer) {
      const ll = enuToLatLon(center, x, -z, 0);
      minTerrain = Math.min(minTerrain, sampleHeight(ll.lon, ll.lat));
    }
    const base = Math.max(minTerrain, 0);
    const h = computeHeights(tags);
    const wallBase = base + h.min;
    const wallTop = wallBase + h.wall;
    const roofTop = wallTop + h.roof;
    const wRamp = wallRamp(tags);
    const rRamp = roofRamp(tags);
    const isCanopy = tags.building === 'roof';
    const shape = tags['roof:shape'] ?? 'flat';

    const centroid: XZ = [
      outer.reduce((s, p) => s + p[0], 0) / outer.length,
      outer.reduce((s, p) => s + p[1], 0) / outer.length,
    ];

    // walls (skipped for canopy roofs)
    if (!isCanopy && h.wall > 0.01) {
      const allRings = [outer, ...holes];
      for (const ring of allRings) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const c = ring[(i + 1) % ring.length];
          const a0: [number, number, number] = [a[0], wallBase, a[1]];
          const a1: [number, number, number] = [a[0], wallTop, a[1]];
          const c0: [number, number, number] = [c[0], wallBase, c[1]];
          const c1: [number, number, number] = [c[0], wallTop, c[1]];
          emitWallQuad(a0, a1, c1, c0, wRamp, centroid);
        }
      }
    }

    // ceiling for elevated parts (arches) and canopies
    if (h.min > 0.01 || isCanopy) {
      capRing(outer, holes, wallBase, wRamp, false);
    }

    // roof
    if (shape === 'flat' || h.roof < 0.01) {
      capRing(outer, holes, wallTop, rRamp, true);
    } else if (shape === 'pyramidal' || shape === 'cone' || shape === 'onion') {
      const apex: [number, number, number] = [centroid[0], roofTop, centroid[1]];
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i], c = outer[(i + 1) % outer.length];
        emitTri([a[0], wallTop, a[1]], [c[0], wallTop, c[1]], apex, rRamp, true);
      }
    } else if (shape === 'dome') {
      const midScale = 0.55;
      const midY = wallTop + h.roof * 0.7;
      const apex: [number, number, number] = [centroid[0], roofTop, centroid[1]];
      const mid: XZ[] = outer.map((p) => [centroid[0] + (p[0] - centroid[0]) * midScale, centroid[1] + (p[1] - centroid[1]) * midScale]);
      for (let i = 0; i < outer.length; i++) {
        const j = (i + 1) % outer.length;
        const a: [number, number, number] = [outer[i][0], wallTop, outer[i][1]];
        const c: [number, number, number] = [outer[j][0], wallTop, outer[j][1]];
        const m0: [number, number, number] = [mid[i][0], midY, mid[i][1]];
        const m1: [number, number, number] = [mid[j][0], midY, mid[j][1]];
        emitTri(a, c, m1, rRamp, true);
        emitTri(a, m1, m0, rRamp, true);
        emitTri(m0, m1, apex, rRamp, true);
      }
    } else {
      // gabled / skillion / hipped / half-hipped via a roof height field
      const field = roofHeightField(outer, centroid, shape, tags);
      roofFieldMesh(outer, holes, wallTop, h.roof, field, rRamp);
    }
  }

  function emitWallQuad(a0: [number, number, number], a1: [number, number, number], c1: [number, number, number], c0: [number, number, number], ramp: number, centroid: XZ): void {
    // outward horizontal normal from edge midpoint away from centroid
    const mx = (a0[0] + c0[0]) / 2 - centroid[0];
    const mz = (a0[2] + c0[2]) / 2 - centroid[1];
    const ex = c0[0] - a0[0], ez = c0[2] - a0[2];
    let nx = ez, nz = -ex;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    for (const p of [a0, c0, c1, a0, c1, a1]) {
      verts.push(p[0], p[1], p[2], nx, 0, nz);
      ramps.push(ramp);
    }
  }

  function capRing(outer: XZ[], holes: XZ[][], y: number, ramp: number, up: boolean): void {
    const flat: number[] = [];
    const holeIdx: number[] = [];
    const pts: XZ[] = [];
    outer.forEach((p) => { flat.push(p[0], p[1]); pts.push(p); });
    for (const hole of holes) {
      holeIdx.push(pts.length);
      for (const p of hole) { flat.push(p[0], p[1]); pts.push(p); }
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    for (let i = 0; i < tris.length; i += 3) {
      const a = pts[tris[i]], b = pts[tris[i + 1]], c = pts[tris[i + 2]];
      emitTri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], ramp, up);
    }
  }

  function roofFieldMesh(outer: XZ[], holes: XZ[][], wallTop: number, roofH: number, field: (p: XZ) => number, ramp: number): void {
    const flat: number[] = [];
    const holeIdx: number[] = [];
    const pts: XZ[] = [];
    outer.forEach((p) => { flat.push(p[0], p[1]); pts.push(p); });
    for (const hole of holes) {
      holeIdx.push(pts.length);
      for (const p of hole) { flat.push(p[0], p[1]); pts.push(p); }
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    type V = { p: XZ; y: number };
    const vert = (p: XZ): V => ({ p, y: wallTop + roofH * field(p) });
    const split = (a: V, b: V, c: V, depth: number): void => {
      const longest = Math.max(
        Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]),
        Math.hypot(b.p[0] - c.p[0], b.p[1] - c.p[1]),
        Math.hypot(c.p[0] - a.p[0], c.p[1] - a.p[1]),
      );
      if (longest <= 4 || depth >= 4) {
        emitTri([a.p[0], a.y, a.p[1]], [b.p[0], b.y, b.p[1]], [c.p[0], c.y, c.p[1]], ramp, true);
        return;
      }
      const mid = (u: V, v: V): V => vert([(u.p[0] + v.p[0]) / 2, (u.p[1] + v.p[1]) / 2]);
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      split(a, ab, ca, depth + 1);
      split(ab, b, bc, depth + 1);
      split(ca, bc, c, depth + 1);
      split(ab, bc, ca, depth + 1);
    };
    for (let i = 0; i < tris.length; i += 3) {
      split(vert(pts[tris[i]]), vert(pts[tris[i + 1]]), vert(pts[tris[i + 2]]), 0);
    }
  }

  const vertexCount = ramps.length;
  return { vertices: new Float32Array(verts), ramps: new Uint16Array(ramps), vertexCount };
}

/** Normalized roof height field in [0,1] for axis-based shapes. */
export function roofHeightField(outer: XZ[], centroid: XZ, shape: string, tags: Record<string, string>): (p: XZ) => number {
  // principal axis from covariance
  let cxx = 0, czz = 0, cxz = 0;
  for (const p of outer) {
    const dx = p[0] - centroid[0], dz = p[1] - centroid[1];
    cxx += dx * dx; czz += dz * dz; cxz += dx * dz;
  }
  const theta = 0.5 * Math.atan2(2 * cxz, cxx - czz);
  let ux = Math.cos(theta), uz = Math.sin(theta);
  if (tags['roof:orientation'] === 'across') { const t = ux; ux = -uz; uz = t; }
  const vx = -uz, vz = ux;
  let maxAlong = 0, maxAcross = 0;
  for (const p of outer) {
    const dx = p[0] - centroid[0], dz = p[1] - centroid[1];
    maxAlong = Math.max(maxAlong, Math.abs(dx * ux + dz * uz));
    maxAcross = Math.max(maxAcross, Math.abs(dx * vx + dz * vz));
  }
  maxAlong = maxAlong || 1;
  maxAcross = maxAcross || 1;

  if (shape === 'skillion') {
    const dir = roofDirection(tags);
    return (p) => {
      const dx = p[0] - centroid[0], dz = p[1] - centroid[1];
      const t = (dx * dir[0] + dz * dir[1]) / maxAcross;
      return clamp01(0.5 - t * 0.5);
    };
  }
  if (shape === 'gabled') {
    return (p) => {
      const dx = p[0] - centroid[0], dz = p[1] - centroid[1];
      return clamp01(1 - Math.abs(dx * vx + dz * vz) / maxAcross);
    };
  }
  if (shape === 'half-hipped') {
    return (p) => {
      const dx = p[0] - centroid[0], dz = p[1] - centroid[1];
      const across = Math.abs(dx * vx + dz * vz) / maxAcross;
      const along = Math.abs(dx * ux + dz * uz) / maxAlong;
      return clamp01(1 - Math.max(across, along * 0.5));
    };
  }
  // hipped (default for the field branch)
  return (p) => {
    const dx = p[0] - centroid[0], dz = p[1] - centroid[1];
    const across = Math.abs(dx * vx + dz * vz) / maxAcross;
    const along = Math.abs(dx * ux + dz * uz) / maxAlong;
    return clamp01(1 - Math.max(across, along));
  };
}

function roofDirection(tags: Record<string, string>): XZ {
  const d = tags['roof:direction'];
  if (!d) return [0, -1];
  const deg = parseFloat(d);
  if (Number.isFinite(deg)) {
    const r = (deg * Math.PI) / 180;
    return [Math.sin(r), -Math.cos(r)];
  }
  const map: Record<string, XZ> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [0.7, -0.7], nw: [-0.7, -0.7], se: [0.7, 0.7], sw: [-0.7, 0.7] };
  return map[d.toLowerCase()] ?? [0, -1];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
/**
 * Far stand-in for buildings: one point per building at its centroid, at roof-top height, in its
 * roof colour (lit step 9). Per point: x, y, z (tile-centre ENU like the meshes), palette index.
 */
export function buildingDots(buildings: OsmBuilding[], tile: Tile, sampleHeight: HeightSampler): Float32Array {
  const center = tileCenter(tile);
  const out: number[] = [];
  for (const b of buildings) {
    const ring = b.rings[0];
    if (!ring?.length) continue;
    let lon = 0, lat = 0;
    for (const [lo, la] of ring) { lon += lo; lat += la; }
    lon /= ring.length;
    lat /= ring.length;
    const h = computeHeights(b.tags);
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    out.push(e, Math.max(0, sampleHeight(lon, lat)) + h.min + h.wall + h.roof, -n, rampIndex(roofRamp(b.tags), 9));
  }
  return new Float32Array(out);
}

/** buildings that nobody lives or works in stay dark at night */
const UNLIT_TYPES = new Set([
  'garage', 'garages', 'carport', 'shed', 'hut', 'cabin', 'roof', 'barn', 'greenhouse', 'storage_tank',
  'silo', 'transformer_tower', 'service', 'ruins', 'construction', 'bunker', 'kiosk', 'toilets',
]);
export function isLitBuilding(tags: Record<string, string>): boolean {
  return !UNLIT_TYPES.has(tags['building:part'] || tags.building || 'yes');
}

/** taller than this (top above ground), a building carries red obstruction lights on its roof */
export const TALL_BUILDING_M = 50;
const WINDOW_SPACING_M = 4;
const FLOOR_M = 3;
const WINDOW_LIT_SHARE = 0.3;
const WINDOW_YELLOW_SHARE = 0.7;
/** windows stand off the wall so the depth test keeps them in front of it */
const WINDOW_OFFSET_M = 0.4;
const MAX_WINDOWS_PER_BUILDING = 600;
const MAX_WINDOWS_PER_TILE = 80000;

/** deterministic 0..1 hash of a position (lights do not reshuffle when a tile is rebuilt) */
function hash01(x: number, y: number, z: number): number {
  let h = Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(y * 10) | 0, 19349663) ^ Math.imul(Math.round(z * 10) | 0, 83492791);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const windowColour = (r: number) => (r < WINDOW_YELLOW_SHARE ? LIGHT.WINDOW_YELLOW : LIGHT.WINDOW_WHITE);

export interface NightLights {
  /** near (with the building mesh): lit windows on the walls, red lights on the roof corners of tall buildings */
  windows: Float32Array;
  /** far (instead of the roof-coloured dots): one yellow or white dot per building, red at roof height for tall ones */
  dots: Float32Array;
}

/**
 * Night lights of buildings; per point x, y, z (tile-centre ENU), palette index, like buildingDots.
 * Windows: every 4 m along each outer wall on every 3 m floor, about a third of them lit, mostly yellow.
 */
export function buildingNightLights(buildings: OsmBuilding[], tile: Tile, sampleHeight: HeightSampler): NightLights {
  const center = tileCenter(tile);
  const windows: number[] = [];
  const dots: number[] = [];
  const toXZ = (ll: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, ll[1], ll[0], 0);
    return [e, -n];
  };

  for (const b of buildings) {
    const ringLL = b.rings[0];
    if (!ringLL?.length) continue;
    const ring = ringLL.map(toXZ);
    // drop the closing duplicate
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) continue;
    const h = computeHeights(b.tags);
    let minTerrain = Infinity;
    for (const [x, z] of ring) {
      const ll = enuToLatLon(center, x, -z, 0);
      minTerrain = Math.min(minTerrain, sampleHeight(ll.lon, ll.lat));
    }
    const base = Math.max(minTerrain, 0);
    const wallBase = base + h.min;
    const roofTop = wallBase + h.wall + h.roof;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const tall = h.min + h.wall + h.roof > TALL_BUILDING_M;
    const lit = isLitBuilding(b.tags) && b.tags.building !== 'roof';

    if (lit) {
      const r = hash01(cx, wallBase, cz);
      dots.push(cx, wallBase + h.wall * 0.5, cz, windowColour(hash01(cz, r, cx)));
    }
    if (tall) dots.push(cx, roofTop, cz, LIGHT.RED);

    if (lit && h.wall >= 2.5 && windows.length / 4 < MAX_WINDOWS_PER_TILE) {
      const floors = Math.max(1, Math.floor(h.wall / FLOOR_M));
      let count = 0;
      for (let i = 0; i < ring.length && count < MAX_WINDOWS_PER_BUILDING; i++) {
        const a = ring[i];
        const c = ring[(i + 1) % ring.length];
        const ex = c[0] - a[0], ez = c[1] - a[1];
        const len = Math.hypot(ex, ez);
        if (len < WINDOW_SPACING_M * 0.75) continue;
        // outward normal: away from the centroid
        let nx = ez / len, nz = -ex / len;
        if (nx * ((a[0] + c[0]) / 2 - cx) + nz * ((a[1] + c[1]) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
        const slots = Math.max(1, Math.floor(len / WINDOW_SPACING_M));
        for (let f = 0; f < floors && count < MAX_WINDOWS_PER_BUILDING; f++) {
          const y = wallBase + (f + 0.5) * (h.wall / floors);
          for (let k = 0; k < slots && count < MAX_WINDOWS_PER_BUILDING; k++) {
            const t = (k + 0.5) / slots;
            const x = a[0] + ex * t + nx * WINDOW_OFFSET_M;
            const z = a[1] + ez * t + nz * WINDOW_OFFSET_M;
            const r = hash01(x, y, z);
            if (r >= WINDOW_LIT_SHARE) continue;
            windows.push(x, y, z, windowColour(r / WINDOW_LIT_SHARE));
            count++;
          }
        }
      }
    }

    if (tall) {
      // the outermost corners of the footprint, just above the roof
      const ext = new Set<XZ>();
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        let best = ring[0], bv = -Infinity;
        for (const p of ring) {
          const v = sx * (p[0] - cx) + sz * (p[1] - cz);
          if (v > bv) { bv = v; best = p; }
        }
        ext.add(best);
      }
      // on the eaves of a pitched roof (its ridge is not at the corners)
      for (const p of ext) windows.push(p[0], wallBase + h.wall + 0.5, p[1], LIGHT.RED);
    }
  }
  return { windows: new Float32Array(windows), dots: new Float32Array(dots) };
}
