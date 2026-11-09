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
        const centerIn = (ha + hb + hc + hd) / 4 >= level;
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

  const edgePt = (e: number): Pt => {
    if (e < hEdges) {
      const j = Math.floor(e / n);
      const i = e - j * n;
      const a = heights[j * side + i];
      const b = heights[j * side + i + 1];
      return { x: i + (level - a) / (b - a), y: j };
    }
    const k = e - hEdges;
    const j = Math.floor(k / side);
    const i = k - j * side;
    const a = heights[j * side + i];
    const b = heights[(j + 1) * side + i];
    return { x: i, y: j + (level - a) / (b - a) };
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
