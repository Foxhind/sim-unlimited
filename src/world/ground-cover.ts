/**
 * The ground covers of a tile: what lies on the ground where — the asphalt and shoulders of the
 * roads, paths, the ballast and right-of-way strip of the railways, runways, water, aerodrome areas,
 * car parks, pitches and their paint, parks and fields — as shapes in the tile's lattice, the senior
 * first (COVER_RANK). A shape has its triangles (what it covers: `locate` finds the senior one at a
 * point) and its edge (what the surface TIN takes as fixed edges). Built from the whole ways and
 * areas, not the tile's share of them, so the tiles round a border agree. Bridges, tunnels and the
 * lifted stretches of the ways (the approaches to the bridges) cover nothing: they run over it.
 */
import earcut from 'earcut';
import { colourOf, RAMP, snowy, withGlow, rampGlowLevel, type RGB } from '../engine/palette';
import { DEFAULT_AREA_STYLES, filterColour, type AreaStyles } from './area-styles';
import { enuToLatLon, latLonToEnu, tileCenter, tileLattice, tileSizeMeters, type Tile } from './geodesy';
import type { OsmArea, OsmLine, OsmPoint } from './osm-types';
import { isLitPitch as isLitPitchRing, pitchFrame } from './pitch-markings';
import { lineNetwork, painted, ribbonGeom, ROUND_ENDS, trackSegs, type P2, type RibbonEnds, type VertexAttr } from './ribbon-shapes';
import { buildRoadLevels, coverLifted } from './road-levels';
import type { RoadSurface } from './road-pull';
import { BALLAST_RAMP, classifyArea, classifyLine, isLitRoad, isOpenCarPark, isTunnel, LIT_ROAD_GLOW, PITCH_GLOW, RAIL_ZONE_M, RAIL_ZONE_RAMP, roadPriority, SHOULDER_RAMP, tieBreak, UNLIT_ROAD_GLOW, waterwayWidth, type AreaStyle } from './way-styles';

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

const SQUARE_ENDS: RibbonEnds = { capStart: false, capEnd: false };
const isBridge = (tags: Record<string, string>): boolean => !!tags.bridge && tags.bridge !== 'no';

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
 * The stretches of a way on the ground, metres from its start (along its points, `e` in ENU), and
 * its length: probed every LIFT_PROBE_M, each flip found to LIFT_SNAP_M and kept to the ground's side
 */
export function groundRuns(line: OsmLine, e: P2[], lifted: (line: OsmLine, d: number) => boolean): { runs: [number, number][]; len: number } {
  let len = 0;
  for (let i = 1; i < e.length; i++) len += Math.hypot(e[i][0] - e[i - 1][0], e[i][1] - e[i - 1][1]);
  const onGround = (d: number) => !lifted(line, d);
  const runs: [number, number][] = [];
  const steps = Math.max(1, Math.ceil(len / LIFT_PROBE_M));
  let prev = 0, was = onGround(0), start: number | undefined = was ? 0 : undefined;
  for (let k = 1; k <= steps; k++) {
    const d = (len * k) / steps, is = onGround(d);
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
export function liftedRuns(line: OsmLine, e: P2[], lifted: (line: OsmLine, d: number) => boolean): { runs: [number, number][]; len: number } {
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
  const lifted = coverLifted(roads, buildRoadLevels(data.lines, data.areas, ([lon, lat]) => enu(lon, lat)));

  interface Draft { shape: CoverShape; rank: number; tie: number; triSeg?: Int32Array; index: number }
  const drafts: Draft[] = [];
  const add = (kind: CoverKind, source: CoverShape['source'], prio: number, tris: Float64Array, outline: P2[][], tie = 0, segs?: VertexAttr[], triSeg?: Int32Array): void => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < tris.length; k += 2) {
      x0 = Math.min(x0, tris[k]); x1 = Math.max(x1, tris[k]);
      y0 = Math.min(y0, tris[k + 1]); y1 = Math.max(y1, tris[k + 1]);
    }
    // nothing of it in the tile (none at all: no triangles)
    if (!(x1 >= 0 && x0 <= grid && y1 >= 0 && y0 <= grid)) return;
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

  /** a ribbon's shape; its triangles' segments offset by `first` (it is a stretch of a longer centre line) */
  const ribbon = (kind: CoverKind, line: OsmLine, c: P2[], half: number | number[], ends: RibbonEnds, prio: number, tie: number, segs?: VertexAttr[], first = 0): void => {
    if (c.length < 2) return;
    const g = ribbonGeom(c, half, ends, latticePerMetre);
    const outline = kind === 'carriageway' || kind === 'ballast' || kind === 'runway' ? [...g.outline, ...g.cuts] : g.outline;
    add(kind, line, prio, flat(g.tris), outline, tie, segs, segs ? Int32Array.from(g.triSeg, (s) => s + first) : undefined);
  };

  const buildLine = (line: OsmLine): void => {
    const style = classifyLine(line.tags);
    if (!style || line.points.length < 2 || isTunnel(line.tags) || isBridge(line.tags)) return;
    const road = !!line.tags.highway;
    const e = line.points.map((ll) => enu(ll[0], ll[1]));
    let pts = line.points.map((ll, i) => ({ c: toLattice(ll), e: e[i] }))
      .filter((p, i, a) => i === 0 || p.c[0] !== a[i - 1].c[0] || p.c[1] !== a[i - 1].c[1]);
    if (pts.length < 2) return;
    if (road) pts = net.forkShift(line, pts);
    const c = pts.map((p) => p.c);
    const half = style.width / 2, shoulder = style.shoulder ?? 0, zone = style.rail ? RAIL_ZONE_M : 0;
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
    const along = (kind: CoverKind, cl: P2[], w: number | number[], ends: RibbonEnds, prio = 0, segs?: VertexAttr[]): void => {
      const cum = cumulative(cl);
      for (const [d0, d1] of runs) {
        const part = runPart(cl, cum, w, ends, d0, d1, len);
        ribbon(kind, line, part.c, part.half, part.ends, prio, tie, segs, part.first);
      }
    };
    if (style.rail) {
      // the ballast carries the track: its segments' attributes
      along('ballast', c, half, ROUND_ENDS, 0, trackSegs(pts));
      along('railZone', c, half + zone, ROUND_ENDS);
      return;
    }
    if (!road) {
      along(waterwayWidth(line.tags) !== undefined ? 'water' : 'runway', c, half, ROUND_ENDS);
      return;
    }
    const ends = net.roadEnds(line);
    if (style.path) {
      along('path', c, half, ends);
      return;
    }
    const prio = roadPriority(line.tags, style.width);
    if (style.marks) {
      // narrowing into a narrower continuation; its paint per segment of the whole way
      const p = painted(line, pts, half, style.marks, net);
      if (p.c.length >= 2) along('carriageway', p.c, p.half, ends, prio, p.segs);
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
  let g = 0;
  shapes.forEach((s, si) => {
    for (let k = 0; k < s.tris.length / 6; k++, g++) {
      triShape[g] = si;
      triLocal[g] = k;
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

  return {
    shapes,
    locate: (x, y, skip) => {
      const gi = find(x, y, -1, skip);
      return gi < 0 ? -1 : triShape[gi];
    },
  };
}
