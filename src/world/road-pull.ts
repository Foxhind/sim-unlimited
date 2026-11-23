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
import type { LonLat, OsmLine } from './osm-types';
import { EARTH_R, mercatorYToLat, type Tile } from './geodesy';
import { ROAD_WINDOW_M, roadWindow } from './road-heights';
import { NET_STEP_M, type NetWay, type RoadNet } from './road-net';
import { classifyLine, isBridge, isTunnel } from './way-styles';

/** the roads of a tile with the height of each network sample: H and the lift */
export interface RoadSurface {
  net: RoadNet;
  z: Float64Array;
  /** the raw DEM at each sample (the base relief under a bridge: bridgeDecks); without it every bridge is lifted whole */
  dem?: ArrayLike<number>;
  /** per way (its index), a bridge's stretches over a mapped way it crosses (bridgeCrossings), the network's metres along it */
  over?: ReadonlyArray<ReadonlyArray<[number, number]>>;
}

export interface RoadPull {
  /** how far the ground at lattice point (x, y) is pulled to the roads: 1 on a bed, 0 beyond every band */
  weight(x: number, y: number): number;
  /**
   * the ways: the network's, then (covered, with the raw DEM) each low stretch of its bridges as a
   * way of its own (its `line` the bridge's): beds' and banks' `way` index this
   */
  ways: NetWay[];
  /** covered, with the raw DEM: per network bridge (its index) its lifted stretches, metres along it (the network's) */
  decks: Map<number, Array<[number, number]>>;
  /** covered: whether lattice point (x, y) is on a road's bank (BANK_M from its cover's edge into a river's water): its faces are ground */
  bank(x: number, y: number): boolean;
  /**
   * the ground the surface takes at a vertex: `height`, but where that is a river's water and
   * `roadAt` says a road's cover holds the point (its edge thinned and snapped, or shifted onto a
   * trunk past its bed's), the ground as if no river were there: no road cover takes the water's level
   */
  surface(x: number, y: number, base: number, roadAt?: (x: number, y: number) => boolean): number;
  /** the ground there, given the base relief's height (as if the ways in `skip` were not there) */
  height(x: number, y: number, base: number, skip?: ReadonlySet<number>): number;
  /** the bed outline of each road inside the tile (lattice), the senior first; cut out of more senior beds */
  beds: Array<{ way: number; edges: Pt[][] }>;
  /**
   * Each road's bank where its bed meets a river's water below it (lattice; not cut to the tile):
   * two rows along the bed's edge as it outranks the water (ROAD_BED_REACH_M), one a hair inside it
   * at the road's height, one BANK_M beyond it at the water's. The pull steps between them, and a
   * face between the road and the water spanned it (a 2.7 m step under a 175 m² water face at
   * 14/9517/6397); as fixed edges they make the bank one steep strip BANK_M and a hair wide
   */
  banks: Array<{ way: number; lines: Pt[][] }>;
  /**
   * Where every road's outline crosses the tile border, whether or not that piece of it is kept
   * (it may be cut out on one side of the border only): the neighbour has the same points
   */
  borderPoints: Pt[];
  /**
   * Points of the pull bands for the mesh: on rows along each road (BAND_ROWS of its band, the last
   * on the band's edge, where the ground is the relief's own), thinned to at most `limit` and off
   * every bed. They carry the fall from a road to the relief along the road, not on the lattice.
   */
  bandPoints(limit: number): Pt[];
}

/**
 * the bed outline runs this far outside the bed's edge, metres: a ribbon's shoulder lies on the
 * bed's faces to its edge, and just off the bed the pull is all but whole (1 − 3·(0.3/band)²)
 */
export const BED_MARGIN_M = 0.3;
/** bed outlines simplified to this in plan (metres) ... */
export const BED_PLAN_TOL_M = 0.4;
/** ... and to this in height along them (metres; checked every half sample, so 0.2 m between) */
const BED_HEIGHT_TOL_M = 0.15;
/** and no outline segment longer than this (metres): no long sliver faces over the bed */
const BED_MAX_SEG_M = 60;
/** on a bed, a stretch of the road counts less the further the point projects past its ends ... */
const BED_ALONG_M = 3;
/** ... and fades out over this much beyond the bed's edge */
const BED_GRACE_M = 1;
/** rows of points along a road in its pull band, as fractions of the band (the last on its edge) */
const BAND_ROWS = [0.3, 0.65, 1];
/** band points no closer than this, metres (more where a tile has too many) */
const BAND_SPACING_M = 12;
/** an outline's mitre on the inside of a bend reaches at most this many times its offset */
const MITRE_MAX = 4;
/**
 * a road's bed as it outranks the rest: to its outline, and the chords simplification cuts inside a
 * bend (BED_PLAN_TOL_M), and a hair beyond
 */
export const ROAD_BED_REACH_M = BED_MARGIN_M + BED_PLAN_TOL_M + 0.05;
/**
 * a river's bed as it holds the water: a little beyond its edge, so the vertices of its cover's edge
 * take the water's level, not the bank's beyond it (else a water face ran from the water up to a
 * vertex on its edge at the ground's height): that edge is thinned by 2 cm, its vertices snap by 3
 * cm, and they lay up to 15 cm off at 14/9517/6397
 */
const WATER_BED_REACH_M = 0.2;
/**
 * a way's bed stops this far past its end at a bridge or a tunnel, metres: the vertices on its
 * cover's square end there take its height, not what lies beyond (a culvert's portal)
 */
const END_SLACK_M = 0.05;
/**
 * covered (the roads' covers' outer edges are their beds' edges): a road's bed reaches this far past
 * that edge where a river's water lies beyond it, metres: the vertices of the cover's edge (thinned
 * by 2 cm) take the road's height, and the bank falls from there
 */
export const ROAD_EDGE_M = 0.05;
/** a road's bank: its water row this far beyond its bed's reach (covered: its cover's edge), metres ... */
export const BANK_M = 0.3;
/** ... its road row this far inside it */
const BANK_IN_M = 0.05;
/** a road's bank may lie this far off a river's bed at most, metres: the widest road's half width, its rows, a sample's spacing */
const DAMP_M = 30;
/** a bank's rows are simplified to this in plan, metres (they keep inside the bed's reach and out of it) */
const BANK_PLAN_TOL_M = 0.05;
/** a bank's water row is probed for the water at least this often, metres */
const BANK_PROBE_M = 1;
/** a bank's rows round the outside of a bend and a dead end in steps of at most this, radians */
const BANK_ARC = Math.PI / 6;
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

/** a network bridge's deck lifted less than this over the pulled ground under it is no lifted run: a cover like any way, metres */
export const DECK_CLEAR_M = 0.3;
/** a bridge's deck is probed for its clearance this often, metres ... */
const DECK_PROBE_M = 0.5;
/** ... and where it passes DECK_CLEAR_M found to this */
const DECK_EDGE_M = 0.01;
/** a bridge's low stretch shorter than this is lifted with the rest, metres (its deck's ends meet its approaches) */
const DECK_LOW_MIN_M = 1;

/** a bridge's deck over the bed of a road beside its crossing is probed this often along it and across it, metres ... */
const BESIDE_PROBE_M = 0.5;
/** ... and where it leaves the bed found to this */
const BESIDE_EDGE_M = 0.01;

/**
 * Per way of `net` (its index), where a bridge crosses a mapped way (a road, a path, a railway or
 * a waterway, not a bridge or a tunnel, not joined to it): the stretch of it within that way's half
 * width and BANK_M (its bank) of the crossing, the network's metres along it, less where any of the
 * deck's width lies over the bed of a network road it does not cross (that bed holds the ground at
 * the road's height, its shoulder under the deck: the bank roads of 14/9517/6397 run inside the
 * canal's width and met the deck's ends within a centimetre of it). The deck spans the water and
 * its banks; beyond them the bridge is a cover at the deck's height. From the ways' nodes alone, on
 * a plane round the bridge's first point: every tile that has them agrees (a canal cut below the
 * raw DEM under a bridge level with its banks: 14/9517/6397)
 */
export function bridgeCrossings(net: RoadNet, lines: ReadonlyArray<OsmLine>): Array<Array<[number, number]>> {
  const out = net.ways.map((): Array<[number, number]> => []);
  /** each line's nodes, to tell a joined one */
  const nodes = new Map<OsmLine, Set<string>>();
  const keysOf = (l: OsmLine) => nodes.get(l) ?? nodes.set(l, new Set(l.points.map((p) => `${p[0]},${p[1]}`))).get(l)!;
  /** each line's box: west, east, south, north */
  const boxes = new Map<OsmLine, [number, number, number, number]>();
  const boxOf = (l: OsmLine): [number, number, number, number] => {
    let box = boxes.get(l);
    if (!box) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [lon, lat] of l.points) { x0 = Math.min(x0, lon); x1 = Math.max(x1, lon); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); }
      boxes.set(l, (box = [x0, x1, y0, y1]));
    }
    return box;
  };
  const under = lines.flatMap((l) => {
    const style = classifyLine(l.tags);
    if (!style || l.points.length < 2 || isBridge(l.tags) || isTunnel(l.tags) || (l.tags.tunnel && l.tags.tunnel !== 'no')) return [];
    return [{ l, half: style.width / 2 + (style.shoulder ?? 0), box: boxOf(l) }];
  });
  net.ways.forEach((w, wi) => {
    if (!w.bridge || w.count < 2) return;
    const pts = w.line.points, own = keysOf(w.line);
    const [lon0, lat0] = pts[0], ky = (EARTH_R * Math.PI) / 180, kx = ky * Math.cos((lat0 * Math.PI) / 180);
    const plane = ([lon, lat]: LonLat): [number, number] => [(lon - lon0) * kx, (lat - lat0) * ky];
    // the network's metres at each of its points (its samples there)
    const at = [net.samples[w.first].d];
    let k = w.first;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] !== pts[i - 1][0] || pts[i][1] !== pts[i - 1][1]) {
        do k++;
        while (k + 1 < w.first + w.count && (net.samples[k].lon !== pts[i][0] || net.samples[k].lat !== pts[i][1]));
      }
      at.push(net.samples[k].d);
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [lon, lat] of pts) { x0 = Math.min(x0, lon); x1 = Math.max(x1, lon); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); }
    /**
     * the roads beside its crossings (set below), each the segments of its axis whose bed (the
     * carriageway and the shoulder) may reach under the deck, on the plane: [x, y, x, y, whether its
     * start is the road's own, whether its end]
     */
    const beside: Array<{ segs: Array<[number, number, number, number, boolean, boolean]>; half: number }> = [];
    const p = pts.map(plane), d0 = net.samples[w.first].d, total = at[at.length - 1] - d0, deckHalf = (classifyLine(w.line.tags)?.width ?? 0) / 2;
    const across = Math.max(1, Math.ceil((2 * deckHalf) / BESIDE_PROBE_M));
    /** whether any of the deck's width at `d` along it lies over the bed of a road beside (no bed past that road's own ends) */
    const onBeside = (d: number): boolean => {
      let i = 1;
      while (i < p.length - 1 && at[i] - d0 < d) i++;
      const a = p[i - 1], b = p[i], span = at[i] - at[i - 1], t = span > 0 ? (d - (at[i - 1] - d0)) / span : 0;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      for (let k = 0; k <= across; k++) {
        const o = deckHalf * ((2 * k) / across - 1), x = a[0] + (b[0] - a[0]) * t + nx * o, y = a[1] + (b[1] - a[1]) * t + ny * o;
        for (const { segs, half } of beside) {
          // the nearest of the road's axis: past its own end it has no bed
          let best = Infinity, end = false;
          for (const [cx, cy, ex, ey, first, last] of segs) {
            const sx = ex - cx, sy = ey - cy, u = ((x - cx) * sx + (y - cy) * sy) / (sx * sx + sy * sy);
            const v = Math.max(0, Math.min(1, u)), far = Math.hypot(x - cx - sx * v, y - cy - sy * v);
            if (far < best) { best = far; end = (u <= 0 && first) || (u >= 1 && last); }
          }
          if (best <= half && !end) return true;
        }
      }
      return false;
    };
    /** [from, to] along it, less its stretches over the beds of the roads beside */
    const offBeside = (from: number, to: number): Array<[number, number]> => {
      if (!beside.length) return [[from, to]];
      const lo = Math.max(0, from), hi = Math.min(total, to), runs: Array<[number, number]> = [];
      if (hi <= lo) return [];
      const steps = Math.max(1, Math.ceil((hi - lo) / BESIDE_PROBE_M));
      let prev = lo, was = !onBeside(lo), start = was ? from : NaN;
      for (let k = 1; k <= steps; k++) {
        const d = lo + ((hi - lo) * k) / steps, is = !onBeside(d);
        if (is !== was) {
          let x0 = prev, x1 = d;
          while (x1 - x0 > BESIDE_EDGE_M) {
            const m = (x0 + x1) / 2;
            if (!onBeside(m) === was) x0 = m;
            else x1 = m;
          }
          // each run to its own side of the bed's edge
          if (was) runs.push([start, x0]);
          else start = x1;
        }
        prev = d;
        was = is;
      }
      if (was) runs.push([start, to]);
      return runs;
    };
    const found: Array<[number, number]> = [], crossed = new Set<OsmLine>();
    for (const { l, half, box } of under) {
      if (l === w.line || box[1] < x0 || box[0] > x1 || box[3] < y0 || box[2] > y1 || l.points.some((p) => own.has(`${p[0]},${p[1]}`))) continue;
      const q = l.points.map(plane);
      for (let i = 1; i < pts.length; i++) {
        const a = p[i - 1], b = p[i];
        for (let j = 1; j < q.length; j++) {
          const c = q[j - 1], d = q[j];
          const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
          if (den === 0) continue;
          const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
          const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const nd = at[i - 1] + (at[i] - at[i - 1]) * t - d0, r = half + BANK_M;
          found.push([nd - r, nd + r]);
          crossed.add(l);
        }
      }
    }
    if (!found.length) return;
    // the network's roads it does not cross whose beds reach under its width
    let px0 = Infinity, px1 = -Infinity, py0 = Infinity, py1 = -Infinity;
    for (const [x, y] of p) { px0 = Math.min(px0, x); px1 = Math.max(px1, x); py0 = Math.min(py0, y); py1 = Math.max(py1, y); }
    for (const j of net.ways) {
      if (j === w || j.water || j.bridge || j.tunnel || crossed.has(j.line) || j.line.points.length < 2) continue;
      const padY = (deckHalf + j.half) / ky, padX = (deckHalf + j.half) / kx, b = boxOf(j.line);
      if (b[1] < x0 - padX || b[0] > x1 + padX || b[3] < y0 - padY || b[2] > y1 + padY) continue;
      const q = j.line.points.map(plane), reach = deckHalf + j.half, segs: (typeof beside)[number]['segs'] = [];
      for (let i = 1; i < q.length; i++) {
        const c = q[i - 1], e = q[i];
        if ((c[0] === e[0] && c[1] === e[1]) || Math.max(c[0], e[0]) < px0 - reach || Math.min(c[0], e[0]) > px1 + reach || Math.max(c[1], e[1]) < py0 - reach || Math.min(c[1], e[1]) > py1 + reach) continue;
        segs.push([c[0], c[1], e[0], e[1], i === 1, i === q.length - 1]);
      }
      if (segs.length) beside.push({ segs, half: j.half });
    }
    for (const [from, to] of found) out[wi].push(...offBeside(from, to));
  });
  return out;
}

const pulls = new WeakMap<RoadSurface, Map<string, RoadPull>>();
/**
 * The pull of a tile's roads on its lattice, built once: the cover, the surface and the mesh share
 * it; `covered` with the roads' covers in the surface (buildRoadPull)
 */
export function roadPullOf(tile: Tile, grid: number, roads: RoadSurface, covered = false): RoadPull {
  const key = `${tile.z}/${tile.x}/${tile.y}/${grid}/${covered}`;
  let byTile = pulls.get(roads);
  if (!byTile) pulls.set(roads, (byTile = new Map()));
  let pull = byTile.get(key);
  if (!pull) byTile.set(key, (pull = buildRoadPull(tile, grid, roads, covered)));
  return pull;
}

/**
 * The lifted stretches of each network bridge with its heights and the raw DEM (the covered pull's
 * `decks`), metres along its points in `enu` (as ground-cover measures a way). Elsewhere a bridge is
 * a cover like any way: a deck level with the bank roads over a canal's channel (14/9517/6397) drew
 * its asphalt in the water faces at its own height. A bridge missing here is lifted whole (no DEM:
 * tests' roads).
 */
export function bridgeDecks(tile: Tile, grid: number, roads: RoadSurface, enu: (p: LonLat) => [number, number]): Map<OsmLine, Array<[number, number]>> {
  const out = new Map<OsmLine, Array<[number, number]>>();
  const { net } = roads;
  if (!roads.dem || !net.ways.some((w) => w.bridge)) return out;
  for (const [wi, runs] of roadPullOf(tile, grid, roads, true).decks) {
    const w = net.ways[wi], pts = w.line.points;
    // metres along its points in ENU, and the network's metres at each point (its samples there)
    const along = [0], at = [0];
    let k = w.first;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = enu(pts[i - 1]), [bx, bz] = enu(pts[i]);
      along.push(along[i - 1] + Math.hypot(bx - ax, bz - az));
      if (pts[i][0] !== pts[i - 1][0] || pts[i][1] !== pts[i - 1][1]) {
        do k++;
        while (k + 1 < w.first + w.count && (net.samples[k].lon !== pts[i][0] || net.samples[k].lat !== pts[i][1]));
      }
      at.push(net.samples[k].d - net.samples[w.first].d);
    }
    const enuAt = (nd: number): number => {
      let i = 0;
      while (i + 2 < at.length && at[i + 1] < nd) i++;
      const t = at[i + 1] > at[i] ? Math.max(0, Math.min(1, (nd - at[i]) / (at[i + 1] - at[i]))) : 0;
      return along[i] + (along[i + 1] - along[i]) * t;
    };
    out.set(w.line, runs.map(([a, b]): [number, number] => [enuAt(a), enuAt(b)]));
  }
  return out;
}

export function buildRoadPull(tile: Tile, grid: number, roads: RoadSurface, covered = false): RoadPull {
  const { net } = roads;
  /** the ways: the network's, and after them the low stretches of its bridges (covered: liftDecks) */
  const ways: NetWay[] = [...net.ways];
  /** each sample's height (the low stretches' after the network's) */
  let z: Float64Array = roads.z;
  const n = 2 ** tile.z;
  // lattice coordinates of every sample
  let sx = new Float64Array(net.samples.length), sy = new Float64Array(net.samples.length);
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
  ways.forEach((w, wi) => {
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
  /** stretch s into the cells its reach touches */
  const register = (s: number): void => {
    const { i, j, way } = segs[s];
    const w = ways[way];
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
  };
  for (let s = 0; s < segs.length; s++) register(s);
  const near = (x: number, y: number): number[] => cells.get(ckey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? [];
  /** the rivers' stretches by the (quarter) cells their beds reach into (and a metre more): where a road's bank may be */
  const WET_CELL = 0.25;
  const wet = new Map<number, number[]>();
  /** the cells a road's bank by a river may lie in (its bed, a road's half width and its rows further) */
  const damp = new Set<number>();
  segs.forEach(({ i, j, way }, q) => {
    const w = ways[way];
    if (!w.water) return;
    const rd = ((w.half + DAMP_M) / Math.min(mpc(0), mpc(grid))) * 1.01;
    for (let cx = Math.floor((Math.min(sx[i], sx[j]) - rd) / CELL); cx <= Math.floor((Math.max(sx[i], sx[j]) + rd) / CELL); cx++) {
      for (let cy = Math.floor((Math.min(sy[i], sy[j]) - rd) / CELL); cy <= Math.floor((Math.max(sy[i], sy[j]) + rd) / CELL); cy++) damp.add(ckey(cx, cy));
    }
    const r = ((w.half + 1) / Math.min(mpc(0), mpc(grid))) * 1.01;
    for (let cx = Math.floor((Math.min(sx[i], sx[j]) - r) / WET_CELL); cx <= Math.floor((Math.max(sx[i], sx[j]) + r) / WET_CELL); cx++) {
      for (let cy = Math.floor((Math.min(sy[i], sy[j]) - r) / WET_CELL); cy <= Math.floor((Math.max(sy[i], sy[j]) + r) / WET_CELL); cy++) {
        const k = ckey(cx, cy), list = wet.get(k);
        if (list) list.push(q);
        else wet.set(k, [q]);
      }
    }
  });

  // the stretches' geometry, flat: start, direction, squared length, length (lattice cells) and
  // the box their reach can touch
  let nSeg = 0;
  let gAx = new Float64Array(0), gAy = gAx, gDx = gAx, gDy = gAx, gL2 = gAx, gLen = gAx, gX0 = gAx, gX1 = gAx, gY0 = gAx, gY1 = gAx;
  /** the stretch starting at each sample, −1 for none */
  let segOf = new Int32Array(0);
  /** (again, once the low stretches are in) */
  const geometry = (): void => {
    nSeg = segs.length;
    gAx = new Float64Array(nSeg); gAy = new Float64Array(nSeg); gDx = new Float64Array(nSeg); gDy = new Float64Array(nSeg);
    gL2 = new Float64Array(nSeg); gLen = new Float64Array(nSeg);
    gX0 = new Float64Array(nSeg); gX1 = new Float64Array(nSeg); gY0 = new Float64Array(nSeg); gY1 = new Float64Array(nSeg);
    const cellsPerM = 1 / Math.min(mpc(0), mpc(grid));
    for (let q = 0; q < nSeg; q++) {
      const { i, j, way } = segs[q];
      gAx[q] = sx[i];
      gAy[q] = sy[i];
      gDx[q] = sx[j] - sx[i];
      gDy[q] = sy[j] - sy[i];
      gL2[q] = gDx[q] * gDx[q] + gDy[q] * gDy[q];
      gLen[q] = Math.sqrt(gL2[q]);
      const w = ways[way], r = (w.half + BED_GRACE_M + w.band * maxScale) * cellsPerM * 1.01;
      gX0[q] = Math.min(sx[i], sx[j]) - r;
      gX1[q] = Math.max(sx[i], sx[j]) + r;
      gY0[q] = Math.min(sy[i], sy[j]) - r;
      gY1[q] = Math.max(sy[i], sy[j]) + r;
    }
    segOf = new Int32Array(sx.length).fill(-1);
    segs.forEach((g, q) => (segOf[g.i] = q));
  };
  geometry();
  /** the last projection: distance (lattice cells), how far it was clamped (cells), the unclamped fraction */
  let pDist = 0, pOver = 0, pRaw = 0;
  /** project (x, y) on stretch q (into pDist, pOver, pRaw) */
  const project = (q: number, x: number, y: number): void => {
    const ax = gAx[q], ay = gAy[q], dx = gDx[q], dy = gDy[q], l2 = gL2[q];
    const raw = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const ex = x - ax - t * dx, ey = y - ay - t * dy;
    pDist = Math.sqrt(ex * ex + ey * ey);
    pOver = Math.abs(raw - t) * gLen[q];
    pRaw = raw;
  };
  /** the box each river's stretch's bed reaches (lattice; a road's: empty) */
  const gX0w = new Float64Array(nSeg).fill(Infinity), gX1w = new Float64Array(nSeg).fill(-Infinity), gY0w = new Float64Array(nSeg).fill(Infinity), gY1w = new Float64Array(nSeg).fill(-Infinity);
  for (let q = 0; q < nSeg; q++) {
    const { i, j, way } = segs[q], w = ways[way];
    if (!w.water) continue;
    const r = ((w.half + WATER_BED_REACH_M) / Math.min(mpc(0), mpc(grid))) * 1.01;
    gX0w[q] = Math.min(sx[i], sx[j]) - r;
    gX1w[q] = Math.max(sx[i], sx[j]) + r;
    gY0w[q] = Math.min(sy[i], sy[j]) - r;
    gY1w[q] = Math.max(sy[i], sy[j]) + r;
  }
  /** per quarter cell asked for: the roads' stretches whose bed (as it outranks the rest) may reach into it */
  const bedNear = new Map<number, number[]>();
  /** whether lattice point (x, y) is on a road's bed (as it outranks the rest: evaluate's topRoad) */
  const onRoadBed = (x: number, y: number): boolean => {
    const cx = Math.floor(x / WET_CELL), cy = Math.floor(y / WET_CELL), key = ckey(cx, cy), m = mpc(y);
    let list = bedNear.get(key);
    if (!list) {
      const r = 1 / Math.min(mpc(0), mpc(grid));
      list = near(x, y).filter((q) => {
        const w = ways[segs[q].way];
        if (w.water) return false;
        const pad = (w.half + ROAD_BED_REACH_M) * r * 1.01;
        return !(Math.max(gAx[q], gAx[q] + gDx[q]) + pad < cx * WET_CELL || Math.min(gAx[q], gAx[q] + gDx[q]) - pad > (cx + 1) * WET_CELL
          || Math.max(gAy[q], gAy[q] + gDy[q]) + pad < cy * WET_CELL || Math.min(gAy[q], gAy[q] + gDy[q]) - pad > (cy + 1) * WET_CELL);
      });
      bedNear.set(key, list);
    }
    for (const q of list) {
      if (reachOf(segs[q].way, x, y, m) < 0) continue;
      project(q, x, y);
      if (pDist * m <= ways[segs[q].way].half + (covered ? ROAD_EDGE_M : ROAD_BED_REACH_M)) return true;
    }
    return false;
  };
  /** the least distance between the segment from p to q and stretch g, lattice cells */
  const segDist = (p: Pt, q: Pt, g: number): number => {
    const ax = gAx[g], ay = gAy[g], bx = ax + gDx[g], by = ay + gDy[g];
    const ptSeg = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => {
      const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
      return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
    };
    // crossing: none apart
    const d1 = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax), d2 = (bx - ax) * (q.y - ay) - (by - ay) * (q.x - ax);
    const d3 = (q.x - p.x) * (ay - p.y) - (q.y - p.y) * (ax - p.x), d4 = (q.x - p.x) * (by - p.y) - (q.y - p.y) * (bx - p.x);
    if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
    return Math.min(ptSeg(p.x, p.y, ax, ay, bx, by), ptSeg(q.x, q.y, ax, ay, bx, by), ptSeg(ax, ay, p.x, p.y, q.x, q.y), ptSeg(bx, by, p.x, p.y, q.x, q.y));
  };
  /** whether (x, y) is outside the box stretch q can reach */
  const outOfReach = (q: number, x: number, y: number): boolean => x < gX0[q] || x > gX1[q] || y < gY0[q] || y > gY1[q];
  // seniority: priority, then the order in the network (only the outlines' cutting uses the order;
  // heights never do: two tiles may list the ways differently)
  const senior = (a: number, b: number) => ways[a].prio > ways[b].prio || (ways[a].prio === ways[b].prio && a < b);

  // A way's end at a bridge or a tunnel (a sample shared with one): nothing of it reaches past that
  // end, into the bridge's span — not its bed, not its band (faded out over STRUCTURE_FADE_M before
  // the end): the ground under a bridge is left as it was, and the road or river under it with it.
  let atStructure = new Uint8Array(net.samples.length);
  net.samples.forEach((_, k) => {
    for (const [o, m] of net.next[k]) {
      const w = ways[net.samples[o].way];
      if (m === 0 && (w.bridge || w.tunnel)) atStructure[k] = 1;
    }
  });
  /** per way: its ends at a structure — the end point and the unit direction out of the way there */
  const endsOf = (w: NetWay): Array<[number, number, number, number]> => {
    const ends: Array<[number, number, number, number]> = [];
    if (w.bridge || w.tunnel || w.count < 2) return ends;
    for (const [e, o] of [[w.first, w.first + 1], [w.first + w.count - 1, w.first + w.count - 2]]) {
      if (!atStructure[e]) continue;
      const dx = sx[e] - sx[o], dy = sy[e] - sy[o], l = Math.hypot(dx, dy);
      if (l > 0) ends.push([sx[e], sy[e], dx / l, dy / l]);
    }
    return ends;
  };
  const structureEnds: Array<Array<[number, number, number, number]>> = ways.map(endsOf);
  /** 1 well inside a way's reach, falling to 0 at an end at a structure; −1 past it (nothing there) */
  const reachOf = (way: number, x: number, y: number, m: number, slack = END_SLACK_M): number => {
    const ends = structureEnds[way];
    if (!ends.length) return 1;
    let f = 1;
    for (const [ex, ey, dx, dy] of ends) {
      const past = ((x - ex) * dx + (y - ey) * dy) * m;
      if (past > slack) return -1;
      f = Math.min(f, smoothStep(-past / STRUCTURE_FADE_M));
    }
    return f;
  };
  /** the height of stretch s at unclamped fraction raw: its grade carried at most BED_ALONG_M past its ends */
  const zAlong = (q: number, raw: number, m: number): number => {
    const s = segs[q];
    const len = gLen[q] * m;
    const over = len > 0 ? BED_ALONG_M / len : 0;
    const t = Math.max(-over, Math.min(1 + over, raw));
    return z[s.i] + (z[s.j] - z[s.i]) * t;
  };
  /** a stretch's weight by how far the point projects past its ends */
  const alongWeight = (ec: number, m: number): number => {
    const a = Math.max(1e-3, 1 - (ec * m) / BED_ALONG_M);
    return a * a;
  };

  /** the weight, whether on a bed and whether that is a river's (no road's reaches there), the height (or the roads' in a band) */
  interface Eval { w: number; bed: boolean; water?: boolean; r: number }
  // What decides the ground, first to last: a road's bed; a river's (its water); a road's band
  // (where any road reaches, the water does not: between them the ground breaks to the water at
  // its bed); a river's band; the relief.
  const evaluate = (x: number, y: number, skip?: ReadonlySet<number>): Eval => {
    const m = mpc(y), scale = bandScale(y);
    if (scale === 0) return { w: 0, bed: false, r: NaN };
    const list = skip?.size ? near(x, y).filter((si) => !skip.has(segs[si].way)) : near(x, y);
    let topRoad = -Infinity, topWater = -Infinity, topMargin = -Infinity;
    let wR = 0, scR = 0, sczR = 0, wW = 0, scW = 0, sczW = 0;
    for (const si of list) {
      if (outOfReach(si, x, y)) continue;
      const s = segs[si];
      const way = ways[s.way];
      const reach = reachOf(s.way, x, y, m);
      if (reach < 0) continue;
      project(si, x, y);
      const d = pDist * m;
      // a road's bed reaches to its outline (BED_MARGIN_M beyond its edge): a river's bed under it
      // does not take the outline down to the water
      if (d <= way.half + (way.water ? WATER_BED_REACH_M : ROAD_BED_REACH_M)) {
        if (way.water) topWater = Math.max(topWater, way.prio);
        // covered: past its cover's edge (ROAD_EDGE_M) a road's bed gives way to a river's water
        else if (covered && d > way.half + ROAD_EDGE_M) topMargin = Math.max(topMargin, way.prio);
        else topRoad = Math.max(topRoad, way.prio);
        continue;
      }
      const u = smoothStep(1 - (d - way.half) / (way.band * scale)) * reach;
      if (u <= 0) continue;
      // u / (1 − u) grows without bound towards a bed; capped where u rounds to 1
      const c = (u / Math.max(1e-12, 1 - u)) * alongWeight(pOver, m);
      const zz = zAlong(si, pRaw, m);
      if (way.water) {
        wW = Math.max(wW, u);
        scW += c;
        sczW += c * zz;
      } else {
        wR = Math.max(wR, u);
        scR += c;
        sczR += c * zz;
      }
    }
    if (topRoad === -Infinity && topWater === -Infinity) topRoad = topMargin;
    const top = topRoad > -Infinity ? topRoad : topWater;
    if (top === -Infinity) {
      if (wR > 0) return { w: wR, bed: false, r: sczR / scR };
      return { w: wW, bed: false, r: scW > 0 ? sczW / scW : NaN };
    }
    // on a bed: the height of the senior roads whose beds hold the point (all of equal priority,
    // blended: no order decides), a blend of their stretches round it so it does not jump where the
    // nearest one changes (inside a bend): each by how far the point projects past its ends
    // (BED_ALONG_M) and how near it is to its bed (BED_GRACE_M beyond), each at its own grade
    let kz = 0, k = 0;
    for (const si of list) {
      if (outOfReach(si, x, y)) continue;
      const s = segs[si];
      const way = ways[s.way];
      if (way.prio !== top || reachOf(s.way, x, y, m) < 0) continue;
      project(si, x, y);
      const d = pDist * m;
      if (d > way.half + BED_GRACE_M) continue;
      const wk = alongWeight(pOver, m) * smoothStep((way.half + BED_GRACE_M - d) / BED_GRACE_M);
      kz += wk * zAlong(si, pRaw, m);
      k += wk;
    }
    return { w: 1, bed: true, water: topRoad === -Infinity, r: k > 0 ? kz / k : NaN };
  };

  const weight = (x: number, y: number) => evaluate(x, y).w;
  const height = (x: number, y: number, base: number, skip?: ReadonlySet<number>) => {
    const e = evaluate(x, y, skip);
    if (e.bed) return e.r;
    return e.w > 0 ? base + e.w * (e.r - base) : base;
  };
  /** the rivers (their ways' indices) */
  const rivers = new Set(ways.flatMap((w, k) => (w.water ? [k] : [])));
  const surface = (x: number, y: number, base: number, roadAt?: (x: number, y: number) => boolean) => {
    const e = evaluate(x, y);
    // under a road's cover the river gives way, as everywhere: the ground as if it were not there
    if (e.bed && e.water && roadAt?.(x, y)) return height(x, y, base, rivers);
    if (e.bed) return e.r;
    return e.w > 0 ? base + e.w * (e.r - base) : base;
  };
  /** per network bridge (its way's index): its lifted stretches, metres along it (the network's) */
  const decks = new Map<number, Array<[number, number]>>();
  if (covered && roads.dem) liftDecks(roads.dem);
  const borderPoints: Pt[] = [];
  /** each sample's latitude and the band scale there */
  const latAt = Float64Array.from(sy, (y) => latOf(y));
  const scaleAt = Float64Array.from(latAt, (lat) => {
    const w = roadWindow(lat);
    return w < MIN_WINDOW_M ? 0 : w / ROAD_WINDOW_M;
  });
  /** whether a run's samples come within `metres` of the tile */
  const reachesTile = (run: number[], metres: number): boolean => {
    const r = metres / Math.min(mpc(0), mpc(grid));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const k of run) { x0 = Math.min(x0, sx[k]); x1 = Math.max(x1, sx[k]); y0 = Math.min(y0, sy[k]); y1 = Math.max(y1, sy[k]); }
    return x1 >= -r && x0 <= grid + r && y1 >= -r && y0 <= grid + r;
  };
  /** the band rows' points inside the tile, the senior roads' first */
  const rowPoints: Pt[] = [];
  const banks: Array<{ way: number; lines: Pt[][] }> = [];
  const beds = bedOutlines();
  /**
   * covered: on a river's bed within BANK_M (and a hair) of a road's cover's edge or square end (or
   * between that edge, a round end's chords, and the bed's: ROAD_EDGE_M)
   */
  const bank = (x: number, y: number): boolean => {
    if (!covered) return false;
    const m = mpc(y), far = BANK_M + 0.02, list = near(x, y);
    let road = false, water = false;
    for (const q of list) {
      if (outOfReach(q, x, y)) continue;
      const w = ways[segs[q].way];
      if (reachOf(segs[q].way, x, y, m, w.water ? END_SLACK_M : far) < 0) continue;
      project(q, x, y);
      if (w.water) water ||= pDist * m <= w.half + WATER_BED_REACH_M;
      else road ||= pDist * m <= w.half + far;
      if (road && water) return true;
    }
    return false;
  };
  return { weight, height, surface, beds, banks, borderPoints, bandPoints, ways, decks, bank };

  /** where the polyline crosses the tile border: shared points (the neighbour has them too) */
  function crossBorder(pts: Pt[]): void {
    for (let k = 1; k < pts.length; k++) {
      for (const t of squareCuts(pts[k - 1], pts[k])) {
        const q = snapBorder(lerp(pts[k - 1], pts[k], t), grid);
        if (q.x >= 0 && q.x <= grid && q.y >= 0 && q.y <= grid && (q.x === 0 || q.x === grid || q.y === 0 || q.y === grid)) borderPoints.push(q);
      }
    }
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

  /**
   * One side of a run of samples offset `metres(k)` from its axis: round on the outside of every
   * bend (no point farther from the axis than the offset), mitred on the inside up to MITRE_MAX times
   */
  /** per sample of a run: the unit normals (left) of the stretches before and after it */
  function runNormals(run: number[]): Array<Array<[number, number]>> {
    const closed = run.length > 3 && sx[run[0]] === sx[run[run.length - 1]] && sy[run[0]] === sy[run[run.length - 1]];
    return run.map((k, q) => {
      const prev = q > 0 ? run[q - 1] : closed ? run[run.length - 2] : -1;
      const next = q + 1 < run.length ? run[q + 1] : closed ? run[1] : -1;
      const normals: Array<[number, number]> = [];
      for (const [a, b] of [[prev, k], [k, next]]) {
        if (a < 0 || b < 0) continue;
        const dx = sx[b] - sx[a], dy = sy[b] - sy[a], l = Math.hypot(dx, dy);
        if (l > 0) normals.push([-dy / l, dx / l]);
      }
      return normals;
    });
  }

  function offsetRun(run: number[], metres: (k: number) => number, side: number, normalsOf: Array<Array<[number, number]>> = runNormals(run)): PtK[] {
    const pts: PtK[] = [];
    run.forEach((k, q) => {
      const normals = normalsOf[q];
      const r = (side * metres(k)) / (cellM * Math.cos((latAt[k] * Math.PI) / 180));
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
      if (!outside) {
        if (ml > 1e-9) at(mx / ml, my / ml, Math.min(1 / Math.max(cosHalf, 1e-9), MITRE_MAX));
        else at(ax, ay, 1);
        return;
      }
      if (cosHalf > 0.99999) {
        at(mx / ml, my / ml, 1);
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
    return pts;
  }

  /**
   * The bank of a run of road way `wi` (bed half width `half`, `normals` its runNormals): its two rows
   * (ROAD_BED_REACH_M less BANK_IN_M and plus BANK_M off its axis) round the run — along each side,
   * round a dead end, square across an end at a bridge or a tunnel (where its bed stops) — where the
   * water row runs over a river's bed no road's reaches, rung to rung: each piece of them reaches to
   * the rungs past the water, so the rows cross what bounds it there (its edge, another road's rows).
   */
  function bankLines(run: number[], half: number, normals: Array<Array<[number, number]>>): Pt[][] {
    // covered, the road's row is its cover's edge (the bed's): the water row BANK_M beyond it
    const rIn = half + ROAD_BED_REACH_M - BANK_IN_M, rOut = half + (covered ? 0 : ROAD_BED_REACH_M) + BANK_M;
    // the samples a river's bed comes near (within the water row's reach and half the samples' spacing):
    // none, no bank; elsewhere no stretch of the rows is probed
    const close = new Set<number>();
    for (const k of run) {
      if (!damp.has(ckey(Math.floor(sx[k] / CELL), Math.floor(sy[k] / CELL)))) continue;
      const r = (rOut + NET_STEP_M / 2 + 1) / mpc(sy[k]);
      for (let cx = Math.floor((sx[k] - r) / WET_CELL); cx <= Math.floor((sx[k] + r) / WET_CELL) && !close.has(k); cx++) {
        for (let cy = Math.floor((sy[k] - r) / WET_CELL); cy <= Math.floor((sy[k] + r) / WET_CELL); cy++) {
          if (wet.has(ckey(cx, cy))) {
            close.add(k);
            break;
          }
        }
      }
    }
    if (!close.size) return [];
    /** metres in lattice cells at sample k */
    const cells = (k: number, metres: number) => metres / (cellM * Math.cos((latAt[k] * Math.PI) / 180));
    /** the rungs: a point of each row across from each other, and the sample they are laid from */
    type Rung = { a: Pt; b: Pt; k: number };
    const side = (s: number): Rung[] => {
      const a = offsetRun(run, () => rIn, s, normals), b = offsetRun(run, () => rOut, s, normals);
      return a.map((p, i) => ({ a: p, b: b[i], k: p.k }));
    };
    const left = side(1), right = side(-1);
    // round the run: a ring's sides each a loop of their own
    const loops: Rung[][] = [];
    if (run.length > 3 && sx[run[0]] === sx[run[run.length - 1]] && sy[run[0]] === sy[run[run.length - 1]]) loops.push(left, right);
    else {
      /** the rungs round end e (its stretch from o) from rung `from` (the side it ends on) to rung `to`: square ones moved onto it */
      const end = (e: number, o: number, from: Rung, to: Rung): Rung[] => {
        const l = Math.hypot(sx[e] - sx[o], sy[e] - sy[o]), ux = (sx[e] - sx[o]) / l, uy = (sy[e] - sy[o]) / l;
        if (atStructure[e]) {
          // square: the bed stops on the line across the end (reachOf), the road row a hair short of it
          const back = cells(e, BANK_IN_M), fore = cells(e, covered ? BANK_M : END_SLACK_M + BANK_M);
          const onto = (r: Rung) => {
            r.a = { x: r.a.x - ux * back, y: r.a.y - uy * back };
            r.b = { x: r.b.x + ux * fore, y: r.b.y + uy * fore };
          };
          onto(from);
          onto(to);
          return [{ a: { x: sx[e] - ux * back, y: sy[e] - uy * back }, b: { x: sx[e] + ux * fore, y: sy[e] + uy * fore }, k: e }];
        }
        // round: from the one side through ahead to the other
        const fx = from.a.x - sx[e], fy = from.a.y - sy[e], fl = Math.hypot(fx, fy) || 1, nx = fx / fl, ny = fy / fl;
        const ci = cells(e, rIn), co = cells(e, rOut), steps = Math.ceil(Math.PI / BANK_ARC), out: Rung[] = [];
        for (let i = 1; i < steps; i++) {
          const t = (Math.PI * i) / steps, dx = nx * Math.cos(t) + ux * Math.sin(t), dy = ny * Math.cos(t) + uy * Math.sin(t);
          out.push({ a: { x: sx[e] + dx * ci, y: sy[e] + dy * ci }, b: { x: sx[e] + dx * co, y: sy[e] + dy * co }, k: e });
        }
        return out;
      };
      const last = run.length - 1;
      const atEnd = end(run[last], run[last - 1], left[left.length - 1], right[right.length - 1]);
      const atStart = end(run[0], run[1], right[0], left[0]);
      loops.push([...left, ...atEnd, ...[...right].reverse(), ...atStart]);
    }
    /** the rivers' stretches the stretch from p to q comes within the bed (its reach) of */
    const nearWater = (p: Pt, q: Pt): number[] => {
      const m = mpc(p.y), out: number[] = [];
      // the cells along it (a stretch between rungs is a few cells long at most)
      const n = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / WET_CELL), cs: number[] = [];
      for (let j = 0; j <= n; j++) {
        const c = ckey(Math.floor((p.x + ((q.x - p.x) * j) / n) / WET_CELL), Math.floor((p.y + ((q.y - p.y) * j) / n) / WET_CELL));
        if (wet.has(c) && !cs.includes(c)) cs.push(c);
      }
      for (const c of cs) {
        for (const g of wet.get(c) ?? []) {
          // the box its bed reaches first
          if (Math.max(p.x, q.x) < gX0w[g] || Math.min(p.x, q.x) > gX1w[g] || Math.max(p.y, q.y) < gY0w[g] || Math.min(p.y, q.y) > gY1w[g]) continue;
          if (!out.includes(g) && segDist(p, q, g) * m <= ways[segs[g].way].half + WATER_BED_REACH_M) out.push(g);
        }
      }
      return out;
    };
    /** whether the water row runs over the water from p to q anywhere: on a river's bed (cheap), then on no road's (the whole pull) */
    const wetFrom = (p: Pt, q: Pt): boolean => {
      const near = nearWater(p, q);
      if (!near.length) return false;
      // probed every half the narrowest's width, BANK_PROBE_M at least: a stream narrower than the
      // rungs apart is crossed
      const m = mpc(p.y), step = Math.max(BANK_PROBE_M, Math.min(...near.map((g) => ways[segs[g].way].half)));
      const n = Math.max(1, Math.ceil((Math.hypot(q.x - p.x, q.y - p.y) * m) / step));
      for (let j = 0; j <= n; j++) {
        const x = p.x + ((q.x - p.x) * j) / n, y = p.y + ((q.y - p.y) * j) / n;
        if (near.some((g) => reachOf(segs[g].way, x, y, m) >= 0 && (project(g, x, y), pDist * m <= ways[segs[g].way].half + WATER_BED_REACH_M)) && !onRoadBed(x, y)) return true;
      }
      return false;
    };
    const pieces: Rung[][] = [];
    for (const loop of loops) {
      const n = loop.length;
      // each stretch of the water row between two rungs: whether it runs over the water
      const wetRow = loop.map((r, i) => (close.has(r.k) || close.has(loop[(i + 1) % n].k)) && wetFrom(r.b, loop[(i + 1) % n].b));
      if (!wetRow.some(Boolean)) continue;
      if (wetRow.every(Boolean)) {
        pieces.push([...loop, loop[0]]);
        continue;
      }
      // the pieces round the loop: the rungs of each run of wet stretches
      for (let s = 0; s < n; s++) {
        if (!wetRow[s] || wetRow[(s + n - 1) % n]) continue;
        const piece = [loop[s]];
        for (let j = s; wetRow[j % n]; j++) piece.push(loop[(j + 1) % n]);
        pieces.push(piece);
      }
    }
    // each row of each piece (covered: the water's alone, its cover's edge the road's) cut at the
    // tile's square from the rows as laid, its crossings shared (the neighbour cuts the same rows
    // there), then thinned
    const out: Pt[][] = [];
    for (const piece of pieces) {
      for (const row of covered ? [piece.map((r) => ({ ...r.b, k: r.k }))] : [piece.map((r) => ({ ...r.a, k: r.k })), piece.map((r) => ({ ...r.b, k: r.k }))]) {
        for (const part of inTile(row)) {
          const kept = thinRow(part);
          if (kept.length >= 2) out.push(kept.map(({ x, y }) => ({ x, y })));
        }
      }
    }
    return out;

    /** the pieces of a row inside the tile, cut where it crosses the tile's border (those points shared: borderPoints) */
    function inTile(row: PtK[]): PtK[][] {
      const parts: PtK[][] = [];
      let cur: PtK[] = [];
      for (let k = 1; k < row.length; k++) {
        const a = row[k - 1], b = row[k];
        if (a.x === b.x && a.y === b.y) continue;
        const ts = [0, 1, ...squareCuts(a, b)].sort((p, q) => p - q);
        for (let c = 1; c < ts.length; c++) {
          if (ts[c] - ts[c - 1] < 1e-9) continue;
          const p = { ...snapBorder(lerp(a, b, ts[c - 1]), grid), k: a.k }, q = { ...snapBorder(lerp(a, b, ts[c]), grid), k: ts[c] === 1 ? b.k : a.k };
          const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
          if (mx >= 0 && mx <= grid && my >= 0 && my <= grid) {
            if (!cur.length) cur.push(p);
            cur.push(q);
            for (const r of [p, q]) if (r.x === 0 || r.x === grid || r.y === 0 || r.y === grid) borderPoints.push({ x: r.x, y: r.y });
          } else if (cur.length) {
            parts.push(cur);
            cur = [];
          }
        }
      }
      if (cur.length) parts.push(cur);
      return parts.filter((part) => part.length >= 2);
    }

    /**
     * Douglas–Peucker on a row: a point goes where the row runs straight through it to
     * BANK_PLAN_TOL_M and the road's height along it is linear to BED_HEIGHT_TOL_M (no chord longer
     * than BED_MAX_SEG_M): the rows keep the bank where the road and its bed bend; the ends kept
     */
    function thinRow(row: PtK[]): PtK[] {
      const keep = new Uint8Array(row.length);
      keep[0] = keep[row.length - 1] = 1;
      const stack: Array<[number, number]> = [[0, row.length - 1]];
      while (stack.length) {
        const [i, j] = stack.pop()!;
        if (j - i < 2) continue;
        const a = row[i], b = row[j], m = mpc((a.y + b.y) / 2), dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        let worst = 0, at = -1;
        for (let k = i + 1; k < j; k++) {
          const p = row[k], t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
          const plan = (Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) * m) / BANK_PLAN_TOL_M;
          const e = Math.max(plan, Math.abs(z[p.k] - (z[a.k] + (z[b.k] - z[a.k]) * t)) / BED_HEIGHT_TOL_M);
          if (e > worst) {
            worst = e;
            at = k;
          }
        }
        if (worst <= 1 && Math.sqrt(l2) * m > BED_MAX_SEG_M) {
          worst = 2;
          at = (i + j) >> 1;
        }
        if (worst > 1) {
          keep[at] = 1;
          stack.push([i, at], [at, j]);
        }
      }
      return row.filter((_, k) => keep[k]);
    }
  }

  /**
   * Each network bridge with its heights (and the raw DEM `dem`): its lifted stretches into `decks`,
   * over a mapped way it crosses (RoadSurface.over: a canal cut below the raw DEM, 14/9517/6397) and
   * where its deck lies DECK_CLEAR_M or more over the raw DEM under it (from its own data and the
   * ways it crosses alone, so every tile that has them agrees: the pulled ground under it is the
   * tile's, and a low stretch cut where one tile's view ended broke the seam); probed every DECK_PROBE_M, each end found to
   * DECK_EDGE_M, a low stretch under DECK_LOW_MIN_M with the deck. Its low stretches (a cover like
   * any way: ground-cover) then pull as roads at the deck's height, square at their ends, after the
   * network's ways: the asphalt there is the deck's height, the road outranks the water under it and
   * the bank falls at its cover's edge (followed down the bank, the asphalt fell 2.6 m inside the
   * deck's footprint at 14/9517/6397, and stepped where it met the lifted deck)
   */
  function liftDecks(dem: ArrayLike<number>): void {
    const lows: Array<{ way: number; a: number; b: number }> = [];
    const nWays = ways.length;
    for (let wi = 0; wi < nWays; wi++) {
      const w = ways[wi];
      if (!w.bridge || w.tunnel || w.count < 2) continue;
      const first = w.first, last = first + w.count - 1;
      let finite = true;
      for (let i = first; i <= last; i++) if (!Number.isFinite(z[i]) || !Number.isFinite(dem[i])) finite = false;
      if (!finite) continue;
      const len = net.samples[last].d - net.samples[first].d;
      // its own data alone (its samples' heights and the raw DEM under them, the same in every tile
      // that has it): the pulled ground under it, and the tile's view of it, differ from tile to tile
      // and so would its low stretches, which pull
      const over = roads.over?.[wi] ?? [];
      const lifted = (d: number): boolean => {
        if (over.some(([a, b]) => d >= a && d <= b)) return true;
        const { i, t } = along(first, last, d);
        return z[i] + (z[i + 1] - z[i]) * t - (dem[i] + (dem[i + 1] - dem[i]) * t) >= DECK_CLEAR_M;
      };
      const runs: Array<[number, number]> = [];
      const steps = Math.max(1, Math.ceil(len / DECK_PROBE_M));
      let prev = 0, was = lifted(0), start = was ? 0 : NaN;
      for (let k = 1; k <= steps; k++) {
        const d = (len * k) / steps, is = lifted(d);
        if (is !== was) {
          let lo = prev, hi = d;
          while (hi - lo > DECK_EDGE_M) {
            const m = (lo + hi) / 2;
            if (lifted(m) === was) lo = m;
            else hi = m;
          }
          // each run to the lifted side of its end
          if (was) runs.push([start, lo]);
          else start = hi;
        }
        prev = d;
        was = is;
      }
      if (was) runs.push([start, len]);
      // a low stretch shorter than DECK_LOW_MIN_M goes with the deck (its end over its approach's bed's end)
      const merged: Array<[number, number]> = [];
      for (const r of runs) {
        const prevRun = merged[merged.length - 1];
        if (prevRun && r[0] - prevRun[1] < DECK_LOW_MIN_M) prevRun[1] = r[1];
        else merged.push([...r]);
      }
      if (merged.length && merged[0][0] < DECK_LOW_MIN_M) merged[0][0] = 0;
      if (merged.length && len - merged[merged.length - 1][1] < DECK_LOW_MIN_M) merged[merged.length - 1][1] = len;
      decks.set(wi, merged);
      // what they leave low
      let at = 0;
      for (const [a, b] of merged) {
        if (a > at) lows.push({ way: wi, a: at, b: a });
        at = b;
      }
      if (at < len) lows.push({ way: wi, a: at, b: len });
    }
    if (!lows.length) return;
    // the low stretches as ways of their own, on samples of their own after the network's
    const xs = Array.from(sx), ys = Array.from(sy), zs = Array.from(z), ends: number[] = [];
    for (const { way, a, b } of lows) {
      const w = ways[way], first = w.first, last = first + w.count - 1, d0 = net.samples[first].d;
      const k0 = xs.length;
      const put = (d: number) => {
        const { i, t } = along(first, last, d);
        xs.push(sx[i] + (sx[i + 1] - sx[i]) * t);
        ys.push(sy[i] + (sy[i + 1] - sy[i]) * t);
        zs.push(z[i] + (z[i + 1] - z[i]) * t);
      };
      put(a);
      for (let i = first + 1; i < last; i++) if (net.samples[i].d - d0 > a + 1e-6 && net.samples[i].d - d0 < b - 1e-6) put(net.samples[i].d - d0);
      put(b);
      const v = ways.push({ ...w, bridge: false, first: k0, count: xs.length - k0 }) - 1;
      ends.push(k0, xs.length - 1);
      for (let k = k0; k + 1 < xs.length; k++) segs.push({ i: k, j: k + 1, way: v });
    }
    sx = Float64Array.from(xs);
    sy = Float64Array.from(ys);
    z = Float64Array.from(zs);
    const old = atStructure;
    atStructure = new Uint8Array(xs.length);
    atStructure.set(old);
    for (const k of ends) atStructure[k] = 1;
    // their ends square: nothing of them past (reachOf)
    for (let v = nWays; v < ways.length; v++) {
      const w = ways[v], out: Array<[number, number, number, number]> = [];
      for (const [e, o] of [[w.first, w.first + 1], [w.first + w.count - 1, w.first + w.count - 2]]) {
        const dx = sx[e] - sx[o], dy = sy[e] - sy[o], l = Math.hypot(dx, dy);
        if (l > 0) out.push([sx[e], sy[e], dx / l, dy / l]);
      }
      structureEnds.push(out);
    }
    const firstNew = nSeg;
    geometry();
    for (let q = firstNew; q < segs.length; q++) register(q);
  }

  /** the stretch of samples first..last d metres (the network's) along from first: its index and fraction */
  function along(first: number, last: number, d: number): { i: number; t: number } {
    const d0 = net.samples[first].d;
    let i = first;
    while (i + 1 < last && net.samples[i + 1].d - d0 < d) i++;
    const s0 = net.samples[i].d - d0, s1 = net.samples[i + 1].d - d0;
    return { i, t: s1 > s0 ? Math.max(0, Math.min(1, (d - s0) / (s1 - s0))) : 0 };
  }

  /** the band rows' points thinned to at most `limit` (closer than BAND_SPACING_M, more if need be), off every bed */
  function bandPoints(limit: number): Pt[] {
    const m = mpc(grid / 2);
    let r = BAND_SPACING_M / m;
    for (let attempt = 0; ; attempt++) {
      // the points kept so far by cell of side r: a linked list per cell
      const side = Math.ceil(grid / r) + 1;
      const head = new Int32Array(side * side).fill(-1);
      const nextKept: number[] = [];
      const kept: Pt[] = [];
      for (const p of rowPoints) {
        const cx = Math.floor(p.x / r), cy = Math.floor(p.y / r);
        let near = false;
        for (let i = Math.max(0, cx - 1); i <= Math.min(side - 1, cx + 1) && !near; i++) {
          for (let j = Math.max(0, cy - 1); j <= Math.min(side - 1, cy + 1) && !near; j++) {
            for (let q = head[j * side + i]; q >= 0; q = nextKept[q]) {
              const o = kept[q];
              if ((o.x - p.x) ** 2 + (o.y - p.y) ** 2 < r * r) { near = true; break; }
            }
          }
        }
        if (near) continue;
        const c = cy * side + cx;
        nextKept.push(head[c]);
        head[c] = kept.length;
        kept.push(p);
      }
      if (kept.length <= limit || attempt >= 6) return kept.filter((p) => !evaluate(p.x, p.y).bed).map(({ x, y }) => ({ x, y }));
      r *= Math.sqrt(kept.length / limit) * 1.05;
    }
  }

  // --- the bed outlines ---
  function bedOutlines(): Array<{ way: number; edges: Pt[][] }> {
    const out: Array<{ way: number; edges: Pt[][] }> = [];
    if (bandScale(grid / 2) === 0) return out;
    const order = ways.map((_, k) => k).filter((k) => !ways[k].bridge && !ways[k].tunnel);
    order.sort((a, b) => (senior(a, b) ? -1 : senior(b, a) ? 1 : 0));
    const rank = new Int32Array(ways.length).fill(-1);
    order.forEach((w, k) => (rank[w] = k));
    // the outline segments laid so far (of more senior beds), by cell
    const laid: Array<[Pt, Pt]> = [];
    /** laidCuts' marks: each laid segment once per call */
    const laidSeen: number[] = [];
    let laidStamp = 0;
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
      const way = ways[wi];
      const edges: Pt[][] = [];
      // runs of samples with a height
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const normals = runNormals(run);
          if (!way.water) {
            const lines = bankLines(run, way.half, normals);
            if (lines.length) banks.push({ way: wi, lines });
          }
          for (const side of [-1, 1]) {
            for (const piece of sideLine(run, way.half, side, wi, normals)) edges.push(piece);
            // the band's rows along it (only where its band reaches the tile)
            if (!reachesTile(run, way.half + BED_MARGIN_M + way.band)) continue;
            for (const f of BAND_ROWS) {
              const row = offsetRun(run, (k) => way.half + BED_MARGIN_M + way.band * scaleAt[k] * f, side, normals);
              crossBorder(row);
              for (const p of row) if (p.x > 0 && p.x < grid && p.y > 0 && p.y < grid) rowPoints.push(p);
            }
          }
        }
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
    function sideLine(run: number[], half: number, side: number, wi: number, normals: Array<Array<[number, number]>>): Pt[][] {
      const pts = offsetRun(run, () => half + BED_MARGIN_M, side, normals);
      crossBorder(pts);
      // split at the tile square and at the senior outlines; keep the pieces off senior beds and inside
      const pieces: PtK[][] = [];
      let cur: PtK[] = [];
      /** whether the outline of a road senior to this one holds (x, y) (its bed and BED_MARGIN_M, a hair more) */
      const covered = (x: number, y: number): boolean => {
        const m = mpc(y), r = rank[wi];
        for (const si of near(x, y)) {
          const s = segs[si], rs = rank[s.way];
          if (rs < 0 || rs >= r || outOfReach(si, x, y) || reachOf(s.way, x, y, m) < 0) continue;
          project(si, x, y);
          if (pDist * m <= ways[s.way].half + BED_MARGIN_M + 0.05) return true;
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

    function laidCuts(a: Pt, b: Pt): number[] {
      const ts: number[] = [];
      laidStamp++;
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
          for (const id of laidCells.get(ckey(cx, cy)) ?? []) {
            if (laidSeen[id] === laidStamp) continue;
            laidSeen[id] = laidStamp;
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
          const e = Math.max(plan, vert);
          if (e > worst) {
            worst = e;
            at = k;
          }
        }
        // a chord too long though within the tolerances: split in the middle
        if (worst <= 1 && (Math.sqrt(l2) * m) / BED_MAX_SEG_M > 1) {
          worst = 2;
          at = (i + j) >> 1;
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
      const w = ways[wi], m = mpc(y);
      let kz = 0, kk = 0;
      for (let i = Math.max(w.first, k - 2); i < Math.min(w.first + w.count - 1, k + 2); i++) {
        const q = segOf[i];
        if (q < 0) continue;
        project(q, x, y);
        const a = alongWeight(pOver, m);
        kz += a * zAlong(q, pRaw, m);
        kk += a;
      }
      return kk > 0 ? kz / kk : z[k];
    }
  }
}

/** within 1e-9 of the tile's border: exactly on it, its position along rounded to 1e-6 cell (the neighbour's too) */
export function snapBorder(p: Pt, grid: number): Pt {
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
