import earcut from 'earcut';
import { colour, colourOf, isMaterial, LIGHT, LUT_SIZE, RAMP, ROAD_EDGE, ROAD_MARK, ROAD_MARK_END_M, ROAD_TAPER_M, ROAD_U_BASE, TRACK_EDGE, FORK_TAPER_M, rampGlowLevel, rampIndex, rgbOf, snowy, withGlow, type RGB } from '../engine/palette';
import { DEFAULT_AREA_STYLES, filterColour, type AreaFilter, type AreaKind, type AreaStyles } from './area-styles';
import type { FaceColor } from './landsat';
import { enuToLatLon, gridLatLon, latLonToEnu, tileBounds, tileCenter, tileSizeMeters, type Tile } from './geodesy';
import { buildBuildingMesh } from './building-mesher';
import { clipTileData } from './clip';
import { INSTANCE, LAMP_SHAPE, pushInstance } from './props-mesher';
import { baseballMarkings, orientedRect, pitchMarkings, pitchSport, pitchSurface, type Seg } from './pitch-markings';
export { FORK_TAPER_M, ROAD_EDGE, ROAD_MARK, ROAD_MARK_END_M, ROAD_TAPER_M, ROAD_U_BASE, TRACK_EDGE } from '../engine/palette';
import type { LonLat, OsmArea, OsmDetail, OsmLine, OsmPoint, OsmTileData } from './osm-types';
import type { HeightSampler } from './terrain-source';
import type { TerrainMeshData } from './terrain-mesher';
import type { TerrainTin } from './terrain-tin';

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
  tin?: TerrainTin;
  /**
   * Imagery colour of a TIN face (the terrain mesh's own). With it, filtered areas (AreaStyle.filter)
   * take the colour of the face under each piece blended with their filter (area-styles).
   */
  faceColor?: FaceColor;
  /** filters of the areas over the imagery (area style editor); DEFAULT_AREA_STYLES by default */
  areaStyles?: AreaStyles;
}

type P2 = [number, number];
/**
 * How a ribbon ends: start/end a lattice vector from its end point towards the way that continues it
 * (the joint mitred), and whether it gets a round cap there
 */
interface RibbonEnds { start?: P2; end?: P2; capStart: boolean; capEnd: boolean }
const ROUND_ENDS: RibbonEnds = { capStart: true, capEnd: true };
/** cosine of half the turn: sharper than a right angle a ribbon's bend is rounded, not mitred */
const SHARP_TURN_COS = Math.SQRT1_2;
/** a vertex's WINDOW_ATTR_FLOATS (WORLD_VS aWinUV, aWinEdge) from its position */
type VertexAttr = (p: { x: number; z: number }) => [number, number, number, number, number];

/** colour of a far road line: mid-lit asphalt (GL lines are not lit) */
const ROAD_LINE_INDEX = rampIndex(RAMP.ASPHALT, 8);
/** colour of a far railway line */
const RAIL_LINE_INDEX = rampIndex(RAMP.HULL_DARK, 7);
/** runway, taxiway, apron and helipad areas above the aerodrome pad, m */
export const AEROWAY_AREA_BIAS = 0.1;
/** runway and taxiway ribbons above the pad, m: over the asphalt areas they cross */
export const AEROWAY_LINE_BIAS = 0.2;

/**
 * A street-lit road: every residential street and motorway / trunk / primary / secondary road,
 * and any road tagged lit=yes.
 */
export function isLitRoad(tags: Record<string, string>): boolean {
  const hw = tags.highway;
  if (!hw) return false;
  return tags.lit === 'yes' || hw === 'residential' || hw === 'living_street' || hw === 'motorway' || hw === 'trunk' || hw === 'primary' || hw === 'secondary';
}

/** glow level of a street-lit road surface at night (the brightest built-up ground is GLOW_LEVELS) */
export const LIT_ROAD_GLOW = 7;
/** glow level of an unlit road at night: just above the night sky's ground */
export const UNLIT_ROAD_GLOW = 2;
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
  /** far stand-in for the roads: GL line vertex pairs (x, y, z, palette index) on the terrain */
  roadLines: Float32Array;
  /** pitch markings, drawn near: 1 px GL line vertex pairs (x, y, z, palette index) on the terrain */
  pitchLines: Float32Array;
  /** night: lamp heads at the ends of the lamp arms (x, y, z, palette index); far, the same points
   *  stand in for the street-lit roads as a dotted line */
  lamps: Float32Array;
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

interface Pt {
  lon: number;
  lat: number;
  x: number;
  z: number;
  y: number;
}

interface AreaStyle {
  ramp: number;
  bias: number;
  water: boolean;
  /**
   * A colour filter instead of a solid fill: each piece takes the imagery colour of the terrain face
   * under it blended with this filter (area-styles filterColour), so the ground keeps its own
   * pattern. Where the face has no imagery colour (or no faceColor is given), `ramp` is drawn.
   */
  filter?: AreaFilter;
}

/** pitches over the parks round them; their markings a little above */
export const PITCH_BIAS = 0.65;
export const PITCH_LINE_BIAS = 0.7;
/** a pitch at least this big (m²) has floodlights on its corners and is lit at night */
export const PITCH_LIT_MIN_M2 = 300;
/** floodlit pitch surface at night: the brightest artificial light */
export const PITCH_GLOW = 7;
/** the floodlight poles stand this far out from the pitch's corners, metres */
const PITCH_LAMP_SETBACK_M = 1.5;
/** pitch markings: white paint (the snow ramp, well lit) in the palette of the day */
export const PITCH_LINE_INDEX = rampIndex(RAMP.SNOW, 10);
/** on a floodlit pitch: the same from the brightest street-lit copy (the plain one by day, buildLUT) */
export const LIT_PITCH_LINE_INDEX = PITCH_GLOW * LUT_SIZE + PITCH_LINE_INDEX;

function classifyArea(tags: Record<string, string>, styles: AreaStyles): AreaStyle | undefined {
  /** open ground (fields, parks, beaches...): snow covers it in winter */
  const ground = (ramp: number, bias: number, kind: AreaKind): AreaStyle => ({ ramp: snowy(ramp), bias, water: false, filter: styles[kind] });
  const natural = tags.natural;
  const landuse = tags.landuse;
  const leisure = tags.leisure;
  const aeroway = tags.aeroway;
  const waterway = tags.waterway;
  if (natural === 'water' || waterway === 'riverbank' || waterway === 'river' || waterway === 'canal') {
    return { ramp: RAMP.WATER, bias: 0.3, water: true };
  }
  if (aeroway === 'runway' || aeroway === 'taxiway' || aeroway === 'apron' || aeroway === 'helipad') {
    // on the aerodrome's flat pad (aerodrome.ts): a hair above it, where the aircraft's wheels are
    return { ramp: RAMP.ASPHALT, bias: AEROWAY_AREA_BIAS, water: false };
  }
  // no fill for wood/forest (trees only, props-mesher) or landuse other than farmland: Landsat colours the terrain
  if (natural === 'scrub') return ground(RAMP.FOREST, 0.6, 'scrub');
  if (natural === 'beach') return ground(RAMP.SAND, 0.6, 'beach');
  if (natural === 'bare_rock' || natural === 'scree') return ground(RAMP.ROCK, 0.6, 'rock');
  if (landuse === 'farmland') return ground(RAMP.FIELD, 0.6, 'farmland');
  if (leisure === 'pitch') {
    // over the park it lies in; a tagged surface solid, natural grass the imagery in a grass filter
    const surface = pitchSurface(tags);
    return surface !== undefined ? { ramp: surface, bias: PITCH_BIAS, water: false } : ground(RAMP.GRASS, PITCH_BIAS, 'pitch');
  }
  if (leisure === 'park') return ground(RAMP.GRASS, 0.6, 'park');
  if (leisure === 'garden') return ground(RAMP.GRASS, 0.6, 'garden');
  if (leisure === 'golf_course') return ground(RAMP.GRASS, 0.6, 'golf');
  if (tags.building) return { ramp: RAMP.BRICK, bias: 0.7, water: false };
  if (natural === 'wetland') return ground(RAMP.GRASS, 0.5, 'wetland');
  return undefined;
}

interface LineStyle {
  ramp: number;
  width: number;
  /** a road's shoulder beyond the carriageway on each side, metres (ROAD_SHOULDER_M) */
  shoulder?: number;
  /** a railway: its ballast carries the track (WORLD_FS trackAt) and a right-of-way strip beside it */
  rail?: boolean;
  /** a minor road (service, track, footway-like streets): no far line */
  minor?: boolean;
  /** a road's paint (roadMarks code, WORLD_FS roadMarkAt); 0: none */
  marks?: number;
}

/**
 * OSM `width` in metres: "5", "5.5 m", "3,5", "12'", "12 ft", "4'6\"". Undefined when absent,
 * unreadable or outside 0.5–200 m (a typo, not a road).
 */
export function osmWidthM(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim().replace(',', '.');
  const feet = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/.exec(v);
  const m = feet ? (Number(feet[1]) + Number(feet[2] ?? 0) / 12) * 0.3048 : /^(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)?$/.exec(v)?.[1];
  const w = Number(m);
  return Number.isFinite(w) && w >= 0.5 && w <= 200 ? w : undefined;
}

/** carriageway width per lane when a road has `lanes` but no `width` */
const LANE_WIDTH_M = 3.5;
/** width of a waterway line without a `width` tag, metres */
const WATERWAY_WIDTH_M: Record<string, number> = { river: 18, canal: 18, stream: 3, brook: 2, ditch: 1.5, drain: 1.5 };

/**
 * Roads drawn near, by highway=*: carriageway width without `width` or `lanes`, and the shoulder
 * beside it on each side (none on town streets that have kerbs instead); footways, paths, cycleways,
 * steps and the like are not drawn. *_link roads take LINK_ROAD.
 */
const ROAD_KINDS: Record<string, { width: number; shoulder: number; minor?: boolean }> = {
  motorway: { width: 20, shoulder: 3 },
  trunk: { width: 20, shoulder: 3 },
  primary: { width: 14, shoulder: 2.5 },
  secondary: { width: 11, shoulder: 2 },
  tertiary: { width: 9, shoulder: 1.5 },
  unclassified: { width: 7, shoulder: 1 },
  road: { width: 6, shoulder: 1 },
  busway: { width: 7, shoulder: 1 },
  raceway: { width: 10, shoulder: 1.5, minor: true },
  residential: { width: 7, shoulder: 0.5 },
  living_street: { width: 6, shoulder: 0 },
  service: { width: 4, shoulder: 0.5, minor: true },
  track: { width: 3, shoulder: 0, minor: true },
  pedestrian: { width: 5, shoulder: 0, minor: true },
};
const LINK_ROAD = { width: 7, shoulder: 1.5 };
/** service=parking_aisle / driveway: narrower, no shoulder */
const NARROW_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through', 'alley']);
/** shoulders: compacted gravel and earth */
export const SHOULDER_RAMP = snowy(colour(150, 140, 118));
/** unpaved roads and tracks: gravel, or earth and grass ruts */
export const GRAVEL_ROAD_RAMP = snowy(colour(146, 134, 110));
export const DIRT_ROAD_RAMP = snowy(colour(118, 102, 80));
const GRAVEL_SURFACES = new Set(['unpaved', 'gravel', 'fine_gravel', 'compacted', 'pebblestone', 'shells']);
const DIRT_SURFACES = new Set(['dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'grass_paver', 'woodchips']);
const PAVED_SURFACES = new Set(['paved', 'asphalt', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'cobblestone']);
/** railway ballast (the track on it is WORLD_FS trackAt): grey-brown crushed stone, cleared of snow */
export const BALLAST_RAMP = colour(104, 98, 90);
/** railway=* drawn: main lines, sidings and yards (service=*), narrow gauge and light rail */
const RAIL_KINDS = new Set(['rail', 'narrow_gauge', 'light_rail']);
/** width of the ballast bed, metres (sleepers 2.7 m in the middle) */
export const BALLAST_WIDTH_M = 6;
/** the right-of-way strip beside the ballast on each side (cleared, mown), metres */
export const RAIL_ZONE_M = 8;
export const RAIL_ZONE_RAMP = snowy(colour(124, 118, 86));

/** lanes of a two-way road of the class without a `lanes` tag (a one-way road half of them, at least 1) */
const DEFAULT_LANES: Record<string, number> = {
  motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, unclassified: 2, road: 2, busway: 2,
};
const EDGE_LINE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

/**
 * Priority of a road where it meets others: the higher one lies over the lower (its ribbon a little
 * higher, ROAD_RANK_STEP_M a rank) and keeps its paint through the junction; links yield to whatever
 * they join. A bridge or a higher layer lies over everything under it (ROAD_LAYER_STEP_M a layer).
 */
const ROAD_RANK: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5, unclassified: 4, road: 3.5, busway: 3.5,
  residential: 3, living_street: 2, service: 1.5, pedestrian: 1, track: 1, raceway: 1,
};
const LINK_RANK = 4.5;
export const ROAD_RANK_STEP_M = 0.02;
export const ROAD_LAYER_STEP_M = 0.25;
/** at most this far apart, roads of equal priority (by a hash of their first point: always the same) */
export const ROAD_TIE_M = 0.012;
/** 0..1 from a point, the same in every tile */
function tieBreak([lon, lat]: LonLat): number {
  let h = Math.imul(Math.round(lon * 1e7) | 0, 73856093) ^ Math.imul(Math.round(lat * 1e7) | 0, 19349663);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
}
/**
 * Where roads of one class meet (an interchange of secondary ramps and carriageways), the wider one
 * lies over the narrower: the rank plus up to 0.9 by the width (40 m and wider: all of it)
 */
export function roadPriority(tags: Record<string, string>, width: number): number {
  return roadRank(tags) + (Math.min(width, 40) / 40) * 0.9;
}
export function roadRank(tags: Record<string, string>): number {
  const hw = tags.highway ?? '';
  return /_link$/.test(hw) ? LINK_RANK : ROAD_RANK[hw] ?? 0;
}
/** the layer a way is drawn in: `layer`, else 1 on a bridge; never below the ground (tunnels are not drawn) */
export function roadLayer(tags: Record<string, string>): number {
  const l = Number(tags.layer);
  if (Number.isFinite(l)) return Math.max(0, Math.min(5, Math.round(l)));
  return tags.bridge && tags.bridge !== 'no' ? 1 : 0;
}

/** a fork branch's direction is taken over its first this many metres */
const FORK_PROBE_M = 15;
/** one carriageway without `width` or `lanes`: at least this wide */
const ONEWAY_MIN_WIDTH_M = 4;
/** a one-way road: oneway=yes/1/-1, a roundabout, or a motorway or link not tagged oneway=no */
export function isOnewayRoad(tags: Record<string, string>): boolean {
  const o = tags.oneway;
  if (o === 'no') return false;
  if (o === 'yes' || o === '1' || o === '-1' || o === 'true') return true;
  const hw = tags.highway ?? '';
  return hw === 'motorway' || /_link$/.test(hw) || tags.junction === 'roundabout' || tags.junction === 'circular';
}

export function roadMarks(hw: string, tags: Record<string, string>): number {
  const link = /_link$/.test(hw);
  const cls = hw.replace(/_link$/, '');
  if (DEFAULT_LANES[cls] === undefined) return 0;
  const oneway = isOnewayRoad(tags.highway ? tags : { ...tags, highway: hw });
  const tagged = Number(tags.lanes);
  const lanes = Number.isInteger(tagged) && tagged >= 1 && tagged <= ROAD_MARK.LANES ? tagged
    : link ? 1 : oneway ? Math.max(1, DEFAULT_LANES[cls] / 2) : DEFAULT_LANES[cls];
  let code = lanes;
  if (oneway) code |= ROAD_MARK.ONEWAY;
  if (EDGE_LINE_CLASSES.has(cls)) code |= ROAD_MARK.EDGES;
  if (!oneway && lanes >= 4) code |= ROAD_MARK.DOUBLE;
  // a single-lane two-way road with no edge lines: nothing to paint
  return !oneway && lanes < 2 && !(code & ROAD_MARK.EDGES) ? 0 : code;
}

export function classifyLine(tags: Record<string, string>): LineStyle | undefined {
  const hw = tags.highway;
  if (hw) {
    if (tags.area === 'yes') return undefined;
    let kind = ROAD_KINDS[hw] ?? (/^(motorway|trunk|primary|secondary|tertiary)_link$/.test(hw) ? LINK_ROAD : undefined);
    if (!kind) return undefined;
    if (hw === 'service' && NARROW_SERVICE.has(tags.service)) kind = { width: 3, shoulder: 0, minor: true };
    const lanes = Number(tags.lanes);
    const width =
      osmWidthM(tags.width) ??
      (Number.isInteger(lanes) && lanes > 0 && lanes <= 16 ? lanes * LANE_WIDTH_M : undefined) ??
      // one carriageway of a dual road: half the road's width
      (isOnewayRoad(tags) ? Math.max(ONEWAY_MIN_WIDTH_M, kind.width / 2) : kind.width);
    const surface = tags.surface ?? (hw === 'track' ? 'unpaved' : undefined);
    const unpaved = surface !== undefined && !PAVED_SURFACES.has(surface) && (GRAVEL_SURFACES.has(surface) || DIRT_SURFACES.has(surface));
    const ramp = !unpaved ? (hw === 'pedestrian' ? RAMP.CONCRETE : RAMP.ASPHALT)
      : DIRT_SURFACES.has(surface!) || (hw === 'track' && (tags.tracktype === 'grade4' || tags.tracktype === 'grade5')) ? DIRT_ROAD_RAMP : GRAVEL_ROAD_RAMP;
    // a bridge has railings, not shoulders (and no strip painted over the water under it)
    const shoulder = unpaved || (tags.bridge && tags.bridge !== 'no') ? 0 : kind.shoulder;
    return { ramp, width, shoulder, minor: kind.minor, marks: unpaved ? 0 : roadMarks(hw, tags) };
  }
  if (tags.railway && RAIL_KINDS.has(tags.railway)) return { ramp: BALLAST_RAMP, width: BALLAST_WIDTH_M, rail: true };
  const ww = tags.waterway;
  if (ww && WATERWAY_WIDTH_M[ww] !== undefined) {
    // piped under roads, fields and buildings: nothing to see
    if (tags.tunnel && tags.tunnel !== 'no') return undefined;
    if (tags.location === 'underground') return undefined;
    return { ramp: RAMP.WATER, width: osmWidthM(tags.width) ?? WATERWAY_WIDTH_M[ww] };
  }
  if (tags.aeroway === 'runway' || tags.aeroway === 'taxiway') return { ramp: RAMP.ASPHALT, width: 30 };
  return undefined;
}

/**
 * A road or railway under the ground: no ribbon over the hill above it, only its portals.
 * `building_passage` runs under a building and is open to the sky on both sides of it.
 */
export function isTunnel(tags: Record<string, string>): boolean {
  const t = tags.tunnel;
  return !!t && t !== 'no' && t !== 'building_passage' && (tags.highway !== undefined || tags.railway !== undefined);
}

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
  // attrs: per vertex WINDOW_ATTR_FLOATS (WORLD_VS aWinUV, aWinEdge) where the mesh carries them
  interface Out { verts: number[]; ramps: number[]; attrs?: number[] }
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

  const emitTri = (a: Pt, b: Pt, c: Pt, ramp: number, out: Out = main, attr?: VertexAttr): void => {
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
  const faces = tin
    ? tin.tris.map((t) => {
        const c: [P2, P2, P2] = [[tin.vx[t.a], tin.vy[t.a]], [tin.vx[t.b], tin.vy[t.b]], [tin.vx[t.c], tin.vy[t.c]]];
        // the mesh draws water and anything below it at 0 m
        const h = [Math.max(0, tin.vh[t.a]), Math.max(0, tin.vh[t.b]), Math.max(0, tin.vh[t.c])];
        const det = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[2][0] - c[0][0]) * (c[1][1] - c[0][1]);
        return {
          c, h, det,
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
  const toLattice = ([lon, lat]: LonLat): P2 => {
    const n = 2 ** tile.z, g = tin!.grid;
    const sinLat = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return [(((lon + 180) / 360) * n - tile.x) * g, (merc * n - tile.y) * g];
  };
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
  const onFaces = (tri: [P2, P2, P2], ramp: number, bias: number, out: Out = main, filter?: AreaFilter, attr?: VertexAttr): void => {
    const x0 = Math.min(tri[0][0], tri[1][0], tri[2][0]), x1 = Math.max(tri[0][0], tri[1][0], tri[2][0]);
    const y0 = Math.min(tri[0][1], tri[1][1], tri[2][1]), y1 = Math.max(tri[0][1], tri[1][1], tri[2][1]);
    for (const f of facesNear(x0, y0, x1, y1)) {
      const piece = clipToTriangle(tri, f.c);
      if (piece.length < 3) continue;
      const pts = piece.map(([x, y]) => onFace(f, x, y, bias));
      const under = filter && imageryOf(f);
      const col = under ? withGlow(snowy(colourOf(filterColour(under, filter))), rampGlowLevel(ramp)) : ramp;
      for (let k = 1; k + 1 < pts.length; k++) emitTri(pts[0], pts[k], pts[k + 1], col, out, attr);
    }
  };
  /** a segment cut by the terrain faces it crosses: GL line pairs lying on them */
  const lineOnFaces = (p: P2, q: P2, bias: number, out: number[], index: number): void => {
    const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]);
    const y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
    // a box of zero width finds no face: widen it a hair
    for (const f of facesNear(x0 - 1e-6, y0 - 1e-6, x1 + 1e-6, y1 + 1e-6)) {
      const t = segmentInTriangle(p, q, f.c);
      if (!t) continue;
      for (const s of t) {
        const v = onFace(f, p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, bias);
        out.push(v.x, v.y, v.z, index);
      }
    }
  };

  const buildArea = (area: OsmArea): void => {
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
  const ringArea = (r: [number, number][]): number => {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length];
      a += x0 * z1 - x1 * z0;
    }
    return Math.abs(a) / 2;
  };
  /**
   * the whole outline (not this tile's share of it) decides, so the tiles a pitch spans agree; the
   * clipped share keeps the tags object of the whole (clip.ts)
   */
  const wholePitch = new Map<Record<string, string>, OsmArea>();
  for (const a of opts.data.areas) if (a.tags.leisure === 'pitch') wholePitch.set(a.tags, a);
  const litPitch = (area: OsmArea): boolean => ringArea(pitchRing(wholePitch.get(area.tags) ?? area)) >= PITCH_LIT_MIN_M2;

  /**
   * A pitch's markings (big-field sports, 1 px lines on the terrain faces, this tile's share) and the
   * floodlights on the corners of its rectangle (those standing in this tile), arms over the pitch
   */
  const buildPitch = (area: OsmArea): void => {
    const ring = pitchRing(area);
    const r = orientedRect(ring);
    if (!r) return;
    const vx = -r.uz, vz = r.ux;
    const toXZ = (s: number, t: number): [number, number] => [r.cx + r.ux * s + vx * t, r.cz + r.uz * s + vz * t];
    const sport = pitchSport(area.tags);
    let segs: Seg[] | undefined;
    let frame = toXZ;
    if (sport === 'baseball') {
      // home plate: the corner of the fan nearest a right angle; second base towards the middle
      let home = ring[0], bestDev = Infinity;
      const mx = ring.reduce((s, p) => s + p[0], 0) / ring.length, mz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
        const ax = a[0] - p[0], az = a[1] - p[1], bx = b[0] - p[0], bz = b[1] - p[1];
        const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
        const dev = Math.abs(cos);
        if (dev < bestDev) { bestDev = dev; home = p; }
      }
      const dl = Math.hypot(mx - home[0], mz - home[1]) || 1;
      const dx = (mx - home[0]) / dl, dz = (mz - home[1]) / dl;
      const reach = Math.max(...ring.map((p) => Math.hypot(p[0] - home[0], p[1] - home[1])));
      segs = baseballMarkings(reach * 0.95);
      frame = (s, t) => [home[0] + dx * s - dz * t, home[1] + dz * s + dx * t];
    } else if (sport) {
      segs = pitchMarkings(sport, r.length, r.width);
    }
    const lattice = ([x, z]: [number, number]): P2 => {
      const ll = enuToLatLon(center, x, -z, 0);
      return toLattice([ll.lon, ll.lat]);
    };
    const lit = ringArea(ring) >= PITCH_LIT_MIN_M2;
    for (const [s0, t0, s1, t1] of segs ?? []) {
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
  const placeLamps = (points: LonLat[], half: number, fixedSide: 1 | -1 | 0): void => {
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
        const y0 = Math.max(sampleHeight(ll.lon, ll.lat), 0);
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
    const bridge = !!line.tags.bridge && line.tags.bridge !== 'no';
    return {
      half: style.width / 2,
      road,
      lit,
      rail: !!style.rail,
      minor: !!style.minor,
      marks: style.marks ?? 0,
      shoulder: style.shoulder ?? 0,
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
  /** points of a round cap around an end of a ribbon (lattice units); 12 sides */
  const CAP_SIDES = 12;

  /**
   * A line's ribbon on the TIN, from the whole way (not this tile's share of it): each triangle is
   * cut by the terrain faces under it, so the relief cannot cut through it, and whatever lies past
   * the tile border finds no face here and is dropped. The neighbour cuts the same ribbon at the
   * same border, so the two halves meet exactly. Each end of the way gets a round cap: OSM splits
   * roads and rivers into ways that meet at an angle, and square ends left a wedge open outside
   * every such bend. Inside a way the sides are mitred, so a bend keeps the full width.
   */
  /** the drawn roads at each OSM node (the whole ways, not this tile's share): at an end or passing through */
  const roadsAtNode = new Map<string, { line: OsmLine; end: boolean; rank: number; prio: number; layer: number; half: number }[]>();
  const nodeKey = (p: LonLat) => `${p[0]},${p[1]}`;
  for (const line of opts.data.lines) {
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
   * How far from its end `at` a road's paint stops: at a junction, where roads of its priority or
   * higher (in its layer) meet it more than its own continuation does, past the widest of them; a
   * road split in two, or meeting only lower ones there, paints on through.
   */
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

  /**
   * A branch of a fork starts with its outer edge on the trunk's (shifted away from the other branch
   * by half the difference of their widths) and eases onto its own line over FORK_TAPER_M (at most
   * half its length): the centre line shifted, with a vertex where the shift ends. Two branches as
   * wide as the trunk together lie side by side; wider ones overlap in the middle (lanes merging),
   * narrower ones leave a gap (a median beginning).
   */
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

  /**
   * The width of the way that continues `line` at `at` (the one other road of its rank, layer and
   * one-way-ness ending there), or undefined where there is none or more than one
   */
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

  /**
   * A painted road (WORLD_FS roadMarkAt). Where the way that continues it is narrower (a lane fewer:
   * the speed-change lanes at ramps), this one narrows to its width at the shared node, linearly
   * over ROAD_TAPER_M (at most half its length): the dropped lane closes on the right, the lines
   * measured from the left edge stay put. Vertex attributes:
   *   u   ROAD_U_BASE + metres from the start in the first half, -(ROAD_U_BASE + metres from the end)
   *       in the second (a vertex at the middle, so no triangle spans both)
   *   v   metres from the left edge (in the driving direction of a one-way road)
   *   edge.x  ROAD_EDGE - (start taper length / 2 m) · 64 - (end taper length / 2 m)
   *   edge.y  full width / 0.25 m + (start narrowing / 0.5 m) · 1024 + (end narrowing / 0.5 m) · 32768
   *   edge.z  the ROAD_MARK code + (start gap / 0.5 m) << 7 + (end gap / 0.5 m) << 13
   */
  const paintedRibbon = (line: OsmLine, src: { c: P2; e: [number, number] }[], look: NonNullable<ReturnType<typeof lineLook>>, ends: RibbonEnds): void => {
    const q = (v: number, step: number, max: number) => Math.max(0, Math.min(max, Math.round(v / step)));
    const wq = q(look.half * 2, 0.25, 1023), width = wq * 0.25;
    const lens = src.slice(1).map((p, i) => Math.hypot(p.e[0] - src[i].e[0], p.e[1] - src[i].e[1]));
    const length = lens.reduce((a, b) => a + b, 0);
    if (length < 1e-3) return;
    const first = line.points[0], last = line.points[line.points.length - 1];
    const narrow = (at: LonLat) => {
      const w = continuationWidth(line, at);
      return w !== undefined && w < width ? q(width - w, 0.5, 31) : 0;
    };
    const n0 = narrow(first), n1 = narrow(last);
    const taperLen = (n: number) => (n ? q(Math.min(ROAD_TAPER_M, length / 2 - 1), 2, 63) : 0);
    const t0q = taperLen(n0), t1q = taperLen(n1);
    const t0 = t0q * 2, t1 = t1q * 2;
    const g0q = q(junctionGap(line, first), 0.5, 63), g1q = q(junctionGap(line, last), 0.5, 63);
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
    const ex = ROAD_EDGE - t0q * 64 - t1q, ey = wq + n0 * 1024 + n1 * 32768, ez = look.marks + (g0q << 7) + (g1q << 13);
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
    ribbon(pts.map((p) => p.c), pts.map((p) => widthAt(p.d) / 2), look.ramp, look.bias, look.out, segs, ends);
  };

  /**
   * How a road's ribbon ends at each node: a dead end gets a round cap; a way continued by exactly
   * one other is mitred onto it (no cap: on a wide road a cap bulged past the edges at every angled
   * joint); at a junction or a fork it ends square, the roads there covering it. Minor roads joining
   * (driveways, parking aisles) do not count.
   */
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

  const buildRibbon = (line: OsmLine): void => {
    const look = lineLook(line);
    if (!look || !tin) return;
    let pts = line.points.map((ll) => ({ c: toLattice(ll), e: enu(ll[0], ll[1]) }))
      .filter((p, i, a) => i === 0 || p.c[0] !== a[i - 1].c[0] || p.c[1] !== a[i - 1].c[1]);
    if (pts.length < 2) return;
    if (look.road) pts = forkShift(line, pts);
    const c = pts.map((p) => p.c);
    const ends = look.road ? roadEnds(line) : ROUND_ENDS;
    // nothing of it reaches this tile: skip the work
    const g = tin.grid, r = (look.half + look.shoulder + look.zone) * latticePerMetre;
    if (c.every((p) => p[0] < -r) || c.every((p) => p[0] > g + r) || c.every((p) => p[1] < -r) || c.every((p) => p[1] > g + r)) return;
    const lit = look.lit ? (ramp: number) => withGlow(ramp, LIT_ROAD_GLOW) : (ramp: number) => ramp;
    // under the carriageway: the right-of-way strip of a railway, the shoulders of a road
    if (look.zone) ribbon(c, look.half + look.zone, RAIL_ZONE_RAMP, ZONE_BIAS, main);
    if (look.shoulder) ribbon(c, look.half + look.shoulder, lit(SHOULDER_RAMP), SHOULDER_BIAS, roads, undefined, ends);
    if (!look.rail) {
      if (!look.marks) {
        ribbon(c, look.half, look.ramp, look.bias, look.out, undefined, ends);
        return;
      }
      paintedRibbon(line, pts, look, ends);
      return;
    }
    // the track: each segment's vertices carry u along the line (metres from its start) and v across it
    const segs: VertexAttr[] = [];
    let u0 = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i].e, [bx, bz] = pts[i + 1].e;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const dx = (bx - ax) / len, dz = (bz - az) / len, start = u0;
      segs.push((p) => [start + (p.x - ax) * dx + (p.z - az) * dz, (p.z - az) * dx - (p.x - ax) * dz, TRACK_EDGE, 0, 0]);
      u0 += len;
    }
    ribbon(c, look.half, look.ramp, RAIL_BIAS, roads, segs);
  };

  /**
   * A ribbon `half` metres wide each side of the lattice polyline `c`, cut by the terrain faces; per
   * segment vertex attributes optional (the caps take the first and last segment's)
   */
  const ribbon = (c: P2[], half: number | number[], ramp: number, bias: number, out: Out, segs?: VertexAttr[], ends: RibbonEnds = ROUND_ENDS): void => {
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
      // mitre: the offset along the mean normal that keeps both segments `r` wide; a turn sharper
      // than SHARP_TURN_COS is not mitred (a spike): each segment keeps its full width up to the
      // vertex, and a disc round it fills the outer wedge
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
    for (let i = 0; i < c.length - 1; i++) {
      onFaces([outL[i], outR[i], inL[i + 1]], ramp, bias, out, undefined, segs?.[i]);
      onFaces([outR[i], inR[i + 1], inL[i + 1]], ramp, bias, out, undefined, segs?.[i]);
    }
    const caps: [boolean, P2, VertexAttr | undefined, number][] = [
      [ends.capStart, c[0], segs?.[0], halfAt(0)], [ends.capEnd, c[c.length - 1], segs?.[segs.length - 1], halfAt(c.length - 1)],
      ...joints.map((i): [boolean, P2, VertexAttr | undefined, number] => [true, c[i], segs?.[Math.min(i, (segs?.length ?? 1) - 1)], halfAt(i)]),
    ];
    for (const [cap, e, attr, h] of caps) {
      if (!cap) continue;
      const r = h * latticePerMetre;
      for (let k = 0; k < CAP_SIDES; k++) {
        const a0 = (k / CAP_SIDES) * 2 * Math.PI, a1 = ((k + 1) / CAP_SIDES) * 2 * Math.PI;
        onFaces([e, [e[0] + Math.cos(a0) * r, e[1] + Math.sin(a0) * r], [e[0] + Math.cos(a1) * r, e[1] + Math.sin(a1) * r]], ramp, bias, out, undefined, attr);
      }
    }
  };

  /** this tile's share of a line: its lamps and far lines (the TIN ribbon is buildRibbon's) */
  const buildLine = (line: OsmLine): void => {
    const look = lineLook(line);
    if (!look) return;
    const { half, road, lit, out, ramp } = look;
    if (lit) placeLamps(line.points, half, lampSide(line.tags));

    if (tin) {
      // far lines: roads but the minor ones, and railways
      if (!(road && !look.minor) && !look.rail) return;
      const index = look.rail ? RAIL_LINE_INDEX : ROAD_LINE_INDEX;
      const c = line.points.map(toLattice).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
      for (let i = 0; i < c.length - 1; i++) lineOnFaces(c[i], c[i + 1], look.bias, roadLines, index);
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
    if (p.tags.aeroway !== 'helipad') return;
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

  for (const area of data.areas) buildArea(area);
  if (tin) for (const area of opts.data.areas) if (area.tags.leisure === 'pitch') buildPitch(area);
  for (const line of data.lines) buildLine(line);
  if (tin) for (const line of opts.data.lines) buildRibbon(line);
  for (const p of data.points) buildPoint(p);
  buildPortals();

  if (opts.buildings !== false && data.buildings.length) {
    const bm = buildBuildingMesh({ tile, buildings: data.buildings, sampleHeight, points: data.points });
    for (let i = 0; i < bm.vertices.length; i++) verts.push(bm.vertices[i]);
    for (let i = 0; i < bm.ramps.length; i++) ramps.push(bm.ramps[i]);
  }

  return {
    vertices: new Float32Array(verts),
    ramps: new Uint32Array(ramps), // face colours (palette.ts)
    vertexCount: ramps.length,
    roads: { vertices: new Float32Array(roads.verts), ramps: new Uint32Array(roads.ramps), vertexCount: roads.ramps.length },
    roadAttrs: new Float32Array(roads.attrs!),
    water: { vertices: new Float32Array(water.verts), ramps: new Uint32Array(water.ramps), vertexCount: water.ramps.length },
    roadLines: new Float32Array(roadLines),
    pitchLines: new Float32Array(pitchLines),
    lamps: new Float32Array(lamps),
    lampPosts: new Float32Array(lampPosts),
  };
}