/**
 * The ground pulled to the roads (roads first, then the land under them).
 *
 *   F(p) = B(p) + w(p) · (R(p) − B(p))
 *
 * B is the base relief. For every stretch of road near p, u = S(1 − max(0, dist − half) / band),
 * S a smooth step: 1 on the road's bed (carriageway and shoulder), 0 beyond its pull band. w is the
 * largest u and R the average of the roads' heights weighted by u / (1 − u), which grows without
 * bound towards a bed: on a bed the ground is exactly that road's height (the senior road's where
 * beds overlap), even with another road at another height in its band, and between two roads it
 * runs from the one to the other. Bridges, tunnels and roads without a height pull nothing.
 *
 * Everything is a function of the point and the network round it, in metres at the point's own
 * latitude: two tiles that see the same roads give the same F on their shared border.
 */
import type { Pt } from './contours';
import { EARTH_R, mercatorYToLat, type Tile } from './geodesy';
import { ROAD_WINDOW_M, roadWindow } from './road-heights';
import type { RoadNet } from './road-net';

/** the roads of a tile with the height of each network sample: H and the lift */
export interface RoadSurface {
  net: RoadNet;
  z: Float64Array;
}

export interface RoadPull {
  /** how far the ground at lattice point (x, y) is pulled to the roads: 1 on a bed, 0 beyond every band */
  weight(x: number, y: number): number;
  /** the ground there, given the base relief's height */
  height(x: number, y: number, base: number): number;
  /** the bed outline of each road inside the tile (lattice), the senior first; cut out of more senior beds */
  beds: Array<{ way: number; edges: Pt[][] }>;
  /**
   * Where every road's outline crosses the tile border, whether or not that piece of it is kept
   * (it may be cut out on one side of the border only): the neighbour has the same points
   */
  borderPoints: Pt[];
}

/**
 * the bed outline runs this far outside the bed's edge, metres: a ribbon's shoulder lies on the
 * bed's faces to its edge, and just off the bed the pull is all but whole (1 − 3·(0.3/band)²)
 */
export const BED_MARGIN_M = 0.3;
/** bed outlines simplified to this in plan (metres) ... */
const BED_PLAN_TOL_M = 0.4;
/** ... and to this in height along them (metres; checked every half sample, so 0.2 m between) */
const BED_HEIGHT_TOL_M = 0.15;
/** and no outline segment longer than this (metres): no long sliver faces over the bed */
const BED_MAX_SEG_M = 60;
/** on a bed, a stretch of the road counts less the further the point projects past its ends ... */
const BED_ALONG_M = 3;
/** ... and fades out over this much beyond the bed's edge */
const BED_GRACE_M = 1;
/** an outline's mitre on the inside of a bend reaches at most this many times its offset */
const MITRE_MAX = 4;
/** an approach's pull band fades out over this many metres before its end at a bridge or tunnel */
const STRUCTURE_FADE_M = 10;
/** below this window (far north: a tile sees too little beyond its border) nothing is pulled */
const MIN_WINDOW_M = 30;

const smoothStep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

interface Seg {
  /** network samples at its ends */
  i: number;
  j: number;
  way: number;
}

export function buildRoadPull(tile: Tile, grid: number, roads: RoadSurface): RoadPull {
  const { net, z } = roads;
  const n = 2 ** tile.z;
  // lattice coordinates of every sample
  const sx = new Float64Array(net.samples.length), sy = new Float64Array(net.samples.length);
  net.samples.forEach((s, k) => {
    sx[k] = (((s.lon + 180) / 360) * n - tile.x) * grid;
    const sin = Math.sin((s.lat * Math.PI) / 180);
    sy[k] = ((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n - tile.y) * grid;
  });
  /** metres a lattice cell at lattice row y */
  const cellM = (2 * Math.PI * EARTH_R) / n / grid;
  const latOf = (y: number) => mercatorYToLat((tile.y + y / grid) / n);
  const mpc = (y: number) => cellM * Math.cos((latOf(y) * Math.PI) / 180);
  /** the band scale at row y: the window there over the full window; 0 where nothing is pulled */
  const bandScale = (y: number) => {
    const w = roadWindow(latOf(y));
    return w < MIN_WINDOW_M ? 0 : w / ROAD_WINDOW_M;
  };

  // the stretches that pull: not bridges or tunnels, both ends with a height
  const segs: Seg[] = [];
  net.ways.forEach((w, wi) => {
    if (w.bridge || w.tunnel) return;
    for (let k = w.first; k + 1 < w.first + w.count; k++) {
      if (Number.isFinite(z[k]) && Number.isFinite(z[k + 1])) segs.push({ i: k, j: k + 1, way: wi });
    }
  });

  // a grid of cells over the tile (and the margin the roads reach into it from)
  const CELL = 1; // lattice cells
  const cells = new Map<number, number[]>();
  const ckey = (cx: number, cy: number) => (cx + 4096) * 8192 + (cy + 4096);
  const maxScale = Math.max(bandScale(0), bandScale(grid));
  for (let s = 0; s < segs.length; s++) {
    const { i, j, way } = segs[s];
    const w = net.ways[way];
    const r = ((w.half + w.band * maxScale) / Math.min(mpc(0), mpc(grid))) * 1.01;
    const x0 = Math.floor((Math.min(sx[i], sx[j]) - r) / CELL), x1 = Math.floor((Math.max(sx[i], sx[j]) + r) / CELL);
    const y0 = Math.floor((Math.min(sy[i], sy[j]) - r) / CELL), y1 = Math.floor((Math.max(sy[i], sy[j]) + r) / CELL);
    // only the cells over the tile and just round it are ever asked for
    const lo = -2, hi = Math.ceil(grid / CELL) + 2;
    for (let cx = Math.max(lo, x0); cx <= Math.min(hi, x1); cx++) {
      for (let cy = Math.max(lo, y0); cy <= Math.min(hi, y1); cy++) {
        const k = ckey(cx, cy);
        const list = cells.get(k);
        if (list) list.push(s);
        else cells.set(k, [s]);
      }
    }
  }
  const near = (x: number, y: number): number[] => cells.get(ckey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? [];

  /**
   * distance (lattice cells) from (x, y) to segment s, the fraction along it, how far (cells) the
   * projection was clamped, and the unclamped fraction
   */
  const project = (s: Seg, x: number, y: number): [number, number, number, number] => {
    const ax = sx[s.i], ay = sy[s.i], dx = sx[s.j] - ax, dy = sy[s.j] - ay;
    const l2 = dx * dx + dy * dy;
    const raw = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    const t = Math.max(0, Math.min(1, raw));
    return [Math.hypot(x - ax - t * dx, y - ay - t * dy), t, Math.abs(raw - t) * Math.sqrt(l2), raw];
  };
  // seniority: priority, then the order in the network (only the outlines' cutting uses the order;
  // heights never do: two tiles may list the ways differently)
  const senior = (a: number, b: number) => net.ways[a].prio > net.ways[b].prio || (net.ways[a].prio === net.ways[b].prio && a < b);

  // A way's end at a bridge or a tunnel (a sample shared with one): nothing of it reaches past that
  // end, into the bridge's span — not its bed, not its band (faded out over STRUCTURE_FADE_M before
  // the end): the ground under a bridge is left as it was, and the road or river under it with it.
  const atStructure = new Uint8Array(net.samples.length);
  net.samples.forEach((_, k) => {
    for (const [o, m] of net.next[k]) {
      const w = net.ways[net.samples[o].way];
      if (m === 0 && (w.bridge || w.tunnel)) atStructure[k] = 1;
    }
  });
  /** per way: its ends at a structure — the end point and the unit direction out of the way there */
  const structureEnds: Array<Array<[number, number, number, number]>> = net.ways.map((w) => {
    const ends: Array<[number, number, number, number]> = [];
    if (w.bridge || w.tunnel || w.count < 2) return ends;
    for (const [e, o] of [[w.first, w.first + 1], [w.first + w.count - 1, w.first + w.count - 2]]) {
      if (!atStructure[e]) continue;
      const dx = sx[e] - sx[o], dy = sy[e] - sy[o], l = Math.hypot(dx, dy);
      if (l > 0) ends.push([sx[e], sy[e], dx / l, dy / l]);
    }
    return ends;
  });
  /** 1 well inside a way's reach, falling to 0 at an end at a structure; −1 past it (nothing there) */
  const reachOf = (way: number, x: number, y: number, m: number): number => {
    let f = 1;
    for (const [ex, ey, dx, dy] of structureEnds[way]) {
      const past = ((x - ex) * dx + (y - ey) * dy) * m;
      if (past > 0) return -1;
      f = Math.min(f, smoothStep(-past / STRUCTURE_FADE_M));
    }
    return f;
  };
  /** the height of stretch s at unclamped fraction raw: its grade carried at most BED_ALONG_M past its ends */
  const zAlong = (s: Seg, raw: number, m: number): number => {
    const len = Math.hypot(sx[s.j] - sx[s.i], sy[s.j] - sy[s.i]) * m;
    const over = len > 0 ? BED_ALONG_M / len : 0;
    const t = Math.max(-over, Math.min(1 + over, raw));
    return z[s.i] + (z[s.j] - z[s.i]) * t;
  };
  /** a stretch's weight by how far the point projects past its ends */
  const alongWeight = (ec: number, m: number): number => {
    const a = Math.max(1e-3, 1 - (ec * m) / BED_ALONG_M);
    return a * a;
  };

  interface Eval { w: number; bed: boolean; r: number }
  const evaluate = (x: number, y: number): Eval => {
    const m = mpc(y), scale = bandScale(y);
    if (scale === 0) return { w: 0, bed: false, r: NaN };
    const list = near(x, y);
    let w = 0, top = -Infinity, sc = 0, scz = 0;
    for (const si of list) {
      const s = segs[si];
      const way = net.ways[s.way];
      const reach = reachOf(s.way, x, y, m);
      if (reach < 0) continue;
      const [dc, , ec, raw] = project(s, x, y);
      const d = dc * m;
      if (d <= way.half) {
        top = Math.max(top, way.prio);
        continue;
      }
      if (top > -Infinity) continue;
      const u = smoothStep(1 - (d - way.half) / (way.band * scale)) * reach;
      if (u <= 0) continue;
      w = Math.max(w, u);
      // u / (1 − u) grows without bound towards a bed; capped where u rounds to 1
      const c = (u / Math.max(1e-12, 1 - u)) * alongWeight(ec, m);
      sc += c;
      scz += c * zAlong(s, raw, m);
    }
    if (top === -Infinity) return { w, bed: false, r: sc > 0 ? scz / sc : NaN };
    // on a bed: the height of the senior roads whose beds hold the point (all of equal priority,
    // blended: no order decides), a blend of their stretches round it so it does not jump where the
    // nearest one changes (inside a bend): each by how far the point projects past its ends
    // (BED_ALONG_M) and how near it is to its bed (BED_GRACE_M beyond), each at its own grade
    let kz = 0, k = 0;
    for (const si of list) {
      const s = segs[si];
      const way = net.ways[s.way];
      if (way.prio !== top || reachOf(s.way, x, y, m) < 0) continue;
      const [dc, , ec, raw] = project(s, x, y);
      const d = dc * m;
      if (d > way.half + BED_GRACE_M) continue;
      const wk = alongWeight(ec, m) * smoothStep((way.half + BED_GRACE_M - d) / BED_GRACE_M);
      kz += wk * zAlong(s, raw, m);
      k += wk;
    }
    return { w: 1, bed: true, r: k > 0 ? kz / k : NaN };
  };

  const weight = (x: number, y: number) => evaluate(x, y).w;
  const height = (x: number, y: number, base: number) => {
    const e = evaluate(x, y);
    if (e.bed) return e.r;
    return e.w > 0 ? base + e.w * (e.r - base) : base;
  };
  const borderPoints: Pt[] = [];
  return { weight, height, beds: bedOutlines(), borderPoints };

  // --- the bed outlines ---
  function bedOutlines(): Array<{ way: number; edges: Pt[][] }> {
    const out: Array<{ way: number; edges: Pt[][] }> = [];
    if (bandScale(grid / 2) === 0) return out;
    const order = net.ways.map((_, k) => k).filter((k) => !net.ways[k].bridge && !net.ways[k].tunnel);
    order.sort((a, b) => (senior(a, b) ? -1 : senior(b, a) ? 1 : 0));
    const rank = new Int32Array(net.ways.length).fill(-1);
    order.forEach((w, k) => (rank[w] = k));
    // the outline segments laid so far (of more senior beds), by cell
    const laid: Array<[Pt, Pt]> = [];
    const laidCells = new Map<number, number[]>();
    const lay = (a: Pt, b: Pt) => {
      const id = laid.push([a, b]) - 1;
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
          const k = ckey(cx, cy);
          const list = laidCells.get(k);
          if (list) list.push(id);
          else laidCells.set(k, [id]);
        }
      }
    };
    for (const wi of order) {
      const way = net.ways[wi];
      const edges: Pt[][] = [];
      // runs of samples with a height
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 2) for (const side of [-1, 1]) for (const piece of sideLine(run, way.half, side, wi)) edges.push(piece);
        run = [];
      };
      for (let k = way.first; k < way.first + way.count; k++) {
        if (Number.isFinite(z[k])) {
          if (!run.length || sx[k] !== sx[run[run.length - 1]] || sy[k] !== sy[run[run.length - 1]]) run.push(k);
        } else flush();
      }
      flush();
      for (const e of edges) for (let k = 1; k < e.length; k++) lay(e[k - 1], e[k]);
      if (edges.length) out.push({ way: wi, edges });
    }
    return out;

    /** one side of a run's bed: offset, clipped to the tile, cut out of senior beds, simplified */
    function sideLine(run: number[], half: number, side: number, wi: number): Pt[][] {
      const closed = run.length > 3 && sx[run[0]] === sx[run[run.length - 1]] && sy[run[0]] === sy[run[run.length - 1]];
      // offset by half + BED_MARGIN_M from the axis, mitred at its bends; round on the outside of a
      // turn sharper than a right angle, the inside mitred up to MITRE_MAX times
      const pts: PtK[] = [];
      run.forEach((k, q) => {
        const prev = q > 0 ? run[q - 1] : closed ? run[run.length - 2] : -1;
        const next = q + 1 < run.length ? run[q + 1] : closed ? run[1] : -1;
        const normals: Array<[number, number]> = [];
        for (const [a, b] of [[prev, k], [k, next]]) {
          if (a < 0 || b < 0) continue;
          const dx = sx[b] - sx[a], dy = sy[b] - sy[a], l = Math.hypot(dx, dy);
          if (l > 0) normals.push([-dy / l, dx / l]);
        }
        const r = (side * (half + BED_MARGIN_M)) / mpc(sy[k]);
        const at = (nx: number, ny: number, f: number) => pts.push({ x: sx[k] + nx * r * f, y: sy[k] + ny * r * f, k });
        if (normals.length < 2) {
          const [nx, ny] = normals[0] ?? [0, 0];
          at(nx, ny, 1);
          return;
        }
        const [[ax, ay], [bx, by]] = normals;
        const mx = ax + bx, my = ay + by, ml = Math.hypot(mx, my);
        const cosHalf = ml / 2;
        // the turn to the left (> 0) has the left side inside
        const outside = side * (ax * by - ay * bx) < 0;
        if (cosHalf >= Math.SQRT1_2 || (!outside && ml > 1e-9)) {
          at(mx / ml, my / ml, Math.min(1 / Math.max(cosHalf, 1e-9), MITRE_MAX));
          return;
        }
        // round: from the one stretch's normal to the other's in steps of 30° at most
        const a0 = Math.atan2(ay, ax);
        let da = Math.atan2(by, bx) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 6)));
        for (let i = 0; i <= steps; i++) at(Math.cos(a0 + (da * i) / steps), Math.sin(a0 + (da * i) / steps), 1);
      });
      for (let k = 1; k < pts.length; k++) {
        for (const t of squareCuts(pts[k - 1], pts[k])) {
          const q = onSquare(lerp(pts[k - 1], pts[k], t));
          if (q.x >= 0 && q.x <= grid && q.y >= 0 && q.y <= grid && (q.x === 0 || q.x === grid || q.y === 0 || q.y === grid)) borderPoints.push(q);
        }
      }
      // split at the tile square and at the senior outlines; keep the pieces off senior beds and inside
      const pieces: PtK[][] = [];
      let cur: PtK[] = [];
      /** whether the outline of a road senior to this one holds (x, y) (its bed and BED_MARGIN_M, a hair more) */
      const covered = (x: number, y: number): boolean => {
        const m = mpc(y), r = rank[wi];
        for (const si of near(x, y)) {
          const s = segs[si], rs = rank[s.way];
          if (rs < 0 || rs >= r || reachOf(s.way, x, y, m) < 0) continue;
          if (project(s, x, y)[0] * m <= net.ways[s.way].half + BED_MARGIN_M + 0.05) return true;
        }
        return false;
      };
      const keep = (a: Pt, b: Pt) => {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        return mx >= 0 && mx <= grid && my >= 0 && my <= grid && !covered(mx, my);
      };
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        // wholly outside the tile: nothing to lay
        if ((a.x < 0 && b.x < 0) || (a.x > grid && b.x > grid) || (a.y < 0 && b.y < 0) || (a.y > grid && b.y > grid)) {
          if (cur.length) {
            pieces.push(cur);
            cur = [];
          }
          continue;
        }
        const ts = [0, 1, ...squareCuts(a, b), ...laidCuts(a, b)].sort((p, q) => p - q);
        for (let c = 1; c < ts.length; c++) {
          if (ts[c] - ts[c - 1] < 1e-9) continue;
          const p = { ...onSquare(lerp(a, b, ts[c - 1])), k: a.k }, q = { ...onSquare(lerp(a, b, ts[c])), k: ts[c] === 1 ? b.k : a.k };
          if (keep(p, q)) {
            if (!cur.length) cur.push(p);
            cur.push(q);
          } else if (cur.length) {
            pieces.push(cur);
            cur = [];
          }
        }
      }
      if (cur.length) pieces.push(cur);
      return pieces.filter((p) => p.length >= 2).map((p) => simplify(p, wi));
    }

    function onSquare(p: Pt): Pt {
      return snapBorder(p, grid);
    }

    function squareCuts(a: Pt, b: Pt): number[] {
      const ts: number[] = [];
      for (const [pa, pb] of [[a.x, b.x], [a.y, b.y]]) {
        for (const edge of [0, grid]) {
          if (pa === pb) continue;
          const t = (edge - pa) / (pb - pa);
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      return ts;
    }

    function laidCuts(a: Pt, b: Pt): number[] {
      const ts: number[] = [];
      const seen = new Set<number>();
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
          for (const id of laidCells.get(ckey(cx, cy)) ?? []) {
            if (seen.has(id)) continue;
            seen.add(id);
            const [c, d] = laid[id];
            const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
            if (den === 0) continue;
            const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
            const s = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
            if (t > 0 && t < 1 && s >= 0 && s <= 1) ts.push(t);
          }
        }
      }
      return ts;
    }

    /** Douglas–Peucker in plan (BED_PLAN_TOL_M) and in the bed's height along the line (BED_HEIGHT_TOL_M) */
    function simplify(raw: PtK[], wi: number): Pt[] {
      // the midpoints too: the bed's height between two samples is not their chord
      const line: PtK[] = [raw[0]];
      for (let k = 1; k < raw.length; k++) line.push({ ...lerp(raw[k - 1], raw[k], 0.5), k: raw[k - 1].k }, raw[k]);
      const h = line.map((p) => ownHeight(wi, p.k, p.x, p.y));
      const keepIdx = new Uint8Array(line.length);
      keepIdx[0] = keepIdx[line.length - 1] = 1;
      const stack: Array<[number, number]> = [[0, line.length - 1]];
      while (stack.length) {
        const [i, j] = stack.pop()!;
        if (j - i < 2) continue;
        const a = line[i], b = line[j], m = mpc((a.y + b.y) / 2);
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        let worst = 0, at = -1;
        for (let k = i + 1; k < j; k++) {
          const p = line[k];
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
          const plan = (Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) * m) / BED_PLAN_TOL_M;
          const vert = Math.abs(h[k] - (h[i] + (h[j] - h[i]) * t)) / BED_HEIGHT_TOL_M;
          const e = Math.max(plan, vert, (Math.sqrt(l2) * m) / BED_MAX_SEG_M);
          if (e > worst) {
            worst = e;
            at = k;
          }
        }
        if (worst > 1) {
          keepIdx[at] = 1;
          stack.push([i, at], [at, j]);
        }
      }
      return line.filter((_, k) => keepIdx[k]).map(({ x, y }) => ({ x, y }));
    }

    /** way wi's bed height at (x, y) near its sample k: the bed blend over its stretches round k */
    function ownHeight(wi: number, k: number, x: number, y: number): number {
      const w = net.ways[wi], m = mpc(y);
      let kz = 0, kk = 0;
      for (let i = Math.max(w.first, k - 2); i < Math.min(w.first + w.count - 1, k + 2); i++) {
        if (!Number.isFinite(z[i]) || !Number.isFinite(z[i + 1])) continue;
        const seg = { i, j: i + 1, way: wi };
        const [, , ec, raw] = project(seg, x, y);
        const a = alongWeight(ec, m);
        kz += a * zAlong(seg, raw, m);
        kk += a;
      }
      return kk > 0 ? kz / kk : z[k];
    }
  }
}

/** within 1e-9 of the tile's border: exactly on it, its position along rounded to 1e-6 cell (the neighbour's too) */
function snapBorder(p: Pt, grid: number): Pt {
  const on = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(v - grid) < 1e-9 ? grid : undefined);
  const x = on(p.x), y = on(p.y);
  if (x !== undefined) return { x, y: y ?? Math.round(p.y * 1e6) / 1e6 };
  if (y !== undefined) return { x: Math.round(p.x * 1e6) / 1e6, y };
  return p;
}

/** an outline point and the network sample it was laid from */
interface PtK extends Pt {
  k: number;
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
