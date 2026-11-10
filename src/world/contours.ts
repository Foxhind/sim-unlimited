/**
 * Deterministic contour pipeline for terrain "belts":
 *   1. marching squares → isoline polylines for each level (grid units),
 *   2. Douglas–Peucker simplification (open lines and closed rings),
 *   3. Bowyer–Watson Delaunay triangulation of the surviving vertices.
 * No randomness, no hash-order dependence: identical input → identical output.
 */

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

/**
 * Bowyer–Watson Delaunay over the points, inserted in (x, y, index) order.
 * Covers the convex hull; zero-area triangles are dropped.
 */
export function delaunay(points: Pt[]): Tri[] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const px: number[] = points.map((p) => p.x);
  const py: number[] = points.map((p) => p.y);
  // super-triangle vertices n, n+1, n+2
  px.push(cx - 40 * span, cx, cx + 40 * span);
  py.push(cy - 20 * span, cy + 40 * span, cy - 20 * span);

  interface T {
    a: number; b: number; c: number;
    ox: number; oy: number; r2: number;
    dead: boolean;
  }
  const make = (a: number, b: number, c: number): T => {
    const ax = px[a], ay = py[a], bx = px[b], by = py[b], cxx = px[c], cyy = py[c];
    const d = 2 * (ax * (by - cyy) + bx * (cyy - ay) + cxx * (ay - by));
    if (Math.abs(d) < 1e-18) return { a, b, c, ox: 0, oy: 0, r2: -1, dead: false };
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cxx * cxx + cyy * cyy;
    const ox = (a2 * (by - cyy) + b2 * (cyy - ay) + c2 * (ay - by)) / d;
    const oy = (a2 * (cxx - bx) + b2 * (ax - cxx) + c2 * (bx - ax)) / d;
    return { a, b, c, ox, oy, r2: (ax - ox) ** 2 + (ay - oy) ** 2, dead: false };
  };

  let tris: T[] = [make(n, n + 1, n + 2)];
  const order = points.map((_, i) => i).sort((i, j) => px[i] - px[j] || py[i] - py[j] || i - j);
  const tol = 1e-9 * span * span;

  for (const p of order) {
    const x = px[p], y = py[p];
    const bad: T[] = [];
    for (const t of tris) {
      if (t.r2 >= 0 && (x - t.ox) ** 2 + (y - t.oy) ** 2 < t.r2 - tol) {
        t.dead = true;
        bad.push(t);
      }
    }
    if (!bad.length) continue; // duplicate / exactly cocircular on all circles
    const edgeCount = new Map<number, [number, number, number]>();
    const key = (u: number, v: number) => (u < v ? u * (n + 3) + v : v * (n + 3) + u);
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const k = key(u, v);
        const e = edgeCount.get(k);
        if (e) e[2]++;
        else edgeCount.set(k, [u, v, 1]);
      }
    }
    tris = tris.filter((t) => !t.dead);
    for (const [u, v, c] of edgeCount.values()) {
      if (c === 1) tris.push(make(u, v, p));
    }
  }

  const out: Tri[] = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    const area2 = (px[t.b] - px[t.a]) * (py[t.c] - py[t.a]) - (px[t.c] - px[t.a]) * (py[t.b] - py[t.a]);
    if (Math.abs(area2) < 1e-12 * span * span) continue;
    out.push({ a: t.a, b: t.b, c: t.c });
  }
  // canonical order → deterministic regardless of Map iteration details
  out.sort((s, t) => s.a - t.a || s.b - t.b || s.c - t.c);
  return out;
}

/**
 * Constrained Delaunay triangulation: Delaunay of `points`, then every segment of `constraints`
 * is forced in as an edge (Sloan's edge flipping) and the Delaunay property is restored around
 * the fixed edges (Lawson flips). `prefer(u, v, p, q)`, when given, is a final flip pass on free
 * edges: edge u–v (opposite vertices p, q) is replaced by p–q when it returns true; it must
 * describe a strictly decreasing potential. Constraints must not cross each other or pass
 * through points. Deterministic: edges are visited in index order.
 */
export function constrainedDelaunay(
  points: Pt[],
  constraints: ReadonlyArray<readonly [number, number]>,
  prefer?: (u: number, v: number, p: number, q: number) => boolean,
): { tris: Tri[]; missing: number } {
  const n = points.length;
  const px = points.map((p) => p.x), py = points.map((p) => p.y);
  const orient = (a: number, b: number, c: number) => (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
  const tri: Array<[number, number, number]> = [];
  const he = new Map<number, number>(); // directed edge u→v → triangle having it (CCW)
  const K = (u: number, v: number) => u * n + v;
  const U = (u: number, v: number) => (u < v ? u * n + v : v * n + u);
  const set = (t: number, a: number, b: number, c: number) => {
    tri[t] = [a, b, c];
    he.set(K(a, b), t);
    he.set(K(b, c), t);
    he.set(K(c, a), t);
  };
  delaunay(points).forEach((t, i) => (orient(t.a, t.b, t.c) > 0 ? set(i, t.a, t.b, t.c) : set(i, t.a, t.c, t.b)));
  const third = (t: number, u: number, v: number) => tri[t].find((w) => w !== u && w !== v)!;
  /** the quad around interior edge u–v, or undefined on the hull */
  const quad = (u: number, v: number): [number, number, number, number] | undefined => {
    const t1 = he.get(K(u, v)), t2 = he.get(K(v, u));
    if (t1 === undefined || t2 === undefined) return undefined;
    return [t1, t2, third(t1, u, v), third(t2, u, v)];
  };
  const convex = (u: number, v: number, p: number, q: number) => orient(p, q, u) * orient(p, q, v) < 0;
  /** flip u–v (u→v in t1 with apex p, v→u in t2 with apex q) into p–q */
  const flip = (t1: number, t2: number, u: number, v: number, p: number, q: number) => {
    for (const t of [t1, t2]) {
      const [a, b, c] = tri[t];
      he.delete(K(a, b));
      he.delete(K(b, c));
      he.delete(K(c, a));
    }
    set(t1, q, v, p);
    set(t2, p, u, q);
  };
  const crosses = (u: number, v: number, a: number, b: number) =>
    orient(a, b, u) * orient(a, b, v) < 0 && orient(u, v, a) * orient(u, v, b) < 0;
  const freeEdges = () =>
    [...he.keys()]
      .filter((k) => {
        const u = Math.floor(k / n), v = k % n;
        return u < v && he.has(K(v, u));
      })
      .sort((x, y) => x - y);

  const fixed = new Set<number>();
  let missing = 0;
  for (const [a, b] of constraints) {
    if (a === b) continue;
    if (!he.has(K(a, b)) && !he.has(K(b, a))) {
      const queue: Array<[number, number]> = freeEdges()
        .map((k) => [Math.floor(k / n), k % n] as [number, number])
        .filter(([u, v]) => crosses(u, v, a, b));
      let guard = queue.length * 64 + 64;
      while (queue.length && guard-- > 0) {
        const [u, v] = queue.shift()!;
        const qd = quad(u, v);
        if (!qd || fixed.has(U(u, v))) break; // a crossing constraint: give up on this one
        const [t1, t2, p, q] = qd;
        if (!convex(u, v, p, q)) {
          queue.push([u, v]);
          continue;
        }
        flip(t1, t2, u, v, p, q);
        if (crosses(p, q, a, b)) queue.push([p, q]);
      }
    }
    if (he.has(K(a, b)) || he.has(K(b, a))) fixed.add(U(a, b));
    else missing++;
  }

  const sweep = (want: (u: number, v: number, p: number, q: number) => boolean) => {
    for (let pass = 0; pass < 200; pass++) {
      let flips = 0;
      for (const k of freeEdges()) {
        if (fixed.has(k)) continue;
        const u = Math.floor(k / n), v = k % n;
        const qd = quad(u, v);
        if (!qd) continue;
        const [t1, t2, p, q] = qd;
        if (!convex(u, v, p, q) || !want(u, v, p, q)) continue;
        flip(t1, t2, u, v, p, q);
        flips++;
      }
      if (!flips) return;
    }
  };
  let span = 1e-9;
  for (let k = 0; k < n; k++) span = Math.max(span, Math.abs(px[k] - px[0]), Math.abs(py[k] - py[0]));
  const tol = 1e-10 * span ** 4;
  // d strictly inside the circumcircle of CCW triangle (a, b, c)
  const inCircle = (a: number, b: number, c: number, d: number) => {
    const ax = px[a] - px[d], ay = py[a] - py[d];
    const bx = px[b] - px[d], by = py[b] - py[d];
    const cx = px[c] - px[d], cy = py[c] - py[d];
    return (
      (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > tol
    );
  };
  sweep((u, v, p, q) => inCircle(u, v, p, q));
  if (prefer) sweep(prefer);

  const out: Tri[] = tri.map(([a, b, c]) =>
    a < b && a < c ? { a, b, c } : b < c ? { a: b, b: c, c: a } : { a: c, b: a, c: b },
  );
  out.sort((s, t) => s.a - t.a || s.b - t.b || s.c - t.c);
  return { tris: out, missing };
}
