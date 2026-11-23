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
import { colourOf, RAMP, snowy, withGlow, rampGlowLevel, type RGB } from '../engine/palette';
import { DEFAULT_AREA_STYLES, filterColour, type AreaStyles } from './area-styles';
import { enuToLatLon, latLonToEnu, tileCenter, tileLattice, tileSizeMeters, type Tile } from './geodesy';
import type { LonLat, OsmArea, OsmLine, OsmPoint } from './osm-types';
import { isLitPitch as isLitPitchRing, pitchFrame } from './pitch-markings';
import { lineNetwork, painted, ribbonGeom, ROUND_ENDS, trackSegs, type P2, type RibbonEnds, type VertexAttr } from './ribbon-shapes';
import { buildRoadLevels, coverLifted, type Lifted } from './road-levels';
import { bridgeDecks, type RoadSurface } from './road-pull';
import { BALLAST_RAMP, classifyArea, classifyLine, isBridge, isLitRoad, isOpenCarPark, isTunnel, LINK_RANK, roadRank, LIT_ROAD_GLOW, PITCH_GLOW, RAIL_ZONE_M, RAIL_ZONE_RAMP, roadPriority, SHOULDER_RAMP, tieBreak, UNLIT_ROAD_GLOW, waterwayWidth, type AreaStyle } from './way-styles';

export type CoverKind = 'runway' | 'ballast' | 'carriageway' | 'shoulder' | 'path' | 'water' | 'railZone' | 'aeroArea' | 'carPark' | 'pitchPaint' | 'pitch' | 'area';

/** seniority of the covers: the lower lies over the higher where they overlap */
export const COVER_RANK: Record<CoverKind, number> = {
  runway: 1, ballast: 2, carriageway: 3, shoulder: 4, path: 5, water: 6, railZone: 7, aeroArea: 8, carPark: 9, pitchPaint: 9.5, pitch: 10, area: 11,
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
}

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
    case 'railZone': return RAIL_ZONE_RAMP;
    case 'runway':
    case 'aeroArea': return RAMP.ASPHALT;
    case 'carPark': return withGlow(RAMP.ASPHALT, UNLIT_ROAD_GLOW);
    case 'pitchPaint': return isLitPitch(shape.source) ? withGlow(RAMP.SNOW, PITCH_GLOW) : RAMP.SNOW;
    case 'water': return RAMP.WATER;
    case 'pitch':
    case 'area': {
      const style = classifyArea(tags, styles);
      if (!style) return RAMP.GRASS;
      const ramp = shape.kind === 'pitch' && isLitPitch(shape.source) ? withGlow(style.ramp, PITCH_GLOW) : style.ramp;
      return style.filter && imagery ? withGlow(snowy(colourOf(filterColour(imagery, style.filter))), rampGlowLevel(ramp)) : ramp;
    }
  }
}

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
  return tags.leisure === 'pitch' ? 'pitch' : 'area';
}

/**
 * The ground covers of `tile` on its lattice of `grid` cells a side, from the whole ways, areas and
 * points round it; `roads` (the tile's roads with their heights) decide which stretches are lifted
 * as the mesh lifts them (coverLifted). Whatever lies wholly outside the tile gives no shape.
 */
export function buildGroundCover(tile: Tile, grid: number, data: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }, roads?: RoadSurface): GroundCover {
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

  interface Draft { shape: CoverShape; rank: number; tie: number; triSeg?: Int32Array; index: number }
  const drafts: Draft[] = [];
  /** a cover's shape; its edge thinned to THIN_M, the points in `keep` kept */
  const add = (kind: CoverKind, source: CoverShape['source'], prio: number, tris: Float64Array, edge: P2[][], tie = 0, segs?: VertexAttr[], triSeg?: Int32Array, keep?: ReadonlySet<P2>): void => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < tris.length; k += 2) {
      x0 = Math.min(x0, tris[k]); x1 = Math.max(x1, tris[k]);
      y0 = Math.min(y0, tris[k + 1]); y1 = Math.max(y1, tris[k + 1]);
    }
    // nothing of it in the tile (none at all: no triangles)
    if (!(x1 >= 0 && x0 <= grid && y1 >= 0 && y0 <= grid)) return;
    const outline = edge.map((l) => thinLine(l, THIN_M * latticePerMetre, keep));
    // equal roads by their first point; anything else keeps its place
    const road = kind === 'carriageway' || kind === 'shoulder';
    const draft: Draft = { shape: { kind, source, prio, tris, outline }, rank: COVER_RANK[kind], tie: road ? tie : 0, triSeg, index: -1 };
    if (segs && triSeg) draft.shape.attr = { segs, segAt: (x, y) => segAt(draft, x, y) };
    drafts.push(draft);
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
  const ribbon = (kind: CoverKind, line: OsmLine, c: P2[], half: number | number[], ends: RibbonEnds, prio: number, tie: number, segs?: VertexAttr[], first = 0, breaks?: ReadonlySet<number>): void => {
    if (c.length < 2) return;
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
  };

  const buildLine = (line: OsmLine): void => {
    const style = classifyLine(line.tags);
    if (!style || line.points.length < 2 || isTunnel(line.tags)) return;
    const road = !!line.tags.highway;
    const e = line.points.map((ll) => enu(ll[0], ll[1]));
    let pts = line.points.map((ll, i) => ({ c: toLattice(ll), e: e[i] }))
      .filter((p, i, a) => i === 0 || p.c[0] !== a[i - 1].c[0] || p.c[1] !== a[i - 1].c[1]);
    if (pts.length < 2) return;
    if (road) pts = net.forkShift(line, pts);
    const c = pts.map((p) => p.c);
    // no right-of-way strip on a bridge (as the mesh: it would paint what the bridge crosses)
    const half = style.width / 2, shoulder = style.shoulder ?? 0, zone = style.rail && !isBridge(line.tags) ? RAIL_ZONE_M : 0;
    // nothing of it reaches the tile: skip the work
    const r = (half + shoulder + zone) * latticePerMetre;
    if (c.every((p) => p[0] < -r) || c.every((p) => p[0] > grid + r) || c.every((p) => p[1] < -r) || c.every((p) => p[1] > grid + r)) return;
    const { runs, len } = groundRuns(line, e, lifted);
    if (!runs.length) return;
    const tie = tieBreak(line.points[0]);
    /**
     * a ribbon along each stretch on the ground: centre line cl (a stretch at the same share of its
     * length as of the way's), its own ends at the way's ends, square where the lift begins
     */
    const along = (kind: CoverKind, cl: P2[], w: number | number[], ways: RibbonEnds, prio = 0, segs?: VertexAttr[], breaks?: ReadonlySet<number>): void => {
      const cum = cumulative(cl), ends = joints(line, ways);
      for (const [d0, d1] of runs) {
        const part = runPart(cl, cum, w, ends, d0, d1, len);
        ribbon(kind, line, part.c, part.half, part.ends, prio, tie, segs, part.first, breaks);
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
    if (style.marks) {
      // narrowing into a narrower continuation; its paint per segment of the whole way
      const p = painted(line, pts, half, style.marks, net);
      if (p.c.length >= 2) along('carriageway', p.c, p.half, ends, prio, p.segs, new Set(p.breaks));
    } else along('carriageway', c, half, ends, prio);
    if (shoulder) along('shoulder', c, half + shoulder, ends, prio);
  };

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
      }
    }
    if (area.tags.leisure === 'pitch') buildPitchPaint(area);
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
      if (only >= 0 ? si !== only : skip?.(si)) continue;
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

  return {
    shapes,
    locate: (x, y, skip) => {
      const gi = find(x, y, -1, skip);
      return gi < 0 ? -1 : triShape[gi];
    },
    outside,
  };
}
