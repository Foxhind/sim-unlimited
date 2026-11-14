import {
  constrainedDelaunay,
  contourLevels,
  extractIsolines,
  simplifyOpen,
  type Polyline,
  type Pt,
  type Tri,
} from './contours';
import { tileRowMeters, type Tile } from './geodesy';
import type { HeightSampler, TileBorders } from './terrain-source';

/** Vertical thickness of one belt, the same at every zoom (tuned in the terrain inspector). */
export const BELT_STEP = 250;

export function beltStepForZoom(_z: number): number {
  return BELT_STEP;
}

/** budget for contour vertices per tile; the (fixed-tolerance) border comes on top */
export const MAX_VERTS = 100;
/** isoline simplification tolerance in lattice cells: starting value and the loosest allowed */
export const EPS_START = 2;
export const EPS_MAX = 3;

/**
 * The coastline is traced just above sea level, so every node at or below 0 m lies outside it
 * (Terrarium seas are mostly exactly 0 m, with a few pixels slightly below). Its vertices get
 * height 0: the sea becomes its own region of triangles at 0 m — a flat water surface — instead
 * of sharing the lowest belt with the coastal plain.
 */
export const COAST_LEVEL = 0.5;

/** belt boundary levels: the coastline (when the tile has sea) and multiples of `step` above 0 */
function beltLevels(minH: number, maxH: number, step: number): number[] {
  const levels = contourLevels(minH, maxH, step).filter((l) => l > 0);
  if (minH <= 0 && maxH > COAST_LEVEL) levels.unshift(COAST_LEVEL);
  return levels;
}
/** height of an isoline's vertices: its level, sea level for the coastline */
const lineHeight = (level: number) => (level === COAST_LEVEL ? 0 : level);

/** Simplified isoline TIN of one tile, in lattice coordinates [0, grid]². */
export interface TerrainTin {
  grid: number;
  vx: number[];
  vy: number[];
  /** raw elevation per vertex (contour vertices sit exactly on their level) */
  vh: number[];
  tris: Tri[];
  /**
   * Stitching to a coarser neighbour, per vertex (present when the borders carry `coarse`):
   * `edges` — bits of the edges the vertex lies on that are also the parent's boundary
   * (1 n, 2 s, 4 w, 8 e); `dh` — metres from the vertex to the parent's border line there (both
   * clamped to sea level). The renderer adds `dh` on the edges whose neighbour is coarser.
   */
  coarse?: { dh: number[]; edges: number[] };
}

/**
 * Belt TIN. The isolines every `step` meters are the belt boundaries: every vertex lies on one of
 * them (at exactly its level) or on the shared tile border. Steps:
 *   1. marching squares traces the isolines (asymptotic decider → lines of different levels
 *      never cross);
 *   2. Douglas–Peucker simplifies them, then segments that cross another line or the border are
 *      refined back towards the raw line until no two boundaries cross (topology preserved);
 *   3. constrained Delaunay with every boundary segment as a fixed edge: no triangle crosses an
 *      isoline, so each triangle lies inside one belt;
 *   4. free edges are flipped so a triangle spans its belt (touches both boundaries) instead of
 *      lying flat on one of them.
 * Pure and deterministic: the mesh, the collision probe and the OSM drape all call this with the
 * same lattice and see the same surface.
 */
export interface TinOptions {
  step?: number;
  eps?: number;
  /** shared edge profiles (see TileBorders); without them the lattice edge nodes are used */
  borders?: TileBorders;
  /** vertical tolerance of the simplified tile border, metres (default: BORDER_TOL_CELLS of a cell) */
  borderTol?: number;
  /** filled with intermediate results when given (inspector tool); does not change the output */
  debug?: TinDebug;
  /** colour labels over the tile: free edges are also flipped toward single-colour triangles */
  colour?: ColourLabels;
  /** colour boundaries (lattice coordinates) forced in as fixed edges, longest first */
  colourLines?: { lines: Array<{ pts: Pt[]; closed: boolean }>; maxVerts?: number };
}

/**
 * Vertical tolerance of the tile border, as a share of the lattice cell (and its cap in metres).
 * The border is a simplified line; the nearest interior vertices (colour boundaries, 2.5 cells
 * in) sit on the lattice surface itself. Whatever the line is off by therefore tilts the strip
 * between them, and how much depends on the strip's width, not on metres: 20 m of error was a
 * 24 deg kink along the seam of a z14 tile (24 m cells) and nothing on a z10 one. A fifth of a
 * cell keeps that tilt under ~5 deg at every zoom: ~5 m at z14, ~25 m at z12, the cap from z11.
 */
export const BORDER_TOL_CELLS = 0.2;
export const BORDER_TOL_MAX_M = 40;

/** default cap on vertices taken from colour boundaries (crossings with isolines come on top) */
export const MAX_COLOUR_VERTS = 80;

/**
 * Quantized imagery over the tile, `size`² pixels covering lattice [0, grid]² (row-major, north
 * first). The final flip pass prefers, after fewer flat triangles, the diagonal whose two
 * triangles hold fewer pixels off their own majority colour, while the lattice error under the
 * quad stays within `maxDh` metres (or does not grow where it is already larger).
 */
export interface ColourLabels {
  label: Uint8Array;
  size: number;
  /** height-error allowance for a colour flip, metres (default: step × REFINE_TOL) */
  maxDh?: number;
}

export interface TinDebug {
  /** belt step and simplification tolerance actually used (after budget escalation) */
  step?: number;
  eps?: number;
  /** raw marching-squares isolines at the final step, before simplification */
  raw?: Polyline[];
  /** fixed edges (vertex ids): border chain and simplified isolines */
  constraints?: Array<[number, number]>;
  /** constraints the triangulation could not insert */
  missing?: number;
  /** number of leading vertices on the tile border */
  borderVerts?: number;
  /** vertices added by error-driven refinement */
  refined?: number;
  /** flips made for colour purity in the last triangulation */
  colourFlips?: number;
  /** colour-boundary vertices and their crossings with isolines in the last triangulation */
  colourVerts?: number;
  colourCrossings?: number;
}

/** one isoline being simplified: raw points (rings repeat point 0 at the end) and a keep-mask */
interface Chain {
  level: number;
  pts: Pt[];
  keep: Uint8Array;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** keep the raw point of (lo, hi) farthest from the chord; false when the span is already raw */
function refine(c: Chain, lo: number, hi: number): boolean {
  let best = -1, bd = -1;
  for (let k = lo + 1; k < hi; k++) {
    const d = distToSeg(c.pts[k], c.pts[lo], c.pts[hi]);
    if (d > bd) {
      bd = d;
      best = k;
    }
  }
  if (best < 0) return false;
  c.keep[best] = 1;
  return true;
}

function dpInto(c: Chain, lo: number, hi: number, eps: number): void {
  const stack: Array<[number, number]> = [[lo, hi]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, wd = eps;
    for (let k = a + 1; k < b; k++) {
      const d = distToSeg(c.pts[k], c.pts[a], c.pts[b]);
      if (d > wd) {
        wd = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      c.keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
}

function makeChain(line: Polyline, eps: number): Chain {
  const pts = line.closed ? [...line.pts, line.pts[0]] : line.pts;
  const c: Chain = { level: line.level, pts, keep: new Uint8Array(pts.length) };
  const last = pts.length - 1;
  c.keep[0] = c.keep[last] = 1;
  if (line.closed) {
    // split the ring at the point farthest from its start, so it keeps at least a triangle
    let far = 1, fd = -1;
    for (let k = 1; k < last; k++) {
      const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y);
      if (d > fd) {
        fd = d;
        far = k;
      }
    }
    c.keep[far] = 1;
    dpInto(c, 0, far, eps);
    dpInto(c, far, last, eps);
    if (c.keep.reduce((s, v) => s + v, 0) < 4) refine(c, 0, far) || refine(c, far, last);
  } else {
    dpInto(c, 0, last, eps);
  }
  return c;
}

const orient2 = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** segments ab and cd cross or touch away from a shared endpoint */
function segsMeet(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const same = (p: Pt, q: Pt) => p.x === q.x && p.y === q.y;
  const tol = 1e-9;
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) {
    if ((same(a, c) && same(b, d)) || (same(a, d) && same(b, c))) return false; // the same edge
    // sharing one end they can still overlap: e.g. an isoline chord running along the tile edge
    // over a border vertex. Then the far end of one lies on the other.
    const [p, q] = same(a, c) || same(a, d) ? [b, same(a, c) ? d : c] : [a, same(b, c) ? d : c];
    return distToSeg(q, a, b) < tol || distToSeg(p, c, d) < tol;
  }
  const o1 = orient2(a, b, c), o2 = orient2(a, b, d), o3 = orient2(c, d, a), o4 = orient2(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  // a point (almost) on the other segment would split a fixed edge
  return distToSeg(c, a, b) < tol || distToSeg(d, a, b) < tol || distToSeg(a, c, d) < tol || distToSeg(b, c, d) < tol;
}

interface Seg {
  a: Pt;
  b: Pt;
  chain: number; // −1 for the tile border
  lo: number;
  hi: number;
}

/** refine chains until no two boundary segments (isolines or border) meet; deterministic */
function untangle(chains: Chain[], border: Seg[]): void {
  for (let iter = 0; iter < 500; iter++) {
    const segs: Seg[] = [...border];
    chains.forEach((c, ci) => {
      let lo = 0;
      for (let k = 1; k < c.pts.length; k++) {
        if (!c.keep[k]) continue;
        segs.push({ a: c.pts[lo], b: c.pts[k], chain: ci, lo, hi: k });
        lo = k;
      }
    });
    const minX = (s: Seg) => Math.min(s.a.x, s.b.x);
    const order = segs.map((_, i) => i).sort((i, j) => minX(segs[i]) - minX(segs[j]) || i - j);
    const bad = new Set<number>();
    for (let oi = 0; oi < order.length; oi++) {
      const s = segs[order[oi]];
      const sx1 = Math.max(s.a.x, s.b.x), sy0 = Math.min(s.a.y, s.b.y), sy1 = Math.max(s.a.y, s.b.y);
      for (let oj = oi + 1; oj < order.length; oj++) {
        const t = segs[order[oj]];
        if (minX(t) > sx1 + 1e-9) break;
        if (Math.min(t.a.y, t.b.y) > sy1 + 1e-9 || Math.max(t.a.y, t.b.y) < sy0 - 1e-9) continue;
        if (!segsMeet(s.a, s.b, t.a, t.b)) continue;
        bad.add(order[oi]);
        bad.add(order[oj]);
      }
    }
    let changed = false;
    for (const i of [...bad].sort((x, y) => x - y)) {
      const s = segs[i];
      if (s.chain >= 0 && refine(chains[s.chain], s.lo, s.hi)) changed = true;
    }
    if (!changed) return;
  }
}

/** refinement: error threshold as a fraction of the belt step, and its limits per tile */
export const REFINE_TOL = 0.25;
const REFINE_ROUNDS = 4;
const REFINE_PER_ROUND = 4;
/** lattice cells between nodes refined in one round */
const REFINE_SPACING = 4;
/** vertices refinement may add to a tile (checked after each round) */
export const MAX_REFINE_VERTS = 60;

/** signed TIN − lattice error at every lattice node (water clamped to 0 on both sides) */
function latticeError(t: { vx: number[]; vy: number[]; vh: number[]; tris: Tri[] }, heights: Float32Array, grid: number): Float64Array {
  const side = grid + 1;
  const err = new Float64Array(side * side);
  for (const tr of t.tris) {
    const ax = t.vx[tr.a], ay = t.vy[tr.a], bx = t.vx[tr.b], by = t.vy[tr.b], cx = t.vx[tr.c], cy = t.vy[tr.c];
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (d === 0) continue;
    const ha = Math.max(0, t.vh[tr.a]), hb = Math.max(0, t.vh[tr.b]), hc = Math.max(0, t.vh[tr.c]);
    for (let j = Math.max(0, Math.ceil(Math.min(ay, by, cy))); j <= Math.min(grid, Math.floor(Math.max(ay, by, cy))); j++) {
      for (let i = Math.max(0, Math.ceil(Math.min(ax, bx, cx))); i <= Math.min(grid, Math.floor(Math.max(ax, bx, cx))); i++) {
        const w1 = ((i - ax) * (cy - ay) - (cx - ax) * (j - ay)) / d;
        const w2 = ((bx - ax) * (j - ay) - (i - ax) * (by - ay)) / d;
        const w0 = 1 - w1 - w2;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        err[j * side + i] = ha * w0 + hb * w1 + hc * w2 - Math.max(0, heights[j * side + i]);
      }
    }
  }
  return err;
}

/**
 * Colour cost of triangles for the flip pass: pixels off the triangle's majority colour, and the
 * largest lattice error under it. Memoized per triangle (the same triangles recur across passes).
 */
function colourCost(
  c: ColourLabels, vx: number[], vy: number[], vh: number[], heights: Float32Array, grid: number, maxDh: number,
): { better: (u: number, v: number, p: number, q: number) => boolean } {
  const side = grid + 1;
  const k = c.size / grid; // pixels per lattice cell
  const counts = new Uint32Array(256);
  const memo = new Map<string, [number, number]>();
  const tri = (a: number, b: number, d: number): [number, number] => {
    const key = [a, b, d].sort((x, y) => x - y).join(',');
    const hit = memo.get(key);
    if (hit) return hit;
    const ax = vx[a], ay = vy[a], bx = vx[b], by = vy[b], dx = vx[d], dy = vy[d];
    const det = (bx - ax) * (dy - ay) - (dx - ax) * (by - ay);
    let off = 0, err = 0;
    if (det !== 0) {
      // off-colour pixels: pixel centres inside the triangle (one on an edge counts for both
      // sides; the flip compares sums over the same quad, so the pass still strictly descends)
      counts.fill(0);
      let n = 0;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, dx) * k)), i1 = Math.min(c.size - 1, Math.ceil(Math.max(ax, bx, dx) * k));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by, dy) * k)), j1 = Math.min(c.size - 1, Math.ceil(Math.max(ay, by, dy) * k));
      for (let j = j0; j <= j1; j++) {
        const sy = (j + 0.5) / k;
        for (let i = i0; i <= i1; i++) {
          const sx = (i + 0.5) / k;
          const w1 = ((sx - ax) * (dy - ay) - (dx - ax) * (sy - ay)) / det;
          const w2 = ((bx - ax) * (sy - ay) - (sx - ax) * (by - ay)) / det;
          if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
          counts[c.label[j * c.size + i]]++;
          n++;
        }
      }
      let best = 0;
      for (let v = 0; v < 256; v++) if (counts[v] > best) best = counts[v];
      off = n - best;
      const ha = Math.max(0, vh[a]), hb = Math.max(0, vh[b]), hd = Math.max(0, vh[d]);
      for (let j = Math.max(0, Math.ceil(Math.min(ay, by, dy))); j <= Math.min(grid, Math.floor(Math.max(ay, by, dy))); j++) {
        for (let i = Math.max(0, Math.ceil(Math.min(ax, bx, dx))); i <= Math.min(grid, Math.floor(Math.max(ax, bx, dx))); i++) {
          const w1 = ((i - ax) * (dy - ay) - (dx - ax) * (j - ay)) / det;
          const w2 = ((bx - ax) * (j - ay) - (i - ax) * (by - ay)) / det;
          const w0 = 1 - w1 - w2;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          err = Math.max(err, Math.abs(ha * w0 + hb * w1 + hd * w2 - Math.max(0, heights[j * side + i])));
        }
      }
    }
    const r: [number, number] = [off, err];
    memo.set(key, r);
    return r;
  };
  return {
    // edge u–v with opposite p, q → diagonal p–q
    better: (u, v, p, q) => {
      const [o1, e1] = tri(u, v, p), [o2, e2] = tri(u, v, q);
      const [n1, f1] = tri(p, q, u), [n2, f2] = tri(p, q, v);
      if (n1 + n2 >= o1 + o2) return false;
      return Math.max(f1, f2) <= Math.max(maxDh, e1, e2);
    },
  };
}

function latticeHeight(heights: Float32Array, grid: number, p: Pt): number {
  const side = grid + 1;
  const i = Math.min(grid - 1, Math.max(0, Math.floor(p.x))), j = Math.min(grid - 1, Math.max(0, Math.floor(p.y)));
  const tx = p.x - i, ty = p.y - j;
  const h = (a: number, b: number) => heights[b * side + a];
  return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - ty) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * ty;
}

/**
 * Add colour boundaries to the fixed edges. A boundary segment crossing a fixed edge splits both
 * at the crossing (height interpolated along the fixed edge: its level for an isoline); a crossing
 * next to an end snaps to that end; a boundary point lying on a fixed edge is dropped (it would
 * split the edge without being a crossing). Deterministic: boundaries in the given order.
 */
function insertColourLines(
  lines: Pt[][],
  constraints: Array<[number, number]>,
  vx: number[], vy: number[], vh: number[],
  vid: (p: Pt, h: number) => number,
  heightAt: (p: Pt) => number,
  stats: { verts: number; crossings: number },
): void {
  const SNAP = 1e-3; // lattice cells
  const P = (k: number): Pt => ({ x: vx[k], y: vy[k] });
  stats.verts = 0;
  stats.crossings = 0;
  for (const line of lines) {
    // drop points sitting on an existing fixed edge (or on a vertex of one)
    const pts = line.filter((p) => !constraints.some(([a, b]) => distToSeg(p, P(a), P(b)) < SNAP));
    if (pts.length < 2) continue;
    let prev = -1;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const before = vx.length;
      const id = vid(p, heightAt(p));
      if (vx.length > before) stats.verts++;
      if (prev >= 0 && prev !== id) {
        // split this boundary segment at every crossing with the fixed edges, nearest first
        const a = P(prev), b = P(id);
        const hits: Array<{ t: number; ci: number; s: number }> = [];
        constraints.forEach(([u, v], ci) => {
          if (u === prev || v === prev || u === id || v === id) return;
          const c = P(u), d = P(v);
          const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
          if (den === 0) return;
          const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
          const s2 = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
          if (t <= 0 || t >= 1 || s2 < 0 || s2 > 1) return;
          hits.push({ t, ci, s: s2 });
        });
        hits.sort((h1, h2) => h1.t - h2.t || h1.ci - h2.ci);
        let from = prev;
        for (const h of hits) {
          const [u, v] = constraints[h.ci];
          const c = P(u), d = P(v);
          const len = Math.hypot(d.x - c.x, d.y - c.y);
          let w: number;
          if (h.s * len < SNAP) w = u;
          else if ((1 - h.s) * len < SNAP) w = v;
          else {
            const q = { x: c.x + (d.x - c.x) * h.s, y: c.y + (d.y - c.y) * h.s };
            w = vid(q, vh[u] + (vh[v] - vh[u]) * h.s);
            constraints[h.ci] = [u, w];
            constraints.push([w, v]);
            stats.crossings++;
          }
          if (w !== from) constraints.push([from, w]);
          from = w;
        }
        if (from !== id) constraints.push([from, id]);
      }
      prev = id;
    }
  }
}

/** rings smaller than the tolerance are noise at this detail level */
function tinyRing(line: Polyline, eps: number): boolean {
  if (!line.closed) return false;
  const xs = line.pts.map((p) => p.x), ys = line.pts.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < eps * 2;
}

/** the isoline of `lines` passing nearest to node (i, j) that is not already a chain */
function nearestNewLine(lines: Polyline[], chains: Chain[], i: number, j: number): Polyline | null {
  let best: Polyline | null = null, bd = Infinity;
  for (const l of lines) {
    if (chains.some((c) => c.level === l.level && c.pts[0].x === l.pts[0].x && c.pts[0].y === l.pts[0].y)) continue;
    let d = Infinity;
    for (const p of l.pts) d = Math.min(d, Math.hypot(p.x - i, p.y - j));
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}

export function buildTerrainTin(tile: Tile, grid: number, heights: Float32Array, opts: TinOptions = {}): TerrainTin {
  const side = grid + 1;
  if (heights.length !== side * side) throw new Error('heights grid size mismatch');
  const baseStep = opts.step ?? beltStepForZoom(tile.z);
  // Tile borders must not depend on per-tile escalation: neighbours simplify the shared edge
  // with the same tolerance, so seams stay within it (skirts hide the rest).
  // from the length of the edge itself, so the two tiles of an edge get the same number
  const borderTol = (edgeLen: number) => opts.borderTol ?? Math.min(BORDER_TOL_MAX_M, (BORDER_TOL_CELLS * edgeLen) / grid);

  let minH = Infinity, maxH = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    minH = Math.min(minH, heights[k]);
    maxH = Math.max(maxH, heights[k]);
  }

  // Border: one profile per edge, shared with the neighbour (TileBorders) and simplified with a
  // fixed tolerance in a frame both tiles agree on (edge length at the edge's own latitude), so
  // the two sides keep the same vertices. Order: n, s, w, e.
  const profiles: Float32Array[] = opts.borders
    ? [opts.borders.n, opts.borders.s, opts.borders.w, opts.borders.e]
    : [
        Float32Array.from({ length: side }, (_, s) => heights[s]),
        Float32Array.from({ length: side }, (_, s) => heights[grid * side + s]),
        Float32Array.from({ length: side }, (_, s) => heights[s * side]),
        Float32Array.from({ length: side }, (_, s) => heights[s * side + grid]),
      ];
  const place = (e: number, f: number): Pt =>
    e === 0 ? { x: f * grid, y: 0 } : e === 1 ? { x: f * grid, y: grid } : e === 2 ? { x: 0, y: f * grid } : { x: grid, y: f * grid };
  /** simplified profile per edge: fraction along the edge and height */
  const simplified = profiles.map((prof, e) => {
    const edgeLen = tileRowMeters(tile.z, e === 0 ? tile.y : e === 1 ? tile.y + 1 : tile.y + 0.5);
    const pts: Pt[] = Array.from(prof, (h, k) => ({ x: (k / (prof.length - 1)) * edgeLen, y: h }));
    return simplifyOpen(pts, borderTol(edgeLen)).map((q) => ({ f: q.x / edgeLen, h: q.y }));
  });
  const lineAt = (line: Array<{ f: number; h: number }>, f: number): number => {
    let k = 1;
    while (k < line.length - 1 && line[k].f < f) k++;
    const a = line[k - 1], b = line[k];
    return b.f > a.f ? a.h + (b.h - a.h) * Math.max(0, Math.min(1, (f - a.f) / (b.f - a.f))) : a.h;
  };
  const borderPts: Array<{ p: Pt; h: number }> = [];
  simplified.forEach((line, e) => {
    for (const q of line) borderPts.push({ p: place(e, q.f), h: q.h });
  });
  // The parent's border line over this tile's half of its edge, simplified exactly as the parent
  // does it. Its vertices become border vertices here too (on this tile's own line, so nothing
  // moves): pulled onto the parent's line, the edge then follows every bend of it.
  const pz = tile.z - 1, py = tile.y >> 1;
  const coarseLines = [opts.borders?.coarse?.n, opts.borders?.coarse?.s, opts.borders?.coarse?.w, opts.borders?.coarse?.e].map((prof, e) => {
    if (!prof) return null;
    const edgeLen = tileRowMeters(pz, e === 0 ? py : e === 1 ? py + 1 : py + 0.5);
    const pts: Pt[] = Array.from(prof, (h, k) => ({ x: (k / (prof.length - 1)) * edgeLen, y: h }));
    const off = ((e < 2 ? tile.x : tile.y) % 2) / 2;
    const line = simplifyOpen(pts, borderTol(edgeLen)).map((q) => ({ f: (q.x / edgeLen - off) * 2, h: q.y }));
    for (const q of line) if (q.f > 0 && q.f < 1) borderPts.push({ p: place(e, q.f), h: lineAt(simplified[e], q.f) });
    return line;
  });
  /** border edge of a lattice point (0 n, 1 s, 2 w, 3 e; corners report the first), −1 inside */
  const edgeOf = (p: Pt) => (p.y === 0 ? 0 : p.y === grid ? 1 : p.x === 0 ? 2 : p.x === grid ? 3 : -1);
  /**
   * Height of the border at a point on it: on the simplified profile, not the raw one. An isoline
   * that ends on the border adds a vertex there on this tile only, and it must lie on the edge the
   * neighbour draws between its own border vertices.
   */
  const borderHeight = (p: Pt): number => {
    const e = edgeOf(p);
    return lineAt(simplified[e], (e < 2 ? p.x : p.y) / grid);
  };

  // Over budget → first simplify harder (looser tolerance), and only when even the loosest
  // tolerance does not fit, make the belts thicker and start the tolerance over. Thicker belts
  // cost far more accuracy than a looser tolerance, but every open isoline costs two border
  // vertices whatever the tolerance, so on rough terrain only fewer levels meet the budget.
  let step = baseStep;
  const eps0 = opts.eps ?? EPS_START;
  let eps = eps0;
  let chains: Chain[] = [];
  let lines: Polyline[] = [];
  for (let attempt = 0; ; attempt++) {
    lines = beltLevels(minH, maxH, step).flatMap((l) => extractIsolines(heights, grid, l));
    chains = [];
    for (const line of lines) {
      if (tinyRing(line, eps)) continue;
      chains.push(makeChain(line, eps));
    }
    const kept = chains.reduce((s, c) => s + c.keep.reduce((t, v) => t + v, 0), 0);
    if (kept <= MAX_VERTS || attempt >= 24) break;
    if (eps * 1.5 <= EPS_MAX) eps *= 1.5;
    else {
      step *= 1.5;
      eps = eps0;
    }
  }

  /** chains → vertices, fixed edges and the constrained triangulation (chains get untangled) */
  const triangulate = (chains: Chain[]) => {
    // vertices: border (profile points and isoline ends), then the kept isoline points
    const vx: number[] = [];
    const vy: number[] = [];
    const vh: number[] = [];
    const ids = new Map<string, number>();
    const vid = (p: Pt, h: number): number => {
      const key = `${Math.round(p.x * 4096)},${Math.round(p.y * 4096)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = vx.length;
        ids.set(key, id);
        vx.push(p.x);
        vy.push(p.y);
        vh.push(h);
      }
      return id;
    };
    const onBorder: Pt[][] = [[], [], [], []];
    for (const { p, h } of borderPts) {
      vid(p, h);
      onBorder[edgeOf(p)].push(p);
    }
    for (const c of chains) {
      for (const p of [c.pts[0], c.pts[c.pts.length - 1]]) {
        const e = edgeOf(p);
        if (e < 0) continue;
        vid(p, c.level === COAST_LEVEL ? 0 : borderHeight(p));
        onBorder[e].push(p);
      }
    }
    const borderVerts = vx.length;
    // corners belong to two edges
    for (const p of [place(0, 0), place(0, 1), place(1, 0), place(1, 1)]) {
      for (let e = 0; e < 4; e++) if (edgeOf(p) !== e && (e < 2 ? p.y === (e ? grid : 0) : p.x === (e === 3 ? grid : 0))) onBorder[e].push(p);
    }
    const borderSegs: Seg[] = [];
    const borderChains: Pt[][] = onBorder.map((l, e) => {
      const along = (p: Pt) => (e < 2 ? p.x : p.y);
      const sorted = l.sort((a, b) => along(a) - along(b)).filter((p, k, arr) => k === 0 || along(p) !== along(arr[k - 1]));
      for (let k = 1; k < sorted.length; k++) borderSegs.push({ a: sorted[k - 1], b: sorted[k], chain: -1, lo: 0, hi: 0 });
      return sorted;
    });

    untangle(chains, borderSegs);

    const constraints: Array<[number, number]> = [];
    for (const l of borderChains) for (let k = 1; k < l.length; k++) constraints.push([vid(l[k - 1], 0), vid(l[k], 0)]);
    for (const c of chains) {
      let prev = -1;
      for (let k = 0; k < c.pts.length; k++) {
        if (!c.keep[k]) continue;
        const p = c.pts[k];
        const id = vid(p, c.level === COAST_LEVEL ? 0 : edgeOf(p) >= 0 ? borderHeight(p) : lineHeight(c.level));
        if (prev >= 0 && prev !== id) constraints.push([prev, id]);
        prev = id;
      }
    }

    // colour boundaries: fixed edges too, with a vertex wherever they cross an isoline (at its
    // level) or another boundary; their own vertices take the lattice height
    if (colourPicked.length) insertColourLines(colourPicked, constraints, vx, vy, vh, vid, (p) => {
      // at sea level like the coastline: a boundary vertex in the sea must not lift a water face
      const h = latticeHeight(heights, grid, p);
      return h < COAST_LEVEL ? 0 : h;
    }, stats);

    // a triangle is flat when all three corners sit at one height (one isoline): it lies on a belt
    // boundary instead of spanning the belt. Flip free edges while that strictly reduces flat ones.
    const flat = (a: number, b: number, c: number) => vh[a] === vh[b] && vh[b] === vh[c];
    const flats = (a: number, b: number, c: number, d: number) => (flat(a, b, c) ? 1 : 0) + (flat(a, b, d) ? 1 : 0);
    // with colour labels: fewer flat triangles first, then fewer off-colour pixels (lexicographic)
    const cc = opts.colour ? colourCost(opts.colour, vx, vy, vh, heights, grid, opts.colour.maxDh ?? step * REFINE_TOL) : null;
    let colourFlips = 0;
    const { tris, missing } = constrainedDelaunay(
      vx.map((x, k) => ({ x, y: vy[k] })),
      constraints,
      (u, v, p, q) => {
        const now = flats(u, v, p, q), next = flats(p, q, u, v);
        if (next !== now || !cc) return next < now;
        if (!cc.better(u, v, p, q)) return false;
        colourFlips++;
        return true;
      },
    );
    lastColourFlips = colourFlips;
    return { vx, vy, vh, tris, constraints, missing, borderVerts };
  };

  let lastColourFlips = 0;
  const stats = { verts: 0, crossings: 0 };
  // colour boundaries up to the vertex cap, longest first
  const colourPicked: Pt[][] = [];
  {
    let budget = opts.colourLines?.maxVerts ?? MAX_COLOUR_VERTS;
    for (const l of opts.colourLines?.lines ?? []) {
      const n = l.closed ? l.pts.length - 1 : l.pts.length;
      if (n > budget) continue;
      budget -= n;
      colourPicked.push(l.pts);
    }
  }
  let res = triangulate(chains);
  const baseVerts = res.vx.length;

  // Refinement. A belt may be far wider than its relief needs: a coastal plain at 5–20 m between
  // the coastline and the 120 m isoline kilometres inland, a valley floor under its lowest level,
  // a summit above its top ring. Linear interpolation across it misses the shape. Where a lattice
  // node is off by more than a quarter step, add one more isoline through it: the component of
  // the level nearest the node, at the node's height rounded to step/8. Every vertex still sits
  // on an equal-height line; only the belts there get thinner. Deterministic (worst node first,
  // ties by index), a few nodes per round so the triangulation is rebuilt only a few times.
  const tol = step * REFINE_TOL;
  const quantum = step / 8;
  const tried = new Set<number>();
  let added = 0;
  for (let round = 0; round < REFINE_ROUNDS && added < MAX_REFINE_VERTS; round++) {
    const err = latticeError(res, heights, grid);
    const worst: number[] = [];
    for (let k = 0; k < err.length; k++) if (Math.abs(err[k]) > tol && !tried.has(k)) worst.push(k);
    worst.sort((p, q) => Math.abs(err[q]) - Math.abs(err[p]) || p - q);
    const picked: number[] = [];
    for (const k of worst) {
      const ki = k % side, kj = Math.floor(k / side);
      if (picked.some((m) => Math.hypot((m % side) - ki, Math.floor(m / side) - kj) < REFINE_SPACING)) continue;
      picked.push(k);
      if (picked.length === REFINE_PER_ROUND) break;
    }
    let grew = false;
    for (const k of picked) {
      tried.add(k);
      const level = Math.max(quantum, Math.round(heights[k] / quantum) * quantum);
      // same noise filter as the base levels: anything nested in a dropped ring is smaller still,
      // so a refinement line never appears inside a belt boundary that was left out
      const candidates = extractIsolines(heights, grid, level).filter((l) => !tinyRing(l, eps));
      const line = nearestNewLine(candidates, chains, k % side, Math.floor(k / side));
      if (!line) continue;
      const c = makeChain(line, eps);
      chains.push(c);
      lines.push(line);
      grew = true;
    }
    if (!grew) break;
    res = triangulate(chains);
    // the cost is every vertex this added: the new lines and the points untangling put back
    added = res.vx.length - baseVerts;
  }

  const { vx, vy, vh, tris, constraints, missing, borderVerts } = res;
  if (opts.debug) {
    Object.assign(opts.debug, {
      step, eps, raw: lines, constraints, missing, borderVerts, refined: added, colourFlips: lastColourFlips,
      colourVerts: stats.verts, colourCrossings: stats.crossings,
    });
  }
  if (!coarseLines.some((l) => l)) return { grid, vx, vy, vh, tris };
  const dh = vx.map(() => 0), edges = vx.map(() => 0);
  for (let k = 0; k < vx.length; k++) {
    const on = [vy[k] === 0, vy[k] === grid, vx[k] === 0, vx[k] === grid];
    for (let e = 0; e < 4; e++) {
      const line = coarseLines[e];
      if (!line || !on[e]) continue;
      edges[k] |= 1 << e;
      dh[k] = Math.max(0, lineAt(line, (e < 2 ? vx[k] : vy[k]) / grid)) - Math.max(0, vh[k]);
    }
  }
  return { grid, vx, vy, vh, tris, coarse: { dh, edges } };
}

/**
 * Height of the rendered surface (same triangles as the mesh, water clamped to
 * 0 m like the mesh) at a lon/lat inside `tile`; clamps to the tile outside it.
 */
export function tinSampler(tin: TerrainTin, tile: Tile): HeightSampler {
  const locate = tinLocator(tin, tile);
  const h = tin.vh.map((v) => Math.max(v, 0));
  return (lon, lat) => {
    const r = locate(lon, lat);
    if (!r) return 0;
    const t = tin.tris[r.tri];
    return h[t.a] * r.w[0] + h[t.b] * r.w[1] + h[t.c] * r.w[2];
  };
}

/** the TIN triangle under a lon/lat (clamped into the tile) and its barycentric weights */
export function tinLocator(tin: TerrainTin, tile: Tile): (lon: number, lat: number) => { tri: number; w: [number, number, number] } | null {
  const { grid, vx, vy, tris } = tin;
  const n = 2 ** tile.z;
  const buckets: number[][] = Array.from({ length: grid * grid }, () => []);
  tris.forEach((t, ti) => {
    const xs = [vx[t.a], vx[t.b], vx[t.c]], ys = [vy[t.a], vy[t.b], vy[t.c]];
    const i0 = Math.max(0, Math.min(grid - 1, Math.floor(Math.min(...xs))));
    const i1 = Math.max(0, Math.min(grid - 1, Math.floor(Math.max(...xs))));
    const j0 = Math.max(0, Math.min(grid - 1, Math.floor(Math.min(...ys))));
    const j1 = Math.max(0, Math.min(grid - 1, Math.floor(Math.max(...ys))));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * grid + i].push(ti);
  });

  return (lon, lat) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin((clamped * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    const fx = Math.max(0, Math.min(grid, (((lon + 180) / 360) * n - tile.x) * grid));
    const fy = Math.max(0, Math.min(grid, (merc * n - tile.y) * grid));
    const cell = Math.min(grid - 1, Math.floor(fy)) * grid + Math.min(grid - 1, Math.floor(fx));
    let best = -1;
    let bestMin = -Infinity;
    let bw: [number, number, number] = [0, 0, 0];
    for (const ti of buckets[cell]) {
      const t = tris[ti];
      const ax = vx[t.a], ay = vy[t.a];
      const d = (vx[t.b] - ax) * (vy[t.c] - ay) - (vx[t.c] - ax) * (vy[t.b] - ay);
      if (d === 0) continue;
      const w1 = ((fx - ax) * (vy[t.c] - ay) - (vx[t.c] - ax) * (fy - ay)) / d;
      const w2 = ((vx[t.b] - ax) * (fy - ay) - (fx - ax) * (vy[t.b] - ay)) / d;
      const w0 = 1 - w1 - w2;
      const m = Math.min(w0, w1, w2);
      if (m > bestMin) {
        bestMin = m;
        best = ti;
        bw = [w0, w1, w2];
        if (m >= -1e-9) break;
      }
    }
    return best < 0 ? null : { tri: best, w: bw };
  };
}
