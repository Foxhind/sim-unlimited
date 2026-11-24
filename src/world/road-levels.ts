/**
 * How high above the ground the roads and railways run: bridges over what they cross, and the
 * approaches to them.
 *
 * A bridge asks for a lift only where it crosses something, by the tags of what is under it (a road
 * or a railway LEVEL_M, a bridge of level m under it LEVEL_M · (m + 1), water WATER_CLEAR_M...).
 * From there the lift falls along the road network at LIFT_GRADE, on over the ways that join the
 * bridge: the approaches come by themselves, and ways sharing a node share its lift. The roads, the
 * railways and the paths are three networks: steps from a bridge down to the street under it do
 * not pull that street up, nor does a level crossing by a bridge raise the track.
 *
 * The lift is metres above the drawn ground, from geometry and tags alone (or, given the roads'
 * own heights, from those: the clearance between the two surfaces at a crossing), never from the
 * relief, and of nothing further than LIFT_REACH_M along the roads. So every tile that sees the roads
 * LIFT_REACH_M round it (overpass.ts ROAD_REACH_M) gets the same lift at the same point, and the
 * ribbons meet at the tile borders. But with the drawn ground (RoadLevelOptions.ground) a bridge
 * without a height of its own, wholly on the tile, takes its clearance from what it crosses: its
 * deck is heights, not a lift over banks higher than the water.
 */
import { classifyLine, isTunnel, roadLayer } from './osm-mesher';
import type { LonLat, OsmArea, OsmLine } from './osm-types';
import type { RoadSurface } from './road-pull';

/** a road or railway under a bridge: the deck this far over it; and a level of a stack of bridges */
export const LEVEL_M = 6;
/** over a river, a canal or a water area */
export const WATER_CLEAR_M = 4;
/** over a canal (in a town, under a street) */
export const CANAL_CLEAR_M = 2;
/** over a stream or a brook */
export const STREAM_CLEAR_M = 1.5;
/** the approaches' slope */
export const LIFT_GRADE = 0.08;
/**
 * no lift reaches further than this along the roads: a higher one falls steeper. 90 m: with the
 * road heights' window (road-heights.ts) the ground a tile builds at its border still depends on
 * roads within 150 m of it (overpass.ts ROAD_REACH_M)
 */
export const LIFT_REACH_M = 90;
/**
 * A bridge without a `layer` or on layer 0 (most small bridges: over a ditch, a stream mapped as
 * an area or not at all) stands at least this far over the ground along its whole length, its
 * approaches coming down at LIFT_GRADE: a bridge never lies flat on the ground
 */
export const MIN_BRIDGE_LIFT_M = 1;
/** less than this is no lift */
export const LIFT_EPS_M = 0.02;

/** a water area under a bridge holds the lift by points this far apart */
const HOLD_STEP_M = 10;
/** a bridge holds its height between two crossings at most this far apart along it */
const HOLD_GAP_M = LIFT_REACH_M;
const CELL_M = 64;

export interface RoadLevels {
  /** the lift `d` metres from the start of the way (along its points), m; 0 for a way not known */
  liftAt(line: OsmLine, d: number): number;
  /** the highest lift on the way: 0 and it is drawn as ever */
  maxLift(line: OsmLine): number;
  /**
   * The lift of the way with these tags (the same object: a tile's clipped share of a line keeps
   * the whole line's, clip.ts) at the point of it nearest to (x, z)
   */
  liftNear(tags: Record<string, string>, x: number, z: number): number;
  /** whether any way with these tags (the same object) is lifted anywhere */
  liftedTags(tags: Record<string, string>): boolean;
}

const PATHS = new Set(['footway', 'path', 'cycleway', 'bridleway', 'steps']);
const isBridge = (tags: Record<string, string>): boolean => !!tags.bridge && tags.bridge !== 'no';

type XZ = [number, number];

interface Way {
  line: OsmLine;
  p: XZ[];
  /** metres from the start at each point */
  cum: number[];
  half: number;
  level: number;
  bridge: boolean;
  path: boolean;
  /** the network its lift runs along: roads, railways or paths */
  net: string;
  /**
   * what the way asks for: at `d` metres from its start, `req` metres of lift; over what it crosses
   * at `at` (its crossing's middle), or over the lowest ground of the asks of one stretch over a water
   * area (`over`, the stretch's number)
   */
  asks: { d: number; req: number; at?: number; over?: number }[];
  /** the graph's nodes along the way, in order */
  stops: { d: number; node: number }[];
  /** a bridge's deck of heights (RoadLevelOptions.ground): metres along it and the deck's height there */
  deck?: { d: number[]; h: number[] };
}

/** something a bridge may cross: one segment of it */
interface Under {
  a: XZ;
  b: XZ;
  ka: string;
  kb: string;
  half: number;
  /** its segment of the way */
  seg: number;
  /** a road or railway (its Way), or water and the clearance over it */
  way?: Way;
  clear?: number;
  /** water: its line and the metres along it at each point (for its own height, RoadLevelOptions.height) */
  water?: { line: OsmLine; cum: number[] };
}

const key = (p: LonLat): string => `${p[0]},${p[1]}`;

/** where pq crosses ab as fractions of each, or undefined */
function cross(p: XZ, q: XZ, a: XZ, b: XZ): [number, number] | undefined {
  const rx = q[0] - p[0], rz = q[1] - p[1], sx = b[0] - a[0], sz = b[1] - a[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return undefined;
  const t = ((a[0] - p[0]) * sz - (a[1] - p[1]) * sx) / den;
  const u = ((a[0] - p[0]) * rz - (a[1] - p[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : undefined;
}

function inRings(rings: XZ[][], x: number, z: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, zi] = r[i], [xj, zj] = r[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** a max-heap of [value, node] */
class Heap {
  private a: [number, number][] = [];
  get size(): number { return this.a.length; }
  push(v: [number, number]): void {
    const a = this.a;
    let i = a.push(v) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (a[up][0] >= a[i][0]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }
  pop(): [number, number] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] > a[m][0]) m = l;
        if (r < a.length && a[r][0] > a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const NONE: RoadLevels = { liftAt: () => 0, maxLift: () => 0, liftNear: () => 0, liftedTags: () => false };

export interface RoadLevelOptions {
  /**
   * The way's own surface height `d` metres from its start (road-heights.ts). Given it, a bridge
   * over a road or railway asks for what is left to the clearance over that way's surface; where
   * either height is not a number, for the whole clearance as without it.
   */
  height?: (line: OsmLine, d: number) => number;
  /**
   * The drawn ground at a point (metres on the plane, as `toXZ`), NaN where it is not known (off the
   * tile). Given it, a bridge without a height of its own (`height` not a number on it) takes what
   * it asks as heights, its clearance over the ground where it asks (the water, the road under it),
   * and holds, levels and falls between and past them as the lifts do (HOLD_GAP_M, LIFT_REACH_M,
   * the grade), over the ground nowhere less than on it: over a river between banks 2–3 m up its
   * clearance stood on the banks, a footway's deck 6–7 m up beside the street's at 4 m
   * (14/9517/6398). Its approaches fall from its lift at its ends. A bridge with a point of it off
   * the tile lifts as without it.
   */
  ground?: (x: number, z: number) => number;
}

/** a deck of heights (RoadLevelOptions.ground) is sampled along its bridge this often, m */
const DECK_STEP_M = 2;

/** `toXZ`: lon, lat → metres on one plane (the mesher's `enu`) */
export function buildRoadLevels(
  lines: OsmLine[],
  areas: OsmArea[],
  toXZ: (p: LonLat) => [number, number],
  opts: RoadLevelOptions = {},
): RoadLevels {
  // --- the roads and railways drawn, and what a bridge may cross ---
  const ways: Way[] = [];
  const unders: Under[] = [];
  for (const line of lines) {
    if (line.points.length < 2) continue;
    const tags = line.tags;
    const style = classifyLine(tags);
    if (!style) continue;
    const drawn = (tags.highway !== undefined || tags.railway !== undefined) && !tags.aeroway;
    if (drawn && isTunnel(tags)) continue;
    const ww = tags.waterway;
    const clear = ww === 'river' ? WATER_CLEAR_M : ww === 'canal' ? CANAL_CLEAR_M : ww === 'stream' || ww === 'brook' ? STREAM_CLEAR_M : 0;
    if (!drawn && !clear) continue;
    const p = line.points.map(toXZ);
    let way: Way | undefined;
    if (drawn) {
      const cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
      way = {
        line, p, cum, half: style.width / 2, level: roadLayer(tags), bridge: isBridge(tags),
        path: PATHS.has(tags.highway ?? ''), asks: [], stops: [],
        net: tags.highway === undefined ? 'rail' : PATHS.has(tags.highway) ? 'path' : 'road',
      };
      ways.push(way);
      if (way.path) continue; // a path under a bridge asks for nothing
    }
    let water: Under['water'];
    if (!way) {
      const cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
      water = { line, cum };
    }
    for (let i = 0; i + 1 < p.length; i++) {
      unders.push({ a: p[i], b: p[i + 1], ka: key(line.points[i]), kb: key(line.points[i + 1]), half: style.width / 2, seg: i, way, clear: way ? undefined : clear, water });
    }
  }
  const bridges = ways.filter((w) => w.bridge);
  if (!bridges.length) return NONE;

  // --- what each bridge asks for where it crosses something ---
  const cells = new Map<string, Under[]>();
  const cellsOf = (a: XZ, b: XZ): string[] => {
    const out: string[] = [];
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL_M), x1 = Math.floor(Math.max(a[0], b[0]) / CELL_M);
    const z0 = Math.floor(Math.min(a[1], b[1]) / CELL_M), z1 = Math.floor(Math.max(a[1], b[1]) / CELL_M);
    // a segment across a great many cells (a broken way): only its ends' cells
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) return [`${x0},${z0}`, `${x1},${z1}`];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push(`${x},${z}`);
    return out;
  };
  for (const u of unders) {
    for (const c of cellsOf(u.a, u.b)) {
      let list = cells.get(c);
      if (!list) cells.set(c, list = []);
      list.push(u);
    }
  }
  const water = areas
    .filter((a) => a.tags.natural === 'water' || a.tags.waterway === 'riverbank' || a.tags.waterway === 'river' || a.tags.waterway === 'canal')
    .map((a) => {
      const rings = a.rings.filter((r) => r.length >= 3).map((r) => r.map(toXZ));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const r of rings) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      return { rings, x0, x1, z0, z1 };
    })
    .filter((a) => a.rings.length);

  for (const w of bridges) {
    const total = w.cum[w.cum.length - 1];
    const ask = (d: number, req: number, at?: number, over?: number): void => {
      if (req > 0 && Number.isFinite(d)) w.asks.push({ d: Math.max(0, Math.min(total, d)), req, ...(at === undefined ? {} : { at: Math.max(0, Math.min(total, at)) }), ...(over === undefined ? {} : { over }) });
    };
    let stretches = 0;
    // on no layer (or layer 0): at least MIN_BRIDGE_LIFT_M all along it
    const layer = w.line.tags.layer;
    if (layer === undefined || Number(layer) === 0) {
      const n = Math.max(1, Math.ceil(total / HOLD_STEP_M));
      for (let k = 0; k <= n; k++) ask((total * k) / n, MIN_BRIDGE_LIFT_M);
    }
    for (let i = 0; i + 1 < w.p.length; i++) {
      const p = w.p[i], q = w.p[i + 1], len = w.cum[i + 1] - w.cum[i];
      if (len < 1e-6) continue;
      const kp = key(w.line.points[i]), kq = key(w.line.points[i + 1]);
      const seen = new Set<Under>();
      for (const c of cellsOf(p, q)) {
        for (const u of cells.get(c) ?? []) {
          if (seen.has(u)) continue;
          seen.add(u);
          if (u.way === w) continue;
          // meeting at a node is a junction, not a crossing
          if (u.ka === kp || u.ka === kq || u.kb === kp || u.kb === kq) continue;
          let req = u.clear ?? 0;
          if (u.way) {
            if (u.way.level >= w.level) continue;
            req = u.way.bridge ? LEVEL_M * u.way.level + LEVEL_M : LEVEL_M;
          }
          const hit = cross(p, q, u.a, u.b);
          if (!hit) continue;
          const d = w.cum[i] + hit[0] * len;
          // with the ways' own heights: what is left to the clearance over what is under it
          const under = u.way ?? u.water;
          if (under && opts.height) {
            const du = under.cum[u.seg] + hit[1] * (under.cum[u.seg + 1] - under.cum[u.seg]);
            const gap = opts.height(w.line, d) - opts.height(under.line, du);
            if (Number.isFinite(gap)) req = Math.max(0, req - gap);
          }
          // held over the whole width of what is crossed
          ask(d, req);
          ask(d - u.half, req, d);
          ask(d + u.half, req, d);
        }
      }
      for (const a of water) {
        if (Math.max(p[0], q[0]) < a.x0 || Math.min(p[0], q[0]) > a.x1 || Math.max(p[1], q[1]) < a.z0 || Math.min(p[1], q[1]) > a.z1) continue;
        const ts = [0, 1];
        for (const r of a.rings) {
          for (let k = 0; k < r.length; k++) {
            const hit = cross(p, q, r[k], r[(k + 1) % r.length]);
            if (hit) ts.push(hit[0]);
          }
        }
        ts.sort((x, y) => x - y);
        for (let k = 0; k + 1 < ts.length; k++) {
          const t0 = ts[k], t1 = ts[k + 1];
          if (t1 - t0 < 1e-9) continue;
          const tm = (t0 + t1) / 2;
          if (!inRings(a.rings, p[0] + (q[0] - p[0]) * tm, p[1] + (q[1] - p[1]) * tm)) continue;
          const n = Math.max(1, Math.ceil(((t1 - t0) * len) / HOLD_STEP_M)), over = stretches++;
          for (let s = 0; s <= n; s++) ask(w.cum[i] + (t0 + ((t1 - t0) * s) / n) * len, WATER_CLEAR_M, undefined, over);
        }
      }
    }
  }
  // --- with the drawn ground: each bridge without a height of its own a straight deck ---
  /** the point `d` metres along way w */
  const pointAt = (w: Way, d: number): XZ => {
    let i = 0;
    while (i + 2 < w.cum.length && w.cum[i + 1] < d) i++;
    const len = w.cum[i + 1] - w.cum[i], t = len > 0 ? Math.max(0, Math.min(1, (d - w.cum[i]) / len)) : 0;
    return [w.p[i][0] + (w.p[i + 1][0] - w.p[i][0]) * t, w.p[i][1] + (w.p[i + 1][1] - w.p[i][1]) * t];
  };
  const groundOf = (w: Way, d: number): number => opts.ground!(...pointAt(w, d));
  /** the grade a lift of `req` falls at (as the passes below take it) */
  const gradeOf = (req: number): number => Math.max(LIFT_GRADE, (Math.ceil(req / LEVEL_M - 1e-9) * LEVEL_M) / LIFT_REACH_M);
  if (opts.ground) {
    for (const w of bridges) {
      if (!w.asks.length || Number.isFinite(opts.height?.(w.line, 0) ?? NaN)) continue;
      const total = w.cum[w.cum.length - 1];
      // each ask as a height: its clearance over what it crosses (the ground at the crossing's middle,
      // not on a bank its width reaches; over a water area, its lowest ground under the bridge: the
      // area's outline may lie past the water's edge the relief has)
      const water = new Map<number, number>();
      for (const a of w.asks) if (a.over !== undefined) water.set(a.over, Math.min(water.get(a.over) ?? Infinity, groundOf(w, a.d)));
      const needs = w.asks.map((a) => ({ d: a.d, h: (a.over !== undefined ? water.get(a.over)! : groundOf(w, a.at ?? a.d)) + a.req })).sort((a, b) => a.d - b.d);
      // and nowhere under the line from the ground at one end to the ground at the other: between banks
      // higher than its clearance it runs straight from one to the other
      const g0 = groundOf(w, 0), g1 = groundOf(w, total);
      if (needs.some((a) => !Number.isFinite(a.h)) || !Number.isFinite(g0) || !Number.isFinite(g1)) continue;
      // asks at most HOLD_GAP_M apart hold the deck between them: each such run its upper hull
      const runs: { d: number[]; h: number[] }[] = [];
      let prev = -Infinity;
      for (const a of needs) {
        if (a.d - prev > HOLD_GAP_M || !runs.length) runs.push({ d: [], h: [] });
        prev = a.d;
        const { d, h } = runs[runs.length - 1];
        if (d.length && a.d - d[d.length - 1] < 1e-6) { h[h.length - 1] = Math.max(h[h.length - 1], a.h); continue; }
        while (d.length >= 2 && (h[h.length - 1] - h[h.length - 2]) * (a.d - d[d.length - 2]) <= (a.h - h[h.length - 2]) * (d[d.length - 1] - d[d.length - 2])) {
          d.pop();
          h.pop();
        }
        d.push(a.d);
        h.push(a.h);
      }
      /**
       * the deck's height d metres along it: a run's hull over it; past a run's end level to the
       * bridge's end if that leaves room for the fall after it within the reach (as `hold`: a short
       * bridge is level, its approaches climb), else the fall from there
       */
      const deckAt = (x: number): number => {
        let best = -Infinity;
        for (const r of runs) {
          const n = r.d.length;
          if (x >= r.d[0] && x <= r.d[n - 1]) {
            let i = 0;
            while (i + 2 < n && r.d[i + 1] < x) i++;
            const t = n > 1 && r.d[i + 1] > r.d[i] ? (x - r.d[i]) / (r.d[i + 1] - r.d[i]) : 0;
            best = Math.max(best, n > 1 ? r.h[i] + (r.h[i + 1] - r.h[i]) * t : r.h[0]);
            continue;
          }
          const e = x < r.d[0] ? 0 : n - 1, req = r.h[e] - groundOf(w, r.d[e]), g = gradeOf(req);
          const end = e ? total : 0, level = req >= LIFT_EPS_M && Math.abs(end - r.d[e]) <= LIFT_REACH_M - req / g;
          best = Math.max(best, level ? r.h[e] : r.h[e] - g * Math.abs(x - r.d[e]));
        }
        return best;
      };
      const n = Math.max(1, Math.ceil(total / DECK_STEP_M));
      const d: number[] = [], h: number[] = [];
      let known = true;
      for (let k = 0; k <= n; k++) {
        const x = (total * k) / n, g = groundOf(w, x);
        known &&= Number.isFinite(g);
        d.push(x);
        h.push(Math.max(g, deckAt(x), g0 + ((g1 - g0) * x) / (total || 1)));
      }
      if (!known) continue;
      w.deck = { d, h };
      // its approaches fall from its lift at its ends
      w.asks = [0, n].flatMap((k) => (h[k] - groundOf(w, d[k]) >= LIFT_EPS_M ? [{ d: d[k], req: h[k] - groundOf(w, d[k]) }] : []));
    }
  }
  if (!bridges.some((w) => w.asks.length || w.deck)) return NONE;

  // --- the graph: the ways' points (shared by their coordinates) and the points that ask ---
  const nodeOf = new Map<string, number>();
  const adj: [number, number][][] = [];
  /** the edges that are bridges */
  const bridgeAdj: [number, number][][] = [];
  const node = (k: string): number => {
    let n = nodeOf.get(k);
    if (n === undefined) {
      nodeOf.set(k, n = adj.length);
      adj.push([]);
      bridgeAdj.push([]);
    }
    return n;
  };
  /** the most asked for at a node */
  const asked = new Map<number, number>();
  ways.forEach((w, wi) => {
    w.stops = w.line.points.map((p, i) => ({ d: w.cum[i], node: node(`${w.net}:${key(p)}`) }));
    for (const a of w.asks) {
      const n = node(`ask:${wi}:${a.d}`);
      asked.set(n, Math.max(asked.get(n) ?? 0, a.req));
      w.stops.push({ d: a.d, node: n });
    }
    // stable: a way's own points keep their order where they coincide
    w.stops = w.stops.map((s, i) => ({ s, i })).sort((x, y) => x.s.d - y.s.d || x.i - y.i).map((x) => x.s);
    for (let i = 0; i + 1 < w.stops.length; i++) {
      const a = w.stops[i], b = w.stops[i + 1];
      if (a.node === b.node) continue;
      adj[a.node].push([b.node, b.d - a.d]);
      adj[b.node].push([a.node, b.d - a.d]);
      // a deck of heights holds itself: its ends' lifts differ by its banks, and holding the one over
      // the other's bank lifted that end by the difference
      if (w.bridge && !w.deck) {
        bridgeAdj[a.node].push([b.node, b.d - a.d]);
        bridgeAdj[b.node].push([a.node, b.d - a.d]);
      }
    }
  });

  // --- a bridge holds its height between two crossings: no dip between the roads it spans ---
  /**
   * Between two points that ask, at most HOLD_GAP_M apart along bridges, the deck runs straight
   * from the one's height to the other's: left to the grade it would dip between every two roads
   * under a long bridge. Further apart they are two humps: whoever sees a point between them must
   * see both (LIFT_REACH_M), or the tiles of a border would disagree. And past its outermost crossing
   * a bridge stays level up to the vertex where the fall after it would still end within that reach.
   */
  const held = new Set<string>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const hold = new Map<number, number>();
  for (const [from, reqFrom] of asked) {
    if (!bridgeAdj[from].length) continue;
    const dist = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const heap = new Heap();
    heap.push([0, from]);
    while (heap.size) {
      const [neg, n] = heap.pop();
      if (-neg > dist.get(n)!) continue;
      for (const [m, len] of bridgeAdj[n]) {
        const d = -neg + len;
        if (d > HOLD_GAP_M || d >= (dist.get(m) ?? Infinity)) continue;
        dist.set(m, d);
        prev.set(m, n);
        heap.push([-d, m]);
      }
    }
    // level along the bridge as far as leaves room for the fall after it within the reach: a short
    // bridge is level from end to end, and its approaches do the climbing
    const level = LIFT_REACH_M - reqFrom / LIFT_GRADE;
    for (const [to, d] of dist) {
      if (to === from || d > level + 1e-6) continue;
      hold.set(to, Math.max(hold.get(to) ?? 0, reqFrom));
      held.add(edgeKey(to, prev.get(to)!));
    }
    for (const [to, gap] of dist) {
      const reqTo = asked.get(to);
      // each pair once
      if (reqTo === undefined || to <= from || gap <= 0) continue;
      for (let n = to; n !== from; n = prev.get(n)!) {
        const v = reqFrom + ((reqTo - reqFrom) * dist.get(n)!) / gap;
        hold.set(n, Math.max(hold.get(n) ?? 0, v));
        held.add(edgeKey(n, prev.get(n)!));
      }
    }
  }
  for (const [n, v] of hold) asked.set(n, Math.max(asked.get(n) ?? 0, v));

  // --- the lift: what is asked for less the grade times the way there, the most of all ---
  /** one pass for each grade: the asks of at most LIFT_GRADE · LIFT_REACH_M share one */
  const byGrade = new Map<number, [number, number][]>();
  for (const [n, req] of asked) {
    // in steps of LEVEL_M, the steeper: a held height between two levels falls no further than the higher
    const g = gradeOf(req);
    let list = byGrade.get(g);
    if (!list) byGrade.set(g, list = []);
    list.push([req, n]);
  }
  const passes: { g: number; val: Float64Array }[] = [];
  for (const [g, sources] of byGrade) {
    const val = new Float64Array(adj.length).fill(-Infinity);
    const heap = new Heap();
    for (const s of sources) {
      if (s[0] > val[s[1]]) {
        val[s[1]] = s[0];
        heap.push(s);
      }
    }
    while (heap.size) {
      const [v, n] = heap.pop();
      if (v < val[n]) continue;
      for (const [m, len] of adj[n]) {
        const next = v - g * len;
        if (next > 0 && next > val[m]) {
          val[m] = next;
          heap.push([next, m]);
        }
      }
    }
    passes.push({ g, val });
  }

  const nodeLift = new Float64Array(adj.length);
  for (const { val } of passes) for (let n = 0; n < val.length; n++) nodeLift[n] = Math.max(nodeLift[n], val[n]);

  const byLine = new Map<OsmLine, Way>();
  const byTags = new Map<Record<string, string>, Way[]>();
  for (const w of ways) {
    byLine.set(w.line, w);
    const list = byTags.get(w.line.tags);
    if (list) list.push(w);
    else byTags.set(w.line.tags, [w]);
  }
  const liftOf = (w: Way, d: number): number => {
    const s = w.stops;
    d = Math.max(0, Math.min(s[s.length - 1].d, d));
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (s[m].d <= d) lo = m;
      else hi = m;
    }
    const t = d - s[lo].d, rest = s[hi].d - d;
    let lift = 0;
    for (const { g, val } of passes) lift = Math.max(lift, val[s[lo].node] - g * t, val[s[hi].node] - g * rest);
    // a held stretch of a bridge: straight between its ends
    if (t + rest > 0 && held.has(edgeKey(s[lo].node, s[hi].node))) lift = Math.max(lift, (nodeLift[s[lo].node] * rest + nodeLift[s[hi].node] * t) / (t + rest));
    // a deck of heights: its height over the ground here, nothing else
    if (w.deck) {
      const dd = w.deck.d, hh = w.deck.h;
      let i = 0;
      while (i + 2 < dd.length && dd[i + 1] < d) i++;
      const f = dd.length > 1 && dd[i + 1] > dd[i] ? Math.max(0, Math.min(1, (d - dd[i]) / (dd[i + 1] - dd[i]))) : 0;
      lift = (dd.length > 1 ? hh[i] + (hh[i + 1] - hh[i]) * f : hh[0]) - groundOf(w, d);
    }
    return lift < LIFT_EPS_M ? 0 : lift;
  };
  const maxOf = new Map<Way, number>();
  const maxLift = (w: Way): number => {
    let m = maxOf.get(w);
    if (m === undefined) {
      m = 0;
      for (const s of w.stops) m = Math.max(m, liftOf(w, s.d));
      if (w.deck) for (const d of w.deck.d) m = Math.max(m, liftOf(w, d));
      maxOf.set(w, m);
    }
    return m;
  };

  return {
    liftAt: (line, d) => {
      const w = byLine.get(line);
      return w && Number.isFinite(d) ? liftOf(w, d) : 0;
    },
    maxLift: (line) => {
      const w = byLine.get(line);
      return w ? maxLift(w) : 0;
    },
    liftedTags: (tags) => (byTags.get(tags) ?? []).some((w) => maxLift(w) > 0),
    liftNear: (tags, x, z) => {
      let best = Infinity, lift = 0;
      for (const w of byTags.get(tags) ?? []) {
        if (!maxLift(w)) continue;
        for (let i = 0; i + 1 < w.p.length; i++) {
          const [ax, az] = w.p[i], [bx, bz] = w.p[i + 1];
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
          const dist = Math.hypot(x - ax - dx * t, z - az - dz * t);
          if (dist < best) {
            best = dist;
            lift = liftOf(w, w.cum[i] + t * (w.cum[i + 1] - w.cum[i]));
          }
        }
      }
      return lift;
    },
  };
}

/** whether a way is lifted d metres along its points; `probes`: where else to look along it (where its lift may begin or end between the probes) */
export type Lifted = ((line: OsmLine, d: number) => boolean) & { probes?: (line: OsmLine) => number[] };

/**
 * Whether a way is lifted off the ground cover `d` metres from its start (ground-cover.ts): a way of
 * the network with its own heights (every sample a number) only where it is a bridge, its approaches
 * lying on the ground pulled up to it, and of a bridge only its stretches in `decks` (road-pull
 * bridgeDecks: where its deck lies DECK_CLEAR_M or more over the pulled ground; a bridge not in it,
 * whole); any other way where the plain levels lift it LIFT_EPS_M or more. From geometry and tags
 * alone, no TIN: every tile that sees the way agrees.
 */
export function coverLifted(roads: RoadSurface | undefined, plain: RoadLevels, decks?: ReadonlyMap<OsmLine, ReadonlyArray<[number, number]>>): Lifted {
  /** the network's ways with heights: whether each is a bridge */
  const own = new Map<OsmLine, boolean>();
  if (roads) {
    const { net, z } = roads;
    net.ways.forEach((w) => {
      for (let i = w.first; i < w.first + w.count; i++) if (!Number.isFinite(z[i])) return;
      own.set(w.line, w.bridge);
    });
  }
  const lifted: Lifted = (line, d) => {
    const bridge = own.get(line);
    if (bridge === undefined) return plain.liftAt(line, d) >= LIFT_EPS_M;
    const runs = bridge ? decks?.get(line) : undefined;
    return runs ? runs.some(([a, b]) => d >= a && d <= b) : bridge;
  };
  // a deck's stretch may be shorter than a probe's step: its ends, and a hair outside them
  lifted.probes = (line) => (own.get(line) ? decks?.get(line) ?? [] : []).flatMap(([a, b]) => [a - 1e-3, a, b, b + 1e-3]);
  return lifted;
}
