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
const PARAPET_THICK_M = 0.3;
/** a pier every this far along the way (from the way's start: the same in every tile) */
export const PIER_SPACING_M = 30;
/** no pier where the slab is lower over the ground than this */
export const PIER_MIN_CLEAR_M = 2.5;
/** a pier's size along the way, and across it as a share of the deck's half width */
const PIER_LENGTH_M = 1;
const PIER_WIDTH = 0.6;
/** piers and slopes reach this far into the ground */
const FOOT_M = 1;
/** an embankment's slope: this far out for a metre down */
const SLOPE = 1.5;

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
}

export interface DeckRun {
  stations: DeckStation[];
  /** a bridge: slab, parapets and piers; else an embankment */
  bridge: boolean;
  /** face colour of the embankment's slopes */
  earth: number;
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
    const along = (a: DeckStation, b: DeckStation): V3 => {
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return [(b.x - a.x) / l, 0, (b.z - a.z) / l];
    };

    if (run.bridge) {
      const c = RAMP.CONCRETE;
      for (let i = 0; i + 1 < st.length; i++) {
        const a = st[i], b = st[i + 1];
        for (const side of [1, -1] as const) {
          const ya = edgeY(a, side), yb = edgeY(b, side);
          const n: V3 = [a.nx * side, 0, a.nz * side];
          const u = a.half * side, ub = b.half * side;
          const ui = (a.half - PARAPET_THICK_M) * side, ubi = (b.half - PARAPET_THICK_M) * side;
          // the slab's side and the parapet over it, one face; the parapet's top and its inner face
          quad(at(a, u, ya - SLAB_THICK_M), at(b, ub, yb - SLAB_THICK_M), at(b, ub, yb + PARAPET_M), at(a, u, ya + PARAPET_M), n, c);
          quad(at(a, u, ya + PARAPET_M), at(b, ub, yb + PARAPET_M), at(b, ubi, yb + PARAPET_M), at(a, ui, ya + PARAPET_M), [0, 1, 0], c);
          quad(at(a, ui, ya), at(b, ubi, yb), at(b, ubi, yb + PARAPET_M), at(a, ui, ya + PARAPET_M), [-n[0], 0, -n[2]], c);
        }
        // the slab's underside
        quad(
          at(a, a.half, edgeY(a, 1) - SLAB_THICK_M), at(b, b.half, edgeY(b, 1) - SLAB_THICK_M),
          at(b, -b.half, edgeY(b, -1) - SLAB_THICK_M), at(a, -a.half, edgeY(a, -1) - SLAB_THICK_M), [0, -1, 0], c,
        );
      }
      // the slab's cut ends
      for (const [s, o] of [[st[0], st[1]], [st[st.length - 1], st[st.length - 2]]] as const) {
        const t = along(o, s);
        const out: V3 = t;
        quad(at(s, s.half, edgeY(s, 1)), at(s, -s.half, edgeY(s, -1)), at(s, -s.half, edgeY(s, -1) - SLAB_THICK_M), at(s, s.half, edgeY(s, 1) - SLAB_THICK_M), out, c);
      }
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

    // an embankment: from each edge of the deck down its slope to the ground
    const toe = (s: DeckStation, side: 1 | -1): V3 => {
      const g = side === 1 ? s.groundL : s.groundR, h = Math.max(0, edgeY(s, side) - g);
      return at(s, (s.half + SLOPE * h) * side, g);
    };
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i], b = st[i + 1];
      for (const side of [1, -1] as const) {
        quad(at(a, a.half * side, edgeY(a, side)), at(b, b.half * side, edgeY(b, side)), toe(b, side), toe(a, side), [a.nx * side, 1, a.nz * side], run.earth);
      }
    }
    // its cut ends (where a bridge's slab takes over, or the tile ends)
    for (const [s, o] of [[st[0], st[1]], [st[st.length - 1], st[st.length - 2]]] as const) {
      const out = along(o, s);
      const l = at(s, s.half, edgeY(s, 1)), r = at(s, -s.half, edgeY(s, -1));
      const tl = toe(s, 1), tr = toe(s, -1);
      quad(tl, l, r, tr, out, run.earth);
      // down into the ground between the toes, so a slope across the road leaves no gap
      quad(tl, tr, [tr[0], Math.min(tl[1], tr[1]) - FOOT_M, tr[2]], [tl[0], Math.min(tl[1], tr[1]) - FOOT_M, tl[2]], out, run.earth);
    }
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
