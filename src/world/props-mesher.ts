import { LIGHT, RAMP, rampIndex, snowy } from '../engine/palette';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import { clipTileData } from './clip';
import type { LonLat, OsmDetail, OsmTileData } from './osm-types';
import type { HeightSampler } from './terrain-source';

export interface PropsOptions {
  tile: Tile;
  detail: OsmDetail;
  data: OsmTileData;
  sampleHeight: HeightSampler;
  /** foliage ramp at a lon/lat (the land colour under the tree); default RAMP.FOREST */
  treeRamp?: (lon: number, lat: number) => number;
}

export interface PropsData {
  /** per tree: x, y, z, height, ramp (instance stride 5) */
  trees: Float32Array;
  /** per light: x, y, z, palette index (stride 4) */
  lights: Float32Array;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insideRing(lon: number, lat: number, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringAreaM2(ring: LonLat[], cosLat: number): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(s / 2) * 111320 * 111320 * cosLat;
}

const LIGHT_EDGE = rampIndex(RAMP.EMISSIVE, 13);
const LIGHT_CENTER = rampIndex(RAMP.EMISSIVE, 10);
const LIGHT_THRESHOLD = rampIndex(RAMP.HUD_GREEN, 13);
const LIGHT_TAXI = LIGHT.TAXI_BLUE;

/** Unit pyramid (18 verts, flat normals): base half-width 0.3, apex at y=1. Scaled per instance. */
export const CONE_VERTICES = (() => {
  const T = [0, 1, 0];
  const A = [-0.3, 0, -0.3];
  const B = [0.3, 0, -0.3];
  const C = [0.3, 0, 0.3];
  const D = [-0.3, 0, 0.3];
  const tris = [
    [B, A, T], [C, B, T], [D, C, T], [A, D, T],
    [A, B, C], [A, C, D],
  ];
  const out: number[] = [];
  for (const [a, b, c] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / len, n[1] / len, n[2] / len];
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
    for (const p of [a, b, c]) out.push(p[0], p[1], p[2], n[0], n[1], n[2]);
  }
  return new Float32Array(out);
})();

/** Q36 instanced cone trees + Q7 runway/taxiway light points, deterministic per tile. */
export function buildProps(opts: PropsOptions): PropsData {
  const { tile, data, sampleHeight } = opts;
  if (opts.detail !== 'full') return { trees: new Float32Array(0), lights: new Float32Array(0) };
  // trees in OSM wood/forest (no fill: Landsat colours the ground), cut at the tile border;
  // lights follow whole runways but only those inside the tile are kept
  const areas = clipTileData({ ...data, lines: [], points: [], buildings: [] }, tile).areas;
  const b = tileBounds(tile);
  const center = tileCenter(tile);
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const enu = (lon: number, lat: number): [number, number] => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const rng = mulberry32((tile.z * 73856093) ^ (tile.x * 19349663) ^ (tile.y * 83492791));

  const trees: number[] = [];
  for (const area of areas) {
    if (area.tags.landuse !== 'forest' && area.tags.natural !== 'wood') continue;
    const outer = area.rings[0];
    if (!outer || outer.length < 3) continue;
    const count = Math.min(2500, Math.round(ringAreaM2(outer, cosLat) / 450));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [lon, lat] of outer) {
      minX = Math.min(minX, lon); maxX = Math.max(maxX, lon);
      minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
    }
    let placed = 0;
    for (let attempt = 0; attempt < count * 4 && placed < count; attempt++) {
      const lon = minX + rng() * (maxX - minX);
      const lat = minY + rng() * (maxY - minY);
      if (!insideRing(lon, lat, outer)) continue;
      if (area.rings.slice(1).some((hole) => insideRing(lon, lat, hole))) continue;
      const y = sampleHeight(lon, lat);
      if (y <= 0) continue;
      const [x, z] = enu(lon, lat);
      trees.push(x, y, z, 8 + rng() * 8, snowy(opts.treeRamp?.(lon, lat) ?? RAMP.FOREST));
      placed++;
    }
  }

  const lights: number[] = [];
  const M_PER_DEG = 111320;
  const pushLight = (lon: number, lat: number, index: number): void => {
    if (lon < b.west || lon >= b.east || lat <= b.south || lat > b.north) return;
    const [x, z] = enu(lon, lat);
    // above the draped runway ribbon (bias 1.4) so depth test keeps the points visible
    lights.push(x, Math.max(sampleHeight(lon, lat), 0) + 1.8, z, index);
  };
  for (const line of data.lines) {
    const runway = line.tags.aeroway === 'runway';
    const taxi = line.tags.aeroway === 'taxiway';
    if ((!runway && !taxi) || line.points.length < 2) continue;
    const half = (parseFloat(line.tags.width) || (runway ? 45 : 23)) / 2;
    const path: LonLat[] = [];
    for (let i = 0; i < line.points.length - 1; i++) {
      const a = line.points[i];
      const b = line.points[i + 1];
      const [ax, az] = enu(a[0], a[1]);
      const [bx, bz] = enu(b[0], b[1]);
      const steps = Math.max(1, Math.min(200, Math.round(Math.hypot(bx - ax, bz - az) / 60)));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    path.push(line.points[line.points.length - 1]);
    for (let i = 0; i < path.length; i++) {
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dy = next[1] - prev[1];
      const dl = Math.hypot(dx * cosLat, dy) || 1;
      dx = (dx * cosLat) / dl;
      dy = dy / dl;
      // unit perpendicular (-dy, dx) in metres, converted to degrees (lon shrinks by cosLat)
      const plon = -dy / cosLat / M_PER_DEG;
      const plat = dx / M_PER_DEG;
      const [lon, lat] = path[i];
      if (runway) {
        pushLight(lon + plon * half, lat + plat * half, LIGHT_EDGE);
        pushLight(lon - plon * half, lat - plat * half, LIGHT_EDGE);
        if (i % 2 === 0) pushLight(lon, lat, LIGHT_CENTER);
      } else if (i % 2 === 0) {
        pushLight(lon + plon * half, lat + plat * half, LIGHT_TAXI);
        pushLight(lon - plon * half, lat - plat * half, LIGHT_TAXI);
      }
    }
    if (runway) {
      for (const end of [path[0], path[path.length - 1]]) {
        const next = end === path[0] ? path[1] : path[path.length - 2];
        let dx = end[0] - next[0];
        let dy = end[1] - next[1];
        const dl = Math.hypot(dx * cosLat, dy) || 1;
        dx = (dx * cosLat) / dl;
        dy = dy / dl;
        for (let k = -2; k <= 2; k++) {
          const f = ((k / 2) * half) / M_PER_DEG;
          pushLight(end[0] - (dy / cosLat) * f, end[1] + dx * f, LIGHT_THRESHOLD);
        }
      }
    }
  }

  return { trees: new Float32Array(trees), lights: new Float32Array(lights) };
}