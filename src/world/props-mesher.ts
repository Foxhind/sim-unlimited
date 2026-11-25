import { colourOf, GLOW_SHIFT, LIGHT, PAYLOAD_MASK, RAMP, rampIndex, snowy } from '../engine/palette';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import { clipTileData } from './clip';
import type { LonLat, OsmDetail, OsmLine, OsmTileData } from './osm-types';
import { pierWidth } from './pier-mesher';
import type { HeightSampler } from './terrain-source';

export interface PropsOptions {
  tile: Tile;
  detail: OsmDetail;
  data: OsmTileData;
  sampleHeight: HeightSampler;
  /** foliage ramp at a lon/lat (the land colour under the tree); default RAMP.FOREST */
  treeRamp?: (lon: number, lat: number) => number;
  /** trees in a wood or forest × FOREST's (relief inspector; the game: 1) */
  treeDensity?: number;
}

/** trees of an OSM wood or forest (landuse=forest, natural=wood) */
export const FOREST = {
  /** one tree to this much of its area, m² */
  M2_PER_TREE: 450,
  /** at most this many trees in one area's piece of a tile */
  MAX_TREES: 2500,
} as const;

export interface PropsData {
  /** per tree: x, y, z, height, colour payload, type, colour flags, yaw (TREE_STRIDE, treeColour), sorted by type */
  trees: Float32Array;
  /** per light: x, y, z, palette index (stride 4) */
  lights: Float32Array;
  /** yachts moored in the marinas (MARINA): instances as `trees`, sailing yachts then motor yachts (after every other type) */
  yachts: Float32Array;
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

/**
 * Far trees are thinned: beyond NEAR_M a falling share of a tile's trees is drawn, down to KEEP at
 * FAR_M, and those left are widened by 1 / sqrt(share) (their height by its square root), so the
 * canopy covers the same ground with fewer of them. A tree's rank is its place in its type's run of
 * the instances (shuffled: any first part of a run is an even sample of the tile's trees); it is
 * drawn where the share at its distance exceeds its rank, growing over the last GROW of the share
 * (no popping). The shader does it per tree (shaders TREE_THIN_GLSL), the tile drawing only the
 * first share of each run at its nearest point (treeKeep).
 */
export const TREE_THIN = { NEAR_M: 500, FAR_M: 2000, KEEP: 0.25, GROW: 0.2 } as const;
/** the share of the trees drawn `d` metres from the eye */
export function treeKeep(d: number): number {
  const t = Math.max(0, Math.min(1, (d - TREE_THIN.NEAR_M) / (TREE_THIN.FAR_M - TREE_THIN.NEAR_M)));
  return 1 + (TREE_THIN.KEEP - 1) * t;
}

/** shuffles the instances (TREE_STRIDE floats each) in place, the same way for the same seed */
function shuffleInstances(inst: number[], seed: number): void {
  const rng = mulberry32(seed);
  for (let i = inst.length / TREE_STRIDE - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    for (let k = 0; k < TREE_STRIDE; k++) {
      const a = i * TREE_STRIDE + k, b = j * TREE_STRIDE + k;
      const v = inst[a];
      inst[a] = inst[b];
      inst[b] = v;
    }
  }
}

/** tree silhouettes; the instance's type field picks one */
export const TREE = { SPRUCE: 0, BROADLEAF: 1, PINE: 2, CYPRESS: 3, PALM: 4 } as const;
export const TREE_TYPES = 5;
/**
 * floats per instance (trees and the other instanced props: INSTANCE): x, y, z, scale (a tree's
 * height; 1 for a prop modelled in metres), colour payload, type, colour flags, yaw (radians: the
 * mesh's +x turns towards (cos yaw, sin yaw) in x, z). The face colour (palette.ts) is split in two
 * floats, its low 24 bits and its flag byte, so a float holds each exactly.
 */
export const TREE_STRIDE = 8;
/** instanced props drawn with the trees, by their type (after the tree types) */
export const INSTANCE = { AC: TREE_TYPES, LAMP: TREE_TYPES + 1, SAILBOAT: TREE_TYPES + 2, MOTORBOAT: TREE_TYPES + 3, SIGNAL: TREE_TYPES + 4 } as const;

/** appends one instance (TREE_STRIDE floats) */
export function pushInstance(out: number[], x: number, y: number, z: number, scale: number, packed: number, type: number, yaw: number): void {
  out.push(x, y, z, scale, packed & PAYLOAD_MASK, type, packed >>> GLOW_SHIFT, yaw);
}

/** a deterministic yaw from a position (trees face every way, stable across rebuilds) */
function yawAt(x: number, z: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (v - Math.floor(v)) * Math.PI * 2;
}

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
  /** an axis-aligned box (all six faces) */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, part: number): this {
    const c: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const v = (i: number): V3 => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    for (const [a, b, d, e] of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) {
      this.tri(v(a), v(b), v(d), part, c);
      this.tri(v(a), v(d), v(e), part, c);
    }
    return this;
  }
}

/** an outdoor air-conditioner unit, m: its back on the wall at x = 0, sticking out along +x */
export const AC_SIZE = { DEPTH: 0.3, WIDTH: 0.8, HEIGHT: 0.55 } as const;
/** a street lamp, m: pole at the origin, arm along +x at the top */
export const LAMP_SHAPE = { HEIGHT: 8, ARM: 2, POLE_HALF: 0.12 } as const;
/**
 * A traffic light, m: a post at the origin, the signal head on its top facing +x (the traffic it
 * stops): HEAD_BOTTOM to HEAD_TOP, its face HEAD_FRONT out along x, HEAD_HALF each side, a shallow
 * box; its lenses LENS_HALF each way, red at RED_Y, green at GREEN_Y (osm-mesher placeSignals)
 */
export const SIGNAL_SHAPE = { POLE_HALF: 0.07, HEAD_BOTTOM: 2.4, HEAD_TOP: 3.4, HEAD_HALF: 0.17, HEAD_FRONT: 0.12, LENS_HALF: 0.12, RED_Y: 3.18, GREEN_Y: 2.62 } as const;

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

/**
 * A yacht a unit long (the instance's scale is its length), stern at x = 0, bow toward +x, the
 * waterline at y = 0: a hull narrowing to the bow, its teak deck (the trunk's part, bark-coloured),
 * then a sailing yacht's mast or a motor yacht's cabin (the hull's colour).
 */
function yacht(sail: boolean): Shape {
  const s = new Shape();
  const C = YACHT_HULL;
  // deck and waterline outlines, stern to bow: [x, half beam]
  const deck: [number, number][] = [[0, C.BEAM], [0.62, C.BEAM], [1, 0]];
  const water: [number, number][] = [[0.03, C.BEAM * 0.8], [0.6, C.BEAM * 0.75], [0.94, 0]];
  const centre: V3 = [0.5, C.FREEBOARD / 2, 0];
  const d = (k: number, side: number): V3 => [deck[k][0], C.FREEBOARD, deck[k][1] * side];
  const w = (k: number, side: number): V3 => [water[k][0], 0, water[k][1] * side];
  for (const side of [1, -1]) {
    for (let k = 0; k + 1 < deck.length; k++) {
      s.tri(d(k, side), d(k + 1, side), w(k + 1, side), CROWN, centre);
      s.tri(d(k, side), w(k + 1, side), w(k, side), CROWN, centre);
    }
  }
  // the transom
  s.tri(d(0, 1), d(0, -1), w(0, -1), CROWN, centre);
  s.tri(d(0, 1), w(0, -1), w(0, 1), CROWN, centre);
  // the deck
  s.tri(d(0, 1), d(0, -1), d(1, -1), TRUNK);
  s.tri(d(0, 1), d(1, -1), d(1, 1), TRUNK);
  s.tri(d(1, 1), d(1, -1), d(2, 1), TRUNK);
  if (sail) s.box(0.52, C.FREEBOARD, -0.008, 0.535, C.MAST, 0.008, CROWN);
  else s.box(0.18, C.FREEBOARD, -C.BEAM * 0.7, 0.58, C.FREEBOARD + C.CABIN, C.BEAM * 0.7, CROWN);
  return s;
}

/** a yacht's proportions to its length: half beam, freeboard, a cabin's height, the mast's top */
const YACHT_HULL = { BEAM: 0.16, FREEBOARD: 0.1, CABIN: 0.14, MAST: 1.35 } as const;

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
  // INSTANCE.AC
  new Shape().box(0, 0, -AC_SIZE.WIDTH / 2, AC_SIZE.DEPTH, AC_SIZE.HEIGHT, AC_SIZE.WIDTH / 2, CROWN),
  // INSTANCE.LAMP: pole and the arm over the road
  new Shape()
    .box(-LAMP_SHAPE.POLE_HALF, 0, -LAMP_SHAPE.POLE_HALF, LAMP_SHAPE.POLE_HALF, LAMP_SHAPE.HEIGHT, LAMP_SHAPE.POLE_HALF, CROWN)
    .box(LAMP_SHAPE.POLE_HALF, LAMP_SHAPE.HEIGHT - 2 * LAMP_SHAPE.POLE_HALF, -LAMP_SHAPE.POLE_HALF, LAMP_SHAPE.ARM + LAMP_SHAPE.POLE_HALF, LAMP_SHAPE.HEIGHT, LAMP_SHAPE.POLE_HALF, CROWN),
  // INSTANCE.SAILBOAT, INSTANCE.MOTORBOAT
  yacht(true),
  yacht(false),
  // INSTANCE.SIGNAL: a post and the head on it
  new Shape()
    .box(-SIGNAL_SHAPE.POLE_HALF, 0, -SIGNAL_SHAPE.POLE_HALF, SIGNAL_SHAPE.POLE_HALF, SIGNAL_SHAPE.HEAD_BOTTOM, SIGNAL_SHAPE.POLE_HALF, CROWN)
    .box(-SIGNAL_SHAPE.HEAD_FRONT, SIGNAL_SHAPE.HEAD_BOTTOM, -SIGNAL_SHAPE.HEAD_HALF, SIGNAL_SHAPE.HEAD_FRONT, SIGNAL_SHAPE.HEAD_TOP, SIGNAL_SHAPE.HEAD_HALF, CROWN),
];

/** all silhouettes in one buffer (TREE_VERTEX_FLOATS per vertex) */
export const TREE_GEOMETRY = new Float32Array(SHAPES.flatMap((sh) => sh.out));
/** per instance type (tree types, then INSTANCE): first vertex and vertex count in TREE_GEOMETRY */
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

/**
 * Single trees (natural=tree, a point) and tree rows (natural=tree_row, a line: an avenue, a
 * windbreak): one at the point, one every ROW_SPACING_M along the row. A tree of its tagged height
 * (within HEIGHT_M), else its type's; its type by its genus or species where it names one
 * (GENUS), else by the climate and its leaf type as a wood's. Each hashed from its place: the same
 * in every tile, drawn by the tile it stands in.
 */
export const LONE_TREE = {
  ROW_SPACING_M: 8,
  HEIGHT_M: [2, 40] as [number, number],
  GENUS: { phoenix: TREE.PALM, washingtonia: TREE.PALM, cupressus: TREE.CYPRESS, pinus: TREE.PINE, picea: TREE.SPRUCE, abies: TREE.SPRUCE } as Record<string, number>,
} as const;

/** a single tree's or a row's type: by its genus (genus, species or taxon), else from `w` by `r` */
export function loneTreeType(tags: Record<string, string>, w: number[], r: number): number {
  const name = (tags.genus ?? tags.species ?? tags.taxon ?? tags['species:en'] ?? '').toLowerCase();
  for (const [g, t] of Object.entries(LONE_TREE.GENUS)) if (name.startsWith(g)) return t;
  if (/palm/.test(name)) return TREE.PALM;
  return pickType(w, r);
}

/**
 * Orchards (landuse=orchard): from the air an orchard is its rows. Olives and citrus of the
 * Mediterranean stand about 5 m apart in rows about 6 m apart, low and round-crowned.
 */
export const ORCHARD = {
  /** between the rows, m */
  ROW_M: 6,
  /** between the trees of a row, m */
  TREE_M: 5,
  /** a tree stands up to this far off its grid point along each axis, m */
  JITTER_M: 0.4,
  HEIGHT_M: [3, 5] as [number, number],
  /** a larger orchard gets its spacing widened to keep to this many trees */
  MAX_TREES: 6000,
} as const;

/** deterministic 0..1 hash of two integers and a salt (the same in every tile) */
function hash2(i: number, j: number, salt: number): number {
  let h = Math.imul(i | 0, 73856093) ^ Math.imul(j | 0, 19349663) ^ Math.imul(salt | 0, 83492791);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The trees of one orchard that stand in `tile`. The grid is the whole orchard's (from its outline,
 * not the tile's piece of it), so the rows run on unbroken across tile borders: origin at the first
 * vertex of the outer ring, rows along its longest edge, every tree's jitter and height hashed from
 * its row and place in the row.
 */
function plantOrchard(
  area: { rings: LonLat[][]; tags: Record<string, string> },
  tile: Tile,
  sampleHeight: HeightSampler,
  enu: (lon: number, lat: number) => [number, number],
  treeRamp: ((lon: number, lat: number) => number) | undefined,
  out: number[][],
): void {
  const outer = area.rings[0];
  if (!outer || outer.length < 3) return;
  const b = tileBounds(tile);
  const [lon0, lat0] = outer[0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 111320;
  const local = ([lon, lat]: LonLat): [number, number] => [(lon - lon0) * kx, (lat - lat0) * ky];
  // the rows run along the longest edge
  let ux = 1, uy = 0, longest = -1;
  for (let i = 0; i + 1 < outer.length; i++) {
    const [ax, ay] = local(outer[i]), [bx, by] = local(outer[i + 1]);
    const len = Math.hypot(bx - ax, by - ay);
    if (len > longest) [longest, ux, uy] = [len, (bx - ax) / len, (by - ay) / len];
  }
  const vx = -uy, vy = ux;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of outer) {
    const [x, y] = local(p);
    const u = x * ux + y * uy, v = x * vx + y * vy;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const areaM2 = ringAreaM2(outer, Math.cos((lat0 * Math.PI) / 180));
  const widen = Math.sqrt(Math.max(1, areaM2 / (ORCHARD.ROW_M * ORCHARD.TREE_M) / ORCHARD.MAX_TREES));
  const rowM = ORCHARD.ROW_M * widen, treeM = ORCHARD.TREE_M * widen;
  const type = area.tags.trees === 'palm_trees' ? TREE.PALM : TREE.BROADLEAF;
  const [h0, h1] = ORCHARD.HEIGHT_M;
  const salt = Math.round(lon0 * 1e6) ^ Math.round(lat0 * 1e6);
  for (let i = Math.ceil(minV / rowM); i * rowM <= maxV; i++) {
    for (let j = Math.ceil(minU / treeM); j * treeM <= maxU; j++) {
      const u = j * treeM + (hash2(i, j, salt) * 2 - 1) * ORCHARD.JITTER_M;
      const v = i * rowM + (hash2(i, j, salt + 1) * 2 - 1) * ORCHARD.JITTER_M;
      const lon = lon0 + (u * ux + v * vx) / kx;
      const lat = lat0 + (u * uy + v * vy) / ky;
      if (lon < b.west || lon >= b.east || lat <= b.south || lat > b.north) continue;
      if (!insideRing(lon, lat, outer) || area.rings.slice(1).some((hole) => insideRing(lon, lat, hole))) continue;
      const y = sampleHeight(lon, lat);
      if (y <= 0) continue;
      const [x, z] = enu(lon, lat);
      const packed = snowy(treeRamp?.(lon, lat) ?? RAMP.FOREST);
      pushInstance(out[type], x, y, z, h0 + hash2(i, j, salt + 2) * (h1 - h0), packed, type, yawAt(x, z));
    }
  }
}

/**
 * Yachts in a marina: moored stern-to along both sides of its pontoons (man_made=pier lines), as
 * Mediterranean marinas moor them, one every SLOT_M, a slot taken by OCCUPANCY of them. Only at a
 * marina: a pontoon with a vertex within RADIUS_M of a leisure=marina point or inside a marina
 * area, and only where the yacht lies on the water (the ground at its middle and its bow at or under
 * WATER_MAX_M).
 */
export const MARINA = {
  RADIUS_M: 400,
  SLOT_M: 4.6,
  OCCUPANCY: 0.8,
  /** the stern this far off the pontoon's edge */
  GAP_M: 0.6,
  LENGTH_M: [9, 16] as [number, number],
  SAIL_SHARE: 0.65,
  /** hulls: mostly white, some navy */
  WHITE: [238, 238, 234] as const,
  NAVY: [38, 56, 96] as const,
  NAVY_SHARE: 0.12,
  WATER_MAX_M: 0.3,
  /** a pontoon wider than this is a quay or a pier for ships, not a pontoon */
  MAX_PONTOON_M: 8,
} as const;

/** the pontoons of the marinas among `data`, whole (not clipped to a tile) */
export function marinaPontoons(data: Pick<OsmTileData, 'lines' | 'areas' | 'points'>): OsmLine[] {
  const marinas = data.points.filter((p) => p.tags.leisure === 'marina').map((p) => p.at);
  const areas = data.areas.filter((a) => a.tags.leisure === 'marina');
  if (!marinas.length && !areas.length) return [];
  const near = ([lon, lat]: LonLat): boolean => {
    for (const [mlon, mlat] of marinas) {
      const dx = (lon - mlon) * 111320 * Math.cos((mlat * Math.PI) / 180), dy = (lat - mlat) * 111320;
      if (dx * dx + dy * dy <= MARINA.RADIUS_M * MARINA.RADIUS_M) return true;
    }
    return areas.some((a) => a.rings[0] && insideRing(lon, lat, a.rings[0]));
  };
  return data.lines.filter((l) => l.tags.man_made === 'pier' && pierWidth(l.tags) <= MARINA.MAX_PONTOON_M && l.points.some(near));
}

/** the yachts of `pontoons` whose sterns lie in `tile`: instances by type (SAILBOAT, then MOTORBOAT) */
function mooredYachts(
  pontoons: ReadonlyArray<OsmLine>,
  tile: Tile,
  sampleHeight: HeightSampler,
  enu: (lon: number, lat: number) => [number, number],
): number[][] {
  const out: number[][] = [[], []];
  const b = tileBounds(tile);
  for (const l of pontoons) {
    const half = pierWidth(l.tags) / 2;
    const [lon0, lat0] = l.points[0];
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 111320;
    const salt = Math.round(lon0 * 1e6) ^ Math.round(lat0 * 1e6);
    for (let i = 0; i + 1 < l.points.length; i++) {
      const [alon, alat] = l.points[i], [blon, blat] = l.points[i + 1];
      // the segment in metres east (x), north (y) of its start
      const dx = (blon - alon) * kx, dy = (blat - alat) * ky;
      const len = Math.hypot(dx, dy);
      const slots = Math.floor(len / MARINA.SLOT_M);
      if (slots < 1) continue;
      const ux = dx / len, uy = dy / len;
      for (let k = 0; k < slots; k++) {
        const along = (len - slots * MARINA.SLOT_M) / 2 + (k + 0.5) * MARINA.SLOT_M;
        for (const side of [1, -1]) {
          const r = (n: number) => hash2(i * 4096 + k, side, salt + n);
          if (r(0) >= MARINA.OCCUPANCY) continue;
          // out from the pontoon: its right (side 1) or left, east/north
          const ox = uy * side, oy = -ux * side;
          const length = MARINA.LENGTH_M[0] + r(1) * (MARINA.LENGTH_M[1] - MARINA.LENGTH_M[0]);
          const at = (m: number): LonLat => [alon + (ux * along + ox * m) / kx, alat + (uy * along + oy * m) / ky];
          const stern = at(half + MARINA.GAP_M);
          const [slon, slat] = stern;
          if (slon < b.west || slon >= b.east || slat <= b.south || slat > b.north) continue;
          const mid = at(half + MARINA.GAP_M + length / 2), bow = at(half + MARINA.GAP_M + length);
          if (sampleHeight(mid[0], mid[1]) > MARINA.WATER_MAX_M || sampleHeight(bow[0], bow[1]) > MARINA.WATER_MAX_M) continue;
          const [x, z] = enu(slon, slat);
          // the bow away from the pontoon: (ox, oy) east/north is (ox, −oy) in x, z
          const yaw = Math.atan2(-oy, ox);
          const sail = r(2) < MARINA.SAIL_SHARE;
          const hull = colourOf(r(3) < MARINA.NAVY_SHARE ? [...MARINA.NAVY] : [...MARINA.WHITE]);
          pushInstance(out[sail ? 0 : 1], x, 0, z, length, hull, sail ? INSTANCE.SAILBOAT : INSTANCE.MOTORBOAT, yaw);
        }
      }
    }
  }
  return out;
}

/** Q36 instanced trees of several types + Q7 runway/taxiway light points, deterministic per tile. */
export function buildProps(opts: PropsOptions): PropsData {
  const { tile, data, sampleHeight } = opts;
  if (opts.detail !== 'full') return { trees: new Float32Array(0), lights: new Float32Array(0), yachts: new Float32Array(0) };
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
    const density = Math.max(0, opts.treeDensity ?? 1);
    const count = Math.round(Math.min(FOREST.MAX_TREES, ringAreaM2(outer, cosLat) / FOREST.M2_PER_TREE) * density);
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
      pushInstance(byType[type], x, y, z, h0 + rng() * (h1 - h0), packed, type, yawAt(x, z));
      placed++;
    }
  }
  // orchards from their whole outlines (plantOrchard keeps the trees inside the tile)
  for (const area of data.areas) {
    if (area.tags.landuse === 'orchard') plantOrchard(area, tile, sampleHeight, enu, opts.treeRamp, byType);
  }
  // single trees and tree rows, from the whole rows (each tree kept by the tile it stands in)
  const inTile = (lon: number, lat: number) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const plantOne = (lon: number, lat: number, tags: Record<string, string>): void => {
    if (!inTile(lon, lat)) return;
    const y = sampleHeight(lon, lat);
    if (y <= 0) return;
    const [x, z] = enu(lon, lat);
    const hi = Math.round(lon * 1e6), hj = Math.round(lat * 1e6);
    const type = loneTreeType(tags, treeWeights(climateLatitude(lat, y), tags), hash2(hi, hj, 1));
    const tagged = parseFloat(tags.height);
    const [h0, h1] = TREE_HEIGHT[type];
    const h = Number.isFinite(tagged) ? Math.max(LONE_TREE.HEIGHT_M[0], Math.min(LONE_TREE.HEIGHT_M[1], tagged)) : h0 + hash2(hi, hj, 2) * (h1 - h0);
    pushInstance(byType[type], x, y, z, h, snowy(opts.treeRamp?.(lon, lat) ?? RAMP.FOREST), type, yawAt(x, z));
  };
  for (const p of data.points) if (p.tags.natural === 'tree') plantOne(p.at[0], p.at[1], p.tags);
  for (const l of data.lines) {
    if (l.tags.natural !== 'tree_row' || l.points.length < 2) continue;
    // a tree at the row's start and every ROW_SPACING_M along it (the spacing carried round its bends)
    let next = 0, start = 0;
    for (let i = 0; i + 1 < l.points.length; i++) {
      const [alon, alat] = l.points[i], [blon, blat] = l.points[i + 1];
      const [ax, az] = enu(alon, alat), [bx, bz] = enu(blon, blat);
      const len = Math.hypot(bx - ax, bz - az);
      for (; next <= start + len + 1e-6; next += LONE_TREE.ROW_SPACING_M) {
        const t = len > 0 ? (next - start) / len : 0;
        plantOne(alon + (blon - alon) * t, alat + (blat - alat) * t, l.tags);
      }
      start += len;
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

  // each type's trees in a random order, whatever wood or orchard they stand in: the far tiles draw
  // the first part of each run (TREE_THIN)
  byType.forEach((inst, type) => shuffleInstances(inst, (tile.z * 2654435761) ^ (tile.x * 40503) ^ (tile.y * 69069) ^ type));

  // yachts at the marinas' pontoons, from the whole pontoons (their sterns in the tile)
  const yachts = mooredYachts(marinaPontoons(data), tile, sampleHeight, enu).flat();
  return { trees: new Float32Array(byType.flat()), lights: new Float32Array(lights), yachts: new Float32Array(yachts) };
}