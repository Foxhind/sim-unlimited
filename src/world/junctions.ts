/**
 * The shape of an at-grade junction: where three or more carriageways meet at an OSM node — or at
 * a few nodes close together, a junction of dual carriageways — each ribbon stops short of it (its
 * trim) and one surface fills the space between their ends: the kerbs rounded between neighbouring
 * roads (fillets), straight on along a road that passes through, round about a node where nothing
 * meets it. Pure geometry in the tile's lattice: the arms are centre lines leaving the junction's
 * nodes, the result their trims and the surface as convex pieces (their union is the junction) with
 * the outline of that union.
 */
import type { P2 } from './ribbon-shapes';

/** a road leaving the junction */
export interface JunctionArm {
  /** its centre line from its node outwards: c[0] is the node (lattice) */
  c: P2[];
  /** half its carriageway's width (lattice) */
  half: number;
  /** its shoulder beyond that (lattice), 0 for none */
  shoulder: number;
  /** at most this far along c it may be trimmed (lattice) */
  maxTrim: number;
}

/** how the outline goes from an arm to the next one round the junction */
export type JunctionCorner =
  /** a kerb rounded round c with radius r, tangent to the first arm's edge ta along it and to the second's tb along it */
  | { kind: 'fillet'; ta: number; tb: number; c: P2; r: number }
  /** a sharp kerb where the edges cross, ta and tb along each */
  | { kind: 'sharp'; ta: number; tb: number }
  /** the edges do not meet within reach: straight across between the trimmed ends */
  | { kind: 'none' }
  /** a straight line or more apart: round the node (or straight between two nodes) */
  | { kind: 'open' };

export interface JunctionShape {
  /** the arms in their order round the junction (counter-clockwise in the lattice's x, y), indices into the arms given */
  order: number[];
  /** per arm (as given): how far along its centre line it is trimmed (lattice) */
  trims: number[];
  /** per arm in `order`: the kerb from it to the next one */
  corners: JunctionCorner[];
}

/** a kerb's corner is rounded with this radius, metres: by the narrower road's width, within these */
export const FILLET_MIN_M = 2;
export const FILLET_MAX_M = 9;
/** a kerb's fillet: this share of the narrower road's width */
const FILLET_SHARE = 0.6;
/** a junction trims an arm by at most this, metres */
export const MAX_TRIM_M = 30;
/** arcs within this of their circles, metres */
const ARC_TOL_M = 0.25;
/** two arms at least this far round from each other (radians, short of a straight line) leave the space between them open */
const OPEN_GAP = Math.PI - 0.02;
/** a road going on (its arms within this of opposite: cosine, about 30°) narrower flares over this many times the difference in width */
const FLARE_COS = 0.85;
const FLARE = 4;
/** …where the widths differ by more than this each side, metres */
const FLARE_MIN_M = 0.2;
/** a shoulder's band turns a corner up to this mitred, sharper bevelled (radians; 60°) */
const MITRE_TURN = Math.PI / 3;
/** two arms leaving within this of one direction (cosine; about 18°) lie side by side */
const PARALLEL_COS = 0.95;
/** an arm's direction is taken over its first this many metres */
const HEADING_M = 4;

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const unit = (a: P2): P2 => { const l = Math.hypot(a[0], a[1]); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; };
const same = (a: P2, b: P2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
/** a quarter turn of u towards increasing angle (atan2 in the lattice's x, y) */
const left = (u: P2): P2 => [-u[1], u[0]];

/** an arm as polyline pieces: each segment's unit direction, length and distance from the node */
interface Track { c: P2[]; dir: P2[]; len: number[]; at: number[]; total: number }
function track(c: P2[]): Track {
  const dir: P2[] = [], len: number[] = [], at: number[] = [0];
  for (let i = 0; i + 1 < c.length; i++) {
    const d = sub(c[i + 1], c[i]), l = Math.hypot(d[0], d[1]);
    dir.push(l > 0 ? [d[0] / l, d[1] / l] : (dir[i - 1] ?? [1, 0]));
    len.push(l);
    at.push(at[i] + l);
  }
  return { c, dir, len, at, total: at[at.length - 1] };
}
/** an arm's direction out over its first HEADING_M or so (in lattice units of that: the caller's scale) */
function heading(tr: Track): P2 {
  return unit(sub(tr.c[Math.min(tr.c.length - 1, Math.max(1, tr.at.findIndex((d) => d > 0)))], tr.c[0]));
}
/** the segment of an arm holding the point t along it */
function segOf(tr: Track, t: number): number {
  let i = 0;
  while (i < tr.len.length - 1 && tr.at[i + 1] <= t) i++;
  return i;
}
/** the point t along an arm, offset w to its side s (+1 left, −1 right of its direction out), on its segment's own parallel */
function edgeAt(tr: Track, t: number, w: number, s: number): P2 {
  const i = segOf(tr, t);
  return add(add(tr.c[i], mul(tr.dir[i], t - tr.at[i])), mul(left(tr.dir[i]), s * w));
}
/** an arm's edge (offset w on side s) at its inner vertices strictly between t0 and t1, mitred, in the order from t0 to t1 */
function edgeVertices(tr: Track, t0: number, t1: number, w: number, s: number): P2[] {
  const out: P2[] = [];
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  for (let i = 1; i < tr.c.length - 1; i++) {
    if (tr.at[i] <= lo + 1e-9 || tr.at[i] >= hi - 1e-9) continue;
    const nIn = left(tr.dir[i - 1]), nOut = left(tr.dir[i]);
    const b = unit(add(nIn, nOut)), cos = dot(b, nIn);
    out.push(add(tr.c[i], mul(b, (s * w) / Math.max(cos, 0.5))));
  }
  return t0 <= t1 ? out : out.reverse();
}
/**
 * Where arm A's edge (offset wa on its left) first crosses arm B's (offset wb on its right) within
 * their reach: the distances along each and the point, or undefined
 */
function meet(a: Track, wa: number, ra: number, b: Track, wb: number, rb: number): { ta: number; tb: number; p: P2 } | undefined {
  let best: { ta: number; tb: number; p: P2 } | undefined;
  for (let i = 0; i < a.len.length && a.at[i] <= ra; i++) {
    const p0 = add(a.c[i], mul(left(a.dir[i]), wa)), da = mul(a.dir[i], a.len[i]);
    for (let j = 0; j < b.len.length && b.at[j] <= rb; j++) {
      const q0 = add(b.c[j], mul(left(b.dir[j]), -wb)), db = mul(b.dir[j], b.len[j]);
      const den = cross(da, db);
      if (Math.abs(den) < 1e-12) continue;
      const w = sub(q0, p0), s = cross(w, db) / den, u = cross(w, da) / den;
      if (s < 0 || s > 1 || u < 0 || u > 1) continue;
      const ta = a.at[i] + s * a.len[i], tb = b.at[j] + u * b.len[j];
      if (ta > ra || tb > rb) continue;
      if (!best || ta + tb < best.ta + best.tb) best = { ta, tb, p: add(p0, mul(da, s)) };
    }
  }
  return best;
}
/** points round c from angle a0 sweeping da, the radius going from r0 to r1, its inner points only, within tol of the circle */
function sweep(c: P2, a0: number, da: number, r0: number, r1: number, tol: number): P2[] {
  const r = Math.max(r0, r1), step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
  const n = Math.max(1, Math.ceil(Math.abs(da) / Math.min(step, Math.PI / 4)));
  const out: P2[] = [];
  for (let k = 1; k < n; k++) {
    const f = k / n, a = a0 + da * f, rr = r0 + (r1 - r0) * f;
    out.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]);
  }
  return out;
}
/** the short arc round c from p to q (radius r), its inner points only */
function arc(c: P2, r: number, p: P2, q: P2, tol: number): P2[] {
  const a0 = Math.atan2(p[1] - c[1], p[0] - c[0]);
  let da = Math.atan2(q[1] - c[1], q[0] - c[0]) - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  return sweep(c, a0, da, r, r, tol);
}
const angleOf = (v: P2) => Math.atan2(v[1], v[0]);
/** where the line through p along u crosses the line through q along v, or undefined */
function lineCross(p: P2, u: P2, q: P2, v: P2): P2 | undefined {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-12) return undefined;
  return add(p, mul(u, cross(sub(q, p), v) / den));
}
/** the angle from a to b counter-clockwise, in (0, 2π] */
const turn = (a: number, b: number) => { let g = b - a; while (g <= 1e-12) g += 2 * Math.PI; while (g > 2 * Math.PI) g -= 2 * Math.PI; return g; };

/**
 * The junction of `arms` (leaving nodes round `centre`): each arm's trim and the kerbs between
 * neighbours. Neighbours less than a straight line apart get a fillet (radius by the narrower road,
 * smaller at an acute corner so its tangent points stay as far past the corner as at a right angle;
 * smaller still or a sharp corner where that reaches past what an arm can give); edges that do not
 * meet within reach go straight across; a straight line or more apart, round the node. Every arm
 * stops at least half the widest other road out (the junction's box).
 */
export function junctionShape(arms: ReadonlyArray<JunctionArm>, centre: P2, latticePerMetre: number): JunctionShape | undefined {
  const n = arms.length;
  if (n < 2) return undefined;
  const tracks = arms.map((a) => track(a.c));
  if (tracks.some((t) => t.total <= 1e-9)) return undefined;
  const heading = arms.map((_, k) => unit(sub(edgeAt(tracks[k], Math.min(tracks[k].total, HEADING_M * latticePerMetre), 0, 1), arms[k].c[0])));
  // round the centre: by where each arm is a little way out
  const placeAngle = arms.map((a, k) => angleOf(sub(edgeAt(tracks[k], Math.min(tracks[k].total, Math.max(a.half, HEADING_M * latticePerMetre)), 0, 1), centre)));
  const order = arms.map((_, k) => k).sort((p, q) => placeAngle[p] - placeAngle[q]);
  const trims = arms.map(() => 0);
  const corners: JunctionCorner[] = [];
  for (let o = 0; o < n; o++) {
    const ka = order[o], kb = order[(o + 1) % n];
    const A = arms[ka], B = arms[kb], ta = tracks[ka], tb = tracks[kb];
    const sameNode = same(A.c[0], B.c[0]);
    // how far round from A to B: by their headings at one node, by their places round the centre else
    const gap = sameNode ? turn(angleOf(heading[ka]), angleOf(heading[kb])) : turn(placeAngle[ka], placeAngle[kb]);
    if (gap >= OPEN_GAP) { corners.push({ kind: 'open' }); continue; }
    const narrow = (Math.min(A.half, B.half) * 2) / latticePerMetre;
    const bend = turn(angleOf(heading[ka]), angleOf(heading[kb]));
    let r = Math.max(FILLET_MIN_M, Math.min(FILLET_MAX_M, narrow * FILLET_SHARE)) * latticePerMetre * Math.min(1, Math.tan(Math.min(bend, Math.PI - 1e-6) / 2));
    let corner: JunctionCorner = { kind: 'none' };
    for (let tries = 0; tries < 3 && corner.kind === 'none'; tries++, r /= 2) {
      const m = meet(ta, A.half + r, A.maxTrim, tb, B.half + r, B.maxTrim);
      if (m) corner = { kind: 'fillet', ta: m.ta, tb: m.tb, c: m.p, r };
    }
    if (corner.kind === 'none') {
      const m = meet(ta, A.half, A.maxTrim, tb, B.half, B.maxTrim);
      if (m) corner = { kind: 'sharp', ta: m.ta, tb: m.tb };
    }
    if (corner.kind === 'fillet' || corner.kind === 'sharp') {
      trims[ka] = Math.max(trims[ka], corner.ta);
      trims[kb] = Math.max(trims[kb], corner.tb);
    }
    corners.push(corner);
  }
  for (let k = 0; k < n; k++) {
    const widest = Math.max(0, ...arms.filter((_, q) => q !== k).map((a) => a.half));
    trims[k] = Math.min(Math.max(trims[k], widest), arms[k].maxTrim, tracks[k].total);
  }
  // neighbours side by side (a dual carriageway's two leaving the same way, from two nodes) end
  // square across both: the one stopping short goes on to where the other stops
  for (let pass = 0; pass < 2; pass++) {
    for (let o = 0; o < n; o++) {
      if (corners[o].kind !== 'none') continue;
      const ka = order[o], kb = order[(o + 1) % n];
      if (dot(heading[ka], heading[kb]) < PARALLEL_COS) continue;
      const u = unit(add(heading[ka], heading[kb]));
      const along = (k: number) => dot(sub(edgeAt(tracks[k], trims[k], 0, 1), centre), u);
      const d = along(ka) - along(kb), lo = d > 0 ? kb : ka;
      trims[lo] = Math.min(trims[lo] + Math.abs(d), arms[lo].maxTrim, tracks[lo].total);
    }
  }
  return { order, trims, corners };
}

/**
 * The junction's surface as convex pieces (counter-clockwise), offset `extra(k)` past each arm's
 * half (0: the carriageway; the shoulder): each arm from its node to its trim, its trimmed end
 * exactly `ends[k]` ([right, left] looking out, as its ribbon has them); between each arm and the
 * next, the kerb's wedge back to their nodes (a fillet concentric with the carriageway's, narrower
 * by the shoulder), triangulated by `triangulate`.
 */
export function junctionPieces(
  shape: JunctionShape, arms: ReadonlyArray<JunctionArm>, ends: ReadonlyArray<[P2, P2]>, extra: (k: number) => number,
  latticePerMetre: number, triangulate: (ring: P2[]) => P2[][],
): P2[][] {
  const tol = ARC_TOL_M * latticePerMetre;
  const pieces: P2[][] = [];
  const push = (poly: P2[]) => {
    const p = poly.filter((q, i) => !same(q, poly[(i + poly.length - 1) % poly.length]));
    if (p.length < 3) return;
    let s = 0;
    for (let i = 0; i < p.length; i++) s += cross(p[i], p[(i + 1) % p.length]);
    if (Math.abs(s) < 1e-14) return;
    pieces.push(s > 0 ? p : p.reverse());
  };
  const tracks = arms.map((a) => track(a.c));
  arms.forEach((a, k) => {
    const tr = tracks[k], w = a.half + extra(k), t = shape.trims[k];
    if (t <= 1e-9) return;
    // its segments to the trim, each a quad on its own parallels, the last one to the exact corners
    const last = segOf(tr, t);
    for (let i = 0; i <= last; i++) {
      const n = mul(left(tr.dir[i]), w), p = tr.c[i];
      const q = i === last ? add(tr.c[i], mul(tr.dir[i], t - tr.at[i])) : tr.c[i + 1];
      const [r1, l1] = i === last ? ends[k] : [sub(q, n), add(q, n)];
      push([sub(p, n), r1, l1, add(p, n)]);
      // the wedges at a bend, outside either quad
      if (i > 0) {
        const m = mul(left(tr.dir[i - 1]), w);
        push([p, add(p, m), add(p, n)]);
        push([p, sub(p, n), sub(p, m)]);
      }
    }
  });
  shape.order.forEach((ka, o) => {
    const kb = shape.order[(o + 1) % shape.order.length], corner = shape.corners[o];
    const A = arms[ka], B = arms[kb], ta = tracks[ka], tb = tracks[kb];
    const ea = extra(ka), eb = extra(kb), wa = A.half + ea, wb = B.half + eb;
    const trA = shape.trims[ka], trB = shape.trims[kb];
    /** A's edge facing B at t (its exact corner at the trim), B's facing A */
    const atA = (t: number): P2 => (t >= trA - 1e-9 ? ends[ka][1] : edgeAt(ta, t, wa, 1));
    const atB = (t: number): P2 => (t >= trB - 1e-9 ? ends[kb][0] : edgeAt(tb, t, wb, -1));
    const nodes = same(A.c[0], B.c[0]) ? [A.c[0]] : [B.c[0], A.c[0]];
    const wedge = (ring: P2[]) => triangulate(ring).forEach(push);
    // a road going on as a narrower or wider one (a lane more onto a roundabout): the kerb flares
    // from the wider one's trimmed corner onto the narrower one's edge over FLARE times the difference
    const ha = heading(ta), hb = heading(tb);
    if (dot(ha, hb) < -FLARE_COS && Math.abs(wa - wb) > FLARE_MIN_M * latticePerMetre && corner.kind !== 'fillet' && corner.kind !== 'sharp') {
      if (wa > wb) {
        const tf = Math.min(tb.total, trB + FLARE * (wa - wb));
        wedge([...nodes, atA(0), ...edgeVertices(ta, 0, trA, wa, 1), atA(trA), atB(tf), ...edgeVertices(tb, tf, 0, wb, -1), atB(0)]);
      } else {
        const tf = Math.min(ta.total, trA + FLARE * (wb - wa));
        wedge([...nodes, atA(0), ...edgeVertices(ta, 0, tf, wa, 1), atA(tf), atB(trB), ...edgeVertices(tb, trB, 0, wb, -1), atB(0)]);
      }
      return;
    }
    if (corner.kind === 'open') {
      if (nodes.length === 1) {
        const pa = atA(0), pb = atB(0), a0 = angleOf(sub(pa, A.c[0]));
        wedge([A.c[0], pa, ...sweep(A.c[0], a0, turn(a0, angleOf(sub(pb, A.c[0]))), wa, wb, tol), pb]);
      } else wedge([...nodes, atA(0), atB(0)]);
      return;
    }
    if (corner.kind === 'none') {
      wedge([...nodes, atA(0), ...edgeVertices(ta, 0, trA, wa, 1), atA(trA), atB(trB), ...edgeVertices(tb, trB, 0, wb, -1), atB(0)]);
      return;
    }
    if (corner.kind === 'sharp') return;
    // the fillet: what it adds beyond the corner the edges make, fanned from that corner
    const pa = atA(corner.ta), pb = atB(corner.tb);
    const x = meet(ta, wa, Math.max(corner.ta, trA) + 1e-9, tb, wb, Math.max(corner.tb, trB) + 1e-9)?.p ?? lineCross(pa, ta.dir[segOf(ta, corner.ta)], pb, tb.dir[segOf(tb, corner.tb)]);
    if (!x) return;
    const fan = [pa, ...arc(corner.c, corner.r, pa, pb, tol), pb];
    for (let i = 0; i + 1 < fan.length; i++) push([x, fan[i], fan[i + 1]]);
  });
  return pieces;
}

/**
 * The outline of the union of convex pieces (counter-clockwise): their edges split wherever another
 * piece's edge crosses or touches them, each stretch kept where just outside it (to its right) no
 * piece holds — so an edge two pieces share, or one inside another, goes — once, as polylines
 */
export function unionOutline(pieces: ReadonlyArray<P2[]>): P2[][] {
  const TOUCH = 1e-9, PROBE = 1e-7;
  const holds = (j: number, p: P2): boolean => {
    const poly = pieces[j];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if (cross(sub(b, a), sub(p, a)) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) <= 0) return false;
    }
    return true;
  };
  const boxes = pieces.map((p) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - PROBE, y0 - PROBE, x1 + PROBE, y1 + PROBE];
  });
  const seen = new Set<string>();
  const key = (a: P2, b: P2) => `${Math.round(a[0] * 1e8)},${Math.round(a[1] * 1e8)},${Math.round(b[0] * 1e8)},${Math.round(b[1] * 1e8)}`;
  const stretches: P2[][] = [];
  pieces.forEach((poly, pi) => {
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length], d = sub(q, p), len = Math.hypot(d[0], d[1]);
      if (len < 1e-12) continue;
      const lo = [Math.min(p[0], q[0]), Math.min(p[1], q[1])], hi = [Math.max(p[0], q[0]), Math.max(p[1], q[1])];
      const near: number[] = [];
      for (let j = 0; j < pieces.length; j++) {
        if (j !== pi && !(boxes[j][2] < lo[0] || boxes[j][0] > hi[0] || boxes[j][3] < lo[1] || boxes[j][1] > hi[1])) near.push(j);
      }
      // where the others' edges cross it or their corners touch it
      const ts = [0, 1];
      for (const j of near) {
        const o = pieces[j];
        for (let m = 0; m < o.length; m++) {
          const a = o[m], b = o[(m + 1) % o.length], e = sub(b, a);
          // a corner on the edge
          const t = dot(sub(a, p), d) / (len * len);
          if (t > 0 && t < 1 && Math.abs(cross(d, sub(a, p))) / len < TOUCH) ts.push(t);
          const den = cross(d, e);
          if (Math.abs(den) < 1e-15) continue;
          const w = sub(a, p), u = cross(w, e) / den, v = cross(w, d) / den;
          if (u > 0 && u < 1 && v >= -1e-12 && v <= 1 + 1e-12) ts.push(u);
        }
      }
      ts.sort((x, y) => x - y);
      const out = mul(left(unit(d)), -PROBE);
      for (let m = 0; m + 1 < ts.length; m++) {
        const t0 = ts[m], t1 = ts[m + 1];
        if ((t1 - t0) * len <= 1e-9) continue;
        const mid = add(add(p, mul(d, (t0 + t1) / 2)), out);
        if (near.some((j) => holds(j, mid))) continue;
        const a = t0 <= 0 ? p : add(p, mul(d, t0)), b = t1 >= 1 ? q : add(p, mul(d, t1));
        const kk = key(a, b);
        if (seen.has(kk)) continue;
        seen.add(kk);
        stretches.push([a, b]);
      }
    }
  });
  return chain(stretches);
}

/**
 * Polylines joined end to start where one ends on (within `tol` of) another's start, a ring closed
 * on its first point: the stretches of a union's edge as its rings
 */
function chain(lines: P2[][], tol = 1e-3): P2[][] {
  const used = new Uint8Array(lines.length), out: P2[][] = [];
  const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [...lines[i]];
    for (;;) {
      const end = line[line.length - 1];
      if (line.length > 2 && near(end, line[0])) { line[line.length - 1] = line[0]; break; }
      let next = -1, best = tol;
      for (let j = 0; j < lines.length; j++) {
        if (used[j]) continue;
        const d = Math.hypot(lines[j][0][0] - end[0], lines[j][0][1] - end[1]);
        if (d <= best) { best = d; next = j; }
      }
      if (next < 0) break;
      used[next] = 1;
      line.push(...lines[next].slice(1));
    }
    // a sliver of an edge (a corner's crumb, millimetres long) is no edge
    let len = 0;
    for (let k = 1; k < line.length; k++) len += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
    if (len > 10 * tol) out.push(line);
  }
  return out;
}

/** an arm's corners at t along it, `extra` past its half: [its right, its left] looking out (where no ribbon gives them) */
export function trimCorners(arm: JunctionArm, t: number, extra: number): [P2, P2] {
  const tr = track(arm.c);
  return [edgeAt(tr, t, arm.half + extra, -1), edgeAt(tr, t, arm.half + extra, 1)];
}

/**
 * The band along the outside of outline polylines `lines` (their inside on the left, counter-
 * clockwise: unionOutline's), `r(p)` wide at each of their points (lattice): the polylines offset
 * outwards, mitred at each turn (bevelled at a convex one sharper than MITRE_TURN), in quads
 * between the line and its offset that meet edge to edge; none along the segments `skip` says (a
 * junction's trim lines, and where the roads' own shoulders run) — convex pieces. A shoulder round
 * a junction: it follows the kerbs' fillets.
 */
export function bandPieces(lines: ReadonlyArray<ReadonlyArray<P2>>, r: (p: P2) => number, skip?: (a: P2, b: P2) => boolean): P2[][] {
  const pieces: P2[][] = [];
  for (const line of lines) {
    const n = line.length, closed = n > 3 && same(line[0], line[n - 1]);
    const rs = line.map(r);
    /** the outward normal of segment i (to the right of its direction) */
    const out = (i: number): P2 => { const u = unit(sub(line[i + 1], line[i])); return [u[1], -u[0]]; };
    const on = line.map((_, i) => i + 1 < n && !same(line[i], line[i + 1]) && !skip?.(line[i], line[i + 1]));
    const prevOf = (i: number) => (i > 0 ? i - 1 : closed ? n - 2 : -1);
    const nextOf = (i: number) => (i < n - 1 ? i : closed ? 0 : -1);
    /** the offset of vertex i as segment `seg` ends there (end) or starts there (start) */
    const offset = (i: number, seg: number, end: boolean): P2 => {
      const p = line[i], ri = rs[i];
      const other = end ? nextOf(i) : prevOf(i);
      // a band's end, or a segment beside one not in the band: square
      if (other < 0 || !on[other]) return add(p, mul(out(seg), ri));
      const o0 = out(end ? seg : other), o1 = out(end ? other : seg);
      const turn = Math.atan2(cross(o0, o1), dot(o0, o1));
      // convex (the outline turning left) and sharp: bevelled, each segment its own square end
      if (turn > MITRE_TURN) return add(p, mul(out(seg), ri));
      const m = unit(add(o0, o1));
      return add(p, mul(m, ri / Math.max(dot(m, o0), 0.5)));
    };
    for (let i = 0; i + 1 < n; i++) {
      if (!on[i] || (rs[i] <= 1e-12 && rs[i + 1] <= 1e-12)) continue;
      const a = line[i], b = line[i + 1];
      pieces.push([a, offset(i, i, false), offset(i + 1, i, true), b]);
    }
    // the bevels' wedges
    for (let i = closed ? 0 : 1; i < n - 1; i++) {
      const pv = prevOf(i);
      if (pv < 0 || !on[pv] || !on[i] || rs[i] <= 1e-12) continue;
      const o0 = out(pv), o1 = out(i);
      if (Math.atan2(cross(o0, o1), dot(o0, o1)) <= MITRE_TURN) continue;
      pieces.push([line[i], add(line[i], mul(o0, rs[i])), add(line[i], mul(o1, rs[i]))]);
    }
  }
  return pieces;
}

/**
 * The width of a junction's shoulder at a point of its outline: its arms' shoulders weighed by how
 * near the point is to each arm's edge (inverse square), so it is each arm's own along it and goes
 * smoothly from one to the next round a kerb
 */
export function shoulderAt(arms: ReadonlyArray<JunctionArm>, trims: ReadonlyArray<number>, p: P2): number {
  let sw = 0, w = 0;
  arms.forEach((a, k) => {
    const tr = track(a.c), reach = Math.min(tr.total, trims[k] + a.half * 2);
    let d = Infinity;
    for (let i = 0; i < tr.len.length && tr.at[i] <= reach; i++) {
      const q = sub(p, tr.c[i]), t = Math.max(0, Math.min(Math.min(tr.len[i], reach - tr.at[i]), dot(q, tr.dir[i])));
      d = Math.min(d, Math.hypot(q[0] - tr.dir[i][0] * t, q[1] - tr.dir[i][1] * t));
    }
    const e = Math.max(0, d - a.half), wk = 1 / (e * e + 1e-6 * a.half * a.half);
    sw += a.shoulder * wk;
    w += wk;
  });
  return w > 0 ? sw / w : 0;
}
