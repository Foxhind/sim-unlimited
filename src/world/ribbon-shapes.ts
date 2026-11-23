/**
 * The shapes of the ribbons ways are drawn as, in the tile's lattice: a centre line widened to each
 * side with mitred bends, round caps and joint discs (ribbonGeom); where roads meet, how a ribbon
 * ends, shifts onto a fork and stops its paint (lineNetwork); and the vertex attributes of a painted
 * road and a railway track (painted, trackSegs). Pure geometry: no terrain, no mesh.
 */
import { FORK_TAPER_M, ROAD_EDGE, ROAD_MARK_END_M, ROAD_TAPER_M, ROAD_U_BASE, TRACK_EDGE } from '../engine/palette';
import type { LonLat, OsmLine } from './osm-types';
import { classifyLine, isOnewayRoad, isTunnel, LINK_RANK, roadLayer, roadPriority, roadRank } from './way-styles';

export type P2 = [number, number];
/**
 * How a ribbon ends: start/end a lattice vector from its end point towards the way that continues it
 * (the joint mitred), and whether it gets a round cap there
 */
export interface RibbonEnds { start?: P2; end?: P2; capStart: boolean; capEnd: boolean }
export const ROUND_ENDS: RibbonEnds = { capStart: true, capEnd: true };
/** cosine of half the turn: sharper than a right angle a ribbon's bend is rounded, not mitred */
const SHARP_TURN_COS = Math.SQRT1_2;
/** a vertex's WINDOW_ATTR_FLOATS (WORLD_VS aWinUV, aWinEdge) from its position */
export type VertexAttr = (p: { x: number; z: number }) => [number, number, number, number, number];
/** points of a round cap around an end of a ribbon (lattice units); 12 sides */
const CAP_SIDES = 12;
/** a cap rounded to a tolerance has at least this many sides */
const MIN_CAP_SIDES = 6;

/**
 * The sides of a cap `half` metres round: CAP_SIDES, or with a tolerance (metres) as few as keep
 * its chords within it of the circle (at least MIN_CAP_SIDES, never more than CAP_SIDES)
 */
export function capSides(half: number, tol?: number): number {
  if (tol === undefined) return CAP_SIDES;
  if (tol >= half) return MIN_CAP_SIDES;
  return Math.max(MIN_CAP_SIDES, Math.min(CAP_SIDES, Math.ceil(Math.PI / Math.acos(1 - tol / half) - 1e-9)));
}
/** a fork branch's direction is taken over its first this many metres */
const FORK_PROBE_M = 15;

/** a ribbon's shape in the lattice */
export interface RibbonGeom {
  /** its triangles, in threes: two a segment of the centre line, then the caps' and joint discs' fans */
  tris: P2[];
  /** the segment of the centre line each triangle belongs to (a cap: the first or last; a joint disc: its vertex's) */
  triSeg: number[];
  /**
   * its edge as polylines: the left and right sides, the arcs of the round caps and joint discs
   * beyond the body, a straight end where it has no cap; no inner edge. The edge of the ribbon as
   * one sheet: where it overlaps itself (a hairpin) the pieces cross.
   */
  outline: P2[][];
  /** across it at each inner vertex of the centre line: the end of the segment before, and the start of the one after where it differs */
  cuts: P2[][];
  /** the vertex of the centre line each cut is at */
  cutAt: number[];
}

const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const same = (a: P2, b: P2): boolean => a[0] === b[0] && a[1] === b[1];

/** the k-th corner of the cap polygon of n sides round e, as its triangles have it */
const capCorner = (e: P2, r: number, k: number, n: number): P2 => {
  const a = (k / n) * 2 * Math.PI;
  return [e[0] + Math.cos(a) * r, e[1] + Math.sin(a) * r];
};

/** where the ray from e (inside the cap polygon of n sides) towards p leaves the polygon */
const capExit = (e: P2, r: number, p: P2, n: number): P2 => {
  const d = sub(p, e);
  for (let k = 0; k < n; k++) {
    const a = capCorner(e, r, k, n), w = sub(capCorner(e, r, (k + 1) % n, n), a);
    const den = cross(d, w);
    if (Math.abs(den) < 1e-300) continue;
    const s = cross(sub(a, e), w) / den, t = cross(sub(a, e), d) / den;
    if (s > 0 && t >= -1e-12 && t <= 1 + 1e-12) return [e[0] + d[0] * s, e[1] + d[1] * s];
  }
  return p;
};

/**
 * The edge of the cap polygon of n sides round e where the body does not cover it: the part where
 * (p − e)·h1 > 0 and (p − e)·h2 > 0, from `from` (on the line (p − e)·h1 = 0) to `to` (on (p − e)·h2 = 0),
 * through the crossings of those lines with the polygon and its corners between them
 */
const capArc = (e: P2, r: number, from: P2, to: P2, h1: P2, h2: P2, n: number): P2[] => {
  const eps = 1e-9 * r;
  const f = sub(from, e), sense = Math.sign(cross(f, [h1[0] + h2[0], h1[1] + h2[1]])) || 1;
  const turn = (p: P2): number => {
    const v = sub(p, e), a = Math.atan2(cross(f, v), dot(f, v)) * sense;
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const corners: P2[] = [];
  for (let k = 0; k < n; k++) {
    const v = capCorner(e, r, k, n);
    if (dot(sub(v, e), h1) > eps && dot(sub(v, e), h2) > eps) corners.push(v);
  }
  corners.sort((a, b) => turn(a) - turn(b));
  const pts = [from, capExit(e, r, from, n), ...corners, capExit(e, r, to, n), to];
  // the crossings fall on the end points or the corners where those lie on the polygon
  const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
  const out: P2[] = [from];
  for (let k = 1; k < pts.length - 1; k++) if (!near(pts[k], out[out.length - 1]) && !near(pts[k], to)) out.push(pts[k]);
  out.push(to);
  return out;
};

/** where segments a0–a1 and b0–b1 cross, or undefined */
const crossing = (a0: P2, a1: P2, b0: P2, b1: P2): P2 | undefined => {
  const da = sub(a1, a0), db = sub(b1, b0), den = cross(da, db);
  if (Math.abs(den) < 1e-300) return undefined;
  const t = cross(sub(b0, a0), db) / den, u = cross(sub(b0, a0), da) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a0[0] + da[0] * t, a0[1] + da[1] * t] : undefined;
};

/**
 * A ribbon `half` metres wide each side of the lattice polyline `c` (a half width per vertex, or
 * one for all). Inside a way the sides are mitred, so a bend keeps the full width; a turn sharper
 * than SHARP_TURN_COS is not mitred (a spike): each segment keeps its full width up to the vertex,
 * and a disc round it fills the outer wedge. Each end is capped round, mitred onto the way that
 * continues it, or square (`ends`): OSM splits roads and rivers into ways that meet at an angle, and
 * square ends left a wedge open outside every such bend. The caps and discs have CAP_SIDES sides, or
 * with `capTol` (metres) as few as keep them within it of the circle (capSides).
 */
export function ribbonGeom(c: P2[], half: number | number[], ends: RibbonEnds, latticePerMetre: number, capTol?: number): RibbonGeom {
  const halfAt = (i: number) => (typeof half === 'number' ? half : half[i]);
  // each vertex's edge points as the end of the segment before it (in) and the start of the one
  // after it (out): the same mitred point at a bend, the two segments' own at a sharp turn
  const inL: P2[] = [], inR: P2[] = [], outL: P2[] = [], outR: P2[] = [];
  const joints: number[] = [];
  // a way continued by another: a point of it past each joint, so the joint is mitred like a bend
  const before: P2 | undefined = ends.start ? [c[0][0] + ends.start[0], c[0][1] + ends.start[1]] : undefined;
  const after: P2 | undefined = ends.end ? [c[c.length - 1][0] + ends.end[0], c[c.length - 1][1] + ends.end[1]] : undefined;
  for (let i = 0; i < c.length; i++) {
    const r = halfAt(i) * latticePerMetre;
    const prev = i === 0 && before ? before : c[Math.max(0, i - 1)];
    const next = i === c.length - 1 && after ? after : c[Math.min(c.length - 1, i + 1)];
    // the direction at the vertex: the bisector of the two segments' directions (the chord from
    // prev to next leans towards the longer one, and the mitre with it: a leg tapered to the corner)
    const unit = (ax: number, ay: number): P2 => { const l = Math.hypot(ax, ay); return l > 1e-12 ? [ax / l, ay / l] : [0, 0]; };
    const uIn = unit(c[i][0] - prev[0], c[i][1] - prev[1]), uOut = unit(next[0] - c[i][0], next[1] - c[i][1]);
    let [dx, dy] = unit(uIn[0] + uOut[0], uIn[1] + uOut[1]);
    if (dx === 0 && dy === 0) [dx, dy] = uIn[0] || uIn[1] ? uIn : uOut;
    // mitre: the offset along the mean normal that keeps both segments `r` wide; a sharp turn keeps
    // each segment's own ends
    const at = (sx: number, sy: number, m: number): [P2, P2] => [[c[i][0] - sy * m, c[i][1] + sx * m], [c[i][0] + sy * m, c[i][1] - sx * m]];
    let pIn = at(dx, dy, r), pOut = pIn;
    if ((i > 0 || before) && (i < c.length - 1 || after)) {
      const ix = c[i][0] - prev[0], iy = c[i][1] - prev[1], il = Math.hypot(ix, iy) || 1;
      const cos = (ix / il) * dx + (iy / il) * dy;
      if (cos >= SHARP_TURN_COS) pIn = pOut = at(dx, dy, r / cos);
      else {
        const ox = next[0] - c[i][0], oy = next[1] - c[i][1], ol = Math.hypot(ox, oy) || 1;
        pIn = at(ix / il, iy / il, r);
        pOut = at(ox / ol, oy / ol, r);
        joints.push(i);
      }
    }
    inL.push(pIn[0]); inR.push(pIn[1]); outL.push(pOut[0]); outR.push(pOut[1]);
  }

  /** an end: the arc beyond the body where it is round, else straight across; h away from the body */
  const endArc = (i: number, l: P2, r: P2, inward: P2): P2[] => {
    if (!(i === 0 ? ends.capStart : ends.capEnd) && !joints.includes(i)) return [l, r];
    const v = sub(r, l), len = Math.hypot(v[0], v[1]) || 1;
    let h: P2 = [-v[1] / len, v[0] / len];
    if (dot(h, inward) > 0) h = [-h[0], -h[1]];
    return capArc(c[i], halfAt(i) * latticePerMetre, l, r, h, h, capSides(halfAt(i), capTol));
  };

  const tris: P2[] = [], triSeg: number[] = [];
  for (let i = 0; i < c.length - 1; i++) {
    tris.push(outL[i], outR[i], inL[i + 1]); triSeg.push(i);
    tris.push(outR[i], inR[i + 1], inL[i + 1]); triSeg.push(i);
  }
  const lastSeg = Math.max(0, c.length - 2);
  const caps: [boolean, P2, number, number][] = [
    [ends.capStart, c[0], 0, halfAt(0)], [ends.capEnd, c[c.length - 1], lastSeg, halfAt(c.length - 1)],
    ...joints.map((i): [boolean, P2, number, number] => [true, c[i], Math.min(i, lastSeg), halfAt(i)]),
  ];
  for (const [ci, [cap, e, seg, h]] of caps.entries()) {
    if (!cap) continue;
    if (capTol !== undefined && ci < 2) {
      // a cover's end (its triangles are what it holds): the cap's half beyond the end only, fanned
      // over its outline's arc; a whole disc reached past the other end of a stretch shorter than it
      const arc = ci === 0 ? endArc(0, outL[0], outR[0], sub(c[1], c[0])) : endArc(c.length - 1, inL[c.length - 1], inR[c.length - 1], sub(c[c.length - 2], c[c.length - 1]));
      for (let k = 1; k < arc.length; k++) {
        if (Math.abs(cross(sub(arc[k - 1], e), sub(arc[k], e))) < 1e-18) continue;
        tris.push(e, arc[k - 1], arc[k]);
        triSeg.push(seg);
      }
      continue;
    }
    const r = h * latticePerMetre, n = capSides(h, capTol);
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 2 * Math.PI, a1 = ((k + 1) / n) * 2 * Math.PI;
      tris.push(e, [e[0] + Math.cos(a0) * r, e[1] + Math.sin(a0) * r], [e[0] + Math.cos(a1) * r, e[1] + Math.sin(a1) * r]);
      triSeg.push(seg);
    }
  }

  // the edge: each side along its segments, round the outer wedge of a sharp turn on the disc's
  // arc, through the crossing of the two segments' sides on the inner one
  const n = c.length;
  const dirOf = (i: number): P2 => { const v = sub(c[i + 1], c[i]), l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const outline: P2[][] = [];
  for (const [ins, outs, left] of [[inL, outL, true], [inR, outR, false]] as const) {
    let line: P2[] = [outs[0]];
    for (let j = 1; j < n; j++) {
      line.push(ins[j]);
      if (j === n - 1 || !joints.includes(j)) continue;
      // the left side is the outer one where the centre line turns right (towards the right side)
      const dIn = dirOf(j - 1), dOut = dirOf(j);
      if ((cross(dIn, dOut) < 0) === left || cross(dIn, dOut) === 0) {
        line.push(...capArc(c[j], halfAt(j) * latticePerMetre, ins[j], outs[j], dIn, [-dOut[0], -dOut[1]], capSides(halfAt(j), capTol)).slice(1));
        continue;
      }
      const p = crossing(line[line.length - 2], ins[j], outs[j], ins[j + 1]);
      if (p) line[line.length - 1] = p;
      else {
        outline.push(line);
        line = [outs[j]];
      }
    }
    outline.push(line);
  }
  outline.push(endArc(0, outL[0], outR[0], sub(c[1], c[0])), endArc(n - 1, inL[n - 1], inR[n - 1], sub(c[n - 2], c[n - 1])));

  const cuts: P2[][] = [], cutAt: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    cuts.push([inL[i], inR[i]]);
    cutAt.push(i);
    if (!same(inL[i], outL[i]) || !same(inR[i], outR[i])) {
      cuts.push([outL[i], outR[i]]);
      cutAt.push(i);
    }
  }
  return { tris, triSeg, outline, cuts, cutAt };
}

/** where roads meet: how their ribbons end, shift onto a fork and stop their paint */
export interface LineNetwork {
  /**
   * A branch of a fork starts with its outer edge on the trunk's (shifted away from the other branch
   * by half the difference of their widths) and eases onto its own line over FORK_TAPER_M (at most
   * half its length): the centre line shifted, with a vertex where the shift ends. Two branches as
   * wide as the trunk together lie side by side; wider ones overlap in the middle (lanes merging),
   * narrower ones leave a gap (a median beginning).
   */
  forkShift(line: OsmLine, pts: { c: P2; e: P2 }[]): { c: P2; e: P2 }[];
  /**
   * How a road's ribbon ends at each node: a dead end gets a round cap; a way continued by exactly
   * one other is mitred onto it (no cap: on a wide road a cap bulged past the edges at every angled
   * joint); at a junction or a fork it ends square, the roads there covering it. Minor roads joining
   * (driveways, parking aisles) do not count.
   */
  roadEnds(line: OsmLine): RibbonEnds;
  /**
   * How far from its end `at` a road's paint stops: at a junction, where roads of its priority or
   * higher (in its layer) meet it more than its own continuation does, past the widest of them; a
   * road split in two, or meeting only lower ones there, paints on through.
   */
  junctionGap(line: OsmLine, at: LonLat): number;
  /**
   * The width of the way that continues `line` at `at` (the one other road of its rank, layer and
   * one-way-ness ending there), or undefined where there is none or more than one
   */
  continuationWidth(line: OsmLine, at: LonLat): number | undefined;
}

/**
 * The road network of `lines` (the whole ways, not a tile's share of them); `enu` gives metres (x
 * east, z south), `toLattice` the tile's lattice point of a node
 */
export function lineNetwork(lines: ReadonlyArray<OsmLine>, enu: (lon: number, lat: number) => P2, toLattice: (p: LonLat) => P2, latticePerMetre: number): LineNetwork {
  /** the drawn roads at each OSM node (the whole ways, not this tile's share): at an end or passing through */
  const roadsAtNode = new Map<string, { line: OsmLine; end: boolean; rank: number; prio: number; layer: number; half: number }[]>();
  const nodeKey = (p: LonLat) => `${p[0]},${p[1]}`;
  for (const line of lines) {
    if (!line.tags.highway || isTunnel(line.tags)) continue;
    const style = classifyLine(line.tags);
    if (!style) continue;
    const entry = { rank: roadRank(line.tags), prio: roadPriority(line.tags, style.width), layer: roadLayer(line.tags), half: style.width / 2 };
    line.points.forEach((p, i) => {
      const k = nodeKey(p);
      let list = roadsAtNode.get(k);
      if (!list) roadsAtNode.set(k, list = []);
      list.push({ line, end: i === 0 || i === line.points.length - 1, ...entry });
    });
  }
  /**
   * A fork at `at`: three or more roads of standing end there (in `layer`; a driveway or a parking
   * aisle may join too) — a two-way road and one-way branches (a dual carriageway begins, a ramp
   * leaving with it), or one-way roads of which one flows the other way to all the rest (a road
   * splits in two or three, or they merge into one); the trunk and the branches, or undefined
   */
  const forkAt = (at: LonLat, layer: number): { width: number; trunk: OsmLine; branches: { line: OsmLine; half: number }[] } | undefined => {
    const here = (roadsAtNode.get(nodeKey(at)) ?? []).filter((o) => o.layer === layer);
    if (!here.length) return undefined;
    // roads below this neither count nor spoil the fork
    const floor = Math.min(Math.max(...here.map((o) => o.rank)), LINK_RANK);
    const big = here.filter((o) => o.rank >= floor);
    if (big.length < 3 || big.some((o) => !o.end)) return undefined;
    const twoWay = big.filter((o) => !isOnewayRoad(o.line.tags));
    let trunk: (typeof big)[number] | undefined;
    if (twoWay.length === 1) trunk = twoWay[0];
    else if (twoWay.length === 0) {
      // flowing into the node: it is the way's last point (its first, drawn against the flow)
      const into = (o: (typeof big)[number]) => (nodeKey(o.line.points[o.line.points.length - 1]) === nodeKey(at)) !== (o.line.tags.oneway === '-1');
      const ins = big.filter(into);
      trunk = ins.length === 1 ? ins[0] : ins.length === big.length - 1 ? big.find((o) => !into(o)) : undefined;
    }
    if (!trunk) return undefined;
    return { width: trunk.half * 2, trunk: trunk.line, branches: big.filter((o) => o !== trunk).map((o) => ({ line: o.line, half: o.half })) };
  };
  /** the unit direction (x, z) a way leaves the node `at` in, over its first FORK_PROBE_M or so */
  const leaving = (line: OsmLine, at: LonLat): [number, number] => {
    const pts = nodeKey(line.points[0]) === nodeKey(at) ? line.points : [...line.points].reverse();
    const [ax, az] = enu(pts[0][0], pts[0][1]);
    let bx = ax, bz = az;
    for (let i = 1; i < pts.length; i++) {
      [bx, bz] = enu(pts[i][0], pts[i][1]);
      if (Math.hypot(bx - ax, bz - az) >= FORK_PROBE_M) break;
    }
    const l = Math.hypot(bx - ax, bz - az) || 1;
    return [(bx - ax) / l, (bz - az) / l];
  };

  const forkShift = (line: OsmLine, pts: { c: P2; e: [number, number] }[]): { c: P2; e: [number, number] }[] => {
    if (!isOnewayRoad(line.tags)) return pts;
    const layer = roadLayer(line.tags);
    const lens = pts.slice(1).map((p, i) => Math.hypot(p.e[0] - pts[i].e[0], p.e[1] - pts[i].e[1]));
    const length = lens.reduce((a, b) => a + b, 0);
    const taper = Math.min(FORK_TAPER_M, length / 2 - 1);
    const first = line.points[0], last = line.points[line.points.length - 1];
    const f0 = forkAt(first, layer), f1 = forkAt(last, layer);
    if ((!f0 && !f1) || taper <= 1) return pts;
    /**
     * The shift there (+ right of the drawing direction): the branches lie across the trunk in the
     * order they leave the node, side by side, the outer ones' outer edges on the trunk's; whatever
     * their widths miss or exceed the trunk's by is shared out evenly between them (a median, or
     * lanes merging), none past the trunk's edges. Two branches: each with its outer edge on the trunk's.
     */
    const shiftAt = (f: NonNullable<ReturnType<typeof forkAt>>, at: LonLat, atStart: boolean): number => {
      const i = f.branches.findIndex((b) => b.line === line);
      if (i < 0) return 0; // this is the trunk
      // the axis: away from the trunk, its right normal (x east, z south)
      const [tx, tz] = leaving(f.trunk, at), nx = tz, nz = -tx;
      const across = f.branches
        .map((b) => { const [bx, bz] = leaving(b.line, at); return { b, s: Math.atan2(nx * bx + nz * bz, -tx * bx - tz * bz) }; })
        .sort((p, q) => p.s - q.s).map((p) => p.b);
      const k = across.indexOf(f.branches[i]);
      const total = across.reduce((a, b) => a + b.half * 2, 0);
      const gap = (f.width - total) / (across.length - 1);
      let offset = -f.width / 2 + k * gap + across[k].half;
      for (let j = 0; j < k; j++) offset += across[j].half * 2;
      // never past the trunk's edges: a branch wider than the trunk keeps to its axis
      const room = Math.max(0, f.width / 2 - across[k].half);
      offset = Math.max(-room, Math.min(room, offset));
      // right of the axis is right of the drawing direction where it leaves (the start), left where it arrives
      return atStart ? offset : -offset;
    };
    const o0 = f0 ? shiftAt(f0, first, true) : 0;
    const o1 = f1 ? shiftAt(f1, last, false) : 0;
    if (!o0 && !o1) return pts;
    // the vertices, with ones where the shifts end
    const out: { c: P2; e: [number, number]; d: number }[] = [];
    let at = 0;
    for (let i = 0; i < pts.length; i++) {
      out.push({ ...pts[i], d: at });
      if (i + 1 === pts.length) break;
      const next = at + lens[i];
      for (const d of [taper, length - taper]) {
        if (d <= at + 1e-3 || d >= next - 1e-3) continue;
        const f = (d - at) / (lens[i] || 1), a = pts[i], b = pts[i + 1];
        out.push({ c: [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f], e: [a.e[0] + (b.e[0] - a.e[0]) * f, a.e[1] + (b.e[1] - a.e[1]) * f], d });
      }
      at = next;
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((p, i) => {
      const shift = o0 * Math.max(0, 1 - p.d / taper) + o1 * Math.max(0, 1 - (length - p.d) / taper);
      if (shift === 0) return { c: p.c, e: p.e };
      const a = out[Math.max(0, i - 1)].e, b = out[Math.min(out.length - 1, i + 1)].e;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      // right of the drawing direction (x east, z south; the lattice's y runs south too)
      const nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
      return {
        e: [p.e[0] + nx * shift, p.e[1] + nz * shift],
        c: [p.c[0] + nx * shift * latticePerMetre, p.c[1] + nz * shift * latticePerMetre],
      };
    });
  };

  const junctionGap = (line: OsmLine, at: LonLat): number => {
    if (forkAt(at, roadLayer(line.tags))) return 0;
    const style = classifyLine(line.tags);
    const own = roadPriority(line.tags, style?.width ?? 0), layer = roadLayer(line.tags);
    let count = 0, widest = 0;
    for (const o of roadsAtNode.get(nodeKey(at)) ?? []) {
      if (o.line === line || o.layer !== layer || o.prio < own) continue;
      count += o.end ? 1 : 2;
      widest = Math.max(widest, o.half);
    }
    return count >= 2 ? widest + ROAD_MARK_END_M : 0;
  };

  const continuationWidth = (line: OsmLine, at: LonLat): number | undefined => {
    if (forkAt(at, roadLayer(line.tags))) return undefined;
    const own = roadRank(line.tags), layer = roadLayer(line.tags), oneway = isOnewayRoad(line.tags);
    let found: number | undefined, n = 0;
    for (const o of roadsAtNode.get(nodeKey(at)) ?? []) {
      if (o.line === line || o.rank !== own || o.layer !== layer) continue;
      if (!o.end || isOnewayRoad(o.line.tags) !== oneway) return undefined;
      found = o.half * 2;
      n++;
    }
    return n === 1 ? found : undefined;
  };

  const roadEnds = (line: OsmLine): RibbonEnds => {
    const own = roadRank(line.tags), layer = roadLayer(line.tags);
    const at = (p: LonLat): { dir?: P2; cap: boolean } => {
      const others = (roadsAtNode.get(nodeKey(p)) ?? []).filter((o) => o.line !== line && o.layer === layer);
      if (!others.length) return { cap: true };
      const floor = Math.min(own, LINK_RANK);
      const big = others.filter((o) => o.rank >= floor);
      if (forkAt(p, layer) || big.length !== 1 || !big[0].end) return { cap: !big.length };
      const o = big[0].line;
      const k = nodeKey(o.points[0]) === nodeKey(p) ? 1 : o.points.length - 2;
      const a = toLattice(p), b = toLattice(o.points[Math.max(0, Math.min(o.points.length - 1, k))]);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return l > 1e-9 ? { dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], cap: false } : { cap: true };
    };
    const s = at(line.points[0]), e = at(line.points[line.points.length - 1]);
    return { start: s.dir, end: e.dir, capStart: s.cap, capEnd: e.cap };
  };

  return { forkShift, roadEnds, junctionGap, continuationWidth };
}

/**
 * A painted road (WORLD_FS roadMarkAt) `half` metres wide each side, with paint `marks` (the
 * ROAD_MARK code): its centre line, half widths and per segment vertex attributes, nothing where it
 * is shorter than a millimetre; `breaks` the vertices where the paint is not linear across (u turns
 * at the middle, the width bends where a taper begins or ends). Where the way that continues it is
 * narrower (a lane fewer: the speed-change lanes at ramps), this one narrows to its width at the
 * shared node, linearly over ROAD_TAPER_M (at most half its length): the dropped lane closes on the
 * right, the lines measured from the left edge stay put. Vertex attributes:
 *   u   ROAD_U_BASE + metres from the start in the first half, -(ROAD_U_BASE + metres from the end)
 *       in the second (a vertex at the middle, so no triangle spans both)
 *   v   metres from the left edge (in the driving direction of a one-way road)
 *   edge.x  ROAD_EDGE - (start taper length / 2 m) · 64 - (end taper length / 2 m)
 *   edge.y  full width / 0.25 m + (start narrowing / 0.5 m) · 1024 + (end narrowing / 0.5 m) · 32768
 *   edge.z  the ROAD_MARK code + (start gap / 0.5 m) << 7 + (end gap / 0.5 m) << 13
 */
export function painted(line: OsmLine, src: { c: P2; e: P2 }[], half: number, marks: number, net: LineNetwork): { c: P2[]; half: number[]; segs: VertexAttr[]; breaks: number[] } {
  const q = (v: number, step: number, max: number) => Math.max(0, Math.min(max, Math.round(v / step)));
  const wq = q(half * 2, 0.25, 1023), width = wq * 0.25;
  const lens = src.slice(1).map((p, i) => Math.hypot(p.e[0] - src[i].e[0], p.e[1] - src[i].e[1]));
  const length = lens.reduce((a, b) => a + b, 0);
  if (length < 1e-3) return { c: [], half: [], segs: [], breaks: [] };
  const first = line.points[0], last = line.points[line.points.length - 1];
  const narrow = (at: LonLat) => {
    const w = net.continuationWidth(line, at);
    return w !== undefined && w < width ? q(width - w, 0.5, 31) : 0;
  };
  const n0 = narrow(first), n1 = narrow(last);
  const taperLen = (n: number) => (n ? q(Math.min(ROAD_TAPER_M, length / 2 - 1), 2, 63) : 0);
  const t0q = taperLen(n0), t1q = taperLen(n1);
  const t0 = t0q * 2, t1 = t1q * 2;
  const g0q = q(net.junctionGap(line, first), 0.5, 63), g1q = q(net.junctionGap(line, last), 0.5, 63);
  const widthAt = (d0: number): number => {
    let w = width;
    if (t0 > 0) w -= n0 * 0.5 * (1 - Math.min(1, Math.max(0, d0) / t0));
    if (t1 > 0) w -= n1 * 0.5 * (1 - Math.min(1, Math.max(0, length - d0) / t1));
    return w;
  };
  // vertices where the width bends and at the middle: each piece of the ribbon is linear in both
  const cuts = [t0, length / 2, length - t1].filter((d) => d > 1e-3 && d < length - 1e-3);
  const pts: { c: P2; e: [number, number]; d: number }[] = [];
  let at = 0;
  for (let i = 0; i < src.length; i++) {
    pts.push({ ...src[i], d: at });
    if (i + 1 === src.length) break;
    const next = at + lens[i];
    for (const d of cuts) {
      if (d <= at + 1e-3 || d >= next - 1e-3) continue;
      const f = (d - at) / (lens[i] || 1), a = src[i], b = src[i + 1];
      pts.push({ c: [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f], e: [a.e[0] + (b.e[0] - a.e[0]) * f, a.e[1] + (b.e[1] - a.e[1]) * f], d });
    }
    at = next;
  }
  pts.sort((a, b) => a.d - b.d);
  const flip = line.tags.oneway === '-1' ? -1 : 1;
  const ex = ROAD_EDGE - t0q * 64 - t1q, ey = wq + n0 * 1024 + n1 * 32768, ez = marks + (g0q << 7) + (g1q << 13);
  const segs: VertexAttr[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i].e, len = (pts[i + 1].d - pts[i].d) || 1;
    const dx = (pts[i + 1].e[0] - ax) / len, dz = (pts[i + 1].e[1] - az) / len, start = pts[i].d;
    const secondHalf = (pts[i].d + pts[i + 1].d) / 2 > length / 2;
    segs.push((p) => {
      const d0 = start + (p.x - ax) * dx + (p.z - az) * dz;
      const across = flip * ((p.z - az) * dx - (p.x - ax) * dz);
      const u = secondHalf ? -(ROAD_U_BASE + (length - d0)) : ROAD_U_BASE + d0;
      return [u, across + widthAt(d0) / 2, ex, ey, ez];
    });
  }
  const breaks = pts.flatMap((p, i) => (cuts.some((d) => Math.abs(p.d - d) <= 1e-3) ? [i] : []));
  return { c: pts.map((p) => p.c), half: pts.map((p) => widthAt(p.d) / 2), segs, breaks };
}

/** a railway track: each segment's vertices carry u along the line (metres from its start) and v across it */
export function trackSegs(pts: { e: P2 }[]): VertexAttr[] {
  const segs: VertexAttr[] = [];
  let u0 = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i].e, [bx, bz] = pts[i + 1].e;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const dx = (bx - ax) / len, dz = (bz - az) / len, start = u0;
    segs.push((p) => [start + (p.x - ax) * dx + (p.z - az) * dz, (p.z - az) * dx - (p.x - ax) * dz, TRACK_EDGE, 0, 0]);
    u0 += len;
  }
  return segs;
}
