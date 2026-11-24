import earcut from 'earcut';
import { colour, colourOf, isMaterial, LIGHT, LUT_SIZE, RAMP, rampGlowLevel, rampIndex, rgbOf, snowy, withGlow, type RGB } from '../engine/palette';
import { DEFAULT_AREA_STYLES, filterColour, type AreaFilter, type AreaStyles } from './area-styles';
import type { FaceColor } from './landsat';
import { enuToLatLon, gridLatLon, latLonToEnu, tileBounds, tileCenter, tileLattice, tileSizeMeters, type Tile } from './geodesy';
import { buildBuildingMesh } from './building-mesher';
import { clipTileData } from './clip';
import { INSTANCE, LAMP_SHAPE, pushInstance } from './props-mesher';
import { isLitPitch, pitchFrame } from './pitch-markings';
export { PITCH_LIT_MIN_M2 } from './pitch-markings';
export { FORK_TAPER_M, ROAD_EDGE, ROAD_MARK, ROAD_MARK_END_M, ROAD_TAPER_M, ROAD_U_BASE, TRACK_EDGE } from '../engine/palette';
import type { LonLat, OsmArea, OsmDetail, OsmLine, OsmPoint, OsmTileData } from './osm-types';
import type { HeightSampler } from './terrain-source';
import { latticeToWorld, type TerrainMeshData } from './terrain-mesher';
import type { SurfaceTin } from './surface-tin';
import { isSeaFace } from './terrain-tin';
import { COVER_RANK, coverRamp, cumulative, liftedJoints, liftedRuns, runPart, type CoverKind, type GroundCover } from './ground-cover';
import { buildRoadLevels, coverLifted, LIFT_EPS_M, type RoadLevels } from './road-levels';
import { bridgeDecks, DECK_CLEAR_M, type RoadSurface } from './road-pull';
import { buildDecks, type DeckRun, type DeckStation } from './bridge-mesher';
import { lineNetwork, painted, ribbonGeom, ROUND_ENDS, trackSegs, type P2, type RibbonEnds, type VertexAttr } from './ribbon-shapes';
import { clipToBox, depthLevels, type LevelItem } from './depth-levels';
import {
  AEROWAY_LINE_BIAS, classifyArea, classifyLine, isBridge, isLitRoad, isTunnel, LIT_ROAD_GLOW, PITCH_GLOW, PITCH_LINE_BIAS, RAIL_ZONE_M,
  RAIL_ZONE_RAMP, ROAD_LAYER_STEP_M, ROAD_RANK_STEP_M, ROAD_TIE_M, roadLayer, roadPriority, SHOULDER_RAMP, tieBreak, UNLIT_ROAD_GLOW,
} from './way-styles';
export {
  AEROWAY_AREA_BIAS, AEROWAY_LINE_BIAS, BALLAST_RAMP, BALLAST_WIDTH_M, CAR_PARK_BIAS, classifyLine, DIRT_ROAD_RAMP, GRAVEL_ROAD_RAMP, isLitRoad,
  isOnewayRoad, isOpenCarPark, isTunnel, LIT_ROAD_GLOW, osmWidthM, PAVING_RAMP, PITCH_BIAS, PITCH_GLOW, PITCH_LINE_BIAS, RAIL_ZONE_M, RAIL_ZONE_RAMP,
  roadClassWidth, ROAD_LAYER_STEP_M, roadLayer, roadMarks, roadPriority, roadRank, ROAD_RANK_STEP_M, ROAD_TIE_M, SHOULDER_RAMP, TRAIL_RAMP,
  UNLIT_ROAD_GLOW, waterwayWidth,
} from './way-styles';

export interface OsmMeshOptions {
  tile: Tile;
  detail: OsmDetail;
  data: OsmTileData;
  sampleHeight: HeightSampler;
  /** Max horizontal triangle edge before subdivision; defaults from tile size. */
  maxEdgeMeters?: number;
  /** include building geometry (default true); the game builds it as a separate mesh */
  buildings?: boolean;
  /**
   * The terrain the mesh lies on. With it, areas are cut by the terrain's faces and every piece
   * lies on its face; without it they are draped on `sampleHeight` (subdivided to maxEdgeMeters).
   */
  tin?: SurfaceTin;
  /**
   * Imagery colour of a TIN face (the terrain mesh's own). With it, filtered areas (AreaStyle.filter)
   * take the colour of the face under each piece blended with their filter (area-styles).
   */
  faceColor?: FaceColor;
  /** filters of the areas over the imagery (area style editor); DEFAULT_AREA_STYLES by default */
  areaStyles?: AreaStyles;
  /**
   * The tile's roads with their heights (surface-tin.ts), the TIN built under them. A bridge then
   * runs at its own height (H and its lift), whatever the ground under it; every other way lies
   * on the TIN, which is its road surface.
   */
  roads?: RoadSurface;
  /**
   * The ground covers the TIN was built with (its `cover` per face); used near ('full') only. With
   * both, the ground is one layer: the carriageway, ballast and runway faces of the TIN go to
   * `roads` and its water faces to `water`, on its own vertices, lifted by nothing; the areas, the
   * pitch markings and the helipads are the terrain's (terrain-mesher), not drawn here; of a way only
   * its lifted stretches are ribbons (with their lift, no bias, square where they meet the ground's
   * ways), but a way the TIN's budget dropped (`tin.loose`), drawn as without the cover yet on the
   * faces too (no bias), over the ground and over each other by its depth level (depth-levels.ts,
   * OsmMeshData.depthLevels), and an area or water it dropped (`tin.looseShapes`), drawn over the
   * faces that are not its own, under the ribbons; neither over the face of a cover senior to it.
   * Areas are known for the cover's by their tags object (the same object
   * in `data`, as clip.ts keeps it): the cover must be built from this very `data`, in the same worker.
   */
  cover?: GroundCover;
}

/** metres a vertex of a ribbon is lifted over the ground under it (road-levels.ts), from its position */
type Lift = (p: { x: number; z: number }) => number;
/** a lifted ribbon has a vertex at least this often along it: the lift bends between the vertices */
const LIFT_STEP_M = 10;
/** a straight deck (straightDecks) is fitted to its way's ground and lift sampled this often, m */
const DECK_SAMPLE_M = 2;
/** a road lifted less than this has nothing built under it */
const DECK_MIN_LIFT_M = 0.3;
/**
 * how far a ribbon reaches from its centre line, × its half width and in metres more: a mitred
 * joint (a turn no sharper than a right angle, ribbon-shapes) reaches √2 half widths out
 */
const LOOSE_REACH = Math.SQRT2;
const LOOSE_MARGIN_M = 0.5;

/** the covers drawn as faces of the road mesh (the water's go to the water mesh; the rest are the terrain's) */
const FACE_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(['carriageway', 'ballast', 'runway']);

/** the covers a lifted ribbon barely over them gives way to (liftedRibbons onJunction) */
const JUNCTION_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(['carriageway', 'ballast', 'runway', 'path']);
/** a lifted ribbon's piece lifted less than this over a junction's face is left out, metres */
const JUNCTION_LIFT_M = 0.5;
/**
 * a bridge's deck with its own height is drawn lifted only where it is this over the face under it,
 * whatever that face's cover, metres: lower, it lies on the face (the bed of a road along the bank a
 * bridge crosses holds the ground under the deck's end at the deck's own height)
 */
const DECK_FLOOR_M = DECK_CLEAR_M;

/** colour of a far road line: mid-lit asphalt (GL lines are not lit) */
const ROAD_LINE_INDEX = rampIndex(RAMP.ASPHALT, 8);
/** colour of a far railway line */
const RAIL_LINE_INDEX = rampIndex(RAMP.HULL_DARK, 7);

/** street lamps along lit roads: one every LAMP_SPACING_M, sides alternating; a one-way road keeps
 *  them on one side (see lampSide) */
export const LAMP_SPACING_M = 35;
export const LAMP_HEIGHT_M = LAMP_SHAPE.HEIGHT;
/** pole foot this far beyond the road edge; the arm reaches back over the road */
const LAMP_SETBACK_M = 1;

/**
 * the side of the way's drawing direction its lamps stand on: oneway=yes only to the right,
 * oneway=-1 only to the left, anything else alternating (0)
 */
export function lampSide(tags: Record<string, string>): 1 | -1 | 0 {
  if (tags.oneway === 'yes') return 1;
  if (tags.oneway === '-1') return -1;
  return 0;
}
const LAMP_RAMP = RAMP.HULL_DARK;

export interface OsmMeshData extends TerrainMeshData {
  /** road ribbons (highway=*) with their shoulders and railway tracks, drawn only near like the buildings */
  roads: TerrainMeshData;
  /** per road vertex WINDOW_ATTR_FLOATS (WORLD_VS aWinUV, aWinEdge): zero, on a track u, v and TRACK_EDGE */
  roadAttrs: Float32Array;
  /** street lamp posts: instances of INSTANCE.LAMP (props-mesher TREE_STRIDE), drawn with the trees */
  lampPosts: Float32Array;
  /**
   * water areas and river/canal ribbons, drawn after the drape without writing depth: whatever
   * comes after (roads first of all) always shows over the water
   */
  water: TerrainMeshData;
  /**
   * what carries the lifted roads (bridge-mesher.ts): slabs, parapets and piers of the bridges, the
   * embankments of their approaches; solid like the buildings, and drawn with them
   */
  bridges: TerrainMeshData;
  /** far stand-in for the roads: GL line vertex pairs (x, y, z, palette index) on the terrain */
  roadLines: Float32Array;
  /** pitch markings, drawn near: 1 px GL line vertex pairs (x, y, z, palette index) on the terrain */
  pitchLines: Float32Array;
  /** night: lamp heads at the ends of the lamp arms (x, y, z, palette index); far, the same points
   *  stand in for the street-lit roads as a dotted line */
  lamps: Float32Array;
  /**
   * per vertex of the drape, the roads and the water: its depth level (WORLD_VS aDepthLevel, 0 for
   * all but the ribbons of the ways the TIN dropped, with the cover: depth-levels.ts); empty when
   * the mesh has none (without the cover always)
   */
  depthLevels: Float32Array;
  roadDepthLevels: Float32Array;
  waterDepthLevels: Float32Array;
}

/** part [t0, t1] of segment p→q inside triangle `c` (lattice coordinates), or undefined */
function segmentInTriangle(p: P2, q: P2, c: [P2, P2, P2]): [number, number] | undefined {
  const turn = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[1][1] - c[0][1]) * (c[2][0] - c[0][0]);
  if (turn === 0) return undefined;
  const sign = turn > 0 ? 1 : -1;
  let t0 = 0, t1 = 1;
  for (let e = 0; e < 3; e++) {
    const a = c[e], b = c[(e + 1) % 3];
    const side = (x: number, y: number) => sign * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
    const sp = side(p[0], p[1]), sq = side(q[0], q[1]);
    if (sp < 0 && sq < 0) return undefined;
    if (sp < 0) t0 = Math.max(t0, sp / (sp - sq));
    else if (sq < 0) t1 = Math.min(t1, sp / (sp - sq));
  }
  return t1 > t0 + 1e-9 ? [t0, t1] : undefined;
}

/** convex polygon `subject` cut to the triangle `clip` (Sutherland–Hodgman); lattice coordinates */
function clipToTriangle(subject: P2[], clip: [P2, P2, P2]): P2[] {
  const turn = (clip[1][0] - clip[0][0]) * (clip[2][1] - clip[0][1]) - (clip[1][1] - clip[0][1]) * (clip[2][0] - clip[0][0]);
  if (turn === 0) return [];
  const sign = turn > 0 ? 1 : -1;
  let out = subject;
  for (let e = 0; e < 3 && out.length; e++) {
    const a = clip[e], b = clip[(e + 1) % 3];
    const side = (p: P2) => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const next: P2[] = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = next;
  }
  return out;
}

/** a mesh vertex: tile-centre world metres */
interface Vtx {
  x: number;
  z: number;
  y: number;
}
interface Pt extends Vtx {
  lon: number;
  lat: number;
}

/** the floodlight poles stand this far out from the pitch's corners, metres */
const PITCH_LAMP_SETBACK_M = 1.5;
/** pitch markings: white paint (the snow ramp, well lit) in the palette of the day */
export const PITCH_LINE_INDEX = rampIndex(RAMP.SNOW, 10);
/** on a floodlit pitch: the same from the brightest street-lit copy (the plain one by day, buildLUT) */
export const LIT_PITCH_LINE_INDEX = PITCH_GLOW * LUT_SIZE + PITCH_LINE_INDEX;

/** shape of a tunnel portal: an arch tube from the mouth into the hill, metres */
const PORTAL = {
  /** between the carriageway's edge and the wall */
  CLEARANCE: 1,
  /** the shell's thickness */
  WALL: 1.2,
  /** walls rise this high above the road before the arch springs */
  SPRING: 2.5,
  /** the arch's rise over the springing line at most (a wide road gets a flat arch, not a dome) */
  RISE: 5,
  /** walls reach this far below the road, so no gap opens on a slope */
  FOOT: 1.5,
  /** tube rings this far apart along the tunnel */
  STEP: 6,
  /** the tube ends where the hill buries it, at most this long (and half the tunnel) */
  MAX: 120,
  /** sides of the arch */
  SIDES: 10,
};
/** the tube's inside and its far cap: the dark of a tunnel seen from outside */
const TUNNEL_DARK = colour(16, 16, 18);
/** the tube's outside when there is no imagery under it */
const TUNNEL_EARTH = colour(112, 94, 70);

export function buildOsmMesh(opts: OsmMeshOptions): OsmMeshData {
  const { tile, sampleHeight } = opts;
  // only this tile's share: the drape knows no terrain beyond the tile border
  const data = clipTileData(opts.data, tile);
  const center = tileCenter(tile);
  const maxEdge = opts.maxEdgeMeters ?? Math.max(120, Math.min(500, tileSizeMeters(tile) / 12));
  // far 'large' layer sits slightly lower so the near 'full' layer wins depth where they overlap
  const biasScale = opts.detail === 'large' ? 0.4 : 1;
  // attrs: per vertex WINDOW_ATTR_FLOATS (WORLD_VS aWinUV, aWinEdge) where the mesh carries them;
  // depth: the depth levels (WORLD_VS aDepthLevel) of the vertices from `from` on (before it: 0)
  // faceOf: per vertex the TIN face it lies on (onFaces), where the mesh keeps them (what lies on the ground's faces: flushLoose)
  interface Out { verts: number[]; ramps: number[]; attrs?: number[]; depth?: { from: number; levels: number[] }; faceOf?: number[] }
  /** whether a piece on a face of cover `cover` (−1: none), TIN face `face`, its vertices lifted `lifts`, is left out (onFaces) */
  type LeftOut = (cover: number, lifts: number[] | undefined, face: number) => boolean;
  /** the least lift of a lifted ribbon's piece over its face, and where what is lower goes, on the face (onFaces) */
  interface Floor { clear: number; low: (cover: number) => Out | undefined }
  const main: Out = { verts: [], ramps: [] };
  const roads: Out = { verts: [], ramps: [], attrs: [] };
  const water: Out = { verts: [], ramps: [] };
  const roadLines: number[] = [];
  const pitchLines: number[] = [];
  const lamps: number[] = [];
  const lampPosts: number[] = [];
  const { verts, ramps } = main;

  const enu = (lon: number, lat: number): [number, number] => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const groundY = (lon: number, lat: number, bias: number): number => Math.max(sampleHeight(lon, lat), 0) + bias * biasScale;
  const makePt = (lon: number, lat: number, y: number): Pt => {
    const [x, z] = enu(lon, lat);
    return { lon, lat, x, z, y };
  };

  const emitTri = (a: Vtx, b: Vtx, c: Vtx, ramp: number, out: Out = main, attr?: VertexAttr): void => {
    const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
    const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) {
      out.verts.push(p.x, p.y, p.z, nx, ny, nz);
      out.ramps.push(ramp);
      if (out.attrs) {
        if (attr) out.attrs.push(...attr(p));
        else out.attrs.push(0, 0, 0, 0, 0);
      }
    }
  };

  const mid = (a: Pt, b: Pt, bias: number, flatY?: number): Pt => {
    const lon = (a.lon + b.lon) / 2;
    const lat = (a.lat + b.lat) / 2;
    const y = flatY ?? groundY(lon, lat, bias);
    return makePt(lon, lat, y);
  };
  const edgeLen = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);

  const subdivide = (a: Pt, b: Pt, c: Pt, ramp: number, bias: number, depth: number): void => {
    const longest = Math.max(edgeLen(a, b), edgeLen(b, c), edgeLen(c, a));
    if (longest <= maxEdge || depth >= 7) {
      emitTri(a, b, c, ramp);
      return;
    }
    const ab = mid(a, b, bias);
    const bc = mid(b, c, bias);
    const ca = mid(c, a, bias);
    subdivide(a, ab, ca, ramp, bias, depth + 1);
    subdivide(ab, b, bc, ramp, bias, depth + 1);
    subdivide(ca, bc, c, ramp, bias, depth + 1);
    subdivide(ab, bc, ca, ramp, bias, depth + 1);
  };

  // --- areas on the terrain's own faces ---
  const tin = opts.tin;
  /** the covers of the TIN's faces: with them the ground is one layer (OsmMeshOptions.cover) */
  const cover = opts.detail === 'full' && opts.cover && tin?.cover ? opts.cover : undefined;
  /** the areas with a shape among the covers (by the tags object of the whole, which the clipped share keeps): the terrain draws them */
  const coveredAreas = cover ? new Set(cover.shapes.filter((s) => 'rings' in s.source).map((s) => s.source.tags)) : undefined;
  const faces = tin
    ? tin.tris.map((t, fi) => {
        const c: [P2, P2, P2] = [[tin.vx[t.a], tin.vy[t.a]], [tin.vx[t.b], tin.vy[t.b]], [tin.vx[t.c], tin.vy[t.c]]];
        // the mesh draws water and anything below it at 0 m
        const h = [Math.max(0, tin.vh[t.a]), Math.max(0, tin.vh[t.b]), Math.max(0, tin.vh[t.c])];
        const det = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[2][0] - c[0][0]) * (c[1][1] - c[0][1]);
        return {
          c, h, det,
          // its index among the TIN's faces
          id: fi,
          // its cover (an index into opts.cover's shapes), or −1
          cover: tin.cover ? tin.cover[fi] : -1,
          x0: Math.min(c[0][0], c[1][0], c[2][0]), x1: Math.max(c[0][0], c[1][0], c[2][0]),
          y0: Math.min(c[0][1], c[1][1], c[2][1]), y1: Math.max(c[0][1], c[1][1], c[2][1]),
        };
      }).filter((f) => f.det !== 0)
    : [];
  // faces by lattice cell, so a small piece looks at the few faces around it
  const g = tin?.grid ?? 1;
  const buckets: number[][] = Array.from({ length: g * g }, () => []);
  const cell = (v: number) => Math.max(0, Math.min(g - 1, Math.floor(v)));
  faces.forEach((f, fi) => {
    for (let j = cell(f.y0); j <= cell(f.y1); j++) for (let i = cell(f.x0); i <= cell(f.x1); i++) buckets[j * g + i].push(fi);
  });
  const seen = new Uint32Array(faces.length);
  let stamp = 0;
  /** faces whose bounding box overlaps the box, each once */
  const facesNear = (x0: number, y0: number, x1: number, y1: number): typeof faces => {
    stamp++;
    const found: typeof faces = [];
    for (let j = cell(y0); j <= cell(y1); j++) {
      for (let i = cell(x0); i <= cell(x1); i++) {
        for (const fi of buckets[j * g + i]) {
          if (seen[fi] === stamp) continue;
          seen[fi] = stamp;
          const f = faces[fi];
          if (f.x1 <= x0 || f.x0 >= x1 || f.y1 <= y0 || f.y0 >= y1) continue;
          found.push(f);
        }
      }
    }
    return found;
  };
  /** a lattice point on face f, `bias` metres above it */
  const onFace = (f: (typeof faces)[number], x: number, y: number, bias: number): Pt => {
    const w1 = ((x - f.c[0][0]) * (f.c[2][1] - f.c[0][1]) - (f.c[2][0] - f.c[0][0]) * (y - f.c[0][1])) / f.det;
    const w2 = ((f.c[1][0] - f.c[0][0]) * (y - f.c[0][1]) - (x - f.c[0][0]) * (f.c[1][1] - f.c[0][1])) / f.det;
    const ll = gridLatLon(tile, x, y, tin!.grid);
    return makePt(ll.lon, ll.lat, f.h[0] * (1 - w1 - w2) + f.h[1] * w1 + f.h[2] * w2 + bias * biasScale);
  };
  /** the TIN's lattice point of a lon/lat (only with the TIN) */
  const latticeOf = tin ? tileLattice(tile, tin.grid) : undefined;
  const toLattice = (p: LonLat): P2 => latticeOf!(p);
  /** imagery colour of a face, once per face (undefined: none, a material ramp) */
  const faceRgb = new Map<(typeof faces)[number], RGB | undefined>();
  const imageryOf = (f: (typeof faces)[number]): RGB | undefined => {
    if (!opts.faceColor) return undefined;
    if (faceRgb.has(f)) return faceRgb.get(f);
    const packed = opts.faceColor(f.c[0][0], f.c[0][1], f.c[1][0], f.c[1][1], f.c[2][0], f.c[2][1]);
    const rgb = isMaterial(packed) ? undefined : rgbOf(packed);
    faceRgb.set(f, rgb);
    return rgb;
  };
  /** one triangle of an area, cut by every terrain face under it: each piece lies on its face */
  /**
   * `over`: whether a piece on a face of that cover (and that index among the TIN's faces), lifted so
   * (its vertices' lifts; undefined: none), is left out; `floor`: what is left of it is drawn only where it is lifted `clear` over its face,
   * the rest of it on the face itself, into `low` of the face's cover (undefined: left out)
   */
  const onFaces = (tri: [P2, P2, P2], ramp: number, bias: number, out: Out = main, filter?: AreaFilter, attr?: VertexAttr, lift?: Lift, over?: LeftOut, floor?: Floor): void => {
    const x0 = Math.min(tri[0][0], tri[1][0], tri[2][0]), x1 = Math.max(tri[0][0], tri[1][0], tri[2][0]);
    const y0 = Math.min(tri[0][1], tri[1][1], tri[2][1]), y1 = Math.max(tri[0][1], tri[1][1], tri[2][1]);
    for (const f of facesNear(x0, y0, x1, y1)) {
      const piece = clipToTriangle(tri, f.c);
      if (piece.length < 3) continue;
      const pts = piece.map(([x, y]) => onFace(f, x, y, bias));
      const lifts = lift ? pts.map((p) => lift(p)) : undefined;
      if (over?.(f.cover, lifts, f.id)) continue;
      if (lifts) pts.forEach((p, k) => { p.y += lifts[k]; });
      if (lifts && floor && lifts.some((l) => l < floor.clear)) {
        // cut where its lift passes the floor along its edges (the piece as drawn is straight along them)
        const { clear } = floor, high: Pt[] = [], low: Pt[] = [];
        for (let k = 0; k < pts.length; k++) {
          const n = (k + 1) % pts.length, la = lifts[k], lb = lifts[n];
          if (la >= clear) high.push(pts[k]);
          else low.push({ ...pts[k], y: pts[k].y - la });
          if (la >= clear === lb >= clear) continue;
          const t = (clear - la) / (lb - la), cut = onFace(f, piece[k][0] + (piece[n][0] - piece[k][0]) * t, piece[k][1] + (piece[n][1] - piece[k][1]) * t, bias);
          low.push(cut);
          high.push({ ...cut, y: cut.y + clear });
        }
        // what is under the floor lies on the face itself
        const on = floor.low(f.cover);
        if (on) {
          for (let k = 1; k + 1 < low.length; k++) emitTri(low[0], low[k], low[k + 1], ramp, on, attr);
          if (on.faceOf) while (on.faceOf.length < on.ramps.length) on.faceOf.push(f.id);
        }
        if (high.length < 3) continue;
        pts.length = 0;
        pts.push(...high);
      }
      const under = filter && imageryOf(f);
      const col = under ? withGlow(snowy(colourOf(filterColour(under, filter))), rampGlowLevel(ramp)) : ramp;
      for (let k = 1; k + 1 < pts.length; k++) emitTri(pts[0], pts[k], pts[k + 1], col, out, attr);
      if (out.faceOf) while (out.faceOf.length < out.ramps.length) out.faceOf.push(f.id);
    }
  };
  /** a segment cut by the terrain faces it crosses: GL line pairs lying on them */
  const lineOnFaces = (p: P2, q: P2, bias: number, out: number[], index: number, lift?: Lift): void => {
    const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]);
    const y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
    // a box of zero width finds no face: widen it a hair
    for (const f of facesNear(x0 - 1e-6, y0 - 1e-6, x1 + 1e-6, y1 + 1e-6)) {
      const t = segmentInTriangle(p, q, f.c);
      if (!t) continue;
      for (const s of t) {
        const v = onFace(f, p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, bias);
        out.push(v.x, v.y + (lift ? lift(v) : 0), v.z, index);
      }
    }
  };

  const buildArea = (area: OsmArea): void => {
    if (coveredAreas?.has(area.tags)) return;
    let style = classifyArea(area.tags, opts.areaStyles ?? DEFAULT_AREA_STYLES);
    if (!style) return;
    // a floodlit pitch is lit at night (its rect, from the whole outline: the same in every tile)
    if (area.tags.leisure === 'pitch' && litPitch(area)) style = { ...style, ramp: withGlow(style.ramp, PITCH_GLOW) };
    const flat: number[] = [];
    const holes: number[] = [];
    const lls: LonLat[] = [];
    area.rings.forEach((ring, ri) => {
      let pts = ring;
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
        pts = pts.slice(0, -1);
      }
      if (pts.length < 3) return;
      if (ri > 0) holes.push(lls.length);
      for (const [lon, lat] of pts) {
        flat.push(lon, lat);
        lls.push([lon, lat]);
      }
    });
    if (lls.length < 3) return;
    const tris = earcut(flat, holes.length ? holes : undefined, 2);

    if (style.water && tin) {
      // on the terrain faces like any area. A flat plane at the shore's highest point hung metres
      // over every water area that runs downhill — a canal mapped as an area beside its own line
      // floated above the ribbon of that line, a second copy of it (14/9517/6398)
      const lp = lls.map(toLattice);
      for (let i = 0; i < tris.length; i += 3) onFaces([lp[tris[i]], lp[tris[i + 1]], lp[tris[i + 2]]], style.ramp, style.bias, water);
      return;
    }
    if (style.water) {
      // no TIN to lie on: a flat water plane at the sampled boundary height
      let level = 0;
      const outer = area.rings[0];
      const probes = Math.min(outer.length, 8);
      for (let i = 0; i < probes; i++) {
        const [lon, lat] = outer[Math.floor((i / probes) * outer.length)];
        level = Math.max(level, sampleHeight(lon, lat));
      }
      level = Math.max(level, 0) + style.bias * biasScale;
      const pts = lls.map(([lon, lat]) => makePt(lon, lat, level));
      for (let i = 0; i < tris.length; i += 3) emitTri(pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]], style.ramp, water);
      return;
    }

    if (tin) {
      // cut by the terrain's faces: a piece is coplanar with the face under it, so the terrain
      // cannot show through (a draped triangle spans its creases and it did, in saw-teeth)
      const lp = lls.map(toLattice);
      for (let i = 0; i < tris.length; i += 3) onFaces([lp[tris[i]], lp[tris[i + 1]], lp[tris[i + 2]]], style.ramp, style.bias, main, style.filter);
      return;
    }
    const pts = lls.map(([lon, lat]) => makePt(lon, lat, groundY(lon, lat, style.bias)));
    for (let i = 0; i < tris.length; i += 3) {
      subdivide(pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]], style.ramp, style.bias, 0);
    }
  };

  /** a pitch's outer ring in tile-centre ENU (x, z), without the closing point */
  const pitchRing = (area: OsmArea): [number, number][] => {
    const ring = area.rings[0] ?? [];
    const pts = ring.map(([lon, lat]) => enu(lon, lat));
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return pts;
  };
  /**
   * the whole outline (not this tile's share of it) decides, so the tiles a pitch spans agree; the
   * clipped share keeps the tags object of the whole (clip.ts)
   */
  const wholePitch = new Map<Record<string, string>, OsmArea>();
  for (const a of opts.data.areas) if (a.tags.leisure === 'pitch') wholePitch.set(a.tags, a);
  const litPitch = (area: OsmArea): boolean => isLitPitch((wholePitch.get(area.tags) ?? area).rings[0] ?? []);

  /**
   * A pitch's markings (big-field sports, 1 px lines on the terrain faces, this tile's share) and the
   * floodlights on the corners of its rectangle (those standing in this tile), arms over the pitch
   */
  const buildPitch = (area: OsmArea): void => {
    const ring = pitchRing(area);
    const pf = pitchFrame(ring, area.tags);
    if (!pf) return;
    const { rect: r, toXZ, segs, frame } = pf;
    const lattice = ([x, z]: [number, number]): P2 => {
      const ll = enuToLatLon(center, x, -z, 0);
      return toLattice([ll.lon, ll.lat]);
    };
    const lit = litPitch(area);
    // with the cover the markings are the terrain's (its pitchPaint faces)
    if (!cover) for (const [s0, t0, s1, t1] of segs ?? []) {
      lineOnFaces(lattice(frame(s0, t0)), lattice(frame(s1, t1)), PITCH_LINE_BIAS, pitchLines, lit ? LIT_PITCH_LINE_INDEX : PITCH_LINE_INDEX);
    }
    if (!lit) return;
    const g = tin!.grid;
    for (const [es, et] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const d = Math.hypot(r.length, r.width) || 1;
      const s = es * (r.length / 2 + PITCH_LAMP_SETBACK_M * r.length / d), t = et * (r.width / 2 + PITCH_LAMP_SETBACK_M * r.width / d);
      const [fx, fz] = toXZ(s, t);
      const [lx, ly] = lattice([fx, fz]);
      if (lx < 0 || ly < 0 || lx >= g || ly >= g) continue; // the neighbour tile's pole
      const ll = enuToLatLon(center, fx, -fz, 0);
      const y0 = Math.max(sampleHeight(ll.lon, ll.lat), 0);
      const cx = r.cx - fx, cz = r.cz - fz, cl = Math.hypot(cx, cz) || 1;
      pushInstance(lampPosts, fx, y0, fz, 1, LAMP_RAMP, INSTANCE.LAMP, Math.atan2(cz, cx));
      lamps.push(fx + (cx / cl) * LAMP_SHAPE.ARM, y0 + LAMP_HEIGHT_M - 2 * LAMP_SHAPE.POLE_HALF - 0.1, fz + (cz / cl) * LAMP_SHAPE.ARM, LIGHT.STREET);
    }
  };

  /** street lamps along a road: pole beside it, arm over it, a light at the arm's end */
  const placeLamps = (points: LonLat[], half: number, fixedSide: 1 | -1 | 0, lift?: Lift): void => {
    const p = points.map(([lon, lat]) => enu(lon, lat));
    let next = LAMP_SPACING_M / 2;
    let walked = 0;
    // side 1 is to the right of the drawing direction (z points south: walking east, +z is right)
    let side: number = fixedSide || 1;
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      while (next <= walked + len) {
        const t = next - walked;
        const nx = -dz * side, nz = dx * side; // towards this lamp's side
        const fx = ax + dx * t + nx * (half + LAMP_SETBACK_M);
        const fz = az + dz * t + nz * (half + LAMP_SETBACK_M);
        const ll = enuToLatLon(center, fx, -fz, 0);
        // on a lifted road the lamp stands on the deck's edge
        const y0 = Math.max(sampleHeight(ll.lon, ll.lat), 0) + (lift ? lift({ x: ax + dx * t, z: az + dz * t }) : 0);
        const top = y0 + LAMP_HEIGHT_M;
        const r = LAMP_SHAPE.POLE_HALF;
        // the post, its arm turned back over the road
        pushInstance(lampPosts, fx, y0, fz, 1, LAMP_RAMP, INSTANCE.LAMP, Math.atan2(-nz, -nx));
        const tx = fx - nx * LAMP_SHAPE.ARM, tz = fz - nz * LAMP_SHAPE.ARM;
        lamps.push(tx, top - 2 * r - 0.1, tz, LIGHT.STREET);
        if (!fixedSide) side = -side;
        next += LAMP_SPACING_M;
      }
      walked += len;
    }
  };

  /** lattice units per metre: Mercator is conformal, so the same both ways inside the tile */
  const latticePerMetre = tin ? tin.grid / tileSizeMeters(tile) : 0;

  /** bridges over what they cross and the approaches to them: near, on the TIN (road-levels.ts) */
  const plainLevels = tin && opts.detail === 'full' ? buildRoadLevels(opts.data.lines, opts.data.areas, ([lon, lat]) => enu(lon, lat)) : undefined;
  const levels = straightDecks(plainLevels && opts.roads ? bridgeLevels(opts.roads, plainLevels) : plainLevels);
  /** with the cover: whether a way is lifted d metres along it, as the cover was cut (ground-cover.ts) */
  const coverLift = cover && plainLevels ? coverLifted(opts.roads, plainLevels, opts.roads && bridgeDecks(tile, tin!.grid, opts.roads, ([lon, lat]) => enu(lon, lat))) : undefined;
  /** with the cover: the ends of the ways where a lifted run ends, as the cover has them (ground-cover liftedJoints) */
  const coverJoints = coverLift ? liftedJoints(opts.data.lines, enu, toLattice, coverLift) : undefined;
  /** whether a way's lift is its own height over the ground (a carriageway of the roads with heights) */
  const ownHeight = (line: OsmLine): boolean => !!opts.roads && !!levels && 'own' in levels && !!(levels as RoadLevels & { own?(l: OsmLine): boolean }).own?.(line);
  /** whether a way's deck has a height of its own (ownHeight, or a straight deck): level across, whatever the ground under it */
  const levelDeck = (line: OsmLine): boolean => ownHeight(line) || !!levels?.straight(line);
  /** the ground under a mesh point (world metres), as the TIN's faces draw it */
  const groundUnder = (p: { x: number; z: number }): number => {
    const ll = enuToLatLon(center, p.x, -p.z, 0);
    return Math.max(sampleHeight(ll.lon, ll.lat), 0);
  };
  /** the ground under way `l`'s centre line `d` metres along it (where its lift is measured from) */
  function groundAlong(l: OsmLine, d: number): number {
    let left = d;
    for (let i = 1; i < l.points.length; i++) {
      const [ax, az] = enu(l.points[i - 1][0], l.points[i - 1][1]), [bx, bz] = enu(l.points[i][0], l.points[i][1]);
      const len = Math.hypot(bx - ax, bz - az);
      if (left <= len || i + 1 === l.points.length) {
        const t = len > 0 ? Math.max(0, Math.min(1, left / len)) : 0;
        return groundUnder({ x: ax + (bx - ax) * t, z: az + (bz - az) * t });
      }
      left -= len;
    }
    const [x, z] = enu(l.points[0][0], l.points[0][1]);
    return groundUnder({ x, z });
  }
  /**
   * A bridge's deck straight between what holds it up. A way tagged a bridge whose lift is over the
   * drawn ground (a path, a railway, a road without a height of its own) lifted to that ground plus
   * its lift took the ground's shape: a footway over a river 6–7 m up at the banks and 4 m over the
   * water, a V (14/9517/6398). Its deck is the upper hull of that profile along it instead: straight
   * between its ends and between the points that hold it highest, nowhere lower than its lift asks,
   * at its ends where it was (its approaches meet it as before); each run of it the lift lifts on its
   * own, so a long way tagged a bridge still comes down to the ground at LIFT_GRADE where it did.
   */
  function straightDecks(inner?: RoadLevels): (RoadLevels & { straight(line: OsmLine): boolean; own?(line: OsmLine): boolean }) | undefined {
    if (!inner) return undefined;
    const own = 'own' in inner ? (inner as RoadLevels & { own(l: OsmLine): boolean }).own : undefined;
    /** per way: its lifted runs, each its hull's stations (metres along it, deck height); null for a way not straightened */
    const hulls = new Map<OsmLine, Array<{ d: number[]; h: number[] }> | null>();
    const hullOf = (line: OsmLine): Array<{ d: number[]; h: number[] }> | null => {
      let runs = hulls.get(line);
      if (runs !== undefined) return runs;
      runs = null;
      if (isBridge(line.tags) && !own?.(line) && line.points.length >= 2 && inner.maxLift(line) >= LIFT_EPS_M) {
        let len = 0;
        for (let i = 1; i < line.points.length; i++) {
          const [ax, az] = enu(line.points[i - 1][0], line.points[i - 1][1]), [bx, bz] = enu(line.points[i][0], line.points[i][1]);
          len += Math.hypot(bx - ax, bz - az);
        }
        const n = Math.max(1, Math.ceil(len / DECK_SAMPLE_M));
        runs = [];
        let cur: { d: number[]; h: number[] } | undefined;
        for (let k = 0; k <= n; k++) {
          const dk = (len * k) / n, lift = inner.liftAt(line, dk);
          // each lifted run on its own: where the lift falls to the ground (at LIFT_GRADE, along a
          // long way tagged a bridge) the deck comes down as it did
          if (lift < LIFT_EPS_M) { cur = undefined; continue; }
          if (!cur) runs.push(cur = { d: [], h: [] });
          const { d, h } = cur, hk = groundAlong(line, dk) + lift;
          // the upper hull: drop the last station while it lies on or under the chord past it
          while (d.length >= 2 && (h[h.length - 1] - h[h.length - 2]) * (dk - d[d.length - 2]) <= (hk - h[h.length - 2]) * (d[d.length - 1] - d[d.length - 2])) {
            d.pop();
            h.pop();
          }
          d.push(dk);
          h.push(hk);
        }
        runs = runs.filter((r) => r.d.length >= 2);
        if (!runs.length) runs = null;
      }
      hulls.set(line, runs);
      return runs;
    };
    const liftAt = (line: OsmLine, d: number): number => {
      const hull = hullOf(line)?.find((r) => d >= r.d[0] && d <= r.d[r.d.length - 1]);
      if (!hull) return inner.liftAt(line, d);
      let i = 0;
      while (i + 2 < hull.d.length && hull.d[i + 1] < d) i++;
      const t = hull.d[i + 1] > hull.d[i] ? Math.max(0, Math.min(1, (d - hull.d[i]) / (hull.d[i + 1] - hull.d[i]))) : 0;
      return Math.max(0, hull.h[i] + (hull.h[i + 1] - hull.h[i]) * t - groundAlong(line, d));
    };
    /** the straightened bridges by their tags (a tile's share of a line keeps the whole line's) */
    const byTags = new Map<Record<string, string>, OsmLine[]>();
    for (const l of opts.data.lines) {
      if (!isBridge(l.tags)) continue;
      const list = byTags.get(l.tags);
      if (list) list.push(l);
      else byTags.set(l.tags, [l]);
    }
    return {
      ...(own ? { own } : {}),
      straight: (line) => !!hullOf(line),
      liftAt,
      maxLift: (line) => {
        const hull = hullOf(line);
        return hull ? Math.max(inner.maxLift(line), ...hull.flatMap((r) => r.d.map((d) => liftAt(line, d)))) : inner.maxLift(line);
      },
      liftNear: (tags, x, z) => {
        const lines = (byTags.get(tags) ?? []).filter((l) => hullOf(l));
        if (!lines.length) return inner.liftNear(tags, x, z);
        let best = Infinity, lift = 0;
        for (const l of lines) {
          let at = 0;
          for (let i = 1; i < l.points.length; i++) {
            const [ax, az] = enu(l.points[i - 1][0], l.points[i - 1][1]), [bx, bz] = enu(l.points[i][0], l.points[i][1]);
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
            const dist = (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2;
            if (dist < best) {
              best = dist;
              lift = liftAt(l, at + Math.sqrt(l2) * t);
            }
            at += Math.sqrt(l2);
          }
        }
        return lift;
      },
      liftedTags: (tags) => inner.liftedTags(tags),
    };
  }

  /**
   * With the roads' own heights: of the carriageways with a height (the network's ways), only the
   * bridges are lifted, to their height, over the ground left as it was under them (the approaches
   * lie on ground pulled up to them). A lift is the bridge's height less the ground under its centre
   * line. Every other way (railways, paths, a road without a height) lifts as without them.
   */
  function bridgeLevels(roads: RoadSurface, plain: RoadLevels): RoadLevels & { own(line: OsmLine): boolean } {
    const { net, z } = roads;
    const wayOf = new Map<OsmLine, number>();
    const byTags = new Map<Record<string, string>, number[]>();
    net.ways.forEach((w, k) => {
      for (let i = w.first; i < w.first + w.count; i++) if (!Number.isFinite(z[i])) return;
      wayOf.set(w.line, k);
      const l = byTags.get(w.line.tags);
      if (l) l.push(k);
      else byTags.set(w.line.tags, [k]);
    });
    /** the centre line of way k at d metres: lon, lat and height */
    const axis = (k: number, d: number): [number, number, number] => {
      const w = net.ways[k];
      let i = w.first;
      const last = w.first + w.count - 1;
      while (i < last && net.samples[i + 1].d < d) i++;
      const a = net.samples[i], b = net.samples[Math.min(last, i + 1)];
      const t = b.d > a.d ? Math.max(0, Math.min(1, (d - a.d) / (b.d - a.d))) : 0;
      const za = z[i], zb = z[Math.min(last, i + 1)];
      return [a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t, za + (zb - za) * t];
    };
    const liftOf = (k: number, d: number): number => {
      if (!net.ways[k].bridge) return 0;
      const [lon, lat, h] = axis(k, d);
      return Number.isFinite(h) ? h - Math.max(sampleHeight(lon, lat), 0) : 0;
    };
    const maxOf = new Map<number, number>();
    const maxLift = (k: number): number => {
      let m = maxOf.get(k);
      if (m === undefined) {
        m = 0;
        const w = net.ways[k];
        for (let i = w.first; i < w.first + w.count; i++) m = Math.max(m, liftOf(k, net.samples[i].d));
        maxOf.set(k, m);
      }
      return m;
    };
    return {
      own: (line) => wayOf.has(line),
      liftAt: (line, d) => {
        const k = wayOf.get(line);
        return k === undefined ? plain.liftAt(line, d) : liftOf(k, d);
      },
      maxLift: (line) => {
        const k = wayOf.get(line);
        return k === undefined ? plain.maxLift(line) : maxLift(k);
      },
      liftNear: (tags, x, zz) => {
        if (!byTags.has(tags)) return plain.liftNear(tags, x, zz);
        let best = Infinity, lift = 0;
        for (const k of byTags.get(tags) ?? []) {
          const w = net.ways[k];
          for (let i = w.first; i + 1 < w.first + w.count; i++) {
            const [ax, az] = enu(net.samples[i].lon, net.samples[i].lat), [bx, bz] = enu(net.samples[i + 1].lon, net.samples[i + 1].lat);
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (zz - az) * dz) / l2)) : 0;
            const dist = (x - ax - dx * t) ** 2 + (zz - az - dz * t) ** 2;
            if (dist < best) {
              best = dist;
              lift = liftOf(k, net.samples[i].d + (net.samples[i + 1].d - net.samples[i].d) * t);
            }
          }
        }
        return lift;
      },
      liftedTags: (tags) => (byTags.has(tags) ? byTags.get(tags)!.some((k) => maxLift(k) >= LIFT_EPS_M) : plain.liftedTags(tags)),
    };
  }

  const LINE_BIAS = 1.4;
  /** under a road's carriageway its shoulders, over a railway's right-of-way strip its track */
  const SHOULDER_BIAS = 1.3;
  const ZONE_BIAS = 1.0;
  const RAIL_BIAS = 1.5;
  /** how a line is drawn: undefined when it is not drawn at all */
  const lineLook = (line: OsmLine) => {
    const style = classifyLine(line.tags);
    if (!style || line.points.length < 2 || isTunnel(line.tags)) return undefined;
    const road = !!line.tags.highway;
    const lit = road && isLitRoad(line.tags);
    const bridge = isBridge(line.tags);
    return {
      half: style.width / 2,
      road,
      lit,
      rail: !!style.rail,
      minor: !!style.minor,
      path: !!style.path,
      marks: style.marks ?? 0,
      shoulder: style.shoulder ?? 0,
      // its place among the roads of the cover (ground-cover.ts): a path has none
      prio: road && !style.path ? roadPriority(line.tags, style.width) : 0,
      tie: road && !style.path ? tieBreak(line.points[0]) : 0,
      // the right-of-way strip: not on a bridge (it would paint the river under it)
      zone: style.rail && !bridge ? RAIL_ZONE_M : 0,
      out: road || style.rail ? roads : style.ramp === RAMP.WATER ? water : main,
      // runways and taxiways lie on the flat aerodrome pad: just above its asphalt areas, not a
      // ribbon raised over bumps (the aircraft stands on the pad, it sank into a 1.4 m ribbon)
      bias: line.tags.aeroway ? AEROWAY_LINE_BIAS
        : road ? LINE_BIAS + roadPriority(line.tags, style.width) * ROAD_RANK_STEP_M + roadLayer(line.tags) * ROAD_LAYER_STEP_M
          // equals (two merging branches alike): one over the other by the way's first point, never in a tie
          + tieBreak(line.points[0]) * ROAD_TIE_M
        : LINE_BIAS,
      // a street-lit surface glows at night (the shader shows the level only then); an unlit road
      // a little too, lighter than the ground round it
      ramp: lit ? withGlow(style.ramp, LIT_ROAD_GLOW) : road ? withGlow(style.ramp, UNLIT_ROAD_GLOW) : style.ramp,
    };
  };
  /** where roads meet (the whole ways, not this tile's share): ribbon ends, forks, paint gaps */
  const net = lineNetwork(opts.data.lines, enu, toLattice, latticePerMetre);

  /** a lifted way as the bridge and embankment builder takes it: its centre line and what it looks like */
  const raisedWays: { line: OsmLine; half: number; bias: number; pts: { c: P2; e: [number, number]; d: number }[] }[] = [];
  /**
   * A way the road levels lift: its centre line with a vertex every LIFT_STEP_M where it is lifted
   * (the lift bends between the vertices of a long straight), and the lift of a ribbon vertex — that
   * of the point of the centre line nearest to it. Undefined for a way on the ground.
   */
  const raise = (line: OsmLine, src: { c: P2; e: [number, number] }[], half: number, bias: number): { pts: { c: P2; e: [number, number] }[]; lift: Lift } | undefined => {
    if (!levels || levels.maxLift(line) < LIFT_EPS_M) return undefined;
    // metres along the way itself at each vertex (a fork's shift stretches the drawn line a little)
    let wayLen = 0;
    for (let i = 1; i < line.points.length; i++) {
      const [ax, az] = enu(line.points[i - 1][0], line.points[i - 1][1]), [bx, bz] = enu(line.points[i][0], line.points[i][1]);
      wayLen += Math.hypot(bx - ax, bz - az);
    }
    const lens = src.slice(1).map((p, i) => Math.hypot(p.e[0] - src[i].e[0], p.e[1] - src[i].e[1]));
    const scale = wayLen / (lens.reduce((a, b) => a + b, 0) || 1);
    const pts: { c: P2; e: [number, number]; d: number }[] = [];
    let at = 0;
    for (let i = 0; i < src.length; i++) {
      pts.push({ ...src[i], d: at * scale });
      if (i + 1 === src.length) break;
      const a = src[i], b = src[i + 1], d0 = at * scale, d1 = (at + lens[i]) * scale;
      const n = Math.ceil(lens[i] / LIFT_STEP_M);
      for (let k = 1; k < n; k++) {
        const f = k / n;
        // only where it is lifted: the rest of a long way stays as it was
        if (!levels.liftAt(line, d0 + (d1 - d0) * ((k - 1) / n)) && !levels.liftAt(line, d0 + (d1 - d0) * f) && !levels.liftAt(line, d0 + (d1 - d0) * ((k + 1) / n))) continue;
        pts.push({ c: [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f], e: [a.e[0] + (b.e[0] - a.e[0]) * f, a.e[1] + (b.e[1] - a.e[1]) * f], d: d0 + (d1 - d0) * f });
      }
      at += lens[i];
    }
    const lift: Lift = (p) => {
      let best = Infinity, d = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i].e, [bx, bz] = pts[i + 1].e;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2)) : 0;
        const dist = (p.x - ax - dx * t) ** 2 + (p.z - az - dz * t) ** 2;
        if (dist < best) {
          best = dist;
          d = pts[i].d + (pts[i + 1].d - pts[i].d) * t;
        }
      }
      // with a height of its own (the roads', a straight deck's): the deck's height over the ground
      // under this very vertex, so it is level across however the ground under it slopes
      return levelDeck(line) ? levels.liftAt(line, d) + groundAlong(line, d) - groundUnder(p) : levels.liftAt(line, d);
    };
    raisedWays.push({ line, half, bias, pts });
    return { pts, lift };
  };

  const buildRibbon = (line: OsmLine): void => {
    const look = lineLook(line);
    if (!look || !tin) return;
    let pts = line.points.map((ll) => ({ c: toLattice(ll), e: enu(ll[0], ll[1]) }))
      .filter((p, i, a) => i === 0 || p.c[0] !== a[i - 1].c[0] || p.c[1] !== a[i - 1].c[1]);
    if (pts.length < 2) return;
    if (look.road) pts = net.forkShift(line, pts);
    // with the cover a way is the terrain's faces but where it is lifted (or the TIN dropped its edges)
    const asCover = !!cover && !tin.loose?.has(line);
    // with the cover every ribbon lies on the faces, the bridge under it too (a dropped way's included)
    const raised = look.road || look.rail ? raise(line, pts, look.half + look.shoulder, cover ? 0 : look.rail ? RAIL_BIAS : look.bias) : undefined;
    if (raised) pts = raised.pts;
    const lift = raised?.lift;
    const c = pts.map((p) => p.c);
    const ends = look.road ? net.roadEnds(line) : ROUND_ENDS;
    // nothing of it reaches this tile: skip the work
    const g = tin.grid, r = (look.half + look.shoulder + look.zone) * latticePerMetre;
    if (c.every((p) => p[0] < -r) || c.every((p) => p[0] > g + r) || c.every((p) => p[1] < -r) || c.every((p) => p[1] > g + r)) return;
    if (asCover) {
      liftedRibbons(line, look, pts, lift);
      return;
    }
    const lit = look.lit ? (ramp: number) => withGlow(ramp, LIT_ROAD_GLOW) : (ramp: number) => ramp;
    // with the cover a way the TIN dropped lies on the faces too, its bias the key of its depth level,
    // but on the faces of the covers senior to it (its `kind` of cover, a road's priority and tie)
    const draw = (kind: CoverKind, cl: P2[], half: number | number[], ramp: number, bias: number, out: Out, segs?: VertexAttr[], ends?: RibbonEnds, lift?: Lift): void => {
      if (cover) looseRibbon(kind, look.prio, look.tie, cl, half, ramp, bias, out, segs, ends, lift);
      else ribbon(cl, half, ramp, bias, out, segs, ends, lift);
    };
    const kind: CoverKind = look.path ? 'path' : look.road ? 'carriageway' : look.out === water ? 'water' : 'runway';
    // under the carriageway: the right-of-way strip of a railway, the shoulders of a road
    if (look.zone) draw('railZone', c, look.half + look.zone, RAIL_ZONE_RAMP, ZONE_BIAS, main);
    // the shoulders of an approach rise with it: the top of its embankment
    if (look.shoulder) draw('shoulder', c, look.half + look.shoulder, lit(SHOULDER_RAMP), SHOULDER_BIAS, roads, undefined, ends, lift);
    if (!look.rail) {
      if (!look.marks) {
        draw(kind, c, look.half, look.ramp, look.bias, look.out, undefined, ends, lift);
        return;
      }
      // a painted road: narrowing into a narrower continuation, its paint in its vertex attributes
      const p = painted(line, pts, look.half, look.marks, net);
      if (p.c.length) draw(kind, p.c, p.half, look.ramp, look.bias, look.out, p.segs, ends, lift);
      return;
    }
    // the track: each segment's vertices carry u along the line and v across it
    draw('ballast', c, look.half, look.ramp, RAIL_BIAS, roads, trackSegs(pts), ROUND_ENDS, lift);
  };

  /**
   * What lies on the ground's own faces over them (with the cover), each with the mesh it goes to: a
   * dropped way's ribbon with its key (`item`), or what is the ground's under every ribbon (`rank`,
   * its cover's: a dropped area's or water's pieces, a dropped railway's right-of-way strip)
   */
  const loose: { item?: LevelItem; rank?: number; out: Out; part: Out }[] = [];
  /** a mesh of its own for what lies on the faces, as `out` is */
  const partOf = (out: Out): Out => ({ verts: [], ramps: [], attrs: out.attrs ? [] : undefined, faceOf: [] });
  /** per shape of the cover, a road's tie among its equals (ground-cover.ts: a carriageway's and a shoulder's) */
  const tieOf = (si: number): number => {
    const sh = cover!.shapes[si];
    return sh.kind === 'carriageway' || sh.kind === 'shoulder' ? tieBreak((sh.source as OsmLine).points[0]) : 0;
  };
  /**
   * With the cover: whether a piece of a dropped way's ribbon, a cover of `kind` (a road's `prio` and
   * `tie`), is left out on a face: on one of a cover senior to it (COVER_RANK, then the roads'
   * priority and tie, as the cover orders its shapes) unless it is lifted JUNCTION_LIFT_M over it on
   * average (a bridge). The face is the senior's surface, as it is where both are in the surface.
   */
  const underSenior = (kind: CoverKind, prio: number, tie: number): LeftOut => (si, lifts) => {
    if (si < 0) return false;
    const sh = cover!.shapes[si], rank = COVER_RANK[sh.kind] - COVER_RANK[kind];
    if (rank > 0 || (rank === 0 && (sh.prio < prio || (sh.prio === prio && tieOf(si) >= tie)))) return false;
    return !lifts || lifts.reduce((a, b) => a + b, 0) / lifts.length < JUNCTION_LIFT_M;
  };
  /**
   * With the cover: a ribbon of a way the TIN's budget dropped (tin.loose), on the faces like the
   * cover's own (no bias) but those of its seniors (underSenior), kept aside until every ribbon is in
   * (flushLoose). `bias`, the height that ordered it over the others when it was lifted, is the key
   * of its depth level; a right-of-way strip is the ground's, under every ribbon (its cover's rank).
   */
  const looseRibbon = (kind: CoverKind, prio: number, tie: number, c: P2[], half: number | number[], ramp: number, bias: number, out: Out, segs?: VertexAttr[], ends: RibbonEnds = ROUND_ENDS, lift?: Lift): void => {
    const part = partOf(out);
    ribbon(c, half, ramp, 0, part, segs, ends, lift, underSenior(kind, kind === 'carriageway' || kind === 'shoulder' ? prio : 0, kind === 'carriageway' || kind === 'shoulder' ? tie : 0));
    if (kind === 'railZone') {
      if (part.ramps.length) loose.push({ rank: COVER_RANK.railZone, out, part });
    } else onGround(c, half, bias, out, part);
  };
  /** what of a ribbon lies on the faces (`part`, of centre line `c`) to the loose ribbons, its key `bias` */
  const onGround = (c: P2[], half: number | number[], bias: number, out: Out, part: Out): void => {
    if (!part.ramps.length) return;
    const widest = typeof half === 'number' ? half : half.reduce((a, b) => Math.max(a, b), 0);
    const reach = (widest * LOOSE_REACH + LOOSE_MARGIN_M) * latticePerMetre, g = tin!.grid;
    // only what of its centre line can reach into the tile: an overlap beyond it raises nothing here
    loose.push({ item: { key: bias, lines: clipToBox(c, -reach, -reach, g + reach, g + reach), reach }, out, part });
  };
  /**
   * With the cover: the areas and waters the TIN's budget dropped (tin.looseShapes), each over the
   * faces it covers but its own (a face wholly in it is its already: surface-tin) and those of its
   * seniors (the shapes before it), cut by the faces and on them (no bias); a water not over a
   * road's bank, an area not over the sea (the terrain's faces keep theirs). The ground's, under
   * every ribbon: flushLoose.
   */
  const buildLooseShapes = (): void => {
    if (!cover || !tin?.looseShapes) return;
    const styles = opts.areaStyles ?? DEFAULT_AREA_STYLES;
    /** per face: 0 not asked, 1 a road's bank, 2 not */
    const banks = new Uint8Array(tin.tris.length);
    const onBank = (f: number): boolean => (banks[f] ||= tin.bank?.(f) ? 1 : 2) === 1;
    for (const si of tin.looseShapes) {
      const shape = cover.shapes[si], wet = shape.kind === 'water';
      const out = wet ? water : main, part = partOf(out);
      // an area with a filter: the imagery of the face under each piece through it, as the terrain colours its faces (coverRamp)
      const filter = shape.kind === 'pitch' || shape.kind === 'area' || shape.kind === 'zone' ? classifyArea(shape.source.tags, styles)?.filter : undefined;
      const ramp = coverRamp(shape, styles, undefined);
      const over: LeftOut = (fc, _lifts, f) => fc === si || (fc >= 0 && fc < si) || (wet ? onBank(f) : isSeaFace(tin, f));
      const t = shape.tris;
      for (let k = 0; k < t.length; k += 6) onFaces([[t[k], t[k + 1]], [t[k + 2], t[k + 3]], [t[k + 4], t[k + 5]]], ramp, 0, part, filter, undefined, undefined, over);
      if (part.ramps.length) loose.push({ rank: COVER_RANK[shape.kind], out, part });
    }
  };
  /**
   * What lies on the faces into its mesh, each vertex with its depth level. On a face, the ground's
   * pieces first, the junior cover lowest (level 1 and up, by the ranks of those on that face: pieces
   * on different faces never overlap), then the ribbons, each by its own level among the ribbons
   * (depth-levels.ts) over the ground's on its face.
   */
  const flushLoose = (): void => {
    const ribbons = loose.filter((l) => l.item);
    const levels = depthLevels(ribbons.map((l) => l.item!));
    /** per face, the ranks of the ground's pieces on it, the junior first */
    const ranks = new Map<number, number[]>();
    for (const { rank, part } of loose) {
      if (rank === undefined) continue;
      let last = -1;
      for (const f of part.faceOf!) {
        if (f === last) continue;
        last = f;
        const of = ranks.get(f);
        if (!of) ranks.set(f, [rank]);
        else if (!of.includes(rank)) of.push(rank);
      }
    }
    for (const of of ranks.values()) of.sort((a, b) => b - a);
    let ri = 0;
    for (const { item, rank, out, part } of loose) {
      const own = item ? levels[ri++] : 0;
      const depth = (out.depth ??= { from: out.ramps.length, levels: [] });
      while (depth.from + depth.levels.length < out.ramps.length) depth.levels.push(0);
      for (const v of part.verts) out.verts.push(v);
      part.ramps.forEach((r, v) => {
        out.ramps.push(r);
        const of = ranks.get(part.faceOf![v]);
        depth.levels.push(rank === undefined ? own + (of?.length ?? 0) : of!.indexOf(rank) + 1);
      });
      if (out.attrs) for (const a of part.attrs!) out.attrs.push(a);
    }
  };

  /**
   * With the cover: whether a piece of a lifted ribbon on a face of cover `si`, lifted `lifts` at its
   * vertices, is left out: one on a carriageway, ballast, runway or path face lifted less than
   * JUNCTION_LIFT_M on average (a bridge ending on the middle of the bank road, a path ending on the
   * foot of an approach), whose face is the junction's surface
   */
  const onJunction: LeftOut = (si, lifts) => {
    if (si < 0 || !JUNCTION_KINDS.has(cover!.shapes[si].kind)) return false;
    const mean = lifts ? lifts.reduce((a, b) => a + b, 0) / lifts.length : 0;
    return mean < JUNCTION_LIFT_M;
  };

  /**
   * With the cover: a way's lifted stretches (what its cover leaves of it, ground-cover liftedRuns)
   * as ribbons with their lift and no bias, square where a stretch ends inside the way, mitred onto
   * a single continuation (liftedJoints); no shoulders or right-of-way strip on them. A piece barely
   * lifted over a road's, a railway's, a runway's or a path's face is left out (onJunction); a deck
   * with its own height is drawn only where it is DECK_FLOOR_M over its face, whatever the face (a
   * plain way's ramp rises from the ground itself: drawn from its foot); lower, it lies on the face
   * (a ground's, a shoulder's: onGround), so the carriageway goes on to the junction.
   */
  const liftedRibbons = (line: OsmLine, look: NonNullable<ReturnType<typeof lineLook>>, pts: { c: P2; e: [number, number] }[], lift?: Lift): void => {
    const { runs, len } = liftedRuns(line, line.points.map(([lon, lat]) => enu(lon, lat)), coverLift!);
    if (!runs.length) return;
    let cl = pts.map((p) => p.c), half: number | number[] = look.half, segs: VertexAttr[] | undefined;
    if (look.rail) segs = trackSegs(pts);
    else if (look.marks) {
      const p = painted(line, pts, look.half, look.marks, net);
      if (!p.c.length) return;
      cl = p.c;
      half = p.half;
      segs = p.segs;
    }
    const ends = coverJoints!(line, look.road ? net.roadEnds(line) : ROUND_ENDS), cum = cumulative(cl);
    const out = look.rail ? roads : look.out, deck = levelDeck(line);
    for (const [d0, d1] of runs) {
      const part = runPart(cl, cum, half, ends, d0, d1, len);
      if (part.c.length < 2) continue;
      // under its floor a deck lies on the ground's faces as a dropped way's ribbon does (a road's, a path's and the water's are their own)
      const low = partOf(out);
      const floor = deck ? { clear: DECK_FLOOR_M, low: (si: number) => (si < 0 || !(JUNCTION_KINDS.has(cover!.shapes[si].kind) || cover!.shapes[si].kind === 'water') ? low : undefined) } : undefined;
      ribbon(part.c, part.half, look.ramp, 0, out, segs?.slice(part.first), part.ends, lift, onJunction, floor);
      onGround(part.c, part.half, look.bias, out, low);
    }
  };

  /**
   * A line's ribbon on the TIN (ribbonGeom), from the whole way (not this tile's share of it): each
   * triangle is cut by the terrain faces under it, so the relief cannot cut through it, and whatever
   * lies past the tile border finds no face here and is dropped. The neighbour cuts the same ribbon
   * at the same border, so the two halves meet exactly. Per segment vertex attributes optional (the
   * caps take the first and last segment's, a joint disc its vertex's).
   */
  const ribbon = (c: P2[], half: number | number[], ramp: number, bias: number, out: Out, segs?: VertexAttr[], ends: RibbonEnds = ROUND_ENDS, lift?: Lift, over?: LeftOut, floor?: Floor): void => {
    const { tris, triSeg } = ribbonGeom(c, half, ends, latticePerMetre);
    for (let k = 0; k < triSeg.length; k++) onFaces([tris[3 * k], tris[3 * k + 1], tris[3 * k + 2]], ramp, bias, out, undefined, segs?.[triSeg[k]], lift, over, floor);
  };

  /** this tile's share of a line: its lamps and far lines (the TIN ribbon is buildRibbon's) */
  const buildLine = (line: OsmLine): void => {
    const look = lineLook(line);
    if (!look) return;
    const { half, road, lit, out, ramp } = look;
    // a tile's share of a line: its lift by the tags it shares with the whole way
    const lift: Lift | undefined = levels?.liftedTags(line.tags) ? (p) => levels.liftNear(line.tags, p.x, p.z) : undefined;
    if (lit && !look.path) placeLamps(line.points, half, lampSide(line.tags), lift);

    if (tin) {
      // far lines: roads but the minor ones, and railways
      if (!(road && !look.minor) && !look.rail) return;
      const index = look.rail ? RAIL_LINE_INDEX : ROAD_LINE_INDEX;
      const c = line.points.map(toLattice).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
      for (let i = 0; i < c.length - 1; i++) {
        // a lifted line in pieces of LIFT_STEP_M, each end at its own height
        const n = lift ? Math.max(1, Math.ceil(Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]) / latticePerMetre / LIFT_STEP_M)) : 1;
        for (let k = 0; k < n; k++) {
          const at = (f: number): P2 => [c[i][0] + (c[i + 1][0] - c[i][0]) * f, c[i][1] + (c[i + 1][1] - c[i][1]) * f];
          lineOnFaces(at(k / n), at((k + 1) / n), look.bias, roadLines, index, lift);
        }
      }
      return;
    }
    // without the TIN the ribbon is sampled point by point and must clear the relief between them
    const bias = LINE_BIAS;

    // densify long segments so the ribbon follows terrain
    const path: LonLat[] = [];
    for (let i = 0; i < line.points.length - 1; i++) {
      const a = line.points[i];
      const b = line.points[i + 1];
      path.push(a);
      const [ax, az] = enu(a[0], a[1]);
      const [bx, bz] = enu(b[0], b[1]);
      const segLen = Math.hypot(bx - ax, bz - az);
      const steps = Math.min(64, Math.ceil(segLen / maxEdge));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    path.push(line.points[line.points.length - 1]);
    if (path.length < 2) return;

    const centers = path.map(([lon, lat]) => {
      const [x, z] = enu(lon, lat);
      const base = Math.max(sampleHeight(lon, lat), 0);
      return { lon, lat, x, z, y: base + bias * biasScale };
    });
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < centers.length; i++) {
      const prev = centers[Math.max(0, i - 1)];
      const next = centers[Math.min(centers.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dz = next.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const px = -dz * half;
      const pz = dx * half;
      const c = centers[i];
      left.push({ lon: c.lon, lat: c.lat, x: c.x + px, z: c.z + pz, y: c.y });
      right.push({ lon: c.lon, lat: c.lat, x: c.x - px, z: c.z - pz, y: c.y });
    }
    for (let i = 0; i < centers.length - 1; i++) {
      emitTri(left[i], right[i], left[i + 1], ramp, out);
      emitTri(right[i], right[i + 1], left[i + 1], ramp, out);
      if (road) {
        const a = centers[i], b = centers[i + 1];
        roadLines.push(a.x, a.y, a.z, ROAD_LINE_INDEX, b.x, b.y, b.z, ROAD_LINE_INDEX);
      }
    }
  };

  const buildPoint = (p: OsmPoint): void => {
    // with the cover the square is the terrain's (an aeroArea face)
    if (p.tags.aeroway !== 'helipad' || cover) return;
    const bias = 1.2;
    const half = 8;
    const y = groundY(p.at[0], p.at[1], bias);
    const c = makePt(p.at[0], p.at[1], y);
    const a = { ...c, x: c.x - half, z: c.z - half };
    const b = { ...c, x: c.x + half, z: c.z - half };
    const d = { ...c, x: c.x + half, z: c.z + half };
    const e = { ...c, x: c.x - half, z: c.z + half };
    emitTri(a, b, d, RAMP.ASPHALT);
    emitTri(a, d, e, RAMP.ASPHALT);
  };

  /** colour of the terrain's imagery at a point (a face colour, snow-capable); earth without imagery */
  const groundColourAt = (lon: number, lat: number): number => {
    if (tin && opts.faceColor) {
      const [x, y] = toLattice([lon, lat]);
      for (const f of facesNear(x - 1e-6, y - 1e-6, x + 1e-6, y + 1e-6)) {
        const w1 = ((x - f.c[0][0]) * (f.c[2][1] - f.c[0][1]) - (f.c[2][0] - f.c[0][0]) * (y - f.c[0][1])) / f.det;
        const w2 = ((f.c[1][0] - f.c[0][0]) * (y - f.c[0][1]) - (x - f.c[0][0]) * (f.c[1][1] - f.c[0][1])) / f.det;
        if (w1 < -1e-9 || w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
        const rgb = imageryOf(f);
        if (rgb) return snowy(colourOf(rgb));
        break;
      }
    }
    return snowy(TUNNEL_EARTH);
  };

  /** a segment of a drawn road or railway, ENU metres, with its half width */
  interface Over { a: [number, number]; b: [number, number]; half: number }
  /** where segment pq crosses segment ab, as a fraction of pq; undefined when they do not cross */
  const crossAt = (p: [number, number], q: [number, number], a: [number, number], b: [number, number]): number | undefined => {
    const rx = q[0] - p[0], rz = q[1] - p[1], sx = b[0] - a[0], sz = b[1] - a[1];
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return undefined;
    const t = ((a[0] - p[0]) * sz - (a[1] - p[1]) * sx) / den;
    const u = ((a[0] - p[0]) * rz - (a[1] - p[1]) * rx) / den;
    return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : undefined;
  };

  /**
   * A tunnel's mouth: a dark arched opening at the road, framed by a tube of the ground's colour
   * that runs on along the tunnel's line, level with the road at the mouth, until the hill buries
   * it. `points` start at the portal and run into the tunnel.
   */
  const buildPortal = (points: LonLat[], half: number, over: Over[]): void => {
    const pe = points.map(([lon, lat]) => enu(lon, lat));
    const cum = [0];
    for (let i = 1; i < pe.length; i++) cum.push(cum[i - 1] + Math.hypot(pe[i][0] - pe[i - 1][0], pe[i][1] - pe[i - 1][1]));
    const total = cum[cum.length - 1];
    if (total < 1) return;
    const along = (s: number): [number, number] => {
      s = Math.max(0, Math.min(total, s));
      let i = 0;
      while (i < pe.length - 2 && cum[i + 1] < s) i++;
      const t = cum[i + 1] > cum[i] ? (s - cum[i]) / (cum[i + 1] - cum[i]) : 0;
      return [pe[i][0] + (pe[i + 1][0] - pe[i][0]) * t, pe[i][1] + (pe[i + 1][1] - pe[i][1]) * t];
    };
    /** position and sideways unit vector of the tube's cross-section at `s` metres in */
    const frame = (s: number) => {
      const [x, z] = along(s);
      const [ax, az] = along(s - PORTAL.STEP / 2), [bx, bz] = along(s + PORTAL.STEP / 2);
      const tl = Math.hypot(bx - ax, bz - az) || 1;
      const tx = (bx - ax) / tl, tz = (bz - az) / tl;
      return { x, z, tx, tz, lx: -tz, lz: tx };
    };
    type Frame = ReturnType<typeof frame>;

    const wi = half + PORTAL.CLEARANCE, risei = Math.min(PORTAL.RISE, wi * 0.6);
    const wo = wi + PORTAL.WALL, riseo = risei + PORTAL.WALL;
    const [lon0, lat0] = points[0];
    const floor = Math.max(sampleHeight(lon0, lat0), 0) + LINE_BIAS * biasScale;
    const crown = floor + PORTAL.SPRING + riseo;
    const heightAt = (x: number, z: number): number => {
      const ll = enuToLatLon(center, x, -z, 0);
      return sampleHeight(ll.lon, ll.lat);
    };

    // a road or railway over the tunnel is its cover (an underpass under an embankment the DEM does
    // not have): the tube stops short of it instead of rising over it
    let length = Math.min(PORTAL.MAX, total / 2);
    for (const r of over) {
      for (let i = 0; i + 1 < pe.length; i++) {
        const t = crossAt(pe[i], pe[i + 1], r.a, r.b);
        if (t !== undefined) length = Math.min(length, cum[i] + t * (cum[i + 1] - cum[i]) - r.half - PORTAL.WALL);
      }
    }
    // the mouth itself is under that road: the tunnel just goes in beneath it
    if (length < 2) return;
    // rings every STEP until the hill covers the tube's crown and both its sides
    const rings: Frame[] = [];
    for (let s = 0; ; s += PORTAL.STEP) {
      const f = frame(Math.min(s, length));
      rings.push(f);
      if (s >= length) break;
      if (s > 0 && [0, -wo, wo].every((u) => heightAt(f.x + f.lx * u, f.z + f.lz * u) >= crown)) break;
    }

    /** cross-section from the left foot up the wall, over the arch and down to the right foot */
    const profile = (w: number, rise: number): P2[] => {
      const p: P2[] = [[-w, -PORTAL.FOOT], [-w, PORTAL.SPRING]];
      for (let k = 1; k < PORTAL.SIDES; k++) {
        const a = Math.PI * (1 - k / PORTAL.SIDES);
        p.push([w * Math.cos(a), PORTAL.SPRING + rise * Math.sin(a)]);
      }
      p.push([w, PORTAL.SPRING], [w, -PORTAL.FOOT]);
      return p;
    };
    const inner = profile(wi, risei), outer = profile(wo, riseo);
    const at = (f: Frame, [u, y]: P2): number[] => [f.x + f.lx * u, floor + y, f.z + f.lz * u];
    const tri = (a: number[], b: number[], c: number[], n: number[], ramp: number): void => {
      for (const q of [a, b, c]) {
        roads.verts.push(q[0], q[1], q[2], n[0], n[1], n[2]);
        roads.ramps.push(ramp);
        roads.attrs!.push(0, 0, 0, 0, 0);
      }
    };
    const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], ramp: number): void => {
      tri(a, b, c, n, ramp);
      tri(a, c, d, n, ramp);
    };
    /** a surface swept along the profile from ring a to ring b; `out` 1 faces away from the axis */
    const sweep = (prof: P2[], a: Frame, b: Frame, out: 1 | -1, ramp: number): void => {
      for (let j = 0; j + 1 < prof.length; j++) {
        const du = prof[j + 1][0] - prof[j][0], dy = prof[j + 1][1] - prof[j][1], len = Math.hypot(du, dy) || 1;
        const nu = (-dy / len) * out, ny = (du / len) * out;
        quad(at(a, prof[j]), at(b, prof[j]), at(b, prof[j + 1]), at(a, prof[j + 1]), [a.lx * nu, ny, a.lz * nu], ramp);
      }
    };
    /** the profile's area filled at a ring, facing along `sign` × the tunnel's direction */
    const cap = (prof: P2[], f: Frame, sign: 1 | -1, ramp: number): void => {
      const c = at(f, [0, PORTAL.SPRING]);
      for (let j = 0; j + 1 < prof.length; j++) tri(c, at(f, prof[j]), at(f, prof[j + 1]), [f.tx * sign, 0, f.tz * sign], ramp);
      tri(c, at(f, prof[prof.length - 1]), at(f, prof[0]), [f.tx * sign, 0, f.tz * sign], ramp);
    };

    const last = rings[rings.length - 1];
    const lastLl = enuToLatLon(center, last.x, -last.z, 0);
    // the hillside the tube runs into, not the road cut at the mouth
    const earth = groundColourAt(lastLl.lon, lastLl.lat);
    for (let i = 0; i + 1 < rings.length; i++) sweep(outer, rings[i], rings[i + 1], 1, earth);
    // the far end, in case the hill leaves it open
    cap(outer, last, 1, earth);
    // the mouth: the shell's cut end around the opening
    const m = rings[0];
    for (let j = 0; j + 1 < inner.length; j++) {
      quad(at(m, inner[j]), at(m, outer[j]), at(m, outer[j + 1]), at(m, inner[j + 1]), [-m.tx, 0, -m.tz], earth);
    }
    // the opening: a short dark reveal and the dark beyond it (the hill inside the tube stays hidden)
    const recess = frame(Math.min(1.5, length / 2));
    sweep(inner, m, recess, -1, TUNNEL_DARK);
    cap(inner, recess, -1, TUNNEL_DARK);
  };

  /** every way end of a tunnel that no other tunnel way continues from, inside this tile */
  const buildPortals = (): void => {
    const tunnels = opts.data.lines.filter((l) => l.points.length >= 2 && isTunnel(l.tags));
    if (!tunnels.length) return;
    const key = (p: LonLat): string => `${p[0]},${p[1]}`;
    const ends = new Map<string, number>();
    for (const l of tunnels) for (const e of [l.points[0], l.points[l.points.length - 1]]) ends.set(key(e), (ends.get(key(e)) ?? 0) + 1);
    const b = tileBounds(tile);
    const inTile = ([lon, lat]: LonLat): boolean => lon >= b.west && lon < b.east && lat >= b.south && lat < b.north;
    let over: Over[] | undefined;
    for (const l of tunnels) {
      const style = classifyLine(l.tags);
      if (!style) continue;
      const first = l.points[0], lastPt = l.points[l.points.length - 1];
      const atFirst = inTile(first) && ends.get(key(first)) === 1, atLast = inTile(lastPt) && ends.get(key(lastPt)) === 1;
      if (!atFirst && !atLast) continue;
      over ??= opts.data.lines.flatMap((r) => {
        if ((!r.tags.highway && !r.tags.railway) || isTunnel(r.tags)) return [];
        const rs = classifyLine(r.tags);
        if (!rs) return [];
        const pts = r.points.map(([lon, lat]) => enu(lon, lat));
        return pts.slice(1).map((b, i) => ({ a: pts[i], b, half: rs.width / 2 }));
      });
      if (atFirst) buildPortal(l.points, style.width / 2, over);
      if (atLast) buildPortal([...l.points].reverse(), style.width / 2, over);
    }
  };

  /**
   * What carries the lifted ways (bridge-mesher.ts), this tile's share: each way's stretches lifted
   * DECK_MIN_LIFT_M or more, cut at the tile border like its ribbon
   */
  const buildBridges = (): { vertices: Float32Array; ramps: Uint32Array } => {
    if (!levels || !tin || !raisedWays.length) return { vertices: new Float32Array(0), ramps: new Uint32Array(0) };
    const g = tin.grid;
    const groundAt = (x: number, z: number): number => {
      const ll = enuToLatLon(center, x, -z, 0);
      return Math.max(sampleHeight(ll.lon, ll.lat), 0);
    };
    // every drawn road and railway: no pier stands on one
    const others = opts.data.lines.flatMap((l) => {
      if ((!l.tags.highway && !l.tags.railway) || isTunnel(l.tags)) return [];
      const style = classifyLine(l.tags);
      if (!style) return [];
      const p = l.points.map(([lon, lat]) => enu(lon, lat));
      return p.slice(1).map((b, i) => ({ a: p[i], b, reach: style.width / 2 + 1, tags: l.tags }));
    });
    interface Raw { e: [number, number]; d: number; lift: number }
    const runs: DeckRun[] = [];
    for (const w of raisedWays) {
      const bridge = isBridge(w.line.tags);
      const lifts = w.pts.map((p) => levels.liftAt(w.line, p.d));
      const blocked = (x: number, z: number): boolean => others.some((o) => {
        if (o.tags === w.line.tags) return false;
        const dx = o.b[0] - o.a[0], dz = o.b[1] - o.a[1], l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - o.a[0]) * dx + (z - o.a[1]) * dz) / l2)) : 0;
        return Math.hypot(x - o.a[0] - dx * t, z - o.a[1] - dz * t) < o.reach;
      });
      let cur: Raw[] = [];
      const flush = (): void => {
        if (cur.length >= 2) {
          const raw = cur;
          const stations = raw.map((p, i): DeckStation => {
            const a = raw[Math.max(0, i - 1)].e, b = raw[Math.min(raw.length - 1, i + 1)].e;
            const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            // left of the way's direction (x east, z south)
            const nx = (b[1] - a[1]) / l, nz = -(b[0] - a[0]) / l;
            const [x, z] = p.e, ground = groundAt(x, z);
            return {
              d: p.d, x, z, y: ground + w.bias * biasScale + p.lift, ground,
              groundL: groundAt(x + nx * w.half, z + nz * w.half), groundR: groundAt(x - nx * w.half, z - nz * w.half),
              nx, nz, half: w.half,
            };
          });
          const m = raw[raw.length >> 1].e, ll = enuToLatLon(center, m[0], -m[1], 0);
          runs.push({ stations, bridge, earth: groundColourAt(ll.lon, ll.lat), blocked, level: levelDeck(w.line) });
        }
        cur = [];
      };
      for (let i = 0; i + 1 < w.pts.length; i++) {
        const a = w.pts[i], b = w.pts[i + 1];
        // from the vertex before the lift passes DECK_MIN_LIFT_M: no lifted stretch without a body
        if (lifts[i] < DECK_MIN_LIFT_M && lifts[i + 1] < DECK_MIN_LIFT_M) { flush(); continue; }
        // this tile's part of the segment (Liang–Barsky on the lattice square)
        let t0 = 0, t1 = 1, inside = true;
        const dx = b.c[0] - a.c[0], dy = b.c[1] - a.c[1];
        for (const [p, q] of [[-dx, a.c[0]], [dx, g - a.c[0]], [-dy, a.c[1]], [dy, g - a.c[1]]]) {
          if (p === 0) { if (q < 0) inside = false; continue; }
          const r = q / p;
          if (p < 0) t0 = Math.max(t0, r);
          else t1 = Math.min(t1, r);
        }
        if (!inside || t0 >= t1) { flush(); continue; }
        const at = (t: number): Raw => ({ e: [a.e[0] + (b.e[0] - a.e[0]) * t, a.e[1] + (b.e[1] - a.e[1]) * t], d: a.d + (b.d - a.d) * t, lift: lifts[i] + (lifts[i + 1] - lifts[i]) * t });
        if (t0 > 0) flush();
        if (!cur.length) cur.push(at(t0));
        cur.push(at(t1));
        if (t1 < 1) flush();
      }
      flush();
    }
    return buildDecks(runs);
  };

  /**
   * With the cover: the TIN's own faces of the carriageways, ballast and runways (to `roads`, their
   * paint or track in the vertex attributes of the shape's segment under the face's centre) and of
   * the water (to `water`), on its vertices at their heights (water and below at 0 m), lifted by nothing
   */
  const buildCoverFaces = (): void => {
    if (!cover || !tin?.cover) return;
    const of = tin.cover, styles = opts.areaStyles ?? DEFAULT_AREA_STYLES;
    // on the terrain mesh's own vertices, bit for bit (latticeToWorld): no pinhole along a road's or the water's edge
    const world = latticeToWorld(tile, tin.grid);
    const at: (Vtx | undefined)[] = new Array(tin.vx.length);
    const vertex = (k: number): Vtx => {
      let p = at[k];
      if (!p) {
        const [x, z] = world(tin.vx[k], tin.vy[k]);
        p = at[k] = { x, z, y: Math.max(0, tin.vh[k]) };
      }
      return p;
    };
    const rampOf = new Map<number, number>();
    tin.tris.forEach((t, f) => {
      const si = of[f];
      if (si < 0) return;
      const shape = cover.shapes[si];
      const out = shape.kind === 'water' ? water : FACE_KINDS.has(shape.kind) ? roads : undefined;
      if (!out) return;
      let ramp = rampOf.get(si);
      // these kinds take no imagery colour
      if (ramp === undefined) rampOf.set(si, ramp = coverRamp(shape, styles, undefined));
      const attr = shape.attr && shape.attr.segs[shape.attr.segAt((tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3)];
      emitTri(vertex(t.a), vertex(t.b), vertex(t.c), ramp, out, attr);
    });
  };

  buildCoverFaces();
  for (const area of data.areas) buildArea(area);
  if (tin) for (const area of opts.data.areas) if (area.tags.leisure === 'pitch') buildPitch(area);
  for (const line of data.lines) buildLine(line);
  if (tin) for (const line of opts.data.lines) buildRibbon(line);
  buildLooseShapes();
  flushLoose();
  for (const p of data.points) buildPoint(p);
  buildPortals();
  const bridges = buildBridges();

  if (opts.buildings !== false && data.buildings.length) {
    const bm = buildBuildingMesh({ tile, buildings: data.buildings, sampleHeight, points: data.points });
    for (let i = 0; i < bm.vertices.length; i++) verts.push(bm.vertices[i]);
    for (let i = 0; i < bm.ramps.length; i++) ramps.push(bm.ramps[i]);
  }

  /** per vertex of a mesh its depth level (0 but the dropped ways' ribbons), or none at all when it has none */
  const depthOf = (out: Out): Float32Array => {
    if (!out.depth) return new Float32Array(0);
    const a = new Float32Array(out.ramps.length);
    a.set(out.depth.levels, out.depth.from);
    return a;
  };

  return {
    vertices: new Float32Array(verts),
    ramps: new Uint32Array(ramps), // face colours (palette.ts)
    vertexCount: ramps.length,
    roads: { vertices: new Float32Array(roads.verts), ramps: new Uint32Array(roads.ramps), vertexCount: roads.ramps.length },
    roadAttrs: new Float32Array(roads.attrs!),
    water: { vertices: new Float32Array(water.verts), ramps: new Uint32Array(water.ramps), vertexCount: water.ramps.length },
    bridges: { ...bridges, vertexCount: bridges.ramps.length },
    roadLines: new Float32Array(roadLines),
    pitchLines: new Float32Array(pitchLines),
    lamps: new Float32Array(lamps),
    lampPosts: new Float32Array(lampPosts),
    depthLevels: depthOf(main),
    roadDepthLevels: depthOf(roads),
    waterDepthLevels: depthOf(water),
  };
}