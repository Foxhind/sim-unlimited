/**
 * The ground covers of a tile: what lies on the ground where — the asphalt and shoulders of the
 * roads, paths, the ballast and right-of-way strip of the railways, runways, water, aerodrome areas,
 * car parks, pitches and their paint, parks and fields — as shapes in the tile's lattice, the senior
 * first (COVER_RANK). A shape has its triangles (what it covers: `locate` finds the senior one at a
 * point) and its edge (what the surface TIN takes as fixed edges). Built from the whole ways and
 * areas, not the tile's share of them, so the tiles round a border agree. Tunnels and the lifted
 * stretches of the ways (coverLifted: the bridges and the approaches to them) cover nothing: they
 * run over it; a bridge the levels leave on the ground is a cover like any way. A way ends square
 * where it meets a lifted one at a joint (liftedJoints).
 */
import earcut from 'earcut';
import { colour, colourOf, RAMP, ROAD_EDGE_OFF, snowy, withGlow, rampGlowLevel, type RGB } from '../engine/palette';
import { DEFAULT_AREA_STYLES, filterColour, type AreaStyles } from './area-styles';
import { enuToLatLon, latLonToEnu, tileCenter, tileLattice, tileSizeMeters, type Tile } from './geodesy';
import type { LonLat, OsmArea, OsmLine, OsmPoint } from './osm-types';
import { isLitPitch as isLitPitchRing, pitchFrame } from './pitch-markings';
import { bandPieces, junctionPieces, shoulderAt, junctionShape, MAX_TRIM_M, trimCorners, unionOutline, type JunctionArm, type JunctionShape } from './junctions';
import { capSides, lineNetwork, painted, ribbonGeom, ringBand, ROUND_ENDS, trackSegs, type P2, type RibbonEnds, type RibbonGeom, type VertexAttr } from './ribbon-shapes';
import { buildRoadLevels, coverLifted, type Lifted } from './road-levels';
import { bridgeDecks, type RoadSurface } from './road-pull';
import { BALLAST_RAMP, beltFilter, classifyArea, classifyLine, isBridge, isLitRoad, isOpenCarPark, isTunnel, landZone, LINK_RANK, roadRank, LIT_ROAD_GLOW, PITCH_GLOW, RAIL_ZONE_M, RAIL_ZONE_RAMP, isOnewayRoad, roadLayer, roadPriority, SHOULDER_RAMP, tieBreak, TOWN_ZONES, UNLIT_ROAD_GLOW, waterwayWidth, type AreaStyle } from './way-styles';

export type CoverKind = 'runway' | 'ballast' | 'zebra' | 'carriageway' | 'shoulder' | 'path' | 'water' | 'railZone' | 'aeroArea' | 'carPark' | 'pitchPaint' | 'pitch' | 'pool' | 'area' | 'zone' | 'belt';

/**
 * seniority of the covers: the lower lies over the higher where they overlap. A path over a road's
 * shoulder (a footway reaches the kerb); a pedestrian crossing's paint (an overlay) over the carriageway.
 */
export const COVER_RANK: Record<CoverKind, number> = {
  runway: 1, ballast: 2, zebra: 2.5, carriageway: 3, path: 3.5, shoulder: 4, water: 6, railZone: 7, aeroArea: 8, carPark: 9, pitchPaint: 9.5, pitch: 10, pool: 10.5, area: 11, zone: 12, belt: 13,
};

export interface CoverShape {
  kind: CoverKind;
  /** the way, area or point it comes from */
  source: OsmLine | OsmArea | OsmPoint;
  /** roadPriority of a carriageway or shoulder (the senior of two roads lies over the junior); 0 else */
  prio: number;
  /** its triangles, six numbers each (lattice x, y of three corners) */
  tris: Float64Array;
  /**
   * its edge as polylines (lattice): a ribbon's sides and ends (ribbonGeom), with its cuts across at
   * each inner vertex for a carriageway, ballast or runway; an area's rings, closed
   */
  outline: P2[][];
  /**
   * a painted carriageway's or a ballast's vertex attributes: per segment of its centre line, and
   * the segment (index into `segs`) of the ribbon triangle at a lattice point (the nearest triangle's
   * where none holds it)
   */
  attr?: { segs: VertexAttr[]; segAt(x: number, y: number): number };
  /** a junction's surface or its shoulders (junctions.ts), not a way's ribbon: the same token for both */
  junction?: object;
  /**
   * drawn over the surface's faces, never an edge of them nor what holds a point (locate passes it
   * over): a junction's shoulders round its kerbs, which would take the vertex budget of whole roads;
   * a pedestrian crossing's stripes
   */
  overlay?: boolean;
  /** a zebra's colour (its stripes are white or yellow) */
  paint?: number;
}

export interface GroundCover {
  /** the shapes, the senior first */
  shapes: CoverShape[];
  /**
   * the index of the senior shape with a triangle holding lattice point (x, y), or −1 (the bare
   * ground); the shapes `skip` returns true for are passed over (the surface's dropped ribbons)
   */
  locate(x: number, y: number, skip?: (shape: number) => boolean): number;
  /**
   * The pieces of lattice polyline `line` outside every shape before `before` (in the shapes'
   * order, the seniors of shape `before`) that `over` returns true for (any without it), their
   * edges counting as inside: a piece ends exactly where the line enters one, on its edge; the
   * line's own points are kept as they are
   */
  outside(line: ReadonlyArray<P2>, before: number, over?: (shape: number) => boolean): P2[][];
  /** the nodes (`lon,lat`) of the junctions' surfaces: a road's paint runs on to its trim there, no gap (painted) */
  junctionNodes: ReadonlySet<string>;
  /** the traffic lights of the junctions mapped with them (placeSignals) */
  signals: ReadonlyArray<JunctionSignal>;
  /** how far from a junction's node (`at`) its junction takes a road ending there, metres, or undefined (painted holdAt) */
  junctionHold(line: OsmLine, at: LonLat): number | undefined;
}

/** a traffic light at a junction's approach: its post (lattice), the way its head faces (lattice, unit), its light */
export interface JunctionSignal { at: P2; facing: P2; green: boolean }

/** a floodlit pitch: its whole outline (the shape's source) is big enough (pitch-markings isLitPitch, as the mesh) */
const isLitPitch = (source: CoverShape['source']): boolean =>
  'rings' in source && source.tags.leisure === 'pitch' && isLitPitchRing(source.rings[0] ?? []);

/**
 * The colour a cover is drawn with (what the ribbons and areas of osm-mesher give it today): glow
 * bits included; `imagery` the imagery colour of the face under it (none: a material ramp, or no
 * imagery), which an area with a filter draws through the filter
 */
export function coverRamp(shape: CoverShape, styles: AreaStyles, imagery: RGB | undefined): number {
  const tags = shape.source.tags;
  const lit = isLitRoad(tags);
  switch (shape.kind) {
    case 'shoulder': return lit ? withGlow(SHOULDER_RAMP, LIT_ROAD_GLOW) : SHOULDER_RAMP;
    case 'path':
    case 'carriageway': {
      const ramp = classifyLine(tags)?.ramp ?? RAMP.ASPHALT;
      return lit ? withGlow(ramp, LIT_ROAD_GLOW) : tags.highway ? withGlow(ramp, UNLIT_ROAD_GLOW) : ramp;
    }
    case 'ballast': return BALLAST_RAMP;
    case 'zebra': return shape.paint ?? ZEBRA_WHITE;
    case 'railZone': return RAIL_ZONE_RAMP;
    case 'runway':
    case 'aeroArea': return RAMP.ASPHALT;
    case 'carPark': return withGlow(RAMP.ASPHALT, UNLIT_ROAD_GLOW);
    case 'pitchPaint': return isLitPitch(shape.source) ? withGlow(RAMP.SNOW, PITCH_GLOW) : RAMP.SNOW;
    case 'water': return RAMP.WATER;
    case 'pitch':
    case 'pool':
    case 'area':
    case 'zone': {
      const style = classifyArea(tags, styles);
      if (!style) return RAMP.GRASS;
      const ramp = shape.kind === 'pitch' && isLitPitch(shape.source) ? withGlow(style.ramp, PITCH_GLOW) : style.ramp;
      return style.filter && imagery ? withGlow(snowy(colourOf(filterColour(imagery, style.filter))), rampGlowLevel(ramp)) : ramp;
    }
    case 'belt': {
      // the ground's own colour halfway to the area's; without imagery the area's ramp (terrain-mesher keeps the ground's)
      const style = classifyArea(tags, styles), filter = beltFilter(tags, styles);
      const ramp = style?.ramp ?? RAMP.GRASS;
      return filter && imagery ? withGlow(snowy(colourOf(filterColour(imagery, filter))), rampGlowLevel(ramp)) : ramp;
    }
  }
}

/**
 * An area's transition belt reaches this far out of it, metres: a ribbon this wide each side of its
 * rings, whose inner half the area itself covers (it is senior)
 */
export const BELT_M = 20;

/** a pedestrian crossing's stripes, white and yellow in turn (Russian GOST 52289 marking 1.14.1) */
export const ZEBRA_WHITE = colour(236, 236, 230);
export const ZEBRA_YELLOW = colour(236, 196, 44);
/** a zebra's stripes: this wide across the road with this much asphalt between, this long along it, metres */
const ZEBRA_STRIPE_M = 0.5;
const ZEBRA_GAP_M = 0.4;
const ZEBRA_LENGTH_M = 4;

/** lift is probed along a way at least this often, metres */
const LIFT_PROBE_M = 10;
/** where a way starts or stops being lifted, found to within this, metres */
const LIFT_SNAP_M = 0.5;
/** a cover's round caps and joint discs keep their chords this close to the circle, metres (ribbonGeom capTol) */
const CAP_TOL_M = 0.05;
/**
 * a cover's edge loses the points it runs straight through to this, metres; a road its cuts across
 * where its paint stays linear to this past them (the vertex attributes of a face across one)
 */
const THIN_M = 0.02;
/** a road is cut across where its centre line turns by this much or more, radians (1°) */
const CUT_TURN = Math.PI / 180;
/** pitch paint: strips this wide each side of a marking line, metres */
const PAINT_HALF_M = 0.06;
/** a helipad point: a square this far each way round it, metres */
const HELIPAD_HALF_M = 8;
/** at most this many lookup cells along a side of the tile */
const MAX_CELLS = 256;
/** a point this close to a triangle's edge (lattice cells²: edge length times distance) is on it */
const ON_EDGE = 1e-10;
/** a triangle's cells reach this far past it (lattice cells): a point on its edge finds it in either cell */
const CELL_PAD = 1e-9;
/** a line this close to a triangle's edge (lattice cells) runs along it: inside (GroundCover.outside) */
const ALONG_EDGE = 1e-7;
/**
 * GroundCover.outside: stretches of a line inside the shapes closer together than this (lattice
 * cells, about 3 mm) are one, and a stretch inside them shorter than ALONG_EDGE is none (a corner touched)
 */
const MERGE_GAP = 1e-4;

const SQUARE_ENDS: RibbonEnds = { capStart: false, capEnd: false };
/** a junction's road straight through leaves it in directions at least this far apart (cosine; 120°), each over its first THROUGH_PROBE_M */
const THROUGH_MAX_COS = -0.5;
const THROUGH_PROBE_M = 10;
/** junction nodes closer along a way than their widest roads' halves and this are one junction, metres */
const CLUSTER_PAD_M = 4;
/** two roads at a junction of several nodes cross where their directions are further than this from parallel (cosine; 45°) */
const CROSS_COS = Math.SQRT1_2;
/** a traffic light's post stands this far off the carriageway's edge, metres */
const SIGNAL_SETBACK_M = 0.8;

/** whether triangle `o` of `t` (six numbers each) holds (x, y), its edges included */
function holds(t: Float64Array, o: number, x: number, y: number): boolean {
  const ax = t[o], ay = t[o + 1], bx = t[o + 2], by = t[o + 3], cx = t[o + 4], cy = t[o + 5];
  const turn = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (turn === 0) return false;
  const s = turn > 0 ? 1 : -1;
  return s * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) >= -ON_EDGE
    && s * ((cx - bx) * (y - by) - (cy - by) * (x - bx)) >= -ON_EDGE
    && s * ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) >= -ON_EDGE;
}

/**
 * The share [t0, t1] of segment a + t·(dx, dy), t in [0, 1], inside triangle `o` of `t` with its
 * edges (ALONG_EDGE wide), or undefined
 */
function within(t: Float64Array, o: number, ax: number, ay: number, dx: number, dy: number): [number, number] | undefined {
  const turn = (t[o + 2] - t[o]) * (t[o + 5] - t[o + 1]) - (t[o + 4] - t[o]) * (t[o + 3] - t[o + 1]);
  if (turn === 0) return undefined;
  const s = turn > 0 ? 1 : -1;
  let t0 = 0, t1 = 1;
  for (let e = 0; e < 3; e++) {
    const px = t[o + 2 * e], py = t[o + 2 * e + 1], ex = t[o + (2 * e + 2) % 6] - px, ey = t[o + (2 * e + 3) % 6] - py;
    // on the inner side of the edge (to ALONG_EDGE): f0 + g·t ≥ 0
    const f0 = s * (ex * (ay - py) - ey * (ax - px)) + ALONG_EDGE * Math.hypot(ex, ey), g = s * (ex * dy - ey * dx);
    if (g === 0) {
      if (f0 < 0) return undefined;
    } else if (g > 0) t0 = Math.max(t0, -f0 / g);
    else t1 = Math.min(t1, -f0 / g);
    if (t1 <= t0) return undefined;
  }
  return [t0, t1];
}

/** distance from p to segment a–b */
function toSegment(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * f, p[1] - a[1] - dy * f);
}

/**
 * Polyline `line` without the points it runs straight through: each point dropped whose
 * neighbours kept round it leave every dropped one within `tol` (lattice cells) of the segment
 * between them, but its ends and the points in `keep`
 */
export function thinLine(line: P2[], tol: number, keep?: ReadonlySet<P2>): P2[] {
  if (line.length <= 2) return line;
  const out: P2[] = [line[0]];
  let a = 0;
  for (let j = 2; j < line.length; j++) {
    let straight = !keep?.has(line[j - 1]);
    for (let k = a + 1; straight && k < j; k++) straight = toSegment(line[k], line[a], line[j]) <= tol;
    if (straight) continue;
    out.push(line[j - 1]);
    a = j - 1;
  }
  out.push(line[line.length - 1]);
  return out;
}

/** squared distance from (x, y) to triangle `o` of `t` (0 inside) */
function distance2(t: Float64Array, o: number, x: number, y: number): number {
  if (holds(t, o, x, y)) return 0;
  let best = Infinity;
  for (let e = 0; e < 3; e++) {
    const ax = t[o + 2 * e], ay = t[o + 2 * e + 1], bx = t[o + (2 * e + 2) % 6], by = t[o + (2 * e + 3) % 6];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, (x - ax - dx * f) ** 2 + (y - ay - dy * f) ** 2);
  }
  return best;
}

/** lengths along polyline c from its start, at each vertex */
export function cumulative(c: P2[]): number[] {
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
  return cum;
}

/**
 * The part of polyline c between lengths s0 and s1 along it (cum), half widths interpolated at its
 * ends; `first` the segment of c its first segment lies on (its k-th lies on c's first + k)
 */
function slice(c: P2[], cum: number[], half: number | number[], s0: number, s1: number): { c: P2[]; half: number | number[]; first: number } {
  const n = c.length;
  if (s0 <= 0 && s1 >= cum[n - 1]) return { c, half, first: 0 };
  let i0 = 0;
  while (i0 < n - 2 && cum[i0 + 1] <= s0) i0++;
  let i1 = n - 2;
  while (i1 > i0 && cum[i1] >= s1) i1--;
  const at = (i: number, s: number): { p: P2; h: number } => {
    const len = cum[i + 1] - cum[i], t = len > 0 ? Math.max(0, Math.min(1, (s - cum[i]) / len)) : 0;
    const h = typeof half === 'number' ? half : half[i] + (half[i + 1] - half[i]) * t;
    return { p: [c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t], h };
  };
  const a = at(i0, s0), b = at(i1, s1);
  return {
    c: [a.p, ...c.slice(i0 + 1, i1 + 1), b.p],
    half: typeof half === 'number' ? half : [a.h, ...half.slice(i0 + 1, i1 + 1), b.h],
    first: i0,
  };
}

/**
 * Whether a ribbon along centre line `c` (lattice), `half` metres wide each side (per vertex, or one
 * for all), needs its cut across at inner vertex i: a face across the vertex takes the vertex
 * attributes of one segment at all three corners, so the cut stays where the line turns by
 * CUT_TURN or more, or the other segment strays more than THIN_M from the line of this one (to its
 * far end), or its width bends by more than THIN_M there
 */
export function cutNeeded(c: ReadonlyArray<P2>, half: number | number[], i: number, latticePerMetre: number): boolean {
  const ax = c[i][0] - c[i - 1][0], ay = c[i][1] - c[i - 1][1], bx = c[i + 1][0] - c[i][0], by = c[i + 1][1] - c[i][1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return true;
  const sin = Math.abs(ax * by - ay * bx) / (la * lb), cos = (ax * bx + ay * by) / (la * lb);
  const far = Math.max(la, lb) / latticePerMetre;
  if (Math.atan2(sin, cos) >= CUT_TURN || far * sin > THIN_M) return true;
  if (typeof half === 'number') return false;
  const sa = (half[i] - half[i - 1]) / (la / latticePerMetre), sb = (half[i + 1] - half[i]) / (lb / latticePerMetre);
  return Math.abs(sa - sb) * far > THIN_M;
}

/**
 * The stretches of a way on the ground, metres from its start (along its points, `e` in ENU), and
 * its length: probed every LIFT_PROBE_M, each flip found to LIFT_SNAP_M and kept to the ground's side
 */
export function groundRuns(line: OsmLine, e: P2[], lifted: Lifted): { runs: [number, number][]; len: number } {
  let len = 0;
  for (let i = 1; i < e.length; i++) len += Math.hypot(e[i][0] - e[i - 1][0], e[i][1] - e[i - 1][1]);
  const onGround = (d: number) => !lifted(line, d);
  const runs: [number, number][] = [];
  const steps = Math.max(1, Math.ceil(len / LIFT_PROBE_M));
  // the probes: every LIFT_PROBE_M, and where the lift says to look (a bridge's deck shorter than that)
  const at = Array.from({ length: steps }, (_, k) => (len * (k + 1)) / steps);
  const more = lifted.probes?.(line).filter((d) => d > 0 && d < len);
  if (more?.length) {
    at.push(...more);
    at.sort((a, b) => a - b);
  }
  let prev = 0, was = onGround(0), start: number | undefined = was ? 0 : undefined;
  for (const d of at) {
    const is = onGround(d);
    if (is !== was) {
      // the flip between the two probes, to LIFT_SNAP_M: the cover keeps to the ground's side of it
      let lo = prev, hi = d;
      while (hi - lo > LIFT_SNAP_M) {
        const m = (lo + hi) / 2;
        if (onGround(m) === was) lo = m;
        else hi = m;
      }
      if (was) runs.push([start!, lo]);
      start = was ? undefined : hi;
    }
    prev = d;
    was = is;
  }
  if (start !== undefined) runs.push([start, len]);
  return { runs: runs.filter(([a, b]) => b - a > 1e-3), len };
}

/**
 * The lifted stretches of a way: what groundRuns leaves of it (the cover ends where they begin, so
 * the two meet exactly), and its length
 */
export function liftedRuns(line: OsmLine, e: P2[], lifted: Lifted): { runs: [number, number][]; len: number } {
  const { runs: ground, len } = groundRuns(line, e, lifted);
  const runs: [number, number][] = [];
  let at = 0;
  for (const [a, b] of ground) {
    if (a > at) runs.push([at, a]);
    at = b;
  }
  if (at < len) runs.push([at, len]);
  return { runs: runs.filter(([a, b]) => b - a > 1e-3), len };
}

/**
 * Stretch [d0, d1] (metres along a way `len` long) of a ribbon along it: its centre line cl at the
 * same share of its length (cum: cumulative(cl)), half widths interpolated at its ends, `first` the
 * segment of cl its first segment lies on; and its ends — the ribbon's own at the way's ends, square
 * (no cap, no mitre) where a stretch begins or ends inside the way
 */
export function runPart(cl: P2[], cum: number[], half: number | number[], ends: RibbonEnds, d0: number, d1: number, len: number): { c: P2[]; half: number | number[]; first: number; ends: RibbonEnds } {
  const total = cum[cum.length - 1];
  const part = slice(cl, cum, half, (d0 / len) * total, (d1 / len) * total);
  const atStart = d0 <= 0, atEnd = d1 >= len;
  return {
    ...part,
    ends: { start: atStart ? ends.start : undefined, capStart: atStart && ends.capStart, end: atEnd ? ends.end : undefined, capEnd: atEnd && ends.capEnd },
  };
}

/** a node of the ways by its lon/lat */
const nodeKey = (p: LonLat): string => `${p[0]},${p[1]}`;
/** ways that can continue one another: the roads, the railways, the waterways, the aerodrome's */
const family = (tags: Record<string, string>): string => (tags.highway ? 'highway' : tags.railway ? 'railway' : tags.waterway ? 'waterway' : 'aeroway');

/**
 * How the ways end where a lifted run ends (`lifted`, metres along a way's points in ENU): a lifted
 * way ending at a node where exactly one other way of its kind is (roads below its rank and a link's
 * not counting, as roadEnds), and that one ends there too, is its single continuation whatever their
 * layers: both are mitred onto each other there (the bisector cut ribbonGeom makes of `start`/`end`),
 * the same for the cover and the ribbon, so neither a gap nor an overlap opens between the deck and
 * its approach. Where it has no single continuation the lifted way ends square; every other way, and
 * every end at a node no lifted run ends at, keeps its own ends (`ends`). Returns the ends of a way.
 */
export function liftedJoints(
  lines: ReadonlyArray<OsmLine>, enu: (lon: number, lat: number) => P2, toLattice: (p: LonLat) => P2, lifted: (line: OsmLine, d: number) => boolean,
): (line: OsmLine, ends: RibbonEnds) => RibbonEnds {
  const drawn = lines.filter((l) => l.points.length >= 2 && !isTunnel(l.tags) && classifyLine(l.tags));
  const atNode = new Map<string, { line: OsmLine; end: boolean }[]>();
  for (const line of drawn) {
    line.points.forEach((p, i) => {
      const k = nodeKey(p);
      let list = atNode.get(k);
      if (!list) atNode.set(k, list = []);
      list.push({ line, end: i === 0 || i === line.points.length - 1 });
    });
  }
  /** per way and end (0 its first point, 1 its last): the lattice direction it is mitred along, or null for square */
  const mitre = new Map<OsmLine, [P2 | null | undefined, P2 | null | undefined]>();
  const set = (line: OsmLine, at: 0 | 1, dir: P2 | null, strong: boolean): void => {
    const m = mitre.get(line) ?? [undefined, undefined];
    if (strong || m[at] === undefined) m[at] = dir;
    mitre.set(line, m);
  };
  /** the unit lattice vector from `line`'s end `at` towards its next point */
  const inward = (line: OsmLine, at: 0 | 1): P2 | null => {
    const n = line.points.length, a = toLattice(line.points[at ? n - 1 : 0]), b = toLattice(line.points[at ? n - 2 : 1]);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return l > 1e-9 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
  };
  for (const line of drawn) {
    let len = 0;
    for (let i = 1; i < line.points.length; i++) {
      const [ax, az] = enu(line.points[i - 1][0], line.points[i - 1][1]), [bx, bz] = enu(line.points[i][0], line.points[i][1]);
      len += Math.hypot(bx - ax, bz - az);
    }
    for (const at of [0, 1] as const) {
      if (!lifted(line, at ? len : 0)) continue;
      const p = line.points[at ? line.points.length - 1 : 0];
      const kind = family(line.tags), floor = line.tags.highway ? Math.min(roadRank(line.tags), LINK_RANK) : -Infinity;
      const others = (atNode.get(nodeKey(p)) ?? []).filter((o) =>
        o.line !== line && family(o.line.tags) === kind && (!o.line.tags.highway || roadRank(o.line.tags) >= floor));
      if (others.length === 1 && others[0].end) {
        const o = others[0].line, oAt: 0 | 1 = nodeKey(o.points[0]) === nodeKey(p) ? 0 : 1;
        set(line, at, inward(o, oAt), true);
        set(o, oAt, inward(line, at), true);
      } else set(line, at, null, false);
    }
  }
  return (line, ends) => {
    const m = mitre.get(line);
    if (!m) return ends;
    const [s, e] = m;
    return {
      start: s === undefined ? ends.start : s ?? undefined, capStart: s === undefined && ends.capStart,
      end: e === undefined ? ends.end : e ?? undefined, capEnd: e === undefined && ends.capEnd,
    };
  };
}

/** the kind of cover of an area classifyArea draws, in classifyArea's order */
function areaKind(tags: Record<string, string>, style: AreaStyle): CoverKind {
  if (style.water) return 'water';
  const a = tags.aeroway;
  if (a === 'runway' || a === 'taxiway' || a === 'apron' || a === 'helipad') return 'aeroArea';
  if (tags.amenity === 'parking' && isOpenCarPark(tags)) return 'carPark';
  const n = tags.natural;
  if (n === 'scrub' || n === 'beach' || n === 'bare_rock' || n === 'scree' || tags.landuse === 'farmland') return 'area';
  if (tags.leisure === 'swimming_pool') return 'pool';
  if (tags.leisure === 'pitch') return 'pitch';
  // a town's zone: the ground under its parks, pitches, pools and car parks, whatever order they came in
  const zone = landZone(tags);
  return zone && TOWN_ZONES.has(zone) ? 'zone' : 'area';
}

/**
 * The ground covers of `tile` on its lattice of `grid` cells a side, from the whole ways, areas and
 * points round it; `roads` (the tile's roads with their heights) decide which stretches are lifted
 * as the mesh lifts them (coverLifted). Whatever lies wholly outside the tile gives no shape.
 * `belts` false leaves the areas' transition belts out.
 */
export function buildGroundCover(tile: Tile, grid: number, data: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }, roads?: RoadSurface, belts = true): GroundCover {
  const center = tileCenter(tile);
  /** ENU metres (x east, z south) about the tile's centre, as the OSM mesh has them */
  const enu = (lon: number, lat: number): P2 => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  /** the tile's lattice point of a lon/lat: the OSM mesh's own */
  const toLattice = tileLattice(tile, grid);
  const enuToLattice = ([x, z]: P2): P2 => {
    const ll = enuToLatLon(center, x, -z, 0);
    return toLattice([ll.lon, ll.lat]);
  };
  /** lattice units per metre: Mercator is conformal, so the same both ways inside the tile */
  const latticePerMetre = grid / tileSizeMeters(tile);
  const net = lineNetwork(data.lines, enu, toLattice, latticePerMetre);
  const lifted = coverLifted(roads, buildRoadLevels(data.lines, data.areas, ([lon, lat]) => enu(lon, lat)), roads && bridgeDecks(tile, grid, roads, ([lon, lat]) => enu(lon, lat)));
  /**
   * the nodes of the network's bridges and tunnels (a culvert): a river's bed stops square at an end
   * there (road-pull), and so does its water
   */
  const structureNodes = new Set<string>();
  for (const w of roads?.net.ways ?? []) if (w.bridge || w.tunnel) for (const p of w.line.points) structureNodes.add(`${p[0]},${p[1]}`);
  /**
   * the ends of the network's bridges that are low (a cover there, not a deck: road-pull
   * bridgeDecks): a road ending there ends square, as its bed does (a round end reached on under
   * the bridge, past where its deck lifts, down the bank there)
   */
  const lowEnds = new Set<string>();
  for (const w of roads?.net.ways ?? []) {
    if (!w.bridge || w.line.points.length < 2) continue;
    const pts = w.line.points;
    let len = 0;
    for (let i = 1; i < pts.length; i++) { const [ax, az] = enu(pts[i - 1][0], pts[i - 1][1]), [bx, bz] = enu(pts[i][0], pts[i][1]); len += Math.hypot(bx - ax, bz - az); }
    if (!lifted(w.line, 0)) lowEnds.add(`${pts[0][0]},${pts[0][1]}`);
    if (!lifted(w.line, len)) lowEnds.add(`${pts[pts.length - 1][0]},${pts[pts.length - 1][1]}`);
  }
  const joints = liftedJoints(data.lines, enu, toLattice, lifted);
  /**
   * the nodes a way's lifted run ends at (a bridge ending on the middle of the bank road), by their
   * lattice point: a way through one keeps its cut and its edges' points there, so the mesh's deck
   * gives way to the junction's faces as before (osm-mesher onJunction, face by face)
   */
  const liftedEnds = new Set<string>();
  const latticeKey = (p: P2) => `${p[0]},${p[1]}`;
  for (const line of data.lines) {
    if (line.points.length < 2 || isTunnel(line.tags) || !classifyLine(line.tags)) continue;
    let len = 0;
    for (let i = 1; i < line.points.length; i++) {
      const [ax, az] = enu(line.points[i - 1][0], line.points[i - 1][1]), [bx, bz] = enu(line.points[i][0], line.points[i][1]);
      len += Math.hypot(bx - ax, bz - az);
    }
    if (lifted(line, 0)) liftedEnds.add(latticeKey(toLattice(line.points[0])));
    if (lifted(line, len)) liftedEnds.add(latticeKey(toLattice(line.points[line.points.length - 1])));
  }

  /** a road's centre line as its ribbons have it (a fork's branch shifted onto the trunk), ENU and lattice */
  const drawnCache = new Map<OsmLine, { c: P2; e: P2 }[] | null>();
  const drawnPts = (line: OsmLine): { c: P2; e: P2 }[] | undefined => {
    let pts = drawnCache.get(line);
    if (pts === undefined) {
      const e = line.points.map((ll) => enu(ll[0], ll[1]));
      let p: { c: P2; e: P2 }[] | null = line.points.map((ll, i) => ({ c: toLattice(ll), e: e[i] }))
        .filter((q, i, a) => i === 0 || q.c[0] !== a[i - 1].c[0] || q.c[1] !== a[i - 1].c[1]);
      if (p.length < 2) p = null;
      else if (line.tags.highway) p = net.forkShift(line, p);
      drawnCache.set(line, pts = p);
    }
    return pts ?? undefined;
  };
  /** a way's length along its points (ENU metres) and at each of them */
  const wayLength = (line: OsmLine): number[] => {
    const at = [0];
    for (let i = 1; i < line.points.length; i++) {
      const [ax, az] = enu(line.points[i - 1][0], line.points[i - 1][1]), [bx, bz] = enu(line.points[i][0], line.points[i][1]);
      at.push(at[i - 1] + Math.hypot(bx - ax, bz - az));
    }
    return at;
  };

  /**
   * The junctions (junctions.ts): every node where three or more carriageways of one layer meet
   * (a way passing through it counts twice) on the ground, but a fork (forkShift lays its branches
   * into the trunk). Nodes closer together along a way than their widest roads reach (the crossings
   * of a dual carriageway) are one junction, the ways between them its own. Each arm leaving it is
   * trimmed back and the junction's surface fills between their ends; a road that goes straight
   * through a node, senior to every other road there or meeting at most one of its own standing,
   * keeps its paint across the surface but for its edge line on the sides the others join.
   */
  interface JArm { line: OsmLine; out: 1 | -1; node: string; dNode: number; trim: number; dTrim: number; arm: JunctionArm; next?: { node: string; d: number }; corners?: [P2, P2] }
  interface Junction { at: LonLat; nodes: P2[]; keys: string[]; arms: JArm[]; inner: { line: OsmLine; c: P2[] }[]; shape: JunctionShape; through: Map<OsmLine, number> }
  const junctions: Junction[] = [];
  /** per way, the stretches the junctions take from it (metres along it) and the arm ends there */
  const trimsOf = new Map<OsmLine, { d0: number; d1: number; inner?: boolean }[]>();
  const cutAt = new Map<OsmLine, Map<number, { arm: JArm; start: boolean }>>();
  /** the nodes of the junctions: a road's paint runs to its trim there, no gap */
  const junctionNodes = new Set<string>();
  /** per way and junction node (`lon,lat|`), how far from the node the junction takes the way, metres */
  const taken = new Map<OsmLine, Map<string, number>>();
  const hold = (line: OsmLine, at: LonLat, d: number) => {
    let m = taken.get(line);
    if (!m) taken.set(line, m = new Map());
    m.set(nodeKey(at), Math.max(m.get(nodeKey(at)) ?? 0, d));
  };
  /** the nodes mapped as traffic lights (highway=traffic_signals), and the lights the junctions there get */
  const signalNodes = new Set(data.points.filter((p) => p.tags.highway === 'traffic_signals').map((p) => nodeKey(p.at)));
  const signals: JunctionSignal[] = [];
  const pendingSignals: { tries: P2[]; facing: P2; green: boolean }[] = [];
  {
    const carriageway = (l: OsmLine) => { const st = l.tags.highway ? classifyLine(l.tags) : undefined; return !!st && !st.path && !isTunnel(l.tags) && l.points.length >= 2; };
    const atNode = new Map<string, { line: OsmLine; i: number }[]>();
    for (const line of data.lines) {
      if (!carriageway(line)) continue;
      line.points.forEach((p, i) => {
        const k = nodeKey(p);
        const list = atNode.get(k);
        if (list) list.push({ line, i }); else atNode.set(k, [{ line, i }]);
      });
    }
    const lengths = new Map<OsmLine, number[]>();
    const lengthOf = (l: OsmLine) => { let v = lengths.get(l); if (!v) lengths.set(l, v = wayLength(l)); return v; };
    const nodeId = (k: string, layer: number) => `${k}|${layer}`;
    // the candidate nodes, each with its arms
    const candidates = new Set<string>();
    for (const [k, here] of atNode) {
      if (here.length < 2) continue;
      for (const layer of new Set(here.map((o) => roadLayer(o.line.tags)))) {
        const at = here[0].line.points[here[0].i];
        // three roads of standing (no driveway, track or yard counts), one of them painted
        const big = (o: { line: OsmLine; i: number }) => { const st = classifyLine(o.line.tags)!; return roadLayer(o.line.tags) === layer && !st.minor; };
        const standing = here.filter(big).reduce((n, o) => n + (o.i === 0 || o.i === o.line.points.length - 1 ? 1 : 2), 0);
        const paint = here.some((o) => big(o) && classifyLine(o.line.tags)!.marks);
        if (standing >= 3 && paint && !net.isFork(at, layer)) candidates.add(nodeId(k, layer));
      }
    }
    const nodes = new Map<string, { at: LonLat; p: P2; layer: number; arms: JArm[] }>();
    for (const id of candidates) {
      const [k, ls] = id.split('|'), layer = Number(ls), here = atNode.get(k)!;
      const at = here[0].line.points[here[0].i], node = toLattice(at), arms: JArm[] = [];
      let ok = true;
      for (const { line, i } of here) {
        if (roadLayer(line.tags) !== layer) continue;
        const pts = drawnPts(line), style = classifyLine(line.tags)!;
        const dAt = lengthOf(line), len = dAt[dAt.length - 1];
        if (!pts || len <= 0 || lifted(line, dAt[i])) { ok = false; break; }
        const c = pts.map((p) => p.c), cum = cumulative(c), total = cum[cum.length - 1];
        // the node on the drawn line (a fork's shift elsewhere on the way leaves it where it is)
        const iv = c.findIndex((p) => Math.abs(p[0] - node[0]) < 1e-7 && Math.abs(p[1] - node[1]) < 1e-7);
        if (iv < 0 || total <= 0) { ok = false; break; }
        for (const out of [1, -1] as const) {
          if (out === 1 ? i === line.points.length - 1 : i === 0) continue;
          // the next junction node along the way, if any: the arm reaches half way to it
          let next: { node: string; d: number } | undefined;
          for (let m = i + out; m >= 0 && m < line.points.length; m += out) {
            const id2 = nodeId(nodeKey(line.points[m]), layer);
            if (candidates.has(id2)) { next = { node: id2, d: Math.abs(dAt[m] - dAt[i]) }; break; }
          }
          const arm = out === 1 ? c.slice(iv) : c.slice(0, iv + 1).reverse();
          if (arm.length < 2) continue;
          const reach = ((next ? next.d : out === 1 ? len - dAt[i] : dAt[i]) / len) * total;
          arms.push({
            line, out, node: id, dNode: dAt[i], trim: 0, dTrim: 0, next,
            arm: { c: arm, half: (style.width / 2) * latticePerMetre, shoulder: (style.shoulder ?? 0) * latticePerMetre, maxTrim: Math.min(reach * (next ? 0.45 : 0.8), MAX_TRIM_M * latticePerMetre) },
          });
        }
      }
      if (ok && arms.length >= 3) nodes.set(id, { at, p: node, layer, arms });
    }
    // nodes closer along a way than their widest roads reach are one junction (never round a roundabout)
    const parent = new Map<string, string>();
    const root = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(id, r); return r; };
    for (const id of nodes.keys()) parent.set(id, id);
    const widest = (id: string) => Math.max(...nodes.get(id)!.arms.map((a) => a.arm.half)) / latticePerMetre;
    const inner = (a: JArm) => !!a.next && nodes.has(a.next.node) && a.line.tags.junction !== 'roundabout' && a.next.d < widest(a.node) + widest(a.next.node) + CLUSTER_PAD_M;
    for (const [id, n] of nodes) for (const a of n.arms) if (inner(a)) parent.set(root(id), root(a.next!.node));
    const clusters = new Map<string, string[]>();
    for (const id of nodes.keys()) { const r = root(id); clusters.set(r, [...(clusters.get(r) ?? []), id]); }
    const prio = (a: JArm) => roadPriority(a.line.tags, classifyLine(a.line.tags)!.width);
    for (const ids of clusters.values()) {
      const all = ids.flatMap((id) => nodes.get(id)!.arms);
      const ext = all.filter((a) => !inner(a));
      const pts = ids.map((id) => nodes.get(id)!.p);
      const centre: P2 = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      if (ext.length < 2) continue;
      const shape = junctionShape(ext.map((a) => a.arm), centre, latticePerMetre);
      if (!shape) continue;
      ext.forEach((a, n) => {
        a.trim = shape.trims[n];
        const total = cumulative(drawnPts(a.line)!.map((p) => p.c)).at(-1)!, len = lengthOf(a.line).at(-1)!;
        a.dTrim = a.dNode + a.out * (a.trim / total) * len;
      });
      // the ways between its nodes, once each
      const innerWays: { line: OsmLine; c: P2[] }[] = [];
      for (const a of all) {
        if (!inner(a) || a.out !== 1) continue;
        const c = drawnPts(a.line)!.map((p) => p.c), total = cumulative(c).at(-1)!, len = lengthOf(a.line).at(-1)!;
        const s0 = (a.dNode / len) * total, s1 = ((a.dNode + a.next!.d) / len) * total, cum = cumulative(c);
        innerWays.push({ line: a.line, c: c.filter((_, m) => cum[m] >= s0 - 1e-9 && cum[m] <= s1 + 1e-9) });
        const list = trimsOf.get(a.line), cut = { d0: a.dNode, d1: a.dNode + a.next!.d, inner: true };
        if (list) list.push(cut); else trimsOf.set(a.line, [cut]);
      }
      /** an arm's direction from its node over its first THROUGH_PROBE_M or so */
      const armDir = (a: JArm): P2 => {
        const c = a.arm.c, cum = cumulative(c);
        let i = 1;
        while (i < c.length - 1 && cum[i] < THROUGH_PROBE_M * latticePerMetre) i++;
        const l = Math.hypot(c[i][0] - c[0][0], c[i][1] - c[0][1]) || 1;
        return [(c[i][0] - c[0][0]) / l, (c[i][1] - c[0][1]) / l];
      };
      // the roads through its nodes: which edges the others join on
      const through = new Map<OsmLine, number>();
      for (const id of ids) {
        const { p: node, arms } = nodes.get(id)!;
        /** the direction an arm leaves in, over its first THROUGH_PROBE_M or so */
        const dir = (a: JArm): P2 => {
          const c = a.arm.c, cum = cumulative(c);
          let i = 1;
          while (i < c.length - 1 && cum[i] < THROUGH_PROBE_M * latticePerMetre) i++;
          const q = c[i], l = Math.hypot(q[0] - node[0], q[1] - node[1]) || 1;
          return [(q[0] - node[0]) / l, (q[1] - node[1]) / l];
        };
        let best: [JArm, JArm] | undefined, bestPrio = -Infinity;
        for (let p = 0; p < arms.length; p++) for (let q = p + 1; q < arms.length; q++) {
          const a = arms[p], b = arms[q], da = dir(a), db = dir(b), cos = da[0] * db[0] + da[1] * db[1];
          if (cos > THROUGH_MAX_COS || !classifyLine(a.line.tags)!.marks || !classifyLine(b.line.tags)!.marks) continue;
          const round = a.line.tags.junction === 'roundabout' && b.line.tags.junction === 'roundabout';
          // the senior first, then the straighter
          const m = Math.min(prio(a), prio(b)) + (round ? 100 : 0) - cos * 1e-3;
          if (m > bestPrio) { bestPrio = m; best = [a, b]; }
        }
        if (!best) continue;
        const [a, b] = best, own = Math.min(prio(a), prio(b));
        const round = a.line.tags.junction === 'roundabout' && b.line.tags.junction === 'roundabout';
        const rivals = arms.filter((o) => o !== a && o !== b && prio(o) >= own - 1e-9);
        if (!round && (rivals.length > 1 || rivals.some((o) => prio(o) > own + 1e-9))) continue;
        // in a junction of several nodes, no road paints across another of its standing or higher crossing it
        if (ids.length > 1) {
          const da = dir(a);
          const crossed = all.some((o) => o.line !== a.line && o.line !== b.line && prio(o) >= own - 1e-9 && Math.abs(armDir(o)[0] * da[0] + armDir(o)[1] * da[1]) < CROSS_COS);
          if (crossed) continue;
        }
        for (const w of new Set([a.line, b.line])) {
          let off = through.get(w) ?? 0;
          const c = drawnPts(w)!.map((q) => q.c);
          let k = 0, bd = Infinity;
          for (let m = 0; m + 1 < c.length; m++) { const d = toSegment(node, c[m], c[m + 1]); if (d < bd) { bd = d; k = m; } }
          const dx = c[k + 1][0] - c[k][0], dy = c[k + 1][1] - c[k][1], flip = w.tags.oneway === '-1' ? -1 : 1;
          for (const o of arms) {
            if (o === a || o === b) continue;
            const q = dir(o);
            // across > 0: to the right of the driving direction (v grows from the left edge)
            off |= flip * (q[1] * dx - q[0] * dy) > 0 ? ROAD_EDGE_OFF.RIGHT : ROAD_EDGE_OFF.LEFT;
          }
          through.set(w, off);
        }
      }
      const j: Junction = { at: nodes.get(ids[0])!.at, nodes: pts, keys: ids.map((id) => id.split('|')[0]), arms: ext, inner: innerWays, shape, through };
      junctions.push(j);
      for (const id of ids) junctionNodes.add(id.split('|')[0]);
      for (const a of all) {
        const at = nodes.get(a.node)!.at;
        hold(a.line, at, inner(a) ? a.next!.d : Math.abs(a.dTrim - a.dNode));
      }
      for (const a of ext) {
        const d0 = Math.min(a.dNode, a.dTrim), d1 = Math.max(a.dNode, a.dTrim);
        const list = trimsOf.get(a.line);
        if (list) list.push({ d0, d1 }); else trimsOf.set(a.line, [{ d0, d1 }]);
        let cuts = cutAt.get(a.line);
        if (!cuts) cutAt.set(a.line, cuts = new Map());
        // the ribbon past the trim starts there (an arm out along the way) or ends there (back along it)
        cuts.set(a.dTrim, { arm: a, start: a.out === 1 });
      }
    }
  }
  /** a way's stretches on the ground less what the junctions take */
  const untrimmed = (line: OsmLine, runs: [number, number][], innerOnly = false): [number, number][] => {
    const cut = trimsOf.get(line)?.filter((c) => !innerOnly || c.inner);
    if (!cut?.length) return runs;
    const out: [number, number][] = [];
    for (const [a, b] of runs) {
      let pieces: [number, number][] = [[a, b]];
      for (const { d0, d1 } of cut) {
        pieces = pieces.flatMap(([p, q]): [number, number][] => (d1 <= p || d0 >= q ? [[p, q]] : [...(d0 > p ? [[p, d0] as [number, number]] : []), ...(d1 < q ? [[d1, q] as [number, number]] : [])]));
      }
      out.push(...pieces.filter(([p, q]) => q - p > 1e-3));
    }
    return out;
  };
  /** how far from a junction's node the junction takes a road ending there, metres (painted: no taper in it) */
  const holdAt = (line: OsmLine, at: LonLat): number | undefined => taken.get(line)?.get(nodeKey(at));
  /** a road's paint at a junction's node: to its trim, no gap */
  const gapAt = (_line: OsmLine, at: LonLat): number | undefined => (junctionNodes.has(nodeKey(at)) ? 0 : undefined);
  /** each painted road's centre line, half widths and paint (painted), once */
  const paintCache = new Map<OsmLine, ReturnType<typeof painted> | null>();
  const paintOf = (line: OsmLine): ReturnType<typeof painted> | undefined => {
    let p = paintCache.get(line);
    if (p === undefined) {
      const style = classifyLine(line.tags), pts = drawnPts(line);
      p = style?.marks && pts ? painted(line, pts, style.width / 2, style.marks, net, gapAt, holdAt) : null;
      paintCache.set(line, p);
    }
    return p ?? undefined;
  };

  interface Draft { shape: CoverShape; rank: number; tie: number; triSeg?: Int32Array; index: number }
  const drafts: Draft[] = [];
  /** a cover's shape; its edge thinned to THIN_M, the points in `keep` kept */
  const add = (kind: CoverKind, source: CoverShape['source'], prio: number, tris: Float64Array, edge: P2[][], tie = 0, segs?: VertexAttr[], triSeg?: Int32Array, keep?: ReadonlySet<P2>): Draft | undefined => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < tris.length; k += 2) {
      x0 = Math.min(x0, tris[k]); x1 = Math.max(x1, tris[k]);
      y0 = Math.min(y0, tris[k + 1]); y1 = Math.max(y1, tris[k + 1]);
    }
    // nothing of it in the tile (none at all: no triangles)
    if (!(x1 >= 0 && x0 <= grid && y1 >= 0 && y0 <= grid)) return undefined;
    const outline = edge.map((l) => thinLine(l, THIN_M * latticePerMetre, keep));
    // equal roads by their first point; anything else keeps its place
    const road = kind === 'carriageway' || kind === 'shoulder';
    const draft: Draft = { shape: { kind, source, prio, tris, outline }, rank: COVER_RANK[kind], tie: road ? tie : 0, triSeg, index: -1 };
    if (segs && triSeg) draft.shape.attr = { segs, segAt: (x, y) => segAt(draft, x, y) };
    drafts.push(draft);
    return draft;
  };
  const flat = (pts: P2[]): Float64Array => {
    const out = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { out[2 * i] = p[0]; out[2 * i + 1] = p[1]; });
    return out;
  };

  /**
   * A ribbon's shape; its triangles' segments offset by `first` (it is a stretch of a longer centre
   * line). A carriageway, ballast or runway is cut across at an inner vertex of it but where its
   * paint stays linear past it (cutNeeded), or `breaks` has it (its index in the longer line), or a
   * lifted run ends there (liftedEnds).
   */
  const ribbon = (kind: CoverKind, line: OsmLine, c: P2[], half: number | number[], ends: RibbonEnds, prio: number, tie: number, segs?: VertexAttr[], first = 0, breaks?: ReadonlySet<number>): RibbonGeom | undefined => {
    if (c.length < 2) return undefined;
    const g = ribbonGeom(c, half, ends, latticePerMetre, CAP_TOL_M);
    const keep = new Set<P2>(), cuts: P2[][] = [];
    if (kind === 'carriageway' || kind === 'ballast' || kind === 'runway') {
      g.cuts.forEach((cut, k) => {
        const i = g.cutAt[k];
        if (!breaks?.has(first + i) && !liftedEnds.has(latticeKey(c[i])) && !cutNeeded(c, half, i, latticePerMetre)) return;
        cuts.push(cut);
        for (const p of cut) keep.add(p);
      });
    }
    add(kind, line, prio, flat(g.tris), [...g.outline, ...cuts], tie, segs, segs ? Int32Array.from(g.triSeg, (s) => s + first) : undefined, keep);
    return g;
  };

  const buildLine = (line: OsmLine): void => {
    const style = classifyLine(line.tags);
    if (!style || line.points.length < 2 || isTunnel(line.tags)) return;
    const road = !!line.tags.highway;
    const e = line.points.map((ll) => enu(ll[0], ll[1]));
    const pts = drawnPts(line);
    if (!pts) return;
    const c = pts.map((p) => p.c);
    // no right-of-way strip on a bridge (as the mesh: it would paint what the bridge crosses)
    const half = style.width / 2, shoulder = style.shoulder ?? 0, zone = style.rail && !isBridge(line.tags) ? RAIL_ZONE_M : 0;
    // nothing of it reaches the tile: skip the work
    const r = (half + shoulder + zone) * latticePerMetre;
    if (c.every((p) => p[0] < -r) || c.every((p) => p[0] > grid + r) || c.every((p) => p[1] < -r) || c.every((p) => p[1] > grid + r)) return;
    const ground = groundRuns(line, e, lifted), len = ground.len;
    // the junctions take their share of a road (they cover it)
    const runs = untrimmed(line, ground.runs);
    if (!runs.length) return;
    const tie = tieBreak(line.points[0]);
    const cuts = cutAt.get(line);
    // its shoulders but between a junction's nodes (none where the junctions take all its carriageway)
    const shoulderRuns = untrimmed(line, ground.runs, true);
    /**
     * a ribbon along each stretch on the ground: centre line cl (a stretch at the same share of its
     * length as of the way's), its own ends at the way's ends, square where the lift begins
     */
    const along = (kind: CoverKind, cl: P2[], w: number | number[], ways: RibbonEnds, prio = 0, segs?: VertexAttr[], breaks?: ReadonlySet<number>): void => {
      const cum = cumulative(cl), ends = joints(line, ways);
      // a road's shoulders run on under its junctions (the junior of every carriageway): round a kerb's fillet they are its ground
      for (const [d0, d1] of kind === 'shoulder' ? shoulderRuns : runs) {
        const part = runPart(cl, cum, w, ends, d0, d1, len);
        const g = ribbon(kind, line, part.c, part.half, part.ends, prio, tie, segs, part.first, breaks);
        if (!g || kind !== 'carriageway') continue;
        // its square ends at a junction's trim: the junction's outline takes their corners as they are
        const ends2 = g.outline.slice(-2);
        for (const [d, start] of [[d0, true], [d1, false]] as const) {
          const cut = cuts?.get(d);
          if (!cut || cut.start !== start) continue;
          const [l, r] = start ? ends2[0] : ends2[1];
          // [right, left] looking out of the junction: an arm out along the way starts here, one back along it ends here
          const corners: [P2, P2] = start ? [r, l] : [l, r];
          cut.arm.corners = corners;
        }
      }
    };
    if (style.rail) {
      // the ballast carries the track: its segments' attributes
      along('ballast', c, half, ROUND_ENDS, 0, trackSegs(pts));
      along('railZone', c, half + zone, ROUND_ENDS);
      return;
    }
    if (!road) {
      const water = waterwayWidth(line.tags) !== undefined, at = (p: LonLat) => water && structureNodes.has(`${p[0]},${p[1]}`);
      along(water ? 'water' : 'runway', c, half, { capStart: !at(line.points[0]), capEnd: !at(line.points[line.points.length - 1]) });
      return;
    }
    const own = net.roadEnds(line), low = (p: LonLat) => !isBridge(line.tags) && lowEnds.has(`${p[0]},${p[1]}`);
    const ends = { ...own, capStart: own.capStart && !low(line.points[0]), capEnd: own.capEnd && !low(line.points[line.points.length - 1]) };
    if (style.path) {
      along('path', c, half, ends);
      return;
    }
    const prio = roadPriority(line.tags, style.width);
    const p = style.marks ? paintOf(line) : undefined;
    if (p) {
      // narrowing into a narrower continuation; its paint per segment of the whole way
      if (p.c.length >= 2) along('carriageway', p.c, p.half, ends, prio, p.segs, new Set(p.breaks));
    } else along('carriageway', c, half, ends, prio);
    // its shoulders narrowing with it
    if (shoulder) {
      if (p && p.c.length >= 2) along('shoulder', p.c, p.half.map((h) => h + shoulder), ends, prio);
      else along('shoulder', c, half + shoulder, ends, prio);
    }
  };

  /** a polygon's triangles (earcut), as pieces of a union */
  const triangulate = (ring: P2[]): P2[][] => {
    const co = ring.flat(), idx = earcut(co), out: P2[][] = [];
    for (let k = 0; k < idx.length; k += 3) out.push([0, 1, 2].map((m) => [co[2 * idx[k + m]], co[2 * idx[k + m] + 1]] as P2));
    return out;
  };
  /** the convex hull of points (counter-clockwise) */
  const hull = (ps: P2[]): P2[] => {
    const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const half = (pts: P2[]) => { const h: P2[] = []; for (const q of pts) { while (h.length >= 2 && (h[h.length - 1][0] - h[h.length - 2][0]) * (q[1] - h[h.length - 2][1]) - (h[h.length - 1][1] - h[h.length - 2][1]) * (q[0] - h[h.length - 2][0]) <= 0) h.pop(); h.push(q); } return h; };
    const lo = half(p), hi = half([...p].reverse());
    return [...lo.slice(0, -1), ...hi.slice(0, -1)];
  };
  /**
   * A junction with a traffic light on one of its nodes: a post at each approach (an arm traffic
   * comes in on: not a one-way road leaving), at its stop line (the trim) beside the kerb on the
   * right of the traffic coming in, SIGNAL_SETBACK_M off the carriageway, its head facing that
   * traffic. Green for the roads through it (or, with none, the senior road), red for the others.
   */
  const placeSignals = (j: Junction, corners: [P2, P2][]): void => {
    const prioOf = (l: OsmLine) => roadPriority(l.tags, classifyLine(l.tags)!.width);
    const top = Math.max(...j.arms.map((a) => prioOf(a.line)));
    j.arms.forEach((a, k) => {
      const ow = a.line.tags.oneway === '-1' ? -1 : isOnewayRoad(a.line.tags) ? 1 : 0;
      // a one-way road leaving the junction: along its drawing direction out (out 1, forward), or against it
      if (ow !== 0 && ow === a.out) return;
      const c = a.arm.c, i = Math.min(c.length - 1, 1);
      const ul = Math.hypot(c[i][0] - c[0][0], c[i][1] - c[0][1]) || 1, u: P2 = [(c[i][0] - c[0][0]) / ul, (c[i][1] - c[0][1]) / ul];
      // the traffic comes in against u: its right is the arm's right looking out (corners[k][0]; the
      // lattice's y runs south, so that side is u turned by (u.y, −u.x))
      const kerb = corners[k][0], off = SIGNAL_SETBACK_M * latticePerMetre;
      const side: P2 = [u[1], -u[0]];
      const green = j.through.size ? j.through.has(a.line) : prioOf(a.line) >= top - 1e-9;
      // where that is another road's carriageway (a median too narrow, a slip road beside it): further
      // out, or on its left (a median's island), else none (settled once every shape is in: settleSignals)
      const left = corners[k][1];
      const tries: P2[] = [1, 2, 4].map((f): P2 => [kerb[0] + side[0] * off * f, kerb[1] + side[1] * off * f])
        .concat([1, 2].map((f): P2 => [left[0] - side[0] * off * f, left[1] - side[1] * off * f]));
      pendingSignals.push({ tries, facing: u, green });
    });
  };

  /**
   * A junction's surface: a carriageway over its arms (their priority, and a little more), the
   * union of its pieces (junctionPieces: the arms to their trimmed ends, the kerbs' wedges; the ways
   * between its nodes; the space between its nodes), its outline that union's; the paint of the
   * roads through it, without the edge line on the sides the others join (ROAD_EDGE_OFF), the
   * nearest segment of those roads at each point. Its shoulders round it, as the arms'.
   */
  const buildJunction = (j: Junction): void => {
    const arms = j.arms.map((a) => a.arm);
    const prioOf = (l: OsmLine) => roadPriority(l.tags, classifyLine(l.tags)!.width);
    const lead = [...j.arms.map((a) => a.line), ...j.inner.map((w) => w.line)].reduce((p, q) => (prioOf(q) > prioOf(p) ? q : p));
    const prio = Math.max(...j.arms.map((a) => prioOf(a.line)), ...j.inner.map((w) => prioOf(w.line))) + 1e-6;
    /** the ways between its nodes, and the space between three or more nodes close together */
    const between = (): P2[][] => {
      const out: P2[][] = [];
      for (const w of j.inner) {
        if (w.c.length < 2) continue;
        const g = ribbonGeom(w.c, (classifyLine(w.line.tags)!.width / 2) * latticePerMetre, SQUARE_ENDS, latticePerMetre);
        for (let k = 0; k < g.tris.length; k += 3) out.push([g.tris[k], g.tris[k + 1], g.tris[k + 2]]);
      }
      if (j.nodes.length >= 3) out.push(hull(j.nodes));
      return out;
    };
    const surface = (pieces: P2[][]): { tris: Float64Array; outline: P2[][]; pieces: P2[][] } => {
      const ccw = pieces.filter((p) => p.length >= 3).map((p) => {
        let a = 0;
        for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
        return a >= 0 ? p : [...p].reverse();
      });
      const tris: P2[] = [];
      for (const p of ccw) for (let k = 1; k + 1 < p.length; k++) tris.push(p[0], p[k], p[k + 1]);
      return { tris: flat(tris), outline: unionOutline(ccw), pieces: ccw };
    };
    const corners = j.arms.map((a) => a.corners ?? trimCorners(a.arm, a.trim, 0));
    if (j.keys.some((k) => signalNodes.has(k))) placeSignals(j, corners);
    const road = surface([...junctionPieces(j.shape, arms, corners, () => 0, latticePerMetre, triangulate), ...between()]);
    if (!road.tris.length) return;
    const draft = add('carriageway', lead, prio, road.tris, road.outline, tieBreak(j.at));
    const token = {};
    if (draft) draft.shape.junction = token;
    // its shoulders round its kerbs (a band along its outline but where the arms' own shoulders run,
    // along their edges, or its outline crosses their ends), each arm's own width along it and going
    // smoothly from one to the next (shoulderAt); the band alone, its inner edge on the carriageway's
    if (j.arms.some((a) => a.arm.shoulder > 0)) {
      const trims = j.arms.map((a) => a.trim), width = (q: P2) => shoulderAt(arms, trims, q);
      const near = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-7;
      const onEdge = (q: P2) => j.arms.some((a) => {
        const c = a.arm.c;
        for (let i = 0; i + 1 < c.length; i++) {
          const dx = c[i + 1][0] - c[i][0], dy = c[i + 1][1] - c[i][1], l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? ((q[0] - c[i][0]) * dx + (q[1] - c[i][1]) * dy) / l2 : 0;
          if (t < -1e-9 || t > 1 + 1e-9) continue;
          if (Math.abs(Math.hypot(q[0] - c[i][0] - dx * t, q[1] - c[i][1] - dy * t) - a.arm.half) < 1e-6) return true;
        }
        return false;
      });
      const skip = (a: P2, b: P2) => corners.some(([r, l]) => (near(a, r) && near(b, l)) || (near(a, l) && near(b, r))) || (onEdge(a) && onEdge(b));
      // round the carriageway's outline as the cover keeps it (thinned): the band's inner edge on its very points
      const band = surface(bandPieces(road.outline.map((l) => thinLine(l, THIN_M * latticePerMetre)), width, skip));
      const sd = band.tris.length ? add('shoulder', lead, prio, band.tris, band.outline, tieBreak(j.at)) : undefined;
      if (sd) Object.assign(sd.shape, { junction: token, overlay: true });
    }
    if (draft && j.through.size) {
      const segs: VertexAttr[] = [], owner: { c: P2[]; base: number }[] = [];
      for (const [line, off] of j.through) {
        const p = paintOf(line);
        if (!p || p.c.length < 2) continue;
        owner.push({ c: p.c, base: segs.length });
        for (const f of p.segs) segs.push((q) => { const a = f(q); a[4] += off; return a; });
      }
      if (segs.length) {
        draft.shape.attr = {
          segs,
          segAt: (x, y) => {
            let best = Infinity, at = 0;
            for (const { c, base } of owner) for (let i = 0; i + 1 < c.length; i++) {
              const d = toSegment([x, y], c[i], c[i + 1]);
              if (d < best) { best = d; at = base + i; }
            }
            return at;
          },
        };
      }
    }
  };

  /**
   * The pedestrian crossings' zebras: at each node mapped as a crossing (highway=crossing) or where a
   * crossing way (footway=crossing, cycleway=crossing) meets a carriageway on the ground, but an
   * unmarked one, stripes across the whole carriageway of the senior road there, ZEBRA_STRIPE_M wide
   * with ZEBRA_GAP_M of asphalt between, ZEBRA_LENGTH_M long along it, white and yellow in turn — two
   * overlays (drawn over its faces)
   */
  function buildZebras(): void {
    const unmarked = (tags: Record<string, string>) => ['no', 'unmarked', 'informal'].includes(tags.crossing ?? '');
    const at = new Map<string, LonLat>();
    for (const p of data.points) if (p.tags.highway === 'crossing' && !unmarked(p.tags)) at.set(nodeKey(p.at), p.at);
    for (const l of data.lines) {
      if (!(l.tags.footway === 'crossing' || l.tags.cycleway === 'crossing' || l.tags.highway === 'crossing') || unmarked(l.tags)) continue;
      for (const p of l.points) at.set(nodeKey(p), p);
    }
    if (!at.size) return;
    const white: P2[] = [], yellow: P2[] = [];
    let lead: OsmLine | undefined, leadPrio = -Infinity;
    for (const line of data.lines) {
      const style = line.tags.highway ? classifyLine(line.tags) : undefined;
      if (!style || style.path || isTunnel(line.tags) || roadLayer(line.tags) !== 0) continue;
      const dAt = wayLength(line);
      line.points.forEach((p, i) => {
        if (!at.has(nodeKey(p)) || lifted(line, dAt[i])) return;
        // the senior road at the node takes it
        at.delete(nodeKey(p));
        const pts = paintOf(line)?.c ?? drawnPts(line)?.map((q) => q.c);
        if (!pts || pts.length < 2) return;
        const node = toLattice(p);
        let k = 0, best = Infinity;
        for (let m = 0; m + 1 < pts.length; m++) { const d = toSegment(node, pts[m], pts[m + 1]); if (d < best) { best = d; k = m; } }
        const dx = pts[k + 1][0] - pts[k][0], dy = pts[k + 1][1] - pts[k][1], l = Math.hypot(dx, dy) || 1;
        const u: P2 = [dx / l, dy / l], n: P2 = [-u[1], u[0]];
        // stripes apart, the asphalt between them, centred on the road: as many as fit
        const w = style.width * latticePerMetre, sw = ZEBRA_STRIPE_M * latticePerMetre, gap = ZEBRA_GAP_M * latticePerMetre, hl = (ZEBRA_LENGTH_M / 2) * latticePerMetre;
        const count = Math.max(1, Math.floor((w - gap) / (sw + gap)));
        const first = -(count * sw + (count - 1) * gap) / 2;
        for (let s2 = 0; s2 < count; s2++) {
          const a = first + s2 * (sw + gap), b = a + sw;
          const q = (o: number, t: number): P2 => [node[0] + n[0] * o + u[0] * t, node[1] + n[1] * o + u[1] * t];
          (s2 % 2 ? yellow : white).push(q(a, -hl), q(b, -hl), q(b, hl), q(a, -hl), q(b, hl), q(a, hl));
        }
        const pr = roadPriority(line.tags, style.width);
        if (pr > leadPrio) { leadPrio = pr; lead = line; }
      });
    }
    if (!lead) return;
    for (const [tris, paint] of [[white, ZEBRA_WHITE], [yellow, ZEBRA_YELLOW]] as const) {
      if (!tris.length) continue;
      const outline: P2[][] = [];
      for (let k = 0; k < tris.length; k += 6) outline.push([tris[k], tris[k + 1], tris[k + 2], tris[k + 5], tris[k]]);
      const d = add('zebra', lead, leadPrio, flat(tris), outline);
      if (d) Object.assign(d.shape, { overlay: true, paint });
    }
  }

  const buildArea = (area: OsmArea): void => {
    const style = classifyArea(area.tags, DEFAULT_AREA_STYLES);
    if (style) {
      const rings = area.rings.map((ring) => {
        const pts = ring.map(toLattice).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
        if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
        return pts;
      });
      // holes without their outer ring are no area
      if (rings.length && rings[0].length >= 3) {
        const kept = rings.filter((r) => r.length >= 3);
        const coords: number[] = [], holes: number[] = [];
        kept.forEach((r, ri) => {
          if (ri > 0) holes.push(coords.length / 2);
          for (const p of r) coords.push(p[0], p[1]);
        });
        const idx = earcut(coords, holes.length ? holes : undefined, 2);
        const tris = new Float64Array(idx.length * 2);
        idx.forEach((v, k) => { tris[2 * k] = coords[2 * v]; tris[2 * k + 1] = coords[2 * v + 1]; });
        add(areaKind(area.tags, style), area, 0, tris, kept.map((r) => [...r, r[0]]));
        if (belts && beltFilter(area.tags, DEFAULT_AREA_STYLES)) buildBelt(area, kept);
      }
    }
    if (area.tags.leisure === 'pitch') buildPitchPaint(area);
  };

  /**
   * An area's transition belt (BELT_M): the band along its rings (ringBand), one shape for them
   * all. It is the junior of every cover: it shows only on the bare ground round the area (or in
   * its holes), the area covering its inner half (and the surface its edge there: GroundCover.outside).
   */
  const buildBelt = (area: OsmArea, rings: P2[][]): void => {
    const r = BELT_M * latticePerMetre;
    const g = ringBand(rings, r, capSides(BELT_M, CAP_TOL_M), [-r, -r, grid + r, grid + r]);
    if (g.tris.length) add('belt', area, 0, flat(g.tris), g.outline);
  };

  /**
   * A pitch's markings (osm-mesher buildPitch): strips PAINT_HALF_M each side of each line, square
   * ended, one shape for them all; the whole outline decides, as in every tile it spans
   */
  const buildPitchPaint = (area: OsmArea): void => {
    const ring = (area.rings[0] ?? []).map(([lon, lat]) => enu(lon, lat));
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    const pf = pitchFrame(ring, area.tags);
    if (!pf) return;
    const { segs, frame } = pf;
    const tris: P2[] = [], outline: P2[][] = [];
    for (const [s0, t0, s1, t1] of segs ?? []) {
      const a = enuToLattice(frame(s0, t0)), b = enuToLattice(frame(s1, t1));
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const g = ribbonGeom([a, b], PAINT_HALF_M, SQUARE_ENDS, latticePerMetre);
      tris.push(...g.tris);
      outline.push(...g.outline);
    }
    if (tris.length) add('pitchPaint', area, 0, flat(tris), outline);
  };

  /** a helipad point: a square HELIPAD_HALF_M each way round it, ENU-aligned (osm-mesher buildPoint) */
  const buildPoint = (p: OsmPoint): void => {
    if (p.tags.aeroway !== 'helipad') return;
    const [x, z] = enu(p.at[0], p.at[1]), h = HELIPAD_HALF_M;
    const q = ([[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h]] as P2[]).map(enuToLattice);
    add('aeroArea', p, 0, flat([q[0], q[1], q[2], q[0], q[2], q[3]]), [[...q, q[0]]]);
  };

  for (const line of data.lines) buildLine(line);
  for (const j of junctions) buildJunction(j);
  buildZebras();
  for (const area of data.areas) buildArea(area);
  for (const p of data.points) buildPoint(p);

  // the senior first; roads among themselves by priority, equals by their first point; the rest as given
  drafts.sort((a, b) => a.rank - b.rank || b.shape.prio - a.shape.prio || a.tie - b.tie);
  drafts.forEach((d, i) => { d.index = i; });
  const shapes = drafts.map((d) => d.shape);

  // --- every triangle in the cells of the tile it overlaps, in the shapes' order ---
  let count = 0;
  for (const s of shapes) count += s.tris.length / 6;
  /** each triangle's shape and its index in the shape */
  const triShape = new Int32Array(count), triLocal = new Int32Array(count);
  const cells = Math.max(1, Math.min(MAX_CELLS, Math.ceil(grid)));
  const cellSize = grid / cells;
  const cellOf = (v: number) => Math.max(0, Math.min(cells - 1, Math.floor(v / cellSize)));
  /**
   * The cells triangle `o` of `t` overlaps, row by row (its span across each row of cells, not its
   * bounding box: a long thin triangle of a big area across the tile would fill thousands); none
   * for one wholly outside the tile
   */
  const eachCell = (t: Float64Array, o: number, visit: (cell: number) => void): void => {
    const y0 = Math.min(t[o + 1], t[o + 3], t[o + 5]), y1 = Math.max(t[o + 1], t[o + 3], t[o + 5]);
    const x0 = Math.min(t[o], t[o + 2], t[o + 4]), x1 = Math.max(t[o], t[o + 2], t[o + 4]);
    if (x1 < 0 || x0 > grid || y1 < 0 || y0 > grid) return;
    for (let j = cellOf(y0 - CELL_PAD); j <= cellOf(y1 + CELL_PAD); j++) {
      // the triangle's x range within the row's band: its edges clipped to the band
      const ya = j * cellSize - CELL_PAD, yb = (j + 1) * cellSize + CELL_PAD;
      let lo = Infinity, hi = -Infinity;
      for (let e = 0; e < 3; e++) {
        const px = t[o + 2 * e], py = t[o + 2 * e + 1], qx = t[o + (2 * e + 2) % 6], qy = t[o + (2 * e + 3) % 6];
        if (Math.max(py, qy) < ya || Math.min(py, qy) > yb) continue;
        if (py === qy) {
          lo = Math.min(lo, px, qx);
          hi = Math.max(hi, px, qx);
          continue;
        }
        const k = (qx - px) / (qy - py);
        const xa = px + k * (Math.max(ya, Math.min(py, qy)) - py), xb = px + k * (Math.min(yb, Math.max(py, qy)) - py);
        lo = Math.min(lo, xa, xb);
        hi = Math.max(hi, xa, xb);
      }
      if (lo > hi) continue;
      for (let i = cellOf(lo - CELL_PAD); i <= cellOf(hi + CELL_PAD); i++) visit(j * cells + i);
    }
  };
  const start = new Int32Array(cells * cells + 1);
  /** each triangle's box: x0, y0, x1, y1 */
  const triBox = new Float64Array(count * 4);
  let g = 0;
  shapes.forEach((s, si) => {
    for (let k = 0; k < s.tris.length / 6; k++, g++) {
      triShape[g] = si;
      triLocal[g] = k;
      const t = s.tris, o = 6 * k;
      triBox[4 * g] = Math.min(t[o], t[o + 2], t[o + 4]) - CELL_PAD;
      triBox[4 * g + 1] = Math.min(t[o + 1], t[o + 3], t[o + 5]) - CELL_PAD;
      triBox[4 * g + 2] = Math.max(t[o], t[o + 2], t[o + 4]) + CELL_PAD;
      triBox[4 * g + 3] = Math.max(t[o + 1], t[o + 3], t[o + 5]) + CELL_PAD;
      eachCell(s.tris, 6 * k, (cell) => { start[cell + 1]++; });
    }
  });
  for (let c = 0; c < cells * cells; c++) start[c + 1] += start[c];
  const entries = new Int32Array(start[cells * cells]);
  const fill = start.slice(0, cells * cells);
  g = 0;
  for (const s of shapes) for (let k = 0; k < s.tris.length / 6; k++, g++) { const gi = g; eachCell(s.tris, 6 * k, (cell) => { entries[fill[cell]++] = gi; }); }

  /** the first triangle (in the shapes' order) of shape `only` (any: −1, but those `skip` passes over) holding (x, y): its global index, or −1 */
  const find = (x: number, y: number, only: number, skip?: (shape: number) => boolean): number => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const cell = cellOf(y) * cells + cellOf(x);
    for (let e = start[cell]; e < start[cell + 1]; e++) {
      const gi = entries[e], si = triShape[gi];
      if (x < triBox[4 * gi] || y < triBox[4 * gi + 1] || x > triBox[4 * gi + 2] || y > triBox[4 * gi + 3]) continue;
      if (only >= 0 ? si !== only : shapes[si].overlay || skip?.(si)) continue;
      if (holds(shapes[si].tris, 6 * triLocal[gi], x, y)) return gi;
    }
    return -1;
  };

  function segAt(d: Draft, x: number, y: number): number {
    const triSeg = d.triSeg!;
    const gi = find(x, y, d.index);
    if (gi >= 0) return triSeg[triLocal[gi]];
    // on no triangle of it (outside the tile, or off it): the nearest triangle's
    let best = Infinity, seg = triSeg[0] ?? 0;
    for (let k = 0; k < triSeg.length; k++) {
      const d2 = distance2(d.shape.tris, 6 * k, x, y);
      if (d2 < best) { best = d2; seg = triSeg[k]; }
    }
    return seg;
  }

  /** per triangle: the segment it was last tried against (GroundCover.outside) */
  const tried = new Int32Array(count).fill(-1);
  let tries = 0;
  const seg = new Float64Array(6);
  const outside = (line: ReadonlyArray<P2>, before: number, over?: (shape: number) => boolean): P2[][] => {
    const pieces: P2[][] = [];
    let cur: P2[] = [];
    const flush = () => {
      if (cur.length >= 2) pieces.push(cur);
      cur = [];
    };
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1], b = line[k], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len === 0) continue;
      // the shares of the segment inside the seniors' triangles along it
      const spans: [number, number][] = [];
      const stamp = tries++;
      const sx0 = Math.min(a[0], b[0]), sy0 = Math.min(a[1], b[1]), sx1 = Math.max(a[0], b[0]), sy1 = Math.max(a[1], b[1]);
      seg[0] = a[0]; seg[1] = a[1]; seg[2] = seg[4] = b[0]; seg[3] = seg[5] = b[1];
      eachCell(seg, 0, (cell) => {
        // a cell's triangles come in the shapes' order: the seniors first
        for (let e = start[cell]; e < start[cell + 1]; e++) {
          const gi = entries[e], si = triShape[gi];
          if (si >= before) break;
          if (sx1 < triBox[4 * gi] || sy1 < triBox[4 * gi + 1] || sx0 > triBox[4 * gi + 2] || sy0 > triBox[4 * gi + 3]) continue;
          if (tried[gi] === stamp || (over && !over(si))) continue;
          tried[gi] = stamp;
          const span = within(shapes[si].tris, 6 * triLocal[gi], a[0], a[1], dx, dy);
          if (span && (span[1] - span[0]) * len > ALONG_EDGE) spans.push(span);
        }
      });
      // what is left of it: the gaps between the shares, merged across MERGE_GAP
      spans.sort((p, q) => p[0] - q[0]);
      const gap = MERGE_GAP / len;
      let at = 0;
      const keep = (from: number, to: number) => {
        // an end within MERGE_GAP of the segment's is that end
        const t0 = from <= gap ? 0 : from, t1 = to >= 1 - gap ? 1 : to;
        if (t1 - t0 <= gap) return;
        if (t0 > 0) flush();
        if (!cur.length) cur.push(t0 > 0 ? [a[0] + dx * t0, a[1] + dy * t0] : a as P2);
        cur.push(t1 < 1 ? [a[0] + dx * t1, a[1] + dy * t1] : b as P2);
        if (t1 < 1) flush();
      };
      for (const [t0, t1] of spans) {
        if (t0 > at + gap) keep(at, t0);
        at = Math.max(at, t1);
      }
      if (at < 1 - gap) keep(at, 1);
      else flush();
    }
    flush();
    return pieces;
  };

  // each traffic light's post at the first of its places off every carriageway
  for (const p of pendingSignals) {
    const at = p.tries.find(([x, y]) => { const si = find(x, y, -1); return si < 0 || shapes[triShape[si]].kind !== 'carriageway'; });
    if (at) signals.push({ at, facing: p.facing, green: p.green });
  }

  return {
    shapes,
    locate: (x, y, skip) => {
      const gi = find(x, y, -1, skip);
      return gi < 0 ? -1 : triShape[gi];
    },
    outside,
    junctionNodes,
    signals,
    junctionHold: holdAt,
  };
}
