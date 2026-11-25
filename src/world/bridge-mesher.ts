/**
 * What carries a lifted road (road-levels.ts): under a bridge its slab, parapets and piers, under
 * an approach its embankment. The deck itself is the road's ribbon (osm-mesher); this is the body
 * below and beside it, built from the deck's centre line.
 */
import { RAMP } from '../engine/palette';

/** the slab under the deck */
export const SLAB_THICK_M = 1;
/** the parapets on the deck's edges */
export const PARAPET_M = 0.9;
export const PARAPET_THICK_M = 0.3;
/** a pier every this far along the way (from the way's start: the same in every tile) */
export const PIER_SPACING_M = 30;
/** no pier where the slab is lower over the ground than this */
export const PIER_MIN_CLEAR_M = 2.5;
/** a pier's size along the way, and across it as a share of the deck's half width */
const PIER_LENGTH_M = 1;
const PIER_WIDTH = 0.6;
/** piers and slopes reach this far into the ground */
const FOOT_M = 1;
/** a deck's edge at a bend or a joint lies at most this many half widths from the node (a mitre, cut short at a sharp turn) */
export const MITRE_LIMIT = 2.5;
/** where an embankment's stretches meet: the slope swept round in steps of at most this, radians */
const JOINT_STEP = Math.PI / 8;
/** the cap over a swept corner, and a structure's own top, lie this far under the deck (its ribbon) */
const CAP_M = 0.03;
/** an embankment's slope: this far out for a metre down */
export const SLOPE = 1.5;

export interface DeckStation {
  /** metres from the start of the way */
  d: number;
  x: number;
  z: number;
  /** the deck's top on the centre line, and the ground under it, under the left and the right edge, m */
  y: number;
  ground: number;
  groundL: number;
  groundR: number;
  /** unit vector to the left of the way's direction */
  nx: number;
  nz: number;
  half: number;
  /**
   * the deck's edges here in plan (x, z), left and right, and the parapets' inner edges: where the
   * way bends or meets others (deckJoint), the edges of the stretches met; else square to the way,
   * `half` out
   */
  l?: [number, number];
  r?: [number, number];
  li?: [number, number];
  ri?: [number, number];
}

export interface DeckRun {
  stations: DeckStation[];
  /** a bridge: slab, parapets and piers; else an embankment */
  bridge: boolean;
  /**
   * a bridge that stands on walls, not piers (a footbridge's ramp or steps): its sides straight down
   * into the ground, nothing under it
   */
  solid?: boolean;
  /**
   * a bridge: whether its first and its last station is a node other decks meet it at (its edges
   * there theirs too: deckJoint): no cut end there, the deck closed to the node instead
   */
  joined?: [boolean, boolean];
  /** a bridge: a top of its own just under the deck's ribbon (what a ribbon's round end leaves open at a corner) */
  cap?: boolean;
  /** face colour of the embankment's slopes */
  earth: number;
  /** the embankment's slope, this far out for a metre down (default SLOPE; 0: walls straight down) */
  slope?: number;
  /** the ground at a point (world metres): where an embankment's slope meets it (else the ground under the deck's edge) */
  groundAt?: (x: number, z: number) => number;
  /** no pier stands here (the road under the bridge) */
  blocked?: (x: number, z: number) => boolean;
  /**
   * a deck level across (a way with a height of its own, a straight bridge: osm-mesher levelDeck):
   * its ribbon is at the centre line's height edge to edge, and so are the slab and the parapets
   * (else each edge lies as far over the ground under it as the centre line does)
   */
  level?: boolean;
}

type V3 = [number, number, number];

/** `a` with `b` put in before its element `at` */
export function insertAt<T extends Float32Array | Uint32Array>(a: T, b: T, at: number): T {
  const out = new (a.constructor as new (n: number) => T)(a.length + b.length);
  out.set(a.subarray(0, at));
  out.set(b, at);
  out.set(a.subarray(at), at + b.length);
  return out;
}

export interface JointLeg {
  /** unit direction away from the node (x, z) */
  dir: [number, number];
  half: number;
}

/**
 * Where decks meet at a node (a bend of one way: two legs; a bridge's end and its ramps: more): the
 * corner of each leg's edge with its neighbour's that faces it, the two edges' lines met (a mitre),
 * no further from the node than MITRE_LIMIT of the wider half. Per leg its corner to the left and
 * to the right of its direction away from the node, each shared with the neighbour on that side: the
 * decks tile the joint, no gap and no overlap. `inset` moves every edge in (a parapet's inner face).
 * A leg alone ends square.
 */
export function deckJoint(node: [number, number], legs: ReadonlyArray<JointLeg>, inset = 0): Array<{ l: [number, number]; r: [number, number] }> {
  const TAU = 2 * Math.PI;
  // left of a direction (x east, z south): as a station's normal
  const left = (d: [number, number]): [number, number] => [d[1], -d[0]];
  /** the angle from leg a round to leg b, turning to a's left, 0..2π */
  const turn = (a: JointLeg, b: JointLeg): number => {
    const n = left(a.dir);
    const t = Math.atan2(b.dir[0] * n[0] + b.dir[1] * n[1], b.dir[0] * a.dir[0] + b.dir[1] * a.dir[1]);
    return t <= 1e-9 ? t + TAU : t;
  };
  /** the corner of leg a's edge on `side` (1 left, −1 right) with leg b's edge facing it */
  const corner = (a: JointLeg, b: JointLeg | undefined, side: 1 | -1): [number, number] => {
    const na = left(a.dir), ha = Math.max(0, a.half - inset);
    const own: [number, number] = [node[0] + na[0] * ha * side, node[1] + na[1] * ha * side];
    if (!b) return own;
    const nb = left(b.dir), hb = Math.max(0, b.half - inset);
    const den = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
    // straight on (or back along itself): its own edge, square
    if (Math.abs(den) < 1e-3) return own;
    // a's edge: node + na·ha·side + t·a.dir; b's, on its other side: node − nb·hb·side + u·b.dir
    const ex = -nb[0] * hb * side - na[0] * ha * side, ez = -nb[1] * hb * side - na[1] * ha * side;
    const t = (ex * b.dir[1] - ez * b.dir[0]) / den;
    let x = na[0] * ha * side + a.dir[0] * t, z = na[1] * ha * side + a.dir[1] * t;
    const len = Math.hypot(x, z), max = MITRE_LIMIT * Math.max(ha, hb);
    if (len > max && len > 0) { x *= max / len; z *= max / len; }
    return [node[0] + x, node[1] + z];
  };
  return legs.map((a) => {
    let lb: JointLeg | undefined, rb: JointLeg | undefined, lt = Infinity, rt = -Infinity;
    for (const b of legs) {
      if (b === a) continue;
      const t = turn(a, b);
      if (t < lt) { lt = t; lb = b; }
      if (t > rt) { rt = t; rb = b; }
    }
    return { l: corner(a, lb, 1), r: corner(a, rb, -1) };
  });
}

/** pos + normal (6 floats a vertex) and a face colour a vertex, like every world mesh */
export function buildDecks(runs: DeckRun[]): { vertices: Float32Array; ramps: Uint32Array } {
  const verts: number[] = [];
  const ramps: number[] = [];
  /** a flat-shaded triangle; its normal turned towards `out` */
  const tri = (a: V3, b: V3, c: V3, out: V3, ramp: number): void => {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    const s = (nx * out[0] + ny * out[1] + nz * out[2] < 0 ? -1 : 1) / len;
    nx *= s; ny *= s; nz *= s;
    for (const p of [a, b, c]) {
      verts.push(p[0], p[1], p[2], nx, ny, nz);
      ramps.push(ramp);
    }
  };
  const quad = (a: V3, b: V3, c: V3, d: V3, out: V3, ramp: number): void => {
    tri(a, b, c, out, ramp);
    tri(a, c, d, out, ramp);
  };

  for (const run of runs) {
    const st = run.stations;
    if (st.length < 2) continue;
    /** a point `u` metres left of the centre line at station s, at height y */
    const at = (s: DeckStation, u: number, y: number): V3 => [s.x + s.nx * u, y, s.z + s.nz * u];
    /** the deck's top at an edge: a level deck's at the centre line's, else as far over the ground there as on the centre line */
    const edgeY = (s: DeckStation, side: 1 | -1): number => (run.level ? s.y : s.y - s.ground + (side === 1 ? s.groundL : s.groundR));
    /** the deck's edge at station s on `side`, or the parapet's inner edge there, at height y */
    const edge = (s: DeckStation, side: 1 | -1, y: number, inner = false): V3 => {
      const p = inner ? (side === 1 ? s.li : s.ri) : side === 1 ? s.l : s.r;
      return p ? [p[0], y, p[1]] : at(s, (s.half - (inner ? PARAPET_THICK_M : 0)) * side, y);
    };
    /** the ground under that edge, FOOT_M into it: a wall's foot */
    const footAt = (s: DeckStation, side: 1 | -1): number => {
      const p = edge(s, side, 0);
      return Math.min(run.groundAt ? run.groundAt(p[0], p[2]) : side === 1 ? s.groundL : s.groundR, edgeY(s, side)) - FOOT_M;
    };
    const along = (a: DeckStation, b: DeckStation): V3 => {
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return [(b.x - a.x) / l, 0, (b.z - a.z) / l];
    };

    if (run.bridge) {
      const c = RAMP.CONCRETE;
      /** the bottom of the deck's side at station s: its slab's, or a wall's foot in the ground */
      const under = (s: DeckStation, side: 1 | -1): number => (run.solid ? footAt(s, side) : edgeY(s, side) - SLAB_THICK_M);
      for (let i = 0; i + 1 < st.length; i++) {
        const a = st[i], b = st[i + 1];
        const t = along(a, b);
        for (const side of [1, -1] as const) {
          const ya = edgeY(a, side), yb = edgeY(b, side);
          // out from this stretch (its own normal: a station's at a joint points anywhere)
          const n: V3 = [t[2] * side, 0, -t[0] * side];
          // the slab's side (or the wall) and the parapet over it, one face; the parapet's top and its inner face
          quad(edge(a, side, under(a, side)), edge(b, side, under(b, side)), edge(b, side, yb + PARAPET_M), edge(a, side, ya + PARAPET_M), n, c);
          quad(edge(a, side, ya + PARAPET_M), edge(b, side, yb + PARAPET_M), edge(b, side, yb + PARAPET_M, true), edge(a, side, ya + PARAPET_M, true), [0, 1, 0], c);
          quad(edge(a, side, ya, true), edge(b, side, yb, true), edge(b, side, yb + PARAPET_M, true), edge(a, side, ya + PARAPET_M, true), [-n[0], 0, -n[2]], c);
        }
        // the slab's underside
        if (!run.solid) quad(edge(a, 1, under(a, 1)), edge(b, 1, under(b, 1)), edge(b, -1, under(b, -1)), edge(a, -1, under(a, -1)), [0, -1, 0], c);
        // its own top, just under the ribbon
        if (run.cap) quad(edge(a, 1, edgeY(a, 1) - CAP_M), edge(b, 1, edgeY(b, 1) - CAP_M), edge(b, -1, edgeY(b, -1) - CAP_M), edge(a, -1, edgeY(a, -1) - CAP_M), [0, 1, 0], c);
      }
      // its ends
      for (const [s, o, k] of [[st[0], st[1], 0], [st[st.length - 1], st[st.length - 2], 1]] as const) {
        const out: V3 = along(o, s);
        const l = edge(s, 1, edgeY(s, 1)), r = edge(s, -1, edgeY(s, -1));
        if (run.joined?.[k]) {
          // at a joint: closed to the node, between its two corners (the decks met there fill the rest)
          const node = (y: number): V3 => [s.x, y, s.z];
          if (run.cap) tri(edge(s, 1, l[1] - CAP_M), node(s.y - CAP_M), edge(s, -1, r[1] - CAP_M), [0, 1, 0], c);
          if (run.solid) {
            // walls under it from each corner to the node: what stands under the end of a slab met here
            const foot = Math.min(footAt(s, 1), footAt(s, -1));
            quad(edge(s, 1, foot), node(foot), node(s.y - CAP_M), edge(s, 1, l[1] - CAP_M), out, c);
            quad(node(foot), edge(s, -1, foot), edge(s, -1, r[1] - CAP_M), node(s.y - CAP_M), out, c);
          } else tri(edge(s, 1, under(s, 1)), node(s.y - SLAB_THICK_M), edge(s, -1, under(s, -1)), [0, -1, 0], c);
          continue;
        }
        // a cut end: the slab's (a wall's) face
        quad(l, r, edge(s, -1, under(s, -1)), edge(s, 1, under(s, 1)), out, c);
        // and each parapet's end over it
        for (const side of [1, -1] as const) {
          const y = edgeY(s, side);
          quad(edge(s, side, y), edge(s, side, y, true), edge(s, side, y + PARAPET_M, true), edge(s, side, y + PARAPET_M), out, c);
        }
      }
      if (run.solid) continue;
      // piers
      const first = Math.ceil((st[0].d - 1e-6) / PIER_SPACING_M) * PIER_SPACING_M;
      let i = 0;
      for (let d = first; d <= st[st.length - 1].d + 1e-6; d += PIER_SPACING_M) {
        while (i + 2 < st.length && st[i + 1].d < d) i++;
        const a = st[i], b = st[i + 1];
        const f = b.d > a.d ? Math.max(0, Math.min(1, (d - a.d) / (b.d - a.d))) : 0;
        const mix = (k: 'x' | 'z' | 'y' | 'ground' | 'groundL' | 'groundR' | 'half') => a[k] + (b[k] - a[k]) * f;
        const x = mix('x'), z = mix('z'), under = mix('y') - SLAB_THICK_M;
        if (under - mix('ground') <= PIER_MIN_CLEAR_M) continue;
        const foot = Math.min(mix('ground'), mix('groundL'), mix('groundR')) - FOOT_M;
        const t = along(a, b), w = mix('half') * PIER_WIDTH, h = PIER_LENGTH_M / 2;
        // the four corners: left-back, left-front, right-front, right-back
        const corner = (u: number, v: number, y: number): V3 => [x + a.nx * u + t[0] * v, y, z + a.nz * u + t[2] * v];
        const ring: [number, number][] = [[w, -h], [w, h], [-w, h], [-w, -h]];
        // no part of its foot on the road under the bridge (it crosses askew: a corner reaches further than the middle)
        if (run.blocked && (run.blocked(x, z) || ring.some(([u, v]) => { const c = corner(u, v, 0); return run.blocked!(c[0], c[2]); }))) continue;
        const outs: V3[] = [[a.nx, 0, a.nz], t, [-a.nx, 0, -a.nz], [-t[0], 0, -t[2]]];
        for (let k = 0; k < 4; k++) {
          const [u0, v0] = ring[k], [u1, v1] = ring[(k + 1) % 4];
          quad(corner(u0, v0, foot), corner(u1, v1, foot), corner(u1, v1, under), corner(u0, v0, under), outs[k], c);
        }
      }
      continue;
    }

    // an embankment: each stretch of the deck a prism of its own, square to it (a station's normal
    // at a switchback, from its neighbours, points anywhere: the slopes crossed), its slopes from
    // the deck's edges down to the ground and FOOT_M into it; round where the stretches meet
    const slope = run.slope ?? SLOPE;
    const earth = run.earth;
    type Dir = [number, number];
    /** a point `u` metres from station s's centre line along `n`, at height y */
    const off = (s: DeckStation, n: Dir, u: number, y: number): V3 => [s.x + n[0] * u, y, s.z + n[1] * u];
    /** the deck's edge on `side` at station s, square to n */
    const top = (s: DeckStation, n: Dir, side: 1 | -1): V3 => off(s, n, s.half * side, edgeY(s, side));
    /** where the slope from that edge meets the ground (as sampled there, never higher than at the edge), FOOT_M under it */
    const toe = (s: DeckStation, n: Dir, side: 1 | -1): V3 => {
      const y = edgeY(s, side), gEdge = side === 1 ? s.groundL : s.groundR;
      let g = gEdge;
      if (run.groundAt) {
        const p = off(s, n, (s.half + slope * Math.max(0, y - gEdge)) * side, 0);
        g = Math.min(g, run.groundAt(p[0], p[2]));
      }
      const foot = Math.min(g, y) - FOOT_M;
      return off(s, n, (s.half + slope * (y - foot)) * side, foot);
    };
    /** the face's outward side: away from the centre line, and up as far as the slope leans */
    const outward = (n: Dir, side: 1 | -1): V3 => [n[0] * side, slope > 0 ? 0.5 : 0, n[1] * side];
    // the stretches with a length, each with its normal (left of the way's direction)
    const segs: { a: number; b: number; n: Dir; t: Dir }[] = [];
    for (let i = 0; i + 1 < st.length; i++) {
      const dx = st[i + 1].x - st[i].x, dz = st[i + 1].z - st[i].z, l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      segs.push({ a: i, b: i + 1, n: [dz / l, -dx / l], t: [dx / l, dz / l] });
    }
    if (!segs.length) continue;
    for (const g of segs) {
      const a = st[g.a], b = st[g.b];
      for (const side of [1, -1] as const) quad(top(a, g.n, side), top(b, g.n, side), toe(b, g.n, side), toe(a, g.n, side), outward(g.n, side), earth);
    }
    // where two stretches meet: on each side the slope swept round the station from the one's normal
    // to the other's (outside a bend it closes the gap; inside, it lies within the two prisms), and
    // a cap just under the deck (a ribbon bevelled at a switchback leaves the swept corner open)
    for (let k = 0; k + 1 < segs.length; k++) {
      const p = segs[k], q = segs[k + 1], s = st[p.b];
      const turn = Math.atan2(p.t[0] * q.t[1] - p.t[1] * q.t[0], p.t[0] * q.t[0] + p.t[1] * q.t[1]);
      const steps = Math.ceil(Math.abs(turn) / JOINT_STEP);
      if (!steps) continue;
      const rot = (n: Dir, f: number): Dir => {
        const c = Math.cos(turn * f), sn = Math.sin(turn * f);
        return [n[0] * c - n[1] * sn, n[0] * sn + n[1] * c];
      };
      for (const side of [1, -1] as const) {
        const centre: V3 = [s.x, edgeY(s, side) - CAP_M, s.z];
        for (let j = 0; j < steps; j++) {
          const n0 = rot(p.n, j / steps), n1 = rot(p.n, (j + 1) / steps);
          const mid = rot(p.n, (j + 0.5) / steps);
          quad(top(s, n0, side), top(s, n1, side), toe(s, n1, side), toe(s, n0, side), outward(mid, side), earth);
          const t0 = top(s, n0, side), t1 = top(s, n1, side);
          tri(centre, [t0[0], t0[1] - CAP_M, t0[2]], [t1[0], t1[1] - CAP_M, t1[2]], [0, 1, 0], earth);
        }
      }
    }
    // its cut ends (where a bridge's slab takes over, or the tile ends), square to the end stretch
    for (const [s, g, sign] of [[st[segs[0].a], segs[0], -1], [st[segs[segs.length - 1].b], segs[segs.length - 1], 1]] as const) {
      const out: V3 = [g.t[0] * sign, 0, g.t[1] * sign];
      const l = top(s, g.n, 1), r = top(s, g.n, -1), tl = toe(s, g.n, 1), tr = toe(s, g.n, -1);
      quad(tl, l, r, tr, out, earth);
      // down into the ground between the toes, so a slope across the road leaves no gap
      const y = Math.min(tl[1], tr[1]) - FOOT_M;
      quad(tl, tr, [tr[0], y, tr[2]], [tl[0], y, tl[2]], out, earth);
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
