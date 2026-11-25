/**
 * The straight skeleton of a footprint (Aichholzer et al. 1995): every edge moves inward at unit speed,
 * parallel to itself, until the polygon shrinks to nothing; the vertices trace the skeleton. A hipped
 * roof is that wavefront lifted by time × slope: each face is the region one edge sweeps, a plane
 * through the edge.
 *
 * Event-driven and exact in time: each wavefront vertex moves linearly, so the moment an edge shrinks to
 * zero (edge event) or a reflex vertex runs into an opposite edge (split event) is the root of a linear
 * equation. The next event is found by brute force over the current wavefront (footprints are small:
 * MAX_VERTICES), which keeps the bookkeeping trivial (Felkel–Obdržálek with no queue to invalidate).
 *
 * Coordinates are a right-handed plan (x, z): the outer ring turns counter-clockwise (positive signed
 * area), holes clockwise, so the interior is always to the left of an edge.
 */

export type XZ = [number, number];

export interface SkeletonEdge {
  /** start, unit direction and inward (left) normal; the offset line at time t is n·p − c = t */
  a: XZ;
  d: XZ;
  n: XZ;
  c: number;
}

export interface Skeleton {
  /** node positions and times (the time is the distance to the footprint) */
  nodes: { p: XZ; t: number }[];
  /** the input edges, rings concatenated (edge i runs from vertex i to the next one of its ring) */
  edges: SkeletonEdge[];
  /** per input edge, its face as node indices: the edge's start, its end, then the skeleton back */
  faces: number[][];
  /** the latest event: half the width of the widest part */
  tMax: number;
}

/** footprints with more vertices keep their simple roofs (the brute force is O(n³)) */
export const MAX_VERTICES = 160;

const EPS = 1e-7;
const MERGE = 1e-5;

interface Vert {
  p: XZ;
  t: number;
  v: XZ;
  eIn: number;
  eOut: number;
  prev: Vert;
  next: Vert;
  node: number;
  alive: boolean;
  reflex: boolean;
  /** its two edges are antiparallel: a zero-width spike that collapses at once */
  spike: boolean;
}

function signedArea(r: XZ[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/**
 * The straight skeleton of `rings` (outer first, then holes; any orientation, not closed), or undefined
 * where the footprint is too big or the events do not close into faces (degenerate input).
 */
export function straightSkeleton(rings: XZ[][]): Skeleton | undefined {
  const clean = rings.map((r, i) => {
    const out: XZ[] = [];
    for (const p of r) {
      const q = out[out.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push([p[0], p[1]]);
    }
    while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-4) out.pop();
    const a = signedArea(out);
    return (i === 0 ? a < 0 : a > 0) ? out.reverse() : out;
  }).filter((r, i) => i === 0 || r.length >= 3);
  if (!clean.length || clean[0].length < 3) return undefined;
  const total = clean.reduce((s, r) => s + r.length, 0);
  if (total > MAX_VERTICES) return undefined;

  const nodes: { p: XZ; t: number }[] = [];
  const addNode = (p: XZ, t: number): number => nodes.push({ p, t }) - 1;
  const edges: SkeletonEdge[] = [];
  const segs: [number, number][][] = [];
  const addSeg = (a: number, b: number, es: number[]) => {
    if (a === b) return;
    for (const e of es) segs[e].push([a, b]);
  };

  const pos = (v: Vert, t: number): XZ => [v.p[0] + v.v[0] * (t - v.t), v.p[1] + v.v[1] * (t - v.t)];

  const makeVert = (p: XZ, t: number, eIn: number, eOut: number, node: number): Vert => {
    const A = edges[eIn].n, B = edges[eOut].n;
    const det = A[0] * B[1] - A[1] * B[0];
    let v: XZ = [0, 0];
    let spike = false;
    if (Math.abs(det) < 1e-9) {
      if (A[0] * B[0] + A[1] * B[1] > 0) v = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      else spike = true;
    } else {
      v = [(B[1] - A[1]) / det, (A[0] - B[0]) / det];
    }
    const dI = edges[eIn].d, dO = edges[eOut].d;
    const vert = { p, t, v, eIn, eOut, node, alive: true, reflex: dI[0] * dO[1] - dI[1] * dO[0] < -1e-9, spike } as Vert;
    vert.prev = vert.next = vert;
    return vert;
  };

  const verts: Vert[] = [];
  for (const r of clean) {
    const base = edges.length;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const d: XZ = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const n: XZ = [-d[1], d[0]];
      edges.push({ a, d, n, c: n[0] * a[0] + n[1] * a[1] });
      segs.push([]);
    }
    const ring: Vert[] = [];
    for (let i = 0; i < r.length; i++) {
      const node = addNode(r[i], 0);
      ring.push(makeVert(r[i], 0, base + ((i + r.length - 1) % r.length), base + i, node));
    }
    for (let i = 0; i < ring.length; i++) {
      ring[i].next = ring[(i + 1) % ring.length];
      ring[i].prev = ring[(i + ring.length - 1) % ring.length];
    }
    verts.push(...ring);
  }
  // the footprint's own edges close each face
  const edgeEnds: [number, number][] = [];
  {
    let k = 0;
    for (const r of clean) {
      for (let i = 0; i < r.length; i++) edgeEnds.push([k + i, k + ((i + 1) % r.length)]);
      k += r.length;
    }
  }

  const kill = (v: Vert, node: number) => {
    v.alive = false;
    addSeg(v.node, node, [v.eIn, v.eOut]);
  };

  /** a wavefront of two vertices has no area left: both stop, joined by a ridge */
  const close = (a: Vert, b: Vert, t: number) => {
    const pa = pos(a, t), pb = pos(b, t);
    const na = addNode(pa, t);
    const nb = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < MERGE ? na : addNode(pb, t);
    kill(a, na);
    kill(b, nb);
    addSeg(na, nb, [a.eOut, b.eOut]);
  };

  const settle = (w: Vert, t: number) => {
    if (!w.alive) return;
    if (w.next === w) { w.alive = false; return; }
    if (w.next.next === w) { close(w, w.next, t); return; }
    if (w.spike) {
      // slide along the collapsed spike to the nearer neighbour and merge with it
      const pp = pos(w.prev, t), pn = pos(w.next, t);
      const dp = Math.hypot(pp[0] - w.p[0], pp[1] - w.p[1]), dn = Math.hypot(pn[0] - w.p[0], pn[1] - w.p[1]);
      if (dp <= dn) edgeEvent(w.prev, w, t, pp); else edgeEvent(w, w.next, t, pn);
    }
  };

  const edgeEvent = (a: Vert, b: Vert, t: number, at?: XZ) => {
    const pa = pos(a, t), pb = pos(b, t);
    const P: XZ = at ?? [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const node = addNode(P, t);
    kill(a, node);
    kill(b, node);
    const prev = a.prev, next = b.next;
    if (prev === b) return; // the two were all that was left
    const w = makeVert(P, t, a.eIn, b.eOut, node);
    w.prev = prev; w.next = next; prev.next = w; next.prev = w;
    verts.push(w);
    settle(w, t);
  };

  const splitEvent = (v: Vert, u: Vert, t: number) => {
    const P = pos(v, t);
    const node = addNode(P, t);
    kill(v, node);
    const x = u.next, E = u.eOut;
    const v1 = makeVert(P, t, v.eIn, E, node);
    const v2 = makeVert(P, t, E, v.eOut, node);
    const vp = v.prev, vn = v.next;
    v1.prev = vp; vp.next = v1; v1.next = x; x.prev = v1;
    v2.prev = u; u.next = v2; v2.next = vn; vn.prev = v2;
    verts.push(v1, v2);
    settle(v1, t);
    settle(v2, t);
  };

  let now = 0;
  const limit = 20 * total + 100;
  for (let iter = 0; ; iter++) {
    if (iter > limit) return undefined;
    const live = verts.filter((v) => v.alive);
    if (!live.length) break;
    let best = Infinity, kind = 0, A: Vert | undefined, B: Vert | undefined;
    for (const a of live) {
      const b = a.next;
      // edge event: a and b meet on the offset line of their shared edge
      const d = edges[a.eOut].d;
      const g1 = d[0] * (b.v[0] - a.v[0]) + d[1] * (b.v[1] - a.v[1]);
      const gNow = d[0] * (pos(b, now)[0] - pos(a, now)[0]) + d[1] * (pos(b, now)[1] - pos(a, now)[1]);
      let te = Infinity;
      if (gNow <= EPS) te = now;
      else if (g1 < -1e-12) te = now - gNow / g1;
      if (te < best - 1e-9 || (te <= best + 1e-9 && kind === 2)) { best = te; kind = 1; A = a; B = b; }
    }
    for (const v of live) {
      if (!v.reflex || v.spike) continue;
      for (const u of live) {
        const E = u.eOut;
        if (u === v || u.next === v || E === v.eIn || E === v.eOut) continue;
        const e = edges[E];
        const pv = pos(v, now);
        const fNow = e.n[0] * pv[0] + e.n[1] * pv[1] - e.c - now;
        const f1 = e.n[0] * v.v[0] + e.n[1] * v.v[1] - 1;
        if (fNow < -EPS || f1 > -1e-12) continue;
        const ts = now - fNow / f1;
        if (ts >= best - 1e-9) continue;
        const P = pos(v, ts);
        const s = e.d[0] * P[0] + e.d[1] * P[1];
        const pu = pos(u, ts), px = pos(u.next, ts);
        const s0 = e.d[0] * pu[0] + e.d[1] * pu[1], s1 = e.d[0] * px[0] + e.d[1] * px[1];
        if (s < s0 - 1e-6 || s > s1 + 1e-6) continue;
        best = ts; kind = 2; A = v; B = u;
      }
    }
    if (!A || !B || !Number.isFinite(best)) return undefined;
    now = Math.max(now, best);
    if (kind === 1) edgeEvent(A, B, now);
    else splitEvent(A, B, now);
  }

  // merge coincident nodes, then walk each face from its edge
  const rep: number[] = nodes.map((_, i) => i);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const [x, z] = nodes[i].p;
    const gx = Math.round(x / MERGE), gz = Math.round(z / MERGE);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dz = -1; dz <= 1 && found < 0; dz++) {
        for (const j of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (Math.hypot(nodes[j].p[0] - x, nodes[j].p[1] - z) < MERGE) { found = j; break; }
        }
      }
    }
    if (found >= 0) rep[i] = found;
    else {
      const k = `${gx},${gz}`;
      grid.set(k, [...(grid.get(k) ?? []), i]);
    }
  }

  const faces: number[][] = [];
  for (let e = 0; e < edges.length; e++) {
    const [s, f] = edgeEnds[e].map((i) => rep[i]);
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      adj.set(a, [...(adj.get(a) ?? []), b]);
      adj.set(b, [...(adj.get(b) ?? []), a]);
    };
    let count = 0;
    for (const [a0, b0] of segs[e]) {
      const a = rep[a0], b = rep[b0];
      if (a === b) continue;
      link(a, b);
      count++;
    }
    // walk from the edge's end back to its start through the skeleton
    const ring = [s, f];
    const used = new Set<string>();
    const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    let cur = f, prev = s, steps = 0;
    while (cur !== s) {
      const free = (adj.get(cur) ?? []).filter((n) => !used.has(key(cur, n)));
      // a node can repeat where the face pinches: never turn straight back if there is a way on
      const nxt = free.find((n) => n !== prev) ?? free[0];
      if (nxt === undefined || ++steps > count + 1) return undefined;
      used.add(key(cur, nxt));
      if (nxt !== s) ring.push(nxt);
      prev = cur;
      cur = nxt;
    }
    faces.push(ring);
  }

  let tMax = 0;
  for (const n of nodes) tMax = Math.max(tMax, n.t);
  return { nodes, edges, faces, tMax };
}
