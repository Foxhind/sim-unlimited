/**
 * Landsat imagery → terrain colours, in three steps:
 *   1. stitch: the source tile with its 8 neighbours, so the blur near the border sees real
 *      imagery instead of an edge, and neighbouring tiles get the same colours at the seam;
 *   2. blur: separable Gaussian with sigma in metres (zoom-independent), on the tile plus a
 *      3-sigma margin;
 *   3. quantize: every pixel to the nearest colour of a palette, the default VGA palette or the
 *      k colours of a median cut of this tile (each snapped to VGA).
 * A terrain face then takes the most frequent quantized colour under it.
 */
import { isWaterVga, nearestVga, RAMP, TERRAIN_RAMP_BASE, VGA_PALETTE, type RGB } from '../engine/palette';
import { tileSizeMeters, type Tile } from './geodesy';
import { fetchLandsatTile, landsatSource, type FaceColor, type RgbaImage } from './landsat';

/** settings chosen in the terrain inspector (the inspector starts from these) */
export const LANDSAT_TUNING = {
  /** Gaussian sigma, metres */
  blurM: 360,
  /** median-cut colours, each snapped to VGA */
  colours: 16,
  /** colour patches smaller than this (lattice cells²) merge into a neighbour */
  minAreaCells: 50,
  /** boundary simplification, lattice cells */
  eps: 1,
  /** colour boundaries stop this many lattice cells short of the tile border: their vertices carry
   * the lattice height, the border its simplified profile, and the strip between them tilts by the
   * difference (at 0.5 cells the low sun drew every seam as a line) */
  borderMarginCells: 2.5,
  /** vertices taken from colour boundaries */
  maxVerts: 80,
  /** colour boundaries as fixed TIN edges */
  edges: true,
  /** colour-purity edge flips */
  flips: false,
} as const;

/** image tiles are 256 px */
export const LS_PX = 256;

/** the 3×3 imagery tiles around `s` (row-major, north-west first; x wraps, y clamps to null) */
export function neighbourTiles(s: Tile): Array<Tile | null> {
  const n = 2 ** s.z;
  const out: Array<Tile | null> = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const y = s.y + dy;
      out.push(y < 0 || y >= n ? null : { z: s.z, x: (((s.x + dx) % n) + n) % n, y });
    }
  }
  return out;
}

/** 3×3 tiles into one 768² image; a missing tile is filled by extending the nearest edge of the centre */
export function stitch3x3(tiles: Array<RgbaImage | null>): RgbaImage {
  const W = LS_PX * 3;
  const data = new Uint8ClampedArray(W * W * 4);
  const centre = tiles[4];
  if (!centre) throw new Error('stitch3x3: the centre tile is required');
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      const img = tiles[ty * 3 + tx];
      for (let y = 0; y < LS_PX; y++) {
        for (let x = 0; x < LS_PX; x++) {
          let o: number;
          if (img) o = (y * LS_PX + x) * 4;
          else {
            // clamp into the centre tile
            const cx = Math.max(0, Math.min(LS_PX - 1, x + (tx - 1) * LS_PX));
            const cy = Math.max(0, Math.min(LS_PX - 1, y + (ty - 1) * LS_PX));
            o = (cy * LS_PX + cx) * 4;
          }
          const src = img ?? centre;
          const d = ((ty * LS_PX + y) * W + tx * LS_PX + x) * 4;
          data[d] = src.data[o];
          data[d + 1] = src.data[o + 1];
          data[d + 2] = src.data[o + 2];
          data[d + 3] = 255;
        }
      }
    }
  }
  return { data, width: W, height: W };
}

export function crop(img: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(img.height - 1, y0 + y));
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(img.width - 1, x0 + x));
      const s = (sy * img.width + sx) * 4, d = (y * w + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** separable Gaussian blur (edges clamp); sigma in pixels, 0 = copy */
export function gaussianBlur(img: RgbaImage, sigma: number): RgbaImage {
  const { width: w, height: h } = img;
  if (sigma <= 0.01) return crop(img, 0, 0, w, h);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const o = (y * w + Math.max(0, Math.min(w - 1, x + i))) * 4;
        const f = k[i + r];
        a += img.data[o] * f; b += img.data[o + 1] * f; c += img.data[o + 2] * f;
      }
      const d = (y * w + x) * 3;
      tmp[d] = a; tmp[d + 1] = b; tmp[d + 2] = c;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const o = (Math.max(0, Math.min(h - 1, y + i)) * w + x) * 3;
        const f = k[i + r];
        a += tmp[o] * f; b += tmp[o + 1] * f; c += tmp[o + 2] * f;
      }
      const d = (y * w + x) * 4;
      data[d] = a; data[d + 1] = b; data[d + 2] = c; data[d + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** median cut: up to k representative colours of the image (deterministic) */
export function medianCut(img: RgbaImage, k: number): RGB[] {
  const n = img.width * img.height;
  const px: number[][] = [];
  for (let i = 0; i < n; i++) px.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
  let boxes: number[][][] = [px];
  while (boxes.length < k) {
    // split the box with the widest channel range
    let bi = -1, bc = 0, br = -1;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        if (hi - lo > br) { br = hi - lo; bi = i; bc = c; }
      }
    });
    if (bi < 0 || br <= 0) break;
    const b = boxes[bi].slice().sort((p, q) => p[bc] - q[bc] || p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const m = b.length >> 1;
    boxes = [...boxes.slice(0, bi), b.slice(0, m), b.slice(m), ...boxes.slice(bi + 1)];
  }
  return boxes.map((b) => {
    const s = [0, 0, 0];
    for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return [s[0] / b.length, s[1] / b.length, s[2] / b.length] as RGB;
  });
}

export interface Quantized {
  /** VGA palette index per pixel */
  index: Uint8Array;
  /** the quantized image (VGA colours) */
  image: RgbaImage;
  /** distinct VGA indices used */
  used: number[];
}

/** nearest of `palette` (VGA indices) for every pixel */
export function quantize(img: RgbaImage, palette: number[]): Quantized {
  const n = img.width * img.height;
  const index = new Uint8Array(n);
  const data = new Uint8ClampedArray(n * 4);
  const memo = new Map<number, number>();
  const used = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let best = memo.get(key);
    if (best === undefined) {
      let bd = Infinity;
      best = palette[0];
      for (const v of palette) {
        const [pr, pg, pb] = VGA_PALETTE[v];
        const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
      memo.set(key, best);
    }
    index[i] = best;
    used.add(best);
    const c = VGA_PALETTE[best];
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return { index, image: { data, width: img.width, height: img.height }, used: [...used].sort((a, b) => a - b) };
}

/** all usable VGA entries (the black filler 248..255 excluded) */
export const FULL_VGA = Array.from({ length: 248 }, (_, i) => i);

export interface LandsatOptions {
  /** Gaussian sigma in metres on the ground (0 = no blur) */
  blurM: number;
  /** 0: the full VGA palette; k > 0: a median cut to k colours, each snapped to VGA */
  colours: number;
}

export interface ProcessedLandsat {
  /** the tile's part of the stitched mosaic, before processing */
  raw: RgbaImage;
  blurred: RgbaImage;
  quantized: Quantized;
  /** VGA indices the quantizer could choose */
  palette: number[];
  sigmaPx: number;
}

/**
 * Process the stitched 3×3 mosaic around landsatSource(tile).tile for `tile`: blur over the tile
 * plus a margin, crop to the tile, quantize.
 */
export function processLandsat(mosaic: RgbaImage, tile: Tile, opts: LandsatOptions): ProcessedLandsat {
  const src = landsatSource(tile);
  const pxM = tileSizeMeters(src.tile) / LS_PX;
  const sigmaPx = Math.max(0, opts.blurM / pxM);
  const size = Math.max(1, Math.round(src.scale * LS_PX));
  const x0 = LS_PX + Math.round(src.x0 * LS_PX), y0 = LS_PX + Math.round(src.y0 * LS_PX);
  const m = Math.min(LS_PX, Math.ceil(sigmaPx * 3));
  const blurredWide = gaussianBlur(crop(mosaic, x0 - m, y0 - m, size + 2 * m, size + 2 * m), sigmaPx);
  const blurred = crop(blurredWide, m, m, size, size);
  let palette = FULL_VGA;
  if (opts.colours > 0) palette = [...new Set(medianCut(blurred, opts.colours).map((c) => nearestVga(c[0], c[1], c[2])))];
  return { raw: crop(mosaic, x0, y0, size, size), blurred, quantized: quantize(blurred, palette), palette, sigmaPx };
}

/**
 * Face colour = the most frequent quantized colour among the pixels whose centres fall in the
 * face (the centroid pixel for a face thinner than a pixel); ties go to the lower VGA index.
 * Imagery water (a clearly blue colour) gets the one water ramp, like the sea and OSM water.
 */
export function faceColorByMode(q: Quantized, size: number, grid: number): FaceColor {
  const k = size / grid;
  const counts = new Uint32Array(256);
  return (ax, ay, bx, by, cx, cy) => {
    const x0 = ax * k, y0 = ay * k, x1 = bx * k, y1 = by * k, x2 = cx * k, y2 = cy * k;
    const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    counts.fill(0);
    let n = 0;
    if (d !== 0) {
      const i0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), i1 = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
      const j0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), j1 = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const sx = i + 0.5, sy = j + 0.5;
          const w1 = ((sx - x0) * (y2 - y0) - (x2 - x0) * (sy - y0)) / d;
          const w2 = ((x1 - x0) * (sy - y0) - (sx - x0) * (y1 - y0)) / d;
          if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
          counts[q.index[j * size + i]]++;
          n++;
        }
      }
    }
    if (!n) {
      const i = Math.max(0, Math.min(size - 1, Math.floor((x0 + x1 + x2) / 3)));
      const j = Math.max(0, Math.min(size - 1, Math.floor((y0 + y1 + y2) / 3)));
      const v = q.index[j * size + i];
      return isWaterVga(v) ? RAMP.WATER : TERRAIN_RAMP_BASE + v;
    }
    let best = 0;
    for (let v = 1; v < 256; v++) if (counts[v] > counts[best]) best = v;
    return isWaterVga(best) ? RAMP.WATER : TERRAIN_RAMP_BASE + best;
  };
}

// ---------- colour boundaries for the TIN ----------

/**
 * Merge patches smaller than `minPx` pixels (4-connected) into their most common neighbouring
 * colour, smallest first, so only boundaries of sizeable areas reach the mesh. Deterministic.
 */
export function cleanLabels(index: Uint8Array, size: number, minPx: number): Uint8Array {
  const lab = Uint8Array.from(index);
  if (minPx <= 1) return lab;
  for (let iter = 0; iter < 32; iter++) {
    const comp = new Int32Array(size * size).fill(-1);
    const comps: number[][] = [];
    for (let s = 0; s < size * size; s++) {
      if (comp[s] >= 0) continue;
      const id = comps.length, px: number[] = [s];
      comp[s] = id;
      for (let h = 0; h < px.length; h++) {
        const k = px[h], x = k % size, y = (k - x) / size;
        for (const n of [x > 0 ? k - 1 : -1, x < size - 1 ? k + 1 : -1, y > 0 ? k - size : -1, y < size - 1 ? k + size : -1]) {
          if (n >= 0 && comp[n] < 0 && lab[n] === lab[s]) { comp[n] = id; px.push(n); }
        }
      }
      comps.push(px);
    }
    const small = comps.map((px, id) => [px.length, id]).filter(([n]) => n < minPx).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!small.length) break;
    let changed = 0;
    for (const [, id] of small) {
      const px = comps[id];
      const own = lab[px[0]];
      if (px.some((k) => lab[k] !== own)) continue; // already merged this round via a neighbour
      const votes = new Uint32Array(256);
      for (const k of px) {
        const x = k % size, y = (k - x) / size;
        for (const n of [x > 0 ? k - 1 : -1, x < size - 1 ? k + 1 : -1, y > 0 ? k - size : -1, y < size - 1 ? k + size : -1]) {
          if (n >= 0 && comp[n] !== id) votes[lab[n]]++;
        }
      }
      let best = -1;
      for (let v = 0; v < 256; v++) if (votes[v] && (best < 0 || votes[v] > votes[best])) best = v;
      if (best < 0 || best === own) continue;
      for (const k of px) lab[k] = best;
      changed++;
    }
    if (!changed) break;
  }
  return lab;
}

export interface ColourLine {
  /** lattice coordinates; a closed ring repeats its first point at the end */
  pts: Array<{ x: number; y: number }>;
  closed: boolean;
}

/**
 * Boundaries between colours as polylines in lattice coordinates: pixel edges between different
 * labels, chained between junctions (where three or more colours meet) or into rings, simplified
 * (Douglas–Peucker, `eps` lattice cells) and kept `margin` cells away from the tile border, where
 * the shared border profile rules. Longest first.
 */
export function colourBoundaries(lab: Uint8Array, size: number, grid: number, eps: number, margin = 0.5): ColourLine[] {
  const S = size + 1; // pixel-corner nodes
  const adj: number[][] = Array.from({ length: S * S }, () => []);
  const link = (a: number, b: number) => { adj[a].push(b); adj[b].push(a); };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = lab[y * size + x];
      if (x + 1 < size && lab[y * size + x + 1] !== l) link(y * S + x + 1, (y + 1) * S + x + 1);
      if (y + 1 < size && lab[(y + 1) * size + x] !== l) link((y + 1) * S + x, (y + 1) * S + x + 1);
    }
  }
  const used = new Set<number>();
  const ekey = (a: number, b: number) => (a < b ? a * S * S + b : b * S * S + a);
  const walk = (start: number, next: number): number[] => {
    const path = [start];
    let prev = start, cur = next;
    used.add(ekey(start, next));
    for (;;) {
      path.push(cur);
      if (adj[cur].length !== 2 || cur === start) break;
      const nx = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
      if (used.has(ekey(cur, nx))) break;
      used.add(ekey(cur, nx));
      prev = cur;
      cur = nx;
    }
    return path;
  };
  const raw: number[][] = [];
  for (let n = 0; n < S * S; n++) {
    if (adj[n].length === 0 || adj[n].length === 2) continue;
    for (const m of [...adj[n]].sort((a, b) => a - b)) if (!used.has(ekey(n, m))) raw.push(walk(n, m));
  }
  for (let n = 0; n < S * S; n++) {
    for (const m of adj[n]) if (!used.has(ekey(n, m))) raw.push(walk(n, m)); // rings
  }
  const k = grid / size;
  const out: ColourLine[] = [];
  for (const path of raw) {
    const closed = path[0] === path[path.length - 1];
    const pts = path.map((n) => ({ x: (n % S) * k, y: Math.floor(n / S) * k }));
    const simple = closed ? simplifyRing(pts, eps) : douglasPeucker(pts, eps);
    // clip to the box `margin` inside the border (Liang–Barsky per segment)
    const lo = margin, hi = grid - margin;
    const inside = (p: P) => p.x >= lo && p.y >= lo && p.x <= hi && p.y <= hi;
    if (closed && simple.every(inside)) {
      if (simple.length >= 4) out.push({ pts: simple, closed: true });
      continue;
    }
    let run: P[] = [];
    const flush = () => { if (run.length >= 2) out.push({ pts: run, closed: false }); run = []; };
    for (let i = 0; i + 1 < simple.length; i++) {
      const a = simple[i], b = simple[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      let t0 = 0, t1 = 1, ok = true;
      for (const [pp, q] of [[-dx, a.x - lo], [dx, hi - a.x], [-dy, a.y - lo], [dy, hi - a.y]]) {
        if (pp === 0) { if (q < 0) ok = false; continue; }
        const r = q / pp;
        if (pp < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
      }
      if (!ok || t0 >= t1) { flush(); continue; }
      const s0 = t0 === 0 ? a : { x: a.x + dx * t0, y: a.y + dy * t0 };
      const s1 = t1 === 1 ? b : { x: a.x + dx * t1, y: a.y + dy * t1 };
      if (t0 > 0) flush();
      if (!run.length) run.push(s0);
      run.push(s1);
      if (t1 < 1) flush();
    }
    flush();
  }
  const len = (l: ColourLine) => l.pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - l.pts[i - 1].x, p.y - l.pts[i - 1].y) : 0), 0);
  return out
    .map((l) => ({ l, n: len(l) }))
    .sort((a, b) => b.n - a.n || a.l.pts[0].y - b.l.pts[0].y || a.l.pts[0].x - b.l.pts[0].x)
    .map((e) => e.l);
}

type P = { x: number; y: number };
function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}
function douglasPeucker(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let best = -1, bd = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(pts[i], pts[lo], pts[hi]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([lo, best], [best, hi]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** a closed ring (first = last): split at the point farthest from the start */
function simplifyRing(pts: P[], eps: number): P[] {
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > fd) { fd = d; far = i; }
  }
  const a = douglasPeucker(pts.slice(0, far + 1), eps), b = douglasPeucker(pts.slice(far), eps);
  return [...a, ...b.slice(1)];
}

// ---------- the game's terrain colouring ----------

export interface LandsatTerrain {
  /** colour boundaries for buildTerrainTin (lattice coordinates, longest first) */
  lines: ColourLine[];
  maxVerts: number;
  /** face colour: most frequent quantized colour under the face */
  faceColor: FaceColor;
}

/**
 * The 3×3 imagery mosaic around `t`'s imagery tile. Any failed fetch throws (a retry later then
 * sees the same imagery), so every consumer of a tile builds its TIN from identical input.
 */
export async function fetchLandsatMosaic(t: Tile): Promise<RgbaImage> {
  const tiles = neighbourTiles(landsatSource(t).tile);
  return stitch3x3(await Promise.all(tiles.map((n) => (n ? fetchLandsatTile(n) : Promise.resolve(null)))));
}

/** imagery → colour boundaries and face colours for a terrain tile, with the inspector-tuned settings */
export function landsatTerrain(mosaic: RgbaImage, tile: Tile, grid: number, tuning: typeof LANDSAT_TUNING = LANDSAT_TUNING): LandsatTerrain {
  const p = processLandsat(mosaic, tile, { blurM: tuning.blurM, colours: tuning.colours });
  const size = p.quantized.image.width;
  const lines = tuning.edges
    ? colourBoundaries(cleanLabels(p.quantized.index, size, tuning.minAreaCells * (size / grid) ** 2), size, grid, tuning.eps, tuning.borderMarginCells)
    : [];
  return { lines, maxVerts: tuning.maxVerts, faceColor: faceColorByMode(p.quantized, size, grid) };
}

/**
 * Landsat colouring of a terrain tile, or null when the imagery is unreachable: callers then
 * build the plain TIN and must not cache the result, so the tile is rebuilt with imagery later.
 * Shared by the terrain mesh, the OSM drape and the collision probe, which must see one surface.
 */
export async function loadLandsatTerrain(tile: Tile, grid: number): Promise<LandsatTerrain | null> {
  try {
    return landsatTerrain(await fetchLandsatMosaic(tile), tile, grid);
  } catch (err) {
    console.warn(`[landsat] ${tile.z}/${tile.x}/${tile.y}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
