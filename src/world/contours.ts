/**
 * Deterministic contour pipeline for terrain "belts":
 *   1. marching squares → isoline polylines for each level (grid units),
 *   2. Douglas–Peucker simplification (open lines and closed rings),
 *   3. Delaunay triangulation of the surviving vertices (Delaunator, Constrainautor).
 * No randomness, no hash-order dependence: identical input → identical output.
 */

import Constrainautor from '@kninnug/constrainautor';
import Delaunator from 'delaunator';

export interface Pt {
  x: number;
  y: number;
}

export interface Polyline {
  level: number;
  closed: boolean;
  pts: Pt[];
}

/** Iso-levels (multiples of `step`) strictly crossed by the data range, never below 0. */
export function contourLevels(minH: number, maxH: number, step: number): number[] {
  const levels: number[] = [];
  const first = Math.max(0, Math.floor(minH / step) + 1) * step;
  for (let l = first; l <= maxH; l += step) {
    if (l > minH) levels.push(l);
  }
  return levels;
}

/**
 * Isoline of `level` over a (n+1)×(n+1) node lattice (row-major). A node is
 * "inside" when h >= level. Saddles are resolved by the cell-center average.
 * Points are in grid units, on lattice edges.
 */
export function extractIsolines(heights: Float32Array, n: number, level: number): Polyline[] {
  const side = n + 1;
  const hEdges = side * n; // horizontal edge (i,j)-(i+1,j): j*n + i
  const vId = (i: number, j: number) => hEdges + j * side + i; // vertical (i,j)-(i,j+1)
  const hId = (i: number, j: number) => j * n + i;

  const segA: number[] = [];
  const segB: number[] = [];
  const adj = new Map<number, number[]>();
  const addSeg = (a: number, b: number) => {
    const s = segA.length;
    segA.push(a);
    segB.push(b);
    for (const e of [a, b]) {
      const l = adj.get(e);
      if (l) l.push(s);
      else adj.set(e, [s]);
    }
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ha = heights[j * side + i];
      const hb = heights[j * side + i + 1];
      const hc = heights[(j + 1) * side + i + 1];
      const hd = heights[(j + 1) * side + i];
      const ia = ha >= level, ib = hb >= level, ic = hc >= level, id = hd >= level;
      const code = (ia ? 1 : 0) | (ib ? 2 : 0) | (ic ? 4 : 0) | (id ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = hId(i, j), bottom = hId(i, j + 1), left = vId(i, j), right = vId(i + 1, j);
      if (code === 5 || code === 10) {
        // asymptotic decider: the saddle value of the bilinear patch. Unlike the cell average it is
        // the same test for every level, so isolines of different levels never cross in a cell.
        const den = ha + hc - hb - hd;
        const saddle = den !== 0 ? (ha * hc - hb * hd) / den : (ha + hb + hc + hd) / 4;
        const centerIn = saddle >= level;
        const aIn = code === 5; // a,c inside
        if (aIn === centerIn) {
          addSeg(top, right);
          addSeg(bottom, left);
        } else {
          addSeg(top, left);
          addSeg(bottom, right);
        }
        continue;
      }
      const es: number[] = [];
      if (ia !== ib) es.push(top);
      if (ib !== ic) es.push(right);
      if (id !== ic) es.push(bottom);
      if (ia !== id) es.push(left);
      addSeg(es[0], es[1]);
    }
  }

  // a node exactly at the level would put the crossing on the node and make it shared by up to
  // four lattice edges; keep it strictly inside its edge so isoline points stay distinct
  const clampT = (t: number) => Math.min(1 - 1e-4, Math.max(1e-4, t));
  const edgePt = (e: number): Pt => {
    if (e < hEdges) {
      const j = Math.floor(e / n);
      const i = e - j * n;
      const a = heights[j * side + i];
      const b = heights[j * side + i + 1];
      return { x: i + clampT((level - a) / (b - a)), y: j };
    }
    const k = e - hEdges;
    const j = Math.floor(k / side);
    const i = k - j * side;
    const a = heights[j * side + i];
    const b = heights[(j + 1) * side + i];
    return { x: i, y: j + clampT((level - a) / (b - a)) };
  };

  const visited = new Uint8Array(segA.length);
  const walk = (startSeg: number, startEdge: number): number[] => {
    const edges = [startEdge];
    let seg = startSeg;
    let cur = startEdge;
    for (;;) {
      visited[seg] = 1;
      const next = segA[seg] === cur ? segB[seg] : segA[seg];
      edges.push(next);
      const nseg = adj.get(next)!.find((s) => !visited[s]);
      if (nseg === undefined) break;
      seg = nseg;
      cur = next;
    }
    return edges;
  };

  const out: Polyline[] = [];
  const openStarts = [...adj.entries()]
    .filter(([, l]) => l.length === 1)
    .map(([e, l]) => [e, l[0]] as const)
    .sort((p, q) => p[0] - q[0]);
  for (const [e, s] of openStarts) {
    if (visited[s]) continue;
    out.push({ level, closed: false, pts: walk(s, e).map(edgePt) });
  }
  for (let s = 0; s < segA.length; s++) {
    if (visited[s]) continue;
    const edges = walk(s, segA[s]);
    edges.pop(); // ring returns to its start edge
    out.push({ level, closed: true, pts: edges.map(edgePt) });
  }
  return out;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Iterative Douglas–Peucker; keeps both endpoints. Ties resolve to the lowest index. */
export function simplifyOpen(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let wd = eps;
    for (let k = lo + 1; k < hi; k++) {
      const d = distToSeg(pts[k], pts[lo], pts[hi]);
      if (d > wd) {
        wd = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Ring simplification: split at point 0 and the point farthest from it. */
export function simplifyRing(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 3) return pts.slice();
  let far = 1;
  let fd = -1;
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y);
    if (d > fd) {
      fd = d;
      far = k;
    }
  }
  const first = simplifyOpen(pts.slice(0, far + 1), eps);
  const second = simplifyOpen([...pts.slice(far), pts[0]], eps);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

export interface Tri {
  a: number;
  b: number;
  c: number;
}

/** flat coordinates for Delaunator */
function coordsOf(points: ReadonlyArray<Pt>): Float64Array {
  const c = new Float64Array(points.length * 2);
  points.forEach((p, k) => {
    c[2 * k] = p.x;
    c[2 * k + 1] = p.y;
  });
  return c;
}

/** the largest coordinate distance from the first point: the scale of the tolerances */
function spanOf(points: ReadonlyArray<Pt>): number {
  let span = 1e-9;
  for (const p of points) span = Math.max(span, Math.abs(p.x - points[0].x), Math.abs(p.y - points[0].y));
  return span;
}

/** the triangles in canonical form (lowest index first, orientation kept), sorted */
function canonical(tris: Tri[]): Tri[] {
  const out = tris.map(({ a, b, c }) => (a < b && a < c ? { a, b, c } : b < c ? { a: b, b: c, c: a } : { a: c, b: a, c: b }));
  out.sort((s, t) => s.a - t.a || s.b - t.b || s.c - t.c);
  return out;
}

/**
 * Delaunay triangulation of the points (Delaunator). Covers the convex hull; exact duplicates
 * are left out and zero-area triangles dropped. Deterministic.
 */
export function delaunay(points: Pt[]): Tri[] {
  if (points.length < 3) return [];
  const { triangles } = new Delaunator(coordsOf(points));
  const span = spanOf(points);
  const out: Tri[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    const pa = points[a], pb = points[b], pc = points[c];
    const area2 = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (Math.abs(area2) < 1e-12 * span * span) continue;
    out.push({ a, b, c });
  }
  return canonical(out);
}

/**
 * Constrainautor's set of edges to flip, iterated as its own bit set iterates (the smallest first;
 * one added past the last visited is visited in the same pass, one behind it in the next) but over
 * the edges in it: the bit set scans every edge of the triangulation after each constraint, most
 * of the time of a surface with tens of thousands of fixed edges (surface-tin.ts)
 */
class FlipSet {
  private readonly bits: Uint8Array;
  /** whether an edge has an entry in the heap (perhaps stale: deleted since) */
  private readonly queued: Uint8Array;
  /** a min-heap of edges */
  private readonly heap: number[] = [];
  constructor(len: number) {
    this.bits = new Uint8Array(len);
    this.queued = new Uint8Array(len);
  }
  has(i: number): boolean {
    return this.bits[i] === 1;
  }
  add(i: number): this {
    this.bits[i] = 1;
    if (!this.queued[i]) {
      this.queued[i] = 1;
      this.push(i);
    }
    return this;
  }
  delete(i: number): this {
    this.bits[i] = 0;
    return this;
  }
  set(i: number, val: boolean): boolean {
    if (val) this.add(i);
    else this.delete(i);
    return val;
  }
  forEach(fn: (i: number) => void): this {
    const later: number[] = [];
    let last = -1;
    while (this.heap.length) {
      const i = this.pop();
      this.queued[i] = 0;
      if (!this.bits[i]) continue;
      if (i <= last) later.push(i);
      else {
        last = i;
        fn(i);
      }
    }
    for (const i of later) if (this.bits[i] && !this.queued[i]) this.add(i);
    return this;
  }
  private push(i: number): void {
    const h = this.heap;
    let k = h.push(i) - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (h[up] <= i) break;
      h[k] = h[up];
      k = up;
    }
    h[k] = i;
  }
  private pop(): number {
    const h = this.heap, top = h[0], end = h.pop()!;
    if (h.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= h.length) break;
        if (c + 1 < h.length && h[c + 1] < h[c]) c++;
        if (h[c] >= end) break;
        h[k] = h[c];
        k = c;
      }
      h[k] = end;
    }
    return top;
  }
}

/**
 * Constrained Delaunay triangulation: Delaunay of `points` (Delaunator), then every segment of
 * `constraints` is forced in as an edge and the Delaunay property restored around it
 * (Constrainautor, exact predicates). `prefer(u, v, p, q)`, when given, is a final flip pass on
 * free edges: edge u–v (u < v; p the apex on the side of u→v, q the other) is replaced by p–q
 * when it returns true; it must describe a strictly decreasing potential. A flip never makes a
 * triangle of (nearly) zero area, so no vertex ends up on another face's edge. A constraint that
 * cannot be inserted (it crosses another or passes through a point) is counted in `missing`.
 * Triangles are counter-clockwise. Deterministic.
 */
export function constrainedDelaunay(
  points: Pt[],
  constraints: ReadonlyArray<readonly [number, number]>,
  prefer?: (u: number, v: number, p: number, q: number) => boolean,
): { tris: Tri[]; missing: number } {
  const n = points.length;
  if (n < 3) return { tris: [], missing: constraints.filter(([a, b]) => a !== b).length };
  const del = new Delaunator(coordsOf(points));
  const con = new Constrainautor(del);
  (con as unknown as { flips: FlipSet }).flips = new FlipSet(del.triangles.length);
  const lone = new Set(con.untriangulatedPoints());
  const fixed = new Set<number>();
  const U = (u: number, v: number) => (u < v ? u * n + v : v * n + u);
  let missing = 0;
  for (const [a, b] of constraints) {
    if (a === b) continue;
    if (lone.has(a) || lone.has(b)) {
      missing++;
      continue;
    }
    try {
      con.constrainOne(a, b);
      fixed.add(U(a, b));
    } catch {
      // crosses another constraint or runs through a point: left out (unless it got in before that)
      if (con.findEdge(a, b) !== Infinity) fixed.add(U(a, b));
      else missing++;
    }
  }

  const tri = del.triangles, he = del.halfedges;
  const px = points.map((p) => p.x), py = points.map((p) => p.y);
  const orient = (a: number, b: number, c: number) => (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
  const span = spanOf(points);
  const tol = 1e-10 * span * span;
  const prev = (e: number) => (e % 3 === 0 ? e + 2 : e - 1);
  const link = (e: number, o: number) => {
    he[e] = o;
    if (o !== -1) he[o] = e;
  };

  if (prefer) {
    // an edge whose two triangles are as they were when it was last looked at gives the same
    // answer again: it is passed over (a pass looks at the few a flip changed, not every edge)
    const changed = new Int32Array(tri.length / 3);
    const looked = new Int32Array(tri.length).fill(-1);
    let clock = 0;
    for (let pass = 0; pass < 200; pass++) {
      let flips = 0;
      for (let e = 0; e < tri.length; e++) {
        const o = he[e];
        if (o < e) continue; // the hull, or visited from its twin
        const te = (e / 3) | 0, to = (o / 3) | 0;
        if (looked[e] >= changed[te] && looked[e] >= changed[to]) continue;
        looked[e] = clock;
        const a = tri[e], b = tri[o];
        if (fixed.has(U(a, b))) continue;
        const e2 = prev(e), o2 = prev(o);
        const p = tri[e2], q = tri[o2];
        // Delaunator's triangles turn clockwise (y up): the quad a, p, b, q; the new triangles
        // (p, a, q) and (q, b, p) must turn the same way, with area
        if (orient(p, a, q) >= -tol || orient(q, b, p) >= -tol) continue;
        // counter-clockwise, b→a has apex p and a→b apex q
        const want = b < a ? prefer(b, a, p, q) : prefer(a, b, q, p);
        if (!want) continue;
        const heE2 = he[e2], heO2 = he[o2];
        tri[e] = q; // q→b
        tri[o] = p; // p→a
        link(e, heO2);
        link(o, heE2);
        link(e2, o2); // p→q and q→p
        clock++;
        changed[te] = changed[to] = clock;
        flips++;
      }
      if (!flips) break;
    }
  }

  const out: Tri[] = [];
  for (let t = 0; t < tri.length; t += 3) out.push({ a: tri[t], b: tri[t + 2], c: tri[t + 1] }); // counter-clockwise
  return { tris: canonical(out), missing };
}
