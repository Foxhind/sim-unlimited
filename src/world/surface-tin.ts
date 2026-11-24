/**
 * The surface of a tile built under its roads (roads first, then the land): the base belt TIN with
 * the roads' bed outlines and the edges of every ground cover (ground-cover.ts) as fixed edges and
 * the lattice nodes of the roads' pull bands as vertices, every vertex's height then replaced by the
 * pulled ground (road-pull.ts); each face then takes the cover under its centre. One function for
 * every builder of a tile's surface: the terrain mesh, the OSM drape and the collision ground.
 */
import type { Pad } from './aerodrome';
import type { Pt } from './contours';
import { EARTH_R, tileCenter, tileSizeMeters, type Tile } from './geodesy';
import { COVER_RANK, type CoverKind, type GroundCover } from './ground-cover';
import type { OsmArea, OsmLine } from './osm-types';
import type { P2 } from './ribbon-shapes';
import { fetchRoadDem, roadWindow, solveRoadHeights } from './road-heights';
import { buildRoadLevels } from './road-levels';
import { buildRoadNet, type NetWay, type RoadNet } from './road-net';
import { BED_MARGIN_M, BED_PLAN_TOL_M, bridgeCrossings, roadPullOf, snapBorder, type RoadSurface } from './road-pull';
import { buildTerrainTin, type SurfacePlan, type TerrainTin, type TinOptions } from './terrain-tin';
import { classifyLine, roadPriority, tieBreak } from './way-styles';

export type { RoadSurface } from './road-pull';

/**
 * the most vertices a tile's surface may have: over it the youngest covers' edges go first, a park
 * before a road, and a road's or a river's bed outline with it
 */
export const MAX_SURFACE_VERTS = 30000;
/**
 * the vertices the covers' lines make where they cross the isolines, the beds alone and each other,
 * per point of theirs: −3 to +2 % on the real tiles measured (Innsbruck 14/8710/5744, Fethiye
 * 14/9517/6397 and round it, Dalaman), up to 50 % on a random town's crossings off the nodes
 */
const CROSSINGS = 0.05;
/** a bed outline's point is put on a cover edge but within this of a point of it, metres (profileOnto) */
const PROFILE_GAP_M = 0.5;
/** over the budget, the next build takes this share of the room the last one's crossings leave (the rest cross more) */
const RETRY_ROOM = 0.97;
/** the base relief's fixed edges get a vertex this often where they run through a pull band, metres */
const BAND_EDGE_STEP_M = 12;
/** at most this many band points a tile (about the lattice nodes it had: 65²) */
const MAX_BAND_POINTS = 4500;
/** the zoom with the roads (chunks.ts DETAIL_Z) */
const ROADS_Z = 14;
/** the covers drawn along a way: dropped from the surface, the way's ribbon lies over it (SurfaceTin.loose) */
const RIBBON_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(['runway', 'ballast', 'carriageway', 'shoulder', 'path', 'railZone']);
/** a water face with a corner under a road's cover, raised this much or more off the river's level, is the road's bank (the ground's), metres */
const BANK_STEP_M = 0.5;
/** a vertex this close to a road's cover is under it (its edge thinned by 2 cm, its vertices snapped by 3), metres */
const COVER_SNAP_M = 0.06;
/** the covers of a road: under them a river gives way (RoadPull.surface) */
const ROAD_COVERS: ReadonlySet<CoverKind> = new Set<CoverKind>(['carriageway', 'shoulder', 'path']);

export interface SurfaceOptions extends TinOptions {
  roads?: RoadSurface;
  /** the tile's ground covers: every edge of them a fixed edge while the vertices last, each face its cover */
  cover?: GroundCover;
  /** the vertex budget, MAX_SURFACE_VERTS unless given (tests: a tile over it without thousands of ways) */
  maxSurfaceVerts?: number;
  /** filled with how the surface was built (tests, measurements) */
  stats?: SurfaceStats;
}

/** how a surface was built */
export interface SurfaceStats {
  /** the triangulations of the surface: the first, and one more each time it came out over the budget */
  builds: number;
  /** the relief's vertices, the extra points, and the points of the picked units' lines */
  relief: number;
  points: number;
  lines: number;
  /** the units (a way's or an area's covers with its bed, a bed alone) and how many of them went in */
  units: number;
  picked: number;
}

export interface SurfaceTin extends TerrainTin {
  /** ways whose edges the vertex budget left out (roads, paths, railways, runways): their ribbons lie on the ground as ever */
  loose?: Set<OsmLine>;
  /**
   * With `cover`: per face, the index of its cover in `cover.shapes` (the senior shape under its
   * centre, a dropped ribbon passed over), or −1 (the bare ground)
   */
  cover?: Int32Array;
  /**
   * The areas and waters whose edges the vertex budget left out (indices into `cover.shapes`, the
   * senior first; a pitch's paint, a helipad's square and a river's water among them): a face is
   * one's only where it lies wholly in it, so the mesh draws the rest of each over the faces it
   * covers (osm-mesher), as it draws the ribbons of `loose`
   */
  looseShapes?: number[];
  /** with `looseShapes`: whether a face is on a road's bank (the ground's, whatever water lies over it) */
  bank?: (face: number) => boolean;
}

/**
 * What goes into the surface or out of it together: a way's or an area's covers (a pitch with its
 * paint; a way's outermost edge is its bed's), or a bed alone (no covers: roads only, or none here)
 */
interface Unit {
  /** its fixed lines (lattice, inside the tile) and their vertices (distinct points), once `settle` has run */
  lines: Pt[][];
  count: number;
  /** fills `lines` and `count` where its shapes' edges are yet to be cut by their seniors (coverUnits): the units picked only */
  settle?: () => void;
  /** its shapes (indices into cover.shapes) */
  shapes: number[];
  /** the way it is drawn along when it is left out: a ribbon kind's source or a bed's way */
  way?: OsmLine;
  /** its place: budgetRank, roadPriority, tieBreak of its senior shape (ground-cover.ts), then that shape's index */
  rank: number;
  prio: number;
  tie: number;
  first: number;
}

/**
 * A detailed (z14) tile's relief follows its lattice within this many metres, and its border line
 * too: its roads and rivers lie on the true relief (raw DEM), and a coarser one let them show
 * through it in trenches 10–16 m deep (14/9515/6394, where the belts left four vertices)
 */
export const Z14_RELIEF_TOL_M = 5;
/**
 * A detailed (z14) tile's isolines: every 25 m, simplified to a tenth of a cell (3 m), not moved
 * uphill (TinOptions.inscribed), and never simplified looser for the budget (thicker belts instead).
 * With the 150 m belts, simplified to a cell and more and moved uphill, an isoline lay 20 m under the
 * ground beside the relief's nodes at their own height: needles a metre wide and hundreds of metres
 * long down every slope (14/9514/6399, 14/9516/6398); and those nodes, 2000 on a hill tile, stood on
 * the lattice, its squares read in the faces. Now the isolines carry the relief: under 300 nodes there.
 */
export const Z14_BELT_STEP_M = 25;
export const Z14_EPS_CELLS = 0.1;
/** a z14 tile's isoline vertex budget (the surface's: MAX_SURFACE_VERTS) */
export const Z14_RELIEF_VERTS = 20000;
/** the relief options of a detailed (z14) tile */
export const Z14_RELIEF: Readonly<TinOptions> = {
  borderTol: Z14_RELIEF_TOL_M, reliefTol: Z14_RELIEF_TOL_M, step: Z14_BELT_STEP_M, eps: Z14_EPS_CELLS, epsMax: Z14_EPS_CELLS,
  inscribed: false, maxVerts: Z14_RELIEF_VERTS,
};

export function buildSurfaceTin(tile: Tile, grid: number, heights: Float32Array, opts: SurfaceOptions = {}): SurfaceTin {
  const { roads, cover, maxSurfaceVerts = MAX_SURFACE_VERTS, stats, ...given } = opts;
  // the options given override the z14 relief's, but those left undefined (a mesher passing on its own)
  const set = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as TinOptions;
  const tinOpts: TinOptions = tile.z === ROADS_Z ? { ...Z14_RELIEF, ...set } : given;
  const pull = roads && roads.net.ways.length ? roadPullOf(tile, grid, roads, !!cover) : undefined;
  if (!pull && !cover) return buildTerrainTin(tile, grid, heights, tinOpts);
  // where the covers' edges cross the tile border, whether kept or not: the neighbour has them too
  const coverBorder: Pt[] = [];
  const units = cover
    ? coverUnits(cover, grid, coverBorder, pull?.beds ?? [], pull?.banks ?? [], pull?.ways ?? [], grid / tileSizeMeters(tile))
    : bedUnits(pull!.beds, pull!.banks, pull!.ways, grid, coverBorder);
  /**
   * whether a road's cover (carriageway, shoulder, path) holds lattice point (x, y), or within
   * COVER_SNAP_M of it: a vertex of its edge, thinned and snapped, may lie a hair outside it
   */
  const snap = (COVER_SNAP_M * grid) / tileSizeMeters(tile);
  const roadAt = cover ? (x: number, y: number): boolean => [[0, 0], [snap, 0], [-snap, 0], [0, snap], [0, -snap]].some(([dx, dy]) => {
    const si = cover.locate(x + dx, y + dy);
    return si >= 0 && ROAD_COVERS.has(cover.shapes[si].kind);
  }) : undefined;
  let picked = 0;
  const tin = buildTerrainTin(tile, grid, heights, {
    ...tinOpts,
    // planned on the relief once it is built (one relief build, however many surface builds)
    surface: (relief): SurfacePlan => {
      const points: Pt[] = [];
      if (pull) {
        // the fall from a road to the relief: points on rows along the roads in their bands (not the
        // lattice: that made the bands square), and on the border the lattice nodes the roads pull
        // (the neighbour has the same) and where the outlines and rows cross it
        points.push(...pull.bandPoints(MAX_BAND_POINTS));
        for (let k = 0; k <= grid; k++) {
          for (const [i, j] of [[k, 0], [k, grid], [0, k], [grid, k]]) if (pull.weight(i, j) > 0) points.push({ x: i, y: j });
        }
        points.push(...pull.borderPoints);
        // and along the relief's fixed edges (isolines, coast) through the bands: an edge there is
        // straight between vertices far apart while the pulled ground under it is not
        const step = BAND_EDGE_STEP_M / (tileSizeMeters(tile) / grid);
        for (const [u, v] of relief.constraints) {
          const ax = relief.vx[u], ay = relief.vy[u], bx = relief.vx[v], by = relief.vy[v];
          if ((ax === bx && (ax === 0 || ax === grid)) || (ay === by && (ay === 0 || ay === grid))) continue; // the border: shared points only
          const n = Math.floor(Math.hypot(bx - ax, by - ay) / step);
          for (let k = 1; k < n; k++) {
            const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
            if (pull.weight(x, y) > 0) points.push({ x, y });
          }
        }
      }
      points.push(...coverBorder);
      // the outlines while the vertices last: their distinct points and CROSSINGS more for where
      // they cross the isolines, the beds and each other (one build, mostly); over the budget, again
      // with as many more as that build made
      const base = relief.vx.length + points.length;
      let room = (maxSurfaceVerts - base) / (1 + CROSSINGS);
      let attempt = 0, used = 0;
      const pick = () => {
        picked = 0;
        used = 0;
        for (; picked < units.length; picked++) {
          const u = units[picked];
          u.settle?.();
          if (used + u.count > room) break;
          used += u.count;
        }
        if (stats) Object.assign(stats, { builds: attempt + 1, relief: relief.vx.length, points: points.length, lines: used, units: units.length, picked });
        return units.slice(0, picked).flatMap((u) => u.lines);
      };
      return {
        extraPoints: points,
        reshape: pull ? (x, y, h) => pull.surface(x, y, h, roadAt) : (_x, _y, h) => h,
        next: (vertices) => {
          if (vertices === undefined) return pick();
          if (vertices <= maxSurfaceVerts || picked === 0 || ++attempt >= 6) return undefined;
          const made = used > 0 ? Math.max(1, (vertices - base) / used) : 1;
          room = Math.min(room - 16, ((maxSurfaceVerts - base) / made) * RETRY_ROOM);
          return pick();
        },
      };
    },
  });
  // the units the budget left out: a way drawn as a ribbon (a road, path, railway or runway, or a bed
  // without a shape) is drawn over the ground as before; an area or water still colours the faces
  // that lie in it, the rest of it drawn over the faces by the mesh (looseShapes)
  const loose = new Set<OsmLine>();
  for (const u of units.slice(picked)) if (u.way) loose.add(u.way);
  const out: SurfaceTin = loose.size ? { ...tin, loose } : tin;
  if (!cover) return out;
  // each face the senior cover under its centre: all its edges are the faces' (but a dropped unit's),
  // so the centre tells. A dropped ribbon's shapes are passed over: its faces take the junior cover
  // under them (a park the road crosses), −1 only on the bare ground, and its ribbon lies over them.
  // A dropped area's or water's edge is no edge of the faces: one takes it only when its corners lie
  // in it too (a small pool under a big face goes, rather than painting the face), else the next under it
  const dropped = new Uint8Array(cover.shapes.length);
  for (const u of units.slice(picked)) for (const si of u.shapes) dropped[si] = RIBBON_KINDS.has(cover.shapes[si].kind) ? 1 : 2;
  let passed: number[] = [];
  const skip = (si: number) => dropped[si] === 1 || passed.includes(si);
  const holds = (si: number, x: number, y: number) => cover.locate(x, y, (sj) => sj !== si) === si;
  const faces = new Int32Array(tin.tris.length);
  /** per vertex: 0 not asked, 1 under a road's cover over a river's water, its ground the land's (RoadPull.surface) BANK_STEP_M or more off the water's, 2 not */
  const roadV = new Uint8Array(tin.vx.length);
  const underRoad = (v: number): boolean => {
    if (!roadV[v]) {
      const x = tin.vx[v], y = tin.vy[v];
      // on a river's water (its level, whatever the relief under it) and raised off it
      const water = pull?.surface(x, y, 0) ?? NaN;
      roadV[v] = water === pull?.surface(x, y, 1000) && Math.abs(tin.vh[v] - water) > BANK_STEP_M && roadAt!(x, y) ? 1 : 2;
    }
    return roadV[v] === 1;
  };
  const looseShapes: number[] = [];
  dropped.forEach((d, si) => { if (d === 2) looseShapes.push(si); });
  const centre = (t: { a: number; b: number; c: number }): [number, number] => [(tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3];
  // a road's bank (between its cover's edge and the water row BANK_M beyond it, or from a corner
  // under a road's cover over a river, at the land's height, down to the water) is the ground's
  const onBank = (t: { a: number; b: number; c: number }, x: number, y: number): boolean => !!pull?.bank(x, y) || [t.a, t.b, t.c].some(underRoad);
  tin.tris.forEach((t, f) => {
    const [x, y] = centre(t);
    passed = [];
    let si = cover.locate(x, y, skip);
    while (si >= 0 && dropped[si] === 2 && ![t.a, t.b, t.c].every((v) => holds(si, tin.vx[v], tin.vy[v]))) {
      passed.push(si);
      si = cover.locate(x, y, skip);
    }
    faces[f] = si >= 0 && cover.shapes[si].kind === 'water' && onBank(t, x, y) ? -1 : si;
  });
  if (!looseShapes.length) return { ...out, cover: faces };
  // a dropped water is drawn over the faces: not over a road's bank, whatever that face's cover (asked of the few faces it reaches)
  return { ...out, cover: faces, looseShapes, bank: (f) => onBank(tin.tris[f], ...centre(tin.tris[f])) };
}

/**
 * each road's or river's bed outline alone, the senior first (as road-pull lays them), a road's
 * bank with it (cut to the tile, where it crosses the border into `border`)
 */
function bedUnits(beds: ReadonlyArray<{ way: number; edges: Pt[][] }>, banks: ReadonlyArray<{ way: number; lines: Pt[][] }>, ways: ReadonlyArray<NetWay>, grid: number, border: Pt[]): Unit[] {
  const units = beds.map((b, i): Unit => ({ lines: [...b.edges], count: 0, shapes: [], way: ways[b.way].line, rank: 0, prio: 0, tie: 0, first: i }));
  const byWay = new Map(beds.map((b, i) => [b.way, units[i]]));
  for (const b of banks) {
    let u = byWay.get(b.way);
    if (!u) {
      u = { lines: [], count: 0, shapes: [], way: ways[b.way].line, rank: 0, prio: 0, tie: 0, first: units.length };
      byWay.set(b.way, u);
      units.push(u);
    }
    for (const line of b.lines) u.lines.push(...clipToTile(line.map((p): P2 => [p.x, p.y]), grid, border));
  }
  for (const u of units) u.count = u.lines.reduce((s, e) => s + e.length, 0);
  return units;
}

/**
 * The covers by source (a way's or an area's shapes together, a pitch with its paint), the senior
 * first; a bed of a way without a shape here on its own, ranked as its way's carriageway or water.
 * A way's covers have no bed outline: their outermost edge (the shoulder's, the carriageway's, the
 * water's) is its bed's edge, the pull giving every vertex its height (BED_MARGIN_M only kept a
 * ribbon's bias off the bed's fall); the bed outline's points move onto that edge (profileOnto), so
 * it bends with the road's height as the bed's did. A way the budget drops goes as before: its unit,
 * and so its edges, out; its ribbon lies over the pulled ground. Their edges cut to the tile; where they cross its border into `border`. A shape's edge inside a senior shape is left out
 * (it parts faces of that one cover): a senior whose unit comes no later, so it is in the surface
 * whenever this one is.
 */
function coverUnits(
  cover: GroundCover, grid: number, border: Pt[], beds: ReadonlyArray<{ way: number; edges: Pt[][] }>, banks: ReadonlyArray<{ way: number; lines: Pt[][] }>,
  ways: ReadonlyArray<NetWay>, latticePerMetre: number,
): Unit[] {
  const units: Unit[] = [];
  /** each covered way's bed outline: its points go onto the way's own edges when it is picked */
  const profiles = new Map<Unit, Pt[][]>();
  /** each covered way's bank (cut to the tile): its lines once it is picked */
  const shores = new Map<Unit, Pt[][]>();
  const bySource = new Map<object, Unit>();
  cover.shapes.forEach((s, si) => {
    let u = bySource.get(s.source);
    if (!u) {
      const road = s.kind === 'carriageway' || s.kind === 'shoulder';
      u = { lines: [], count: 0, shapes: [], rank: budgetRank(s.kind), prio: s.prio, tie: road ? tieBreak((s.source as OsmLine).points[0]) : 0, first: si };
      bySource.set(s.source, u);
      units.push(u);
    }
    u.shapes.push(si);
    if (RIBBON_KINDS.has(s.kind)) u.way = s.source as OsmLine;
  });
  units.sort(byPlace);
  /** each shape's unit's place */
  const place = new Int32Array(cover.shapes.length);
  units.forEach((u, i) => { for (const si of u.shapes) place[si] = i; });
  /** each unit's edges inside the tile (every one's border points now), cut by the seniors when it is picked */
  const pending = units.map(() => [] as { si: number; piece: P2[] }[]);
  cover.shapes.forEach((s, si) => {
    for (const line of s.outline) for (const piece of clipToTile(line, grid, border)) pending[place[si]].push({ si, piece: piece.map((p): P2 => [p.x, p.y]) });
  });
  units.forEach((u, i) => {
    u.settle = () => {
      u.settle = undefined;
      for (const { si, piece } of pending[i]) {
        for (const part of cover.outside(piece, si, (sj) => place[sj] <= place[si])) u.lines.push(part.map(([x, y]) => ({ x, y })));
      }
      const bed = profiles.get(u);
      if (bed) profileOnto(u.lines, bed, (BED_MARGIN_M + BED_PLAN_TOL_M + 0.1 + (u.way ? classifyLine(u.way.tags)?.shoulder ?? 0 : 0)) * latticePerMetre, PROFILE_GAP_M * latticePerMetre);
      // the bank where its bed meets the water, whole: a senior cover over it may be a bridge's,
      // which holds no ground at its height (road-pull), the bank's step under it
      for (const line of shores.get(u) ?? []) u.lines.push(line);
      u.count = distinctPoints(u.lines);
    };
  });
  beds.forEach((b, i) => {
    const line = ways[b.way].line;
    // a way with covers: their edge is the bed's, its points the bed's
    const own = bySource.get(line);
    if (own) {
      profiles.set(own, [...(profiles.get(own) ?? []), ...b.edges]);
      return;
    }
    const road = !!line.tags.highway;
    const u: Unit = {
      lines: b.edges, count: 0, shapes: [], way: line, rank: budgetRank(road ? 'carriageway' : 'water'),
      prio: road ? roadPriority(line.tags, classifyLine(line.tags)?.width ?? 0) : 0, tie: road ? tieBreak(line.points[0]) : 0, first: cover.shapes.length + i,
    };
    bySource.set(line, u);
    units.push(u);
  });
  // a road's bank goes with its covers, or with its bed alone (a bank without either: on its own, as a bed)
  banks.forEach((b, i) => {
    const line = ways[b.way].line;
    const pieces = b.lines.flatMap((l) => clipToTile(l.map((p): P2 => [p.x, p.y]), grid, border));
    if (!pieces.length) return;
    let u = bySource.get(line);
    if (!u) {
      u = {
        lines: [], count: 0, shapes: [], way: line, rank: COVER_RANK.carriageway, prio: roadPriority(line.tags, classifyLine(line.tags)?.width ?? 0),
        tie: tieBreak(line.points[0]), first: cover.shapes.length + beds.length + i,
      };
      bySource.set(line, u);
      units.push(u);
    }
    if (u.settle) shores.set(u, [...(shores.get(u) ?? []), ...pieces]);
    else u.lines.push(...pieces);
  });
  // the vertices a unit brings: its lines' points, each once (a cut's ends are its sides' points)
  for (const u of units) if (!u.settle) u.count = distinctPoints(u.lines);
  return units.sort(byPlace);
}

/**
 * Every point of a bed outline `bed` onto each of `lines` passing within `reach` of it (lattice), at
 * its nearest point there, unless that is within `gap` of a point of the line: the bed's points are
 * where its height along the road bends (road-pull simplifies it in height too), and so the sides
 * of the asphalt and of the shoulder bend with it on their side, across from each other (a way's
 * edges have only their plan's points: long faces across a straight road missed its rise between)
 */
function profileOnto(lines: Pt[][], bed: ReadonlyArray<ReadonlyArray<Pt>>, reach: number, gap: number): void {
  /** per line, the points to put in each segment: segment index, fraction, point */
  const adds = lines.map(() => [] as { k: number; t: number; p: Pt }[]);
  for (const l of bed) for (const q of l) {
    lines.forEach((line, li) => {
      let best = reach, at = -1, tt = 0;
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1], b = line[k], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
        const d = Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t);
        if (d < best) { best = d; at = k; tt = t; }
      }
      if (at < 0) return;
      const a = line[at - 1], b = line[at], len = Math.hypot(b.x - a.x, b.y - a.y);
      if (tt * len <= gap || (1 - tt) * len <= gap) return;
      adds[li].push({ k: at, t: tt, p: { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt } });
    });
  }
  lines.forEach((line, li) => {
    if (!adds[li].length) return;
    const by = adds[li].sort((p, q) => p.k - q.k || p.t - q.t);
    const out: Pt[] = [line[0]];
    let j = 0;
    for (let k = 1; k < line.length; k++) {
      for (let last = -Infinity; j < by.length && by[j].k === k; j++) {
        // two bed points onto one place: one
        if (by[j].t - last > 1e-9) out.push(by[j].p);
        last = by[j].t;
      }
      out.push(line[k]);
    }
    lines[li] = out;
  });
}

/** the distinct points of `lines` (to a rare collision of two in one key: an estimate) */
function distinctPoints(lines: ReadonlyArray<ReadonlyArray<Pt>>): number {
  const seen = new Set<number>();
  for (const l of lines) for (const p of l) seen.add(p.x * 4099 + p.y);
  return seen.size;
}

/**
 * A unit's rank in the budget: its cover's (COVER_RANK), but the water's before the paths'. A path
 * left out lies over the ground as a ribbon, as before; a water left out leaves the ground under it
 * the DEM's, its water drawn over that tilted, and a bridge's deck over a bank (14/9517/6398, where
 * every river and canal went). Where they overlap the path still lies over the water.
 */
const budgetRank = (k: CoverKind): number => (k === 'water' ? COVER_RANK.path - 0.5 : COVER_RANK[k]);
/** the senior unit first: by rank (budgetRank), priority, tie and first shape (a bed alone after every shape) */
const byPlace = (a: Unit, b: Unit): number => a.rank - b.rank || b.prio - a.prio || a.tie - b.tie || a.first - b.first;

/**
 * The pieces of lattice polyline `line` inside the tile, each ending where it reaches the border,
 * exactly on it (snapped as the road beds are: the neighbour cuts its own the same); a stretch along
 * the border is no piece (the border is an edge already). Every point of it on the border into `border`.
 */
function clipToTile(line: ReadonlyArray<P2>, grid: number, border: Pt[]): Pt[][] {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  const onBorder = (p: Pt) => p.x === 0 || p.x === grid || p.y === 0 || p.y === grid;
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], [bx, by] = line[k];
    // wholly outside the tile
    if ((ax < 0 && bx < 0) || (ax > grid && bx > grid) || (ay < 0 && by < 0) || (ay > grid && by > grid)) {
      flush();
      continue;
    }
    const ts = [0, 1];
    for (const [pa, pb] of [[ax, bx], [ay, by]]) {
      if (pa === pb) continue;
      for (const edge of [0, grid]) {
        const t = (edge - pa) / (pb - pa);
        if (t > 0 && t < 1) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    for (let c = 1; c < ts.length; c++) {
      const p = snapBorder({ x: ax + (bx - ax) * ts[c - 1], y: ay + (by - ay) * ts[c - 1] }, grid);
      const q = snapBorder({ x: ax + (bx - ax) * ts[c], y: ay + (by - ay) * ts[c] }, grid);
      if (p.x === q.x && p.y === q.y) continue;
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const inside = mx >= 0 && mx <= grid && my >= 0 && my <= grid;
      for (const r of [p, q]) if (inside && onBorder(r)) border.push(r);
      // outside, or along the border
      if (!inside || (p.x === q.x && (p.x === 0 || p.x === grid)) || (p.y === q.y && (p.y === 0 || p.y === grid))) {
        flush();
        continue;
      }
      if (!cur.length) cur.push(p);
      cur.push(q);
      // a piece ends on the border: its end is a shared border vertex, never a split of the border's edge
      if (onBorder(q)) flush();
    }
  }
  flush();
  return pieces;
}

/**
 * The roads of a z14 tile with their heights: the network, its raw DEM (on the pads round an
 * aerodrome), the heights by the window along it, and the lifts of bridges over what they cross.
 * Undefined below z14 or without roads. Throws what demHeights throws (RetryableError).
 */
export async function fetchRoadSurface(
  tile: Tile,
  data: { lines: OsmLine[]; areas: OsmArea[] },
  pads: ReadonlyArray<Pad>,
): Promise<RoadSurface | undefined> {
  if (tile.z !== ROADS_Z) return undefined;
  const net = buildRoadNet(data.lines);
  if (!net.ways.length) return undefined;
  return roadSurfaceOf(tile, data, net, await fetchRoadDem(net, pads));
}

/**
 * The heights of a tile's network from its raw DEM: the window along it, water down in its channel
 * (WATER_DEPTH_M), and the lifts of bridges over what they cross between the two surfaces
 */
export function roadSurfaceOf(tile: Tile, data: { lines: OsmLine[]; areas: OsmArea[] }, net: RoadNet, dem: ArrayLike<number>): RoadSurface {
  const h = solveRoadHeights(net, dem, roadWindow(tileCenter(tile).lat));
  net.samples.forEach((s, i) => (h[i] -= net.ways[s.way].depth));
  // H along each way by metres from its start
  const wayOf = new Map<OsmLine, number>();
  net.ways.forEach((w, k) => wayOf.set(w.line, k));
  const heightAt = (line: OsmLine, d: number): number => {
    const k = wayOf.get(line);
    if (k === undefined) return NaN;
    const w = net.ways[k];
    let i = w.first;
    const last = w.first + w.count - 1;
    while (i < last && net.samples[i + 1].d < d) i++;
    if (i >= last) return h[last];
    const a = net.samples[i], b = net.samples[i + 1];
    const t = b.d > a.d ? Math.max(0, Math.min(1, (d - a.d) / (b.d - a.d))) : 0;
    return h[i] + (h[i + 1] - h[i]) * t;
  };
  // the plane of the network's metres (road-net.ts metresBetween)
  const c = tileCenter(tile);
  const ky = (EARTH_R * Math.PI) / 180, kx = ky * Math.cos((c.lat * Math.PI) / 180);
  const levels = buildRoadLevels(data.lines, data.areas, ([lon, lat]) => [(lon - c.lon) * kx, -(lat - c.lat) * ky], { height: heightAt });
  const z = Float64Array.from(net.samples, (s, i) => h[i] + levels.liftAt(net.ways[s.way].line, s.d));
  return { net, z, dem, over: bridgeCrossings(net, data.lines) };
}
