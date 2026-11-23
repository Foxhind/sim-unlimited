export const EARTH_R = 6371000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Tile {
  z: number;
  x: number;
  y: number;
}

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function tileForLatLon(lat: number, lon: number, z: number): Tile {
  const n = 2 ** z;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = Math.floor(((lon + 180) / 360) * n);
  const sinLat = Math.sin(clamped * D2R);
  const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return { z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

export function mercatorYToLat(fy: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * fy))) * R2D;
}

export function tileBounds(t: Tile): TileBounds {
  const n = 2 ** t.z;
  return {
    west: (t.x / n) * 360 - 180,
    east: ((t.x + 1) / n) * 360 - 180,
    north: mercatorYToLat(t.y / n),
    south: mercatorYToLat((t.y + 1) / n),
  };
}

export function tileCenter(t: Tile): LatLon {
  const n = 2 ** t.z;
  return {
    lon: ((t.x + 0.5) / n) * 360 - 180,
    lat: mercatorYToLat((t.y + 0.5) / n),
  };
}

/** Ground width of a tile in meters (spherical Mercator compensation). */
export function tileSizeMeters(t: Tile): number {
  return ((2 * Math.PI * EARTH_R) / 2 ** t.z) * Math.cos(tileCenter(t).lat * D2R);
}

/**
 * Ground length of a tile's west–east extent at Mercator row `row` (t.y: north edge, t.y + 1:
 * south edge). Unlike tileSizeMeters it is the same number for the two tiles that share the edge.
 */
export function tileRowMeters(z: number, row: number): number {
  return ((2 * Math.PI * EARTH_R) / 2 ** z) * Math.cos(mercatorYToLat(row / 2 ** z) * D2R);
}

/** Sample i/j of a (grid+1)×(grid+1) vertex lattice, in lat/lon. */
export function gridLatLon(t: Tile, i: number, j: number, grid: number): LatLon {
  const n = 2 ** t.z;
  const fx = (t.x + i / grid) / n;
  const fy = (t.y + j / grid) / n;
  return { lon: fx * 360 - 180, lat: mercatorYToLat(fy) };
}

/**
 * The inverse of gridLatLon: lon/lat to the lattice of tile `t` with `grid` cells a side (x east,
 * y south, 0..grid over the tile, beyond it past the tile), latitude clamped to Mercator's range.
 * The OSM mesh and the ground covers lay their shapes on the same lattice through it.
 */
export function tileLattice(t: Tile, grid: number): (p: readonly [number, number]) => [number, number] {
  return ([lon, lat]) => {
    const n = 2 ** t.z;
    const sinLat = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return [(((lon + 180) / 360) * n - t.x) * grid, (merc * n - t.y) * grid];
  };
}

export type Vec3 = [number, number, number];

export function latLonToEcef(lat: number, lon: number, h: number): Vec3 {
  const la = lat * D2R;
  const lo = lon * D2R;
  const r = EARTH_R + h;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
}

/** Double-precision ENU meters of a point relative to a local origin (CPU side). */
export function latLonToEnu(origin: LatLon, lat: number, lon: number, h: number): Vec3 {
  const p = latLonToEcef(lat, lon, h);
  return ecefToEnu(origin, p);
}

export function ecefToEnu(origin: LatLon, p: Vec3): Vec3 {
  const o = latLonToEcef(origin.lat, origin.lon, 0);
  const dx = p[0] - o[0];
  const dy = p[1] - o[1];
  const dz = p[2] - o[2];
  const la = origin.lat * D2R;
  const lo = origin.lon * D2R;
  const sl = Math.sin(la);
  const cl = Math.cos(la);
  const so = Math.sin(lo);
  const co = Math.cos(lo);
  return [
    -so * dx + co * dy,
    -sl * co * dx - sl * so * dy + cl * dz,
    cl * co * dx + cl * so * dy + sl * dz,
  ];
}

/**
 * Yaw of the ENU frame at `at` inside the ENU frame at `origin` (radians, from origin north toward
 * east): the turn that brings a mesh built around `at` into the world of `origin`.
 */
export function frameYaw(origin: LatLon, at: LatLon): number {
  const la = at.lat * D2R, lo = at.lon * D2R;
  // local north of `at` in ECEF
  const dx = -Math.sin(la) * Math.cos(lo), dy = -Math.sin(la) * Math.sin(lo), dz = Math.cos(la);
  const ola = origin.lat * D2R, olo = origin.lon * D2R;
  const e = -Math.sin(olo) * dx + Math.cos(olo) * dy;
  const n = -Math.sin(ola) * Math.cos(olo) * dx - Math.sin(ola) * Math.sin(olo) * dy + Math.cos(ola) * dz;
  return Math.atan2(e, n);
}

export function enuToLatLon(origin: LatLon, e: number, n: number, u: number): LatLon & { alt: number } {
  const la = origin.lat * D2R;
  const lo = origin.lon * D2R;
  const sl = Math.sin(la);
  const cl = Math.cos(la);
  const so = Math.sin(lo);
  const co = Math.cos(lo);
  const dx = -so * e - sl * co * n + cl * co * u;
  const dy = co * e - sl * so * n + cl * so * u;
  const dz = cl * n + sl * u;
  const o = latLonToEcef(origin.lat, origin.lon, 0);
  const x = o[0] + dx;
  const y = o[1] + dy;
  const z = o[2] + dz;
  const r = Math.hypot(x, y, z);
  return {
    lat: Math.asin(z / r) * R2D,
    lon: Math.atan2(y, x) * R2D,
    alt: r - EARTH_R,
  };
}

/** AWS Terrarium: elevation = R*256 + G + B/256 − 32768. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export function tileKey(kind: string, t: Tile, schemaVersion: number): string {
  return `${kind}/${t.z}/${t.x}/${t.y}/${schemaVersion}`;
}