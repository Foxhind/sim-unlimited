/**
 * Clouds (Q46): the weather's cloud layers as flat-shaded geometry in the game's style.
 *
 * Two looks, picked by how much of the sky a layer covers:
 *  - cumulus (scattered and broken): each cloud is a heap of a few jittered icosahedra ("puffs")
 *    cut flat at the layer's base, lit in steps like everything else: white tops, grey bellies;
 *  - deck (overcast, DECK_COVER and above): a continuous slab, a bumpy faceted top seen from above
 *    (a sea of clouds) and a grey ceiling seen from below.
 * Inside a cloud the view is whited out with a dither veil (renderer.drawVeil), its density from
 * cloudDensity / deckDensity.
 *
 * Everything here is pure and deterministic: a layer is cut into square tiles of TILE_M in a fixed
 * east/north frame (the cloud frame, see cloud-field.ts), and a tile's clouds come from a hash of
 * its global cell indices, so neighbouring tiles agree and a tile rebuilt later is the same.
 * Meshes are in the tile's local frame (x east of the tile centre, y up = metres MSL, z south).
 */

/** what the weather says about the clouds */
export interface CloudInput {
  /** total cover, %: the low layer's cover when the layers are not known */
  cloudPct: number;
  cloudLowPct?: number;
  cloudMidPct?: number;
  tempC?: number;
  dewPointC?: number;
  /** ground height of the observation, m MSL */
  elevation: number;
  /** forced base of the low layer above the ground, m (URL ?clouds=80,900) */
  baseAgl?: number;
}

export type CloudKind = 'cumulus' | 'deck';

export interface CloudLayer {
  id: 'low' | 'mid';
  kind: CloudKind;
  /** fraction of the sky covered, 0..1 (steps of 0.05) */
  cover: number;
  /** base and top, m MSL */
  base: number;
  top: number;
  /** puff height over the cumulus look (mid-level clouds are flatter) */
  flat: number;
  seed: number;
  /** changes whenever the layer's geometry would */
  key: string;
}

/** a layer this thin or thinner is not drawn */
export const MIN_COVER = 0.05;
/** from this cover on a layer is a continuous deck */
export const DECK_COVER = 0.85;
/** the low cloud base above the ground per degree of temperature-dew point spread, m (the usual 400 ft/°C) */
export const BASE_PER_SPREAD_M = 125;
export const BASE_MIN_AGL = 250;
export const BASE_MAX_AGL = 3000;
/** low cloud base when the dew point is not known, m above the ground */
export const BASE_DEFAULT_AGL = 1200;
/** side of a cloud tile, m */
export const TILE_M = 16000;
/** cumulus: side of a cell (up to CLOUDS_PER_CELL clouds each), m */
export const CELL_M = 2000;
const CELLS = TILE_M / CELL_M;
const CLOUDS_PER_CELL = 2;
/** deck: grid of the surfaces, m, and how far its top and bottom go up and down */
export const DECK_GRID_M = 1000;
const DECK_N = TILE_M / DECK_GRID_M;
const DECK_TOP_BUMP = 140;
const DECK_BOTTOM_BUMP = 40;
const DECK_JITTER = 0.4;
/** face colour of the clouds (RGB, lit and fogged in the world shader) */
export const CLOUD_RGB = 0xf2f4f7;

const step = (v: number, s: number): number => Math.round(v / s) * s;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** height of the low cloud base above the ground from the temperature and dew point, m */
export function cloudBaseAgl(tempC: number | undefined, dewPointC: number | undefined): number {
  if (tempC === undefined || dewPointC === undefined || !Number.isFinite(tempC) || !Number.isFinite(dewPointC)) return BASE_DEFAULT_AGL;
  return clamp(BASE_PER_SPREAD_M * (tempC - dewPointC), BASE_MIN_AGL, BASE_MAX_AGL);
}

/** a layer of `cover` (0..1, rounded to 0.05) and thickness `thick(cover, kind)`, or none when too thin */
function layer(id: CloudLayer['id'], cover: number, base: number, thick: (c: number, kind: CloudKind) => number, flat: number, seed: number): CloudLayer | undefined {
  if (!(cover >= MIN_COVER)) return undefined;
  const c = clamp(Math.round(cover * 20) / 20, 0, 1);
  const kind: CloudKind = c >= DECK_COVER ? 'deck' : 'cumulus';
  const b = step(base, 50);
  const top = b + step(thick(c, kind), 50);
  return { id, kind, cover: c, base: b, top, flat, seed, key: `${id}:${kind}:${c.toFixed(2)}:${b}:${top}` };
}

/**
 * The cloud layers of the weather, low first: the low layer at the base from the dew point spread
 * (cumulus grows taller the more of the sky it covers), the mid layer (altocumulus, flatter) at
 * 3.5 km or 2.5 km above the ground, whichever is higher, and above the low one. High clouds
 * (cirrus) are not drawn.
 */
export function cloudLayers(c: CloudInput | undefined): CloudLayer[] {
  if (!c) return [];
  const layered = c.cloudLowPct !== undefined && c.baseAgl === undefined;
  const lowPct = layered ? c.cloudLowPct! : c.cloudPct;
  const midPct = layered ? c.cloudMidPct ?? 0 : 0;
  const out: CloudLayer[] = [];
  const lowCover = lowPct / 100;
  const low = layer('low', lowCover, c.elevation + (c.baseAgl ?? cloudBaseAgl(c.tempC, c.dewPointC)),
    (cv, kind) => (kind === 'deck' ? 600 : 300 + 1200 * cv), 1, 0x51ab);
  if (low) out.push(low);
  const midCover = midPct / 100;
  const mid = layer('mid', midCover, Math.max(3500, c.elevation + 2500, (low?.top ?? 0) + 600),
    (cv, kind) => (kind === 'deck' ? 500 : 250 + 350 * cv), 0.6, 0x3c27);
  if (mid) out.push(mid);
  return out;
}

/** integer hash of four ints → [0, 1) */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function rng(seed: number): () => number {
  let s = Math.floor(seed * 4294967296) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** one puff of a cumulus cloud: an ellipsoid (centre, radii) cut flat at `floor` (tile frame) */
export interface Puff {
  c: [number, number, number];
  r: [number, number, number];
  floor: number;
}

/** a tile's mesh: pos.xyz + normal.xyz per vertex, a face colour per vertex */
export interface CloudMesh {
  verts: Float32Array;
  ramps: Uint32Array;
  /** the puffs, for cloudDensity (cumulus tiles; empty for decks) */
  puffs: Puff[];
}

class Builder {
  v: number[] = [];
  /**
   * A flat-shaded triangle; its normal is turned to point along `out` (away from the puff's centre,
   * up for a deck top...): the winding does not matter, there is no culling.
   */
  tri(a: number[], b: number[], c: number[], ox: number, oy: number, oz: number): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-3) return; // degenerate (squashed flat onto the base)
    nx /= len; ny /= len; nz /= len;
    if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) this.v.push(p[0], p[1], p[2], nx, ny, nz);
  }
  mesh(puffs: Puff[]): CloudMesh {
    const verts = new Float32Array(this.v);
    return { verts, ramps: new Uint32Array(verts.length / 6).fill(CLOUD_RGB), puffs };
  }
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V: [number, number, number][] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
].map(([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
});
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function addPuff(b: Builder, p: Puff, yaw: number, rand: () => number): void {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const pts = ICO_V.map(([x, y, z]) => {
    const j = 0.82 + 0.36 * rand();
    const lx = x * p.r[0] * j, lz = z * p.r[2] * j;
    return [p.c[0] + lx * cs - lz * sn, Math.max(p.c[1] + y * p.r[1] * j, p.floor), p.c[2] + lx * sn + lz * cs];
  });
  for (const [i, j, k] of ICO_F) {
    const a = pts[i], bb = pts[j], c = pts[k];
    b.tri(a, bb, c, (a[0] + bb[0] + c[0]) / 3 - p.c[0], (a[1] + bb[1] + c[1]) / 3 - p.c[1], (a[2] + bb[2] + c[2]) / 3 - p.c[2]);
  }
}

/** the clouds of a cumulus layer in tile (ti, tj) of the cloud frame (tile centre at ((ti+½)·TILE_M, (tj+½)·TILE_M) east, north) */
export function cumulusTile(l: CloudLayer, ti: number, tj: number): CloudMesh {
  const b = new Builder();
  const puffs: Puff[] = [];
  const thick = l.top - l.base;
  for (let ci = 0; ci < CELLS; ci++) {
    for (let cj = 0; cj < CELLS; cj++) {
      const rand = rng(hash4(l.seed, ti * CELLS + ci, tj * CELLS + cj, 7));
      for (let k = 0; k < CLOUDS_PER_CELL; k++) {
        const here = rand() < l.cover;
        // draw the same numbers whether or not the cloud is there, so the others don't move
        const fx = rand(), fz = rand(), fr = rand(), fh = rand(), n = 2 + Math.floor(rand() * 4), seed = rand();
        if (!here) continue;
        const x = (ci + fx) * CELL_M - TILE_M / 2;
        const z = -((cj + fz) * CELL_M - TILE_M / 2);
        const R = (300 + 900 * l.cover) * (0.6 + 0.8 * fr);
        const H = thick * (0.45 + 0.55 * fh) * l.flat;
        const pr = rng(seed);
        const cloud: Puff[] = [
          { c: [x, l.base + 0.42 * H, z], r: [R, 0.58 * H, R * (0.75 + 0.3 * pr())], floor: l.base },
        ];
        for (let i = 0; i < n; i++) {
          const a = pr() * Math.PI * 2, d = R * (0.35 + 0.45 * pr()), rr = R * (0.4 + 0.3 * pr());
          const cy = l.base + H * (0.25 + 0.35 * pr());
          cloud.push({ c: [x + Math.cos(a) * d, cy, z + Math.sin(a) * d], r: [rr, H * (0.3 + 0.2 * pr()), rr], floor: l.base + 2 * (i + 1) });
        }
        // a crown on top, off centre
        const a = pr() * Math.PI * 2;
        cloud.push({ c: [x + Math.cos(a) * R * 0.2, l.base + 0.72 * H, z + Math.sin(a) * R * 0.2], r: [R * 0.5, 0.3 * H, R * 0.5], floor: l.base + 2 * (n + 1) });
        for (const p of cloud) addPuff(b, p, pr() * Math.PI * 2, pr);
        puffs.push(...cloud);
      }
    }
  }
  return b.mesh(puffs);
}

/** a deck layer in tile (ti, tj): the top and bottom surfaces, continuous across tiles */
export function deckTile(l: CloudLayer, ti: number, tj: number): CloudMesh {
  const b = new Builder();
  const N = DECK_N;
  const gx0 = ti * N, gy0 = tj * N;
  const vert = (i: number, j: number, top: boolean): number[] => {
    const gx = gx0 + i, gy = gy0 + j;
    const jx = (hash4(l.seed, gx, gy, 3) - 0.5) * DECK_JITTER * DECK_GRID_M;
    const jy = (hash4(l.seed, gx, gy, 4) - 0.5) * DECK_JITTER * DECK_GRID_M;
    const h = top
      ? l.top + (hash4(l.seed, gx, gy, 1) - 0.5) * 2 * DECK_TOP_BUMP
      : l.base + (hash4(l.seed, gx, gy, 2) - 0.5) * 2 * DECK_BOTTOM_BUMP;
    return [i * DECK_GRID_M - TILE_M / 2 + jx, h, -(j * DECK_GRID_M - TILE_M / 2 + jy)];
  };
  for (const top of [true, false]) {
    const up = top ? 1 : -1;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p00 = vert(i, j, top), p10 = vert(i + 1, j, top), p01 = vert(i, j + 1, top), p11 = vert(i + 1, j + 1, top);
        if (hash4(l.seed, gx0 + i, gy0 + j, 5) < 0.5) {
          b.tri(p00, p10, p11, 0, up, 0);
          b.tri(p00, p11, p01, 0, up, 0);
        } else {
          b.tri(p00, p10, p01, 0, up, 0);
          b.tri(p10, p11, p01, 0, up, 0);
        }
      }
    }
  }
  return b.mesh([]);
}

/** how deep the edge of a puff fades in the veil, as a share of its radius */
const PUFF_EDGE = 0.3;

/** density of the cloud at a point of the tile frame, 0..1 (the veil): the densest puff it is in */
export function cloudDensity(puffs: readonly Puff[], x: number, y: number, z: number): number {
  let best = 0;
  for (const p of puffs) {
    if (y < p.floor) continue;
    // the puff is turned about the vertical (addPuff): its wider radius stands for both horizontal ones
    const dh = Math.hypot(x - p.c[0], z - p.c[2]) / Math.max(p.r[0], p.r[2]), dy = (y - p.c[1]) / p.r[1];
    const q = Math.sqrt(dh * dh + dy * dy);
    if (q < 1) best = Math.max(best, Math.min(1, (1 - q) / PUFF_EDGE));
    if (best >= 1) break;
  }
  return best;
}

/** density of a deck at height y, 0..1: thin in its bumpy skins, whole in the middle */
export function deckDensity(l: CloudLayer, y: number): number {
  const lower = l.base + DECK_BOTTOM_BUMP, upper = l.top - DECK_TOP_BUMP;
  if (y <= lower || y >= upper) return 0;
  return clamp(0.25 + Math.min(y - lower, upper - y) / 120, 0, 1);
}
