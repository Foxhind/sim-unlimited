/**
 * How OSM ways and areas are drawn, from their tags alone: the style of a line (width, shoulder,
 * paint, ramp) and of an area, a road's rank, priority and layer where it meets others, and the
 * biases and glows the ground cover is drawn with
 */
import { colour, colourOf, RAMP, ROAD_MARK, snowy, withGlow, type RGB } from '../engine/palette';
import { halfFilter, type AreaFilter, type AreaKind, type AreaStyles } from './area-styles';
import { CLIFF_TAG } from './cliffs';
import type { LonLat } from './osm-types';
import { pitchSurface } from './pitch-markings';
export { PITCH_LIT_MIN_M2 } from './pitch-markings';

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

export interface AreaStyle {
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
/** floodlit pitch surface at night: the brightest artificial light */
export const PITCH_GLOW = 7;

/** car parks over the parks and pitches they border, under the road ribbons (LINE_BIAS) */
export const CAR_PARK_BIAS = 0.75;
/**
 * A car park drawn as asphalt: an open one (parking=surface, or untagged); not one under the ground,
 * in a building (multi-storey: the building is drawn) or on a roof
 */
export function isOpenCarPark(tags: Record<string, string>): boolean {
  if (tags.location === 'underground' || tags.parking === 'underground' || tags.parking === 'multi-storey' || tags.parking === 'rooftop') return false;
  const layer = Number(tags.layer);
  return !(Number.isFinite(layer) && layer < 0);
}

/**
 * Swimming pools (leisure=swimming_pool): from the air a resort town is its pools, bright turquoise
 * by every hotel. One flat colour; over the park or garden they lie in (ground-cover 'pool').
 */
export const POOL_RGB: RGB = [62, 196, 214];
/** over the areas round it on the drape (no cover) */
export const POOL_BIAS = 0.62;

/**
 * A pool seen from the air: not indoor, on a roof or underground. A covered one stays: its cover is
 * mostly a light shade or a sliding roof over the water.
 */
export function isOpenPool(tags: Record<string, string>): boolean {
  if (tags.indoor === 'yes' || tags.building !== undefined) return false;
  const loc = tags.location;
  return loc !== 'indoor' && loc !== 'roof' && loc !== 'rooftop' && loc !== 'underground';
}

export type DockKind = 'dry' | 'floating' | 'wet';

/** a dock's kind (waterway=dock): a dry dock, a floating one, else a wet or tidal basin */
export function dockKind(tags: Record<string, string>): DockKind | undefined {
  if (tags.waterway !== 'dock') return undefined;
  if (tags.dock === 'drydock' || tags.dock === 'dry') return 'dry';
  if (tags.dock === 'floating') return 'floating';
  return 'wet';
}

/** a dock that is water: any but a dry dock (a floating one floats on it) */
export function isWetDock(tags: Record<string, string>): boolean {
  const k = dockKind(tags);
  return k === 'wet' || k === 'floating';
}

/** a dry dock's floor: wet dark concrete (dock-mesher stands its coping and keel blocks on it) */
export const DRY_DOCK_RGB: RGB = [96, 98, 100];
export const DRY_DOCK_BIAS = 0.7;

export function classifyArea(tags: Record<string, string>, styles: AreaStyles): AreaStyle | undefined {
  /** open ground (fields, parks, beaches...): snow covers it in winter */
  const ground = (ramp: number, bias: number, kind: AreaKind): AreaStyle => ({ ramp: snowy(ramp), bias, water: false, filter: styles[kind] });
  const natural = tags.natural;
  const landuse = tags.landuse;
  const leisure = tags.leisure;
  const aeroway = tags.aeroway;
  const waterway = tags.waterway;
  if (natural === 'water' || waterway === 'riverbank' || waterway === 'river' || waterway === 'canal' || isWetDock(tags)) {
    return { ramp: RAMP.WATER, bias: 0.3, water: true };
  }
  if (dockKind(tags) === 'dry') return { ramp: colourOf(DRY_DOCK_RGB), bias: DRY_DOCK_BIAS, water: false };
  if (aeroway === 'runway' || aeroway === 'taxiway' || aeroway === 'apron' || aeroway === 'helipad') {
    // on the aerodrome's flat pad (aerodrome.ts): a hair above it, where the aircraft's wheels are
    return { ramp: RAMP.ASPHALT, bias: AEROWAY_AREA_BIAS, water: false };
  }
  // open car parks: the roads' asphalt, a little lit at night like an unlit road
  if (tags.amenity === 'parking' && isOpenCarPark(tags)) return { ramp: withGlow(RAMP.ASPHALT, UNLIT_ROAD_GLOW), bias: CAR_PARK_BIAS, water: false };
  // an open-air pool: a turquoise patch of its own, not the sea's colour (none under a roof or on one)
  if (leisure === 'swimming_pool') return isOpenPool(tags) ? { ramp: colourOf(POOL_RGB), bias: POOL_BIAS, water: false } : undefined;
  // a wood's floor under its trees (props-mesher plants them): the shade between the crowns
  if (natural === 'wood' || landuse === 'forest') return ground(RAMP.FOREST, 0.6, 'forest');
  if (natural === 'scrub') return ground(RAMP.FOREST, 0.6, 'scrub');
  if (natural === 'beach') return ground(RAMP.SAND, 0.6, 'beach');
  // a cliff's band (cliffs.ts) before the bare rock it is tagged as
  if (tags[CLIFF_TAG] === 'yes') return ground(RAMP.ROCK, 0.6, 'cliff');
  if (natural === 'bare_rock' || natural === 'scree') return ground(RAMP.ROCK, 0.6, 'rock');
  if (landuse === 'farmland') return ground(RAMP.FIELD, 0.6, 'farmland');
  // the orchard's trees are props (props-mesher plantOrchard); the ground between the rows is tinted
  if (landuse === 'orchard') return ground(RAMP.FIELD, 0.6, 'orchard');
  if (landuse === 'vineyard') return ground(RAMP.FIELD, 0.6, 'vineyard');
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
  const zone = landZone(tags);
  if (zone) return ground(ZONE_RAMP[zone], ZONE_BIAS[zone], zone);
  return undefined;
}

/**
 * The filter of an area's transition belt, or undefined for none: the land areas drawn through a
 * filter (classifyArea), but a cliff's band (a strip under a line, not a patch of ground)
 */
export function beltFilter(tags: Record<string, string>, styles: AreaStyles): AreaFilter | undefined {
  if (tags[CLIFF_TAG] === 'yes') return undefined;
  const f = classifyArea(tags, styles)?.filter;
  return f && halfFilter(f);
}

/**
 * Land zones (landuse and the like): the ground of a town, of its outskirts and of open land, where
 * no other area says more. Without imagery the terrain is coloured by height and climate alone, the
 * town as the fields round it; a zone tints it. The town's own (residential, commercial,
 * industrial) lie under everything else (ground-cover 'zone', ZONE_BIAS).
 */
export type LandZone = 'grass' | 'meadow' | 'cemetery' | 'quarry' | 'construction' | 'residential' | 'commercial' | 'industrial';

export function landZone(tags: Record<string, string>): LandZone | undefined {
  const lu = tags.landuse, n = tags.natural;
  if (lu === 'grass' || lu === 'village_green' || lu === 'recreation_ground') return 'grass';
  if (lu === 'meadow' || n === 'grassland' || n === 'heath') return 'meadow';
  if (lu === 'cemetery' || tags.amenity === 'grave_yard') return 'cemetery';
  if (lu === 'quarry' || lu === 'landfill') return 'quarry';
  if (lu === 'construction' || lu === 'brownfield') return 'construction';
  if (lu === 'residential') return 'residential';
  if (lu === 'commercial' || lu === 'retail') return 'commercial';
  if (lu === 'industrial') return 'industrial';
  return undefined;
}

/** the zones that are a town's ground: under every other area and cover */
export const TOWN_ZONES: ReadonlySet<LandZone> = new Set(['residential', 'commercial', 'industrial']);

/** a zone's material without imagery */
const ZONE_RAMP: Record<LandZone, number> = {
  grass: RAMP.GRASS, meadow: RAMP.FIELD, cemetery: RAMP.GRASS, quarry: RAMP.ROCK, construction: RAMP.SAND,
  residential: RAMP.CONCRETE, commercial: RAMP.CONCRETE, industrial: RAMP.CONCRETE,
};
/** on the drape: open land as the fields, a town's zone under every other area (wetland 0.5, water 0.3 stay apart by kind) */
const ZONE_BIAS: Record<LandZone, number> = {
  grass: 0.6, meadow: 0.55, cemetery: 0.6, quarry: 0.6, construction: 0.6,
  residential: 0.4, commercial: 0.42, industrial: 0.42,
};

export interface LineStyle {
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
  /** a footway, path, cycleway or steps: no street lamps along it */
  path?: boolean;
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
/**
 * width of a waterway line without a `width` tag, metres: a canal as a town's (14/9517/6397: at
 * 18 m it reached under the roads along its banks)
 */
const WATERWAY_WIDTH_M: Record<string, number> = { river: 18, canal: 8, stream: 3, brook: 2, ditch: 1.5, drain: 1.5 };
/** a waterway's drawn width, metres (its `width`, else by kind); undefined for anything else */
export function waterwayWidth(tags: Record<string, string>): number | undefined {
  const ww = tags.waterway;
  return ww && WATERWAY_WIDTH_M[ww] !== undefined ? osmWidthM(tags.width) ?? WATERWAY_WIDTH_M[ww] : undefined;
}

/**
 * Roads drawn near, by highway=*: carriageway width without `width` or `lanes`, and the shoulder
 * beside it on each side (none on town streets that have kerbs instead). Footways, paths, cycleways,
 * bridleways and steps are PATH_KINDS. *_link roads take LINK_ROAD.
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
/** the carriageway width of a road's class (both directions, whatever its own tags say), metres; undefined for other ways */
export function roadClassWidth(highway: string): number | undefined {
  return ROAD_KINDS[highway]?.width ?? (/^(motorway|trunk|primary|secondary|tertiary)_link$/.test(highway) ? LINK_ROAD.width : undefined);
}
/**
 * Footways, paths and the like: narrow strips without `width`, paved light (paving slabs) or, a
 * path or bridleway without `surface`, beaten earth
 */
export const PATH_KINDS: Record<string, { width: number; paved: boolean }> = {
  footway: { width: 2, paved: true },
  cycleway: { width: 2, paved: true },
  steps: { width: 2, paved: true },
  path: { width: 1.5, paved: false },
  bridleway: { width: 2, paved: false },
};
/** footways and paved paths: light paving slabs */
export const PAVING_RAMP = colour(184, 176, 160);
/** unpaved paths: light beaten earth and fine gravel */
export const TRAIL_RAMP = colour(166, 148, 116);
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
export const RAIL_KINDS = new Set(['rail', 'narrow_gauge', 'light_rail']);
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
  footway: 0.5, cycleway: 0.5, steps: 0.5, path: 0.5, bridleway: 0.5,
};
export const LINK_RANK = 4.5;
export const ROAD_RANK_STEP_M = 0.02;
export const ROAD_LAYER_STEP_M = 0.25;
/** at most this far apart, roads of equal priority (by a hash of their first point: always the same) */
export const ROAD_TIE_M = 0.012;
/** 0..1 from a point, the same in every tile */
export function tieBreak([lon, lat]: LonLat): number {
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
    const path = PATH_KINDS[hw];
    if (path) {
      const surface = tags.surface;
      const paved = surface === undefined ? path.paved : PAVED_SURFACES.has(surface) || !(GRAVEL_SURFACES.has(surface) || DIRT_SURFACES.has(surface));
      const ramp = surface === 'asphalt' ? RAMP.ASPHALT : paved ? PAVING_RAMP : TRAIL_RAMP;
      return { ramp, width: Math.min(osmWidthM(tags.width) ?? path.width, 8), shoulder: 0, minor: true, marks: 0, path: true };
    }
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

/** a way on a bridge (bridge=yes, viaduct, aqueduct...: anything but no) */
export function isBridge(tags: Record<string, string>): boolean {
  return !!tags.bridge && tags.bridge !== 'no';
}

/**
 * A road or railway under the ground: no ribbon over the hill above it, only its portals.
 * `building_passage` runs under a building and is open to the sky on both sides of it.
 */
export function isTunnel(tags: Record<string, string>): boolean {
  const t = tags.tunnel;
  return !!t && t !== 'no' && t !== 'building_passage' && (tags.highway !== undefined || tags.railway !== undefined);
}
