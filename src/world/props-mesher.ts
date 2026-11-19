import { GLOW_SHIFT, LIGHT, PAYLOAD_MASK, RAMP, rampIndex, snowy } from '../engine/palette';
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
  /** per tree: x, y, z, height, colour payload, type, colour flags (TREE_STRIDE, treeColour), sorted by type */
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

/** tree silhouettes; the instance's type field picks one */
export const TREE = { SPRUCE: 0, BROADLEAF: 1, PINE: 2, CYPRESS: 3, PALM: 4 } as const;
export const TREE_TYPES = 5;
/**
 * floats per tree instance: x, y, z, height, colour payload, type, colour flags. The face colour
 * (palette.ts) is split in two floats, its low 24 bits and its flag byte, so a float holds each exactly.
 */
export const TREE_STRIDE = 7;

/** the face colour of tree instance i (its first float) */
/** runway and taxiway edge lights stand this high above the pad, m */
const RUNWAY_LIGHT_M = 0.5;

export function treeColour(trees: Float32Array, i: number): number {
  return ((trees[i + 6] << GLOW_SHIFT) | trees[i + 4]) >>> 0;
}

/** sets the face colour of tree instance i (its first float) */
export function setTreeColour(trees: Float32Array, i: number, packed: number): void {
  trees[i + 4] = packed & PAYLOAD_MASK;
  trees[i + 6] = packed >>> GLOW_SHIFT;
}
/** floats per tree geometry vertex: x, y, z, normal, part (0 crown, 1 trunk) */
export const TREE_VERTEX_FLOATS = 7;

type V3 = [number, number, number];

/** flat-shaded triangles of one silhouette at unit height; normals point away from `centre` (or up) */
class Shape {
  out: number[] = [];
  tri(a: V3, b: V3, c: V3, part: number, centre?: V3): void {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((v) => v / len);
    const away = centre
      ? ((a[0] + b[0] + c[0]) / 3 - centre[0]) * n[0] + ((a[1] + b[1] + c[1]) / 3 - centre[1]) * n[1] + ((a[2] + b[2] + c[2]) / 3 - centre[2]) * n[2]
      : n[1];
    if (away < 0) n = n.map((v) => -v);
    for (const p of [a, b, c]) this.out.push(p[0], p[1], p[2], n[0], n[1], n[2], part);
  }
  /** a lathe: `profile` is [radius, y] from bottom to top (radius 0 = apex), `sides` around the axis */
  lathe(profile: [number, number][], sides: number, part: number, turn = 0): this {
    const ring = (r: number, y: number, k: number): V3 => {
      const t = turn + (k / sides) * Math.PI * 2;
      return [r * Math.cos(t), y, r * Math.sin(t)];
    };
    for (let i = 0; i + 1 < profile.length; i++) {
      const [r0, y0] = profile[i];
      const [r1, y1] = profile[i + 1];
      const centre: V3 = [0, (y0 + y1) / 2, 0];
      for (let k = 0; k < sides; k++) {
        const a0 = ring(r0, y0, k), b0 = ring(r0, y0, k + 1);
        const a1 = ring(r1, y1, k), b1 = ring(r1, y1, k + 1);
        if (r0 > 0) this.tri(a0, b0, a1, part, centre);
        if (r1 > 0) this.tri(b0, b1, a1, part, centre);
      }
    }
    return this;
  }
}

const TRUNK = 1;
const CROWN = 0;

function palm(): Shape {
  const s = new Shape().lathe([[0.035, 0], [0.025, 0.86]], 4, TRUNK);
  const fronds = 7;
  for (let k = 0; k < fronds; k++) {
    const t = (k / fronds) * Math.PI * 2;
    const c = Math.cos(t), sn = Math.sin(t);
    const at = (d: number, y: number, side: number): V3 => [c * d - sn * side, y, sn * d + c * side];
    const root = at(0, 0.88, 0), tip = at(0.5, 0.7, 0);
    const l = at(0.25, 0.93, 0.07), r = at(0.25, 0.93, -0.07);
    s.tri(root, l, r, CROWN);
    s.tri(l, tip, r, CROWN);
  }
  return s;
}

const SHAPES: Shape[] = [
  // spruce: the old pyramid, as a narrow four-sided cone
  new Shape().lathe([[0.3 * Math.SQRT2, 0], [0, 1]], 4, CROWN, Math.PI / 4),
  // broadleaf: short trunk, rounded hexagonal crown
  new Shape().lathe([[0.05, 0], [0.05, 0.4]], 4, TRUNK).lathe([[0, 0.3], [0.34, 0.45], [0.42, 0.7], [0, 1]], 6, CROWN),
  // umbrella (stone) pine: tall bare trunk, wide flat crown
  new Shape().lathe([[0.04, 0], [0.03, 0.72]], 4, TRUNK).lathe([[0, 0.68], [0.5, 0.78], [0.36, 0.9], [0, 0.97]], 6, CROWN),
  // cypress: a narrow dark column
  new Shape().lathe([[0, 0], [0.11, 0.25], [0.1, 0.6], [0, 1]], 5, CROWN),
  palm(),
];

/** all silhouettes in one buffer (TREE_VERTEX_FLOATS per vertex) */
export const TREE_GEOMETRY = new Float32Array(SHAPES.flatMap((sh) => sh.out));
/** per tree type: first vertex and vertex count in TREE_GEOMETRY */
export const TREE_MESHES: { first: number; count: number }[] = (() => {
  let first = 0;
  return SHAPES.map((sh) => {
    const count = sh.out.length / TREE_VERTEX_FLOATS;
    const m = { first, count };
    first += count;
    return m;
  });
})();

/** height range (m) of each tree type */
const TREE_HEIGHT: [number, number][] = [[10, 20], [8, 16], [8, 14], [10, 18], [8, 14]];

/**
 * Share of each tree type by "climate latitude": |latitude| plus elevation / 150 m (about 6.7 deg per
 * km, the drop of the tree line). Weights are interpolated between the anchors: tropical palms and
 * broadleaves, Mediterranean stone pines, cypresses and oaks, then temperate broadleaves, then spruce.
 */
const CLIMATE: [number, number[]][] = [
  //    spruce broadleaf pine cypress palm
  [12, [0, 0.65, 0, 0, 0.35]],
  [26, [0, 0.5, 0.25, 0.05, 0.2]],
  [36, [0.05, 0.35, 0.45, 0.15, 0]],
  [44, [0.3, 0.6, 0.05, 0.05, 0]],
  [52, [0.55, 0.45, 0, 0, 0]],
  [62, [0.85, 0.15, 0, 0, 0]],
];
const NEEDLE = [TREE.SPRUCE, TREE.PINE, TREE.CYPRESS];
const BROAD = [TREE.BROADLEAF, TREE.PALM];

/** climate latitude of a point: |lat| + elevation / 150 m */
export function climateLatitude(lat: number, elevation: number): number {
  return Math.abs(lat) + Math.max(0, elevation) / 150;
}

/** OSM leaf type of a wood: leaf_type, else the old wood=coniferous/deciduous */
function leafType(tags: Record<string, string>): 'needle' | 'broad' | undefined {
  const lt = tags.leaf_type ?? { coniferous: 'needleleaved', deciduous: 'broadleaved' }[tags.wood ?? ''];
  return lt === 'needleleaved' ? 'needle' : lt === 'broadleaved' ? 'broad' : undefined;
}

/** weights of the tree types at a climate latitude, narrowed to the wood's leaf type */
export function treeWeights(climateLat: number, tags: Record<string, string> = {}): number[] {
  let w: number[];
  if (climateLat <= CLIMATE[0][0]) w = [...CLIMATE[0][1]];
  else if (climateLat >= CLIMATE[CLIMATE.length - 1][0]) w = [...CLIMATE[CLIMATE.length - 1][1]];
  else {
    const i = CLIMATE.findIndex(([a]) => a > climateLat);
    const [a0, w0] = CLIMATE[i - 1];
    const [a1, w1] = CLIMATE[i];
    const t = (climateLat - a0) / (a1 - a0);
    w = w0.map((v, k) => v + (w1[k] - v) * t);
  }
  const leaf = leafType(tags);
  if (leaf) {
    const keep: readonly number[] = leaf === 'needle' ? NEEDLE : BROAD;
    w = w.map((v, k) => (keep.includes(k) ? v : 0));
    if (!w.some((v) => v > 0)) w[leaf === 'broad' ? TREE.BROADLEAF : climateLat < 44 ? TREE.PINE : TREE.SPRUCE] = 1;
  }
  return w;
}

function pickType(w: number[], r: number): number {
  const sum = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let k = 0; k < w.length; k++) {
    acc += w[k] / sum;
    if (r < acc) return k;
  }
  return w.length - 1 - [...w].reverse().findIndex((v) => v > 0);
}

/** Q36 instanced trees of several types + Q7 runway/taxiway light points, deterministic per tile. */
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

  const byType: number[][] = Array.from({ length: TREE_TYPES }, () => []);
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
      const type = pickType(treeWeights(climateLatitude(lat, y), area.tags), rng());
      const [h0, h1] = TREE_HEIGHT[type];
      const packed = snowy(opts.treeRamp?.(lon, lat) ?? RAMP.FOREST);
      byType[type].push(x, y, z, h0 + rng() * (h1 - h0), packed & PAYLOAD_MASK, type, packed >>> GLOW_SHIFT);
      placed++;
    }
  }

  const lights: number[] = [];
  const M_PER_DEG = 111320;
  const pushLight = (lon: number, lat: number, index: number): void => {
    if (lon < b.west || lon >= b.east || lat <= b.south || lat > b.north) return;
    const [x, z] = enu(lon, lat);
    // edge-light height, above the runway ribbon (AEROWAY_LINE_BIAS) so the depth test keeps them visible
    lights.push(x, Math.max(sampleHeight(lon, lat), 0) + RUNWAY_LIGHT_M, z, index);
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

  return { trees: new Float32Array(byType.flat()), lights: new Float32Array(lights) };
}