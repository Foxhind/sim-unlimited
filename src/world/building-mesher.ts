import earcut from 'earcut';
import { colour, colourOf, FACADE, FACADE_ALL_NIGHT, FACADE_BLIND, FACADE_RESIDENTIAL, FACADE_SEED_BITS, FAR_WINDOWS, LIGHT, pointValue, snowy, WINDOWS, type RGB } from '../engine/palette';
import { enuToLatLon, latLonToEnu, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmBuilding, OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';
import type { TerrainMeshData } from './terrain-mesher';
import { AC_SIZE, INSTANCE, pushInstance } from './props-mesher';
import { crossings, roofCreases, roofFrame, roofModel, roofRun, roofShape, splitConvex, type Plane, type RoofFrame, type RoofModel, type XZ } from './roof-shapes';

/** floats per vertex of BuildingMeshData.windows */
export const WINDOW_ATTR_FLOATS = 5;

/**
 * The building mesh, and per vertex where it is on a windowed facade (WORLD_VS aWinUV, aWinEdge):
 * u metres along the wall edge from its start, v metres above the wall base, the edge's length,
 * the wall height (0: no windows on this face) and the edge's code: a 20-bit seed (which windows are
 * lit, which slots carry balconies) plus the FACADE style and flags (palette.ts FACADE_SEED_BITS).
 */
export interface BuildingMeshData extends TerrainMeshData {
  windows: Float32Array;
  /**
   * the vertices from 0 to here are the buildings without their small parts (parapets, roof plant,
   * doors), which come after: what a far LOD draws (osm-manager BUILDING_DETAIL_M)
   */
  coreVertexCount: number;
  /** air-conditioner units on the walls: instances of INSTANCE.AC (props-mesher TREE_STRIDE), drawn with the trees */
  acs: Float32Array;
  /** see-through faces (greenhouse walls and roofs, GREENHOUSE): pos+normal with face colours, drawn blended */
  glass: TerrainMeshData;
}

/** building values whose walls carry air-conditioner units */
const AC_TYPES = new Set([
  'yes', 'house', 'detached', 'semidetached_house', 'terrace', 'residential', 'apartments', 'dormitory',
  'hotel', 'commercial', 'office', 'retail',
]);
/**
 * Air conditioners: on the window grid of a facade (WORLD_FS windowAt: slots every WINDOWS.SPACING_M,
 * floors every WINDOWS.FLOOR_M, both stretched to fit), under a window pane GAP_M below its sill, not
 * on the ground floor of a building of two floors or more; each window taken with PROBABILITY
 * (deterministic by its position).
 */
export const AC = { PROBABILITY: 0.05, GAP_M: 0.1 } as const;
const AC_RGB: RGB = [222, 222, 216];

/**
 * Mini structures on a large flat roof (stair and lift sheds, machine rooms, vents, plant): on a roof
 * surface of at least MIN_AREA_M2, one per AREA_PER_UNIT_M2 (at least one, at most MAX), kept MARGIN_M
 * off the parapet and each other. UNITS: four kinds, [length along the building, width, height, colour].
 */
export const ROOFTOP = {
  MIN_AREA_M2: 400, AREA_PER_UNIT_M2: 600, MAX: 6, MARGIN_M: 0.6,
  UNITS: [
    [4, 3, 2.6, [150, 150, 150]],
    [6, 4.5, 3, [118, 120, 123]],
    [1.4, 1.4, 1.2, [178, 178, 175]],
    [4.5, 2, 1.4, [96, 98, 102]],
  ] as [number, number, number, RGB][],
} as const;

export interface BuildingMeshOptions {
  tile: Tile;
  buildings: OsmBuilding[];
  sampleHeight: HeightSampler;
  /** the terrain's colour at a point (its face colour): a house's plinth takes it; earth without */
  groundColour?: (lon: number, lat: number) => number | undefined;
  /** OSM points: those tagged `entrance` on a building's outline become doors in its wall */
  points?: OsmPoint[];
}

/** a wall edge at least this long may carry balconies (one slot of WINDOWS.SPACING_M) */
const BALCONY_MIN_EDGE_M = 4;
/** building types whose walls may carry balconies; an untagged `yes` from this many metres of facade */
const BALCONY_TYPES = new Set(['apartments', 'residential', 'dormitory', 'hotel']);
const BALCONY_YES_MIN_WALL_M = 12;
/** shares of the balconied edges of such a building: glazed, then open (the rest plain windows) */
const GLAZED_SHARE = 0.3;
const OPEN_SHARE = 0.25;

export function hasBalconies(tags: Record<string, string>, wall: number): boolean {
  const type = tags['building:part'] || tags.building || 'yes';
  return BALCONY_TYPES.has(type) || (type === 'yes' && wall >= BALCONY_YES_MIN_WALL_M);
}

/** an entrance node this close to a wall edge (it is usually a vertex of the outline) is on it */
const ENTRANCE_SNAP_M = 1.5;
/**
 * Parapet along the edges of a flat roof, inside the building's height (the roof is HEIGHT_M under the
 * wall top): width inward from the wall face, height; only on a footprint whose sides are at least
 * MIN_SIDE_M and a facade at least MIN_WALL_M tall.
 */
export const PARAPET = { WIDTH_M: 0.2, HEIGHT_M: 0.5, MIN_SIDE_M: 2, MIN_WALL_M: 2.5 } as const;
/**
 * A chimney (man_made=chimney, building=chimney) is open at the top: a rim WALL_M thick like a
 * parapet, the shaft inside it soot-black (SOOT) and its floor sunk DEPTH (a share of the wall) below
 * the top, with no rooftop structures.
 */
export const CHIMNEY = { WALL_M: 0.5, DEPTH: 0.8, SOOT: [22, 22, 24] as RGB } as const;
export function isChimney(tags: Record<string, string>): boolean {
  return tags.man_made === 'chimney' || (tags['building:part'] || tags.building) === 'chimney';
}
/** doors: width × height by the entrance tag, and the leaf colours (picked per door by its hash) */
const DOOR_SIZE: Record<string, [number, number]> = { main: [1.9, 2.4], garage: [2.6, 2.3], default: [1.1, 2.1] };
const DOOR_FRAME_RGB: RGB = [58, 56, 54];
const DOOR_LEAF_RGB: RGB[] = [[104, 70, 44], [70, 74, 80], [48, 82, 60], [96, 44, 40]];
const GARAGE_DOOR_RGB: RGB = [150, 152, 150];
/** standoff of the door layers from the wall (window cover, frame, leaf), so the depth test keeps the order */
const DOOR_LAYERS_M = [0.03, 0.06, 0.09];


/** the CSS colour names OSM colour tags may use (the real CSS values: muting happens later) */
const CSS_COLORS: Record<string, RGB> = Object.fromEntries(
  (
    'aliceblue f0f8ff,antiquewhite faebd7,aqua 00ffff,aquamarine 7fffd4,azure f0ffff,beige f5f5dc,bisque ffe4c4,black 000000,blanchedalmond ffebcd,blue 0000ff,blueviolet 8a2be2,brown a52a2a,burlywood deb887,cadetblue 5f9ea0,chartreuse 7fff00,chocolate d2691e,coral ff7f50,cornflowerblue 6495ed,cornsilk fff8dc,crimson dc143c,cyan 00ffff,darkblue 00008b,darkcyan 008b8b,darkgoldenrod b8860b,darkgray a9a9a9,darkgreen 006400,darkgrey a9a9a9,darkkhaki bdb76b,darkmagenta 8b008b,darkolivegreen 556b2f,darkorange ff8c00,darkorchid 9932cc,darkred 8b0000,darksalmon e9967a,darkseagreen 8fbc8f,darkslateblue 483d8b,darkslategray 2f4f4f,darkslategrey 2f4f4f,darkturquoise 00ced1,darkviolet 9400d3,deeppink ff1493,deepskyblue 00bfff,dimgray 696969,dimgrey 696969,dodgerblue 1e90ff,firebrick b22222,floralwhite fffaf0,forestgreen 228b22,fuchsia ff00ff,gainsboro dcdcdc,ghostwhite f8f8ff,gold ffd700,goldenrod daa520,gray 808080,green 008000,greenyellow adff2f,grey 808080,honeydew f0fff0,hotpink ff69b4,indianred cd5c5c,indigo 4b0082,ivory fffff0,khaki f0e68c,lavender e6e6fa,lavenderblush fff0f5,lawngreen 7cfc00,lemonchiffon fffacd,lightblue add8e6,lightcoral f08080,lightcyan e0ffff,lightgoldenrodyellow fafad2,lightgray d3d3d3,lightgreen 90ee90,lightgrey d3d3d3,lightpink ffb6c1,lightsalmon ffa07a,lightseagreen 20b2aa,lightskyblue 87cefa,lightslategray 778899,lightslategrey 778899,lightsteelblue b0c4de,lightyellow ffffe0,lime 00ff00,limegreen 32cd32,linen faf0e6,magenta ff00ff,maroon 800000,mediumaquamarine 66cdaa,mediumblue 0000cd,mediumorchid ba55d3,mediumpurple 9370db,mediumseagreen 3cb371,mediumslateblue 7b68ee,mediumspringgreen 00fa9a,mediumturquoise 48d1cc,mediumvioletred c71585,midnightblue 191970,mintcream f5fffa,mistyrose ffe4e1,moccasin ffe4b5,navajowhite ffdead,navy 000080,oldlace fdf5e6,olive 808000,olivedrab 6b8e23,orange ffa500,orangered ff4500,orchid da70d6,palegoldenrod eee8aa,palegreen 98fb98,paleturquoise afeeee,palevioletred db7093,papayawhip ffefd5,peachpuff ffdab9,peru cd853f,pink ffc0cb,plum dda0dd,powderblue b0e0e6,purple 800080,rebeccapurple 663399,red ff0000,rosybrown bc8f8f,royalblue 4169e1,saddlebrown 8b4513,salmon fa8072,sandybrown f4a460,seagreen 2e8b57,seashell fff5ee,sienna a0522d,silver c0c0c0,skyblue 87ceeb,slateblue 6a5acd,slategray 708090,slategrey 708090,snow fffafa,springgreen 00ff7f,steelblue 4682b4,tan d2b48c,teal 008080,thistle d8bfd8,tomato ff6347,turquoise 40e0d0,violet ee82ee,wheat f5deb3,white ffffff,whitesmoke f5f5f5,yellow ffff00,yellowgreen 9acd32'
  ).split(',').map((e) => {
    const [name, hex] = e.split(' ');
    return [name, [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] as RGB];
  }),
);

/** OSM colour value: CSS name, #rgb, #rrggbb or rgb(r,g,b); for a list ("red;white") the first one */
export function parseColor(v: string | undefined): RGB | undefined {
  if (!v) return undefined;
  const s = v.split(';')[0].trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (CSS_COLORS[s]) return CSS_COLORS[s];
  const fn = s.match(/^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/);
  if (fn) return [Math.min(255, +fn[1]), Math.min(255, +fn[2]), Math.min(255, +fn[3])];
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
  }
  return undefined;
}

/** Parse OSM length values: "12", "12 m", "3,7", "40 ft", "40'", '12\'6"'. Returns meters. */
export function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  // a decimal comma ("3,7") is common in European data
  const s = v.trim().toLowerCase().replace(/^(\d+),(\d+)/, '$1.$2');
  const feetInch = s.match(/^(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)?"?$/);
  if (feetInch) return parseFloat(feetInch[1]) * 0.3048 + (feetInch[2] ? parseFloat(feetInch[2]) * 0.0254 : 0);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|ft|'|")?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === 'ft' || unit === "'") return n * 0.3048;
  if (unit === '"') return n * 0.0254;
  return n;
}

/**
 * Facade zones of a building with windows (isLitBuilding, not a booth): a windowless plinth PLINTH_M
 * high on the ground, then the floors with windows, then under a flat roof a windowless technical
 * floor TECH_FLOOR_M high. A booth (footprint under BOOTH_MAX_AREA_M2) has no windows at all.
 */
export const FACADE_ZONES = { PLINTH_M: 1, TECH_FLOOR_M: 1.5, BOOTH_MAX_AREA_M2: 20 } as const;
/** internal tag (not OSM): the footprint is a booth's (FACADE_ZONES.BOOTH_MAX_AREA_M2) */
export const BOOTH_TAG = 'sim:booth';

/** the building has the facade zones (plinth, floors with windows, technical floor) */
export function hasFacadeZones(tags: Record<string, string>): boolean {
  return isLitBuilding(tags) && tags[BOOTH_TAG] !== 'yes';
}

/** a building:part area (not the outline of a building made of parts) */
export function isBuildingPart(tags: Record<string, string>): boolean {
  return tags['building:part'] !== undefined && tags['building:part'] !== 'no';
}

/**
 * The technical floor goes under a flat roof of a zoned building, not of a building:part: parts stack
 * (building:min_level of one is building:levels of another), and an extra 1.5 m on top of each part
 * would push it into the part above.
 */
function hasTechFloor(tags: Record<string, string>, shape: string): boolean {
  return shape === 'flat' && hasFacadeZones(tags) && !isBuildingPart(tags);
}

/** facade levels of a building with no height, no building:levels and no footprint rule (withDefaultTags) */
export const DEFAULT_LEVELS = 2;

/** S3DB: a level without height tags is 3 m */
export const LEVEL_M = 3;
/** pitch of a ridged roof with no roof:height, roof:angle or roof:levels */
const DEFAULT_PITCH_DEG = 30;

/**
 * S3DB heights of a building or part: min_height (else building:min_level), the facade, and the roof.
 * `height` runs from the ground to the roof top; the facade is height − roof:height. The roof height is
 * roof:height, else from roof:angle over `run` (the horizontal run of a slope: roofRun), else
 * roof:levels × 3 m, else a default for the shape (30° pitch, a hemisphere for a dome). Without
 * `height`: building:levels × 3 m plus that roof; without levels either, the facade from the footprint
 * (FOOTPRINT_WALL_TAG, set by withDefaultTags for building=residential) plus that roof; else
 * DEFAULT_LEVELS (2) × 3 m plus that roof. Levels counted from tags (building:levels, the default) get
 * the facade zones added (hasFacadeZones): the plinth on the ground and, under a flat roof, the
 * technical floor, so the levels keep their full 3 m. A building:part counts its levels from the ground
 * like the parts around it, so every part lifts its levels by the plinth (its top always, its bottom
 * when building:min_level is above the ground) and none gets the technical floor (hasTechFloor): the
 * parts keep stacking without gaps or overlaps.
 */
export function computeHeights(tags: Record<string, string>, run?: number): { min: number; wall: number; roof: number } {
  const shape = roofShape(tags);

  let roof = 0;
  if (shape !== 'flat') {
    const angle = parseFloat(tags['roof:angle']);
    const roofLevels = parseLength(tags['roof:levels']);
    roof = parseLength(tags['roof:height'])
      ?? (Number.isFinite(angle) && angle > 0 && angle < 89 && run ? Math.tan((angle * Math.PI) / 180) * run : undefined)
      ?? (roofLevels ? roofLevels * LEVEL_M : undefined)
      ?? defaultRoofHeight(shape, run);
  }

  const part = isBuildingPart(tags);
  let min = parseLength(tags.min_height) ?? 0;
  const minLevel = parseLength(tags['building:min_level']);
  if (min === 0 && minLevel !== undefined) min = minLevel * LEVEL_M + (part && minLevel > 0 ? FACADE_ZONES.PLINTH_M : 0);

  let height = parseLength(tags.height);
  if (height === undefined) {
    const levels = parseLength(tags['building:levels']);
    // roof levels under a flat roof are still storeys on top of the facade levels
    const flatRoofLevels = shape === 'flat' ? (parseLength(tags['roof:levels']) ?? 0) * LEVEL_M : 0;
    const footprintWall = parseLength(tags[FOOTPRINT_WALL_TAG]);
    if (footprintWall !== undefined && levels === undefined) height = footprintWall + roof + flatRoofLevels;
    else {
      const zones = part
        ? FACADE_ZONES.PLINTH_M
        : hasFacadeZones(tags)
          ? (min < 0.5 ? FACADE_ZONES.PLINTH_M : 0) + (hasTechFloor(tags, shape) ? FACADE_ZONES.TECH_FLOOR_M : 0)
          : 0;
      height = (levels ?? DEFAULT_LEVELS) * LEVEL_M + zones + roof + flatRoofLevels;
    }
  }

  height = Math.max(height, min + 0.3);
  roof = Math.min(roof, Math.max(0, height - min));
  const wall = Math.max(0, height - roof - min);
  return { min, wall, roof };
}

function defaultRoofHeight(shape: string, run: number | undefined): number {
  if (!run) return LEVEL_M;
  if (shape === 'dome' || shape === 'round') return run;
  if (shape === 'onion') return run * 2.4;
  if (shape === 'cone') return run * 2;
  if (shape === 'skillion') return Math.min(Math.max(Math.tan((15 * Math.PI) / 180) * run, 1), 6);
  return Math.min(Math.max(Math.tan((DEFAULT_PITCH_DEG * Math.PI) / 180) * run, 1.5), 8);
}

/** a footprint in metres about its first vertex (x east, z south), for the roof frame outside a tile mesh */
function localXZ(ring: LonLat[]): XZ[] {
  const [lon0, lat0] = ring[0];
  const k = 111320, c = Math.cos((lat0 * Math.PI) / 180);
  return ring.map(([lo, la]) => [(lo - lon0) * k * c, -(la - lat0) * k]);
}

/** a facade with neither height nor building:levels is at least this tall */
export const MIN_FOOTPRINT_HEIGHT_M = 2.5;
/** internal tag (not OSM): the facade height from the footprint, the roof goes on top of it */
export const FOOTPRINT_WALL_TAG = 'sim:footprint_wall';
/** a building up to this height (facade, without the roof) is low-rise: a hipped roof when OSM gives none */
export const LOW_RISE_FACADE_M = 12;

/**
 * Facade height (without the roof) of a building with neither `height` nor `building:levels`: the mean
 * of the width and length of the footprint's bounding rectangle in the local axes (x east, z south),
 * but at least 2.5 m.
 */
export function footprintHeight(outer: XZ[]): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of outer) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) return MIN_FOOTPRINT_HEIGHT_M;
  return Math.max(MIN_FOOTPRINT_HEIGHT_M, (maxX - minX + (maxZ - minZ)) / 2);
}

/** building values that get a hipped roof by default when low-rise */
const HIPPED_DEFAULT_TYPES = new Set(['yes', 'residential']);
/** a footprint larger than this (m²) keeps the flat default roof: a hipped roof over it would tower over the walls */
export const HIPPED_DEFAULT_MAX_AREA_M2 = 1000;

/**
 * The tags a building is drawn with: OSM tags plus the defaults it lacks. A building=residential
 * without `height` and `building:levels` has the footprint height as its facade (FOOTPRINT_WALL_TAG;
 * the roof goes on top); others get DEFAULT_LEVELS in computeHeights. Without `roof:shape`, a low-rise
 * building=yes or building=residential (facade from height, else building:levels × 3 m, else the
 * default, up to 12 m) with a footprint up to HIPPED_DEFAULT_MAX_AREA_M2 gets a `hipped` roof; larger
 * footprints, every other type and building:part areas stay flat.
 */
export function withDefaultTags(tags: Record<string, string>, outer: XZ[] | undefined): Record<string, string> {
  const out = { ...tags };
  const levels = parseLength(tags['building:levels']);
  if (tags.building === 'residential' && parseLength(tags.height) === undefined && levels === undefined && outer && outer.length >= 3) {
    out[FOOTPRINT_WALL_TAG] = String(footprintHeight(outer));
  }
  if (outer && outer.length >= 3 && Math.abs(ringAreaXZ(outer)) < FACADE_ZONES.BOOTH_MAX_AREA_M2) out[BOOTH_TAG] = 'yes';
  const isPart = isBuildingPart(tags);
  const small = !outer || Math.abs(ringAreaXZ(outer)) <= HIPPED_DEFAULT_MAX_AREA_M2;
  if (tags['roof:shape'] === undefined && !isPart && small && HIPPED_DEFAULT_TYPES.has(tags.building)) {
    const facade = parseLength(tags.height) ?? (levels !== undefined ? levels * LEVEL_M : undefined)
      ?? parseLength(out[FOOTPRINT_WALL_TAG]) ?? DEFAULT_LEVELS * LEVEL_M;
    if (facade <= LOW_RISE_FACADE_M) out['roof:shape'] = 'hipped';
  }
  if (tags.building === 'greenhouse' && !isPart) greenhouseDefaults(tags, out, levels);
  return out;
}

/**
 * A greenhouse (building=greenhouse): Fethiye's plain is thousands of them, low glass sheds spanning
 * up to hectares. Without a shape or size in OSM: a shallow ridge whatever the footprint (a default
 * pitch over a 50 m span would raise an 8 m roof). Drawn as see-through glass (its walls and roof go to
 * BuildingMeshData.glass, drawn blended with the sun's glints, osm-manager) on a thin frame: posts
 * along the walls, a beam on top of them, rafters across the roof and purlins along it.
 */
export const GREENHOUSE = {
  /** top of the roof above the ground, without height and building:levels */
  HEIGHT_M: 3.8,
  /** the ridge above the eaves, without roof:height, roof:angle and roof:levels */
  ROOF_M: 1.2,
  /** the glass's tint without a colour or material in OSM */
  GLASS: [196, 222, 226] as const,
  /** how much of what is behind the glass it hides (renderer.opacity) */
  OPACITY: 0.35,
  /** the frame: galvanised steel */
  FRAME: [206, 209, 210] as const,
  /** posts along the walls and rafters across the roof this far apart, at most */
  BAY_M: 4,
  /** purlins along the roof (one on the ridge line) this far apart */
  PURLIN_M: 6,
  /** width of a bar of the frame */
  BAR_M: 0.15,
  /** the frame lies this far outside the glass, so no depth fight */
  LIFT_M: 0.04,
};

/** a greenhouse, drawn as glass on a frame */
export function isGlasshouse(tags: Record<string, string>): boolean {
  return (tags['building:part'] || tags.building) === 'greenhouse';
}

function greenhouseDefaults(tags: Record<string, string>, out: Record<string, string>, levels: number | undefined): void {
  if (tags['roof:shape'] === undefined) out['roof:shape'] = 'gabled';
  if (tags['roof:height'] === undefined && tags['roof:angle'] === undefined && tags['roof:levels'] === undefined) {
    out['roof:height'] = String(GREENHOUSE.ROOF_M);
  }
  if (parseLength(tags.height) === undefined && levels === undefined) out.height = String(GREENHOUSE.HEIGHT_M);
}

const defaultTagsCache = new WeakMap<OsmBuilding, Record<string, string>>();
/** withDefaultTags of a building, its footprint in metres about its first vertex (stable across tiles) */
export function buildingTags(b: OsmBuilding): Record<string, string> {
  let t = defaultTagsCache.get(b);
  if (!t) {
    const ring = b.rings[0];
    t = withDefaultTags(b.tags, ring && ring.length >= 3 ? localXZ(ring) : undefined);
    defaultTagsCache.set(b, t);
  }
  return t;
}

/** computeHeights with the roof run taken from the footprint (dots, collision, lit windows) */
export function buildingHeights(b: OsmBuilding): { min: number; wall: number; roof: number } {
  const tags = buildingTags(b);
  const ring = b.rings[0];
  if (!ring || ring.length < 3 || roofShape(tags) === 'flat') return computeHeights(tags);
  const outer = localXZ(ring);
  const shape = roofShape(tags);
  return computeHeights(tags, roofRun(shape, roofFrame(outer, tags)));
}

/** typical colour of an OSM material value (building:material / roof:material) */
const MATERIAL_RGB: Record<string, RGB> = {
  brick: [156, 88, 64], concrete: [150, 150, 150], cement: [150, 150, 150], cement_block: [150, 150, 150],
  glass: [150, 190, 210], metal: [128, 132, 138], steel: [128, 132, 138], metal_sheet: [128, 132, 138],
  tin: [150, 154, 158], aluminium: [170, 174, 178], zinc: [140, 146, 152], copper: [96, 160, 140],
  tile: [180, 92, 56], tiles: [180, 92, 56], roof_tiles: [180, 92, 56], clay: [180, 92, 56],
  slate: [72, 76, 84], stone: [150, 140, 125], sandstone: [190, 165, 120], limestone: [200, 190, 165],
  granite: [130, 126, 124], marble: [215, 212, 206],
  wood: [150, 110, 70], timber: [150, 110, 70], timber_framing: [200, 185, 150], log: [130, 92, 56],
  plaster: [210, 195, 160], stucco: [210, 195, 160], render: [210, 195, 160], mud: [150, 120, 90],
  thatch: [160, 130, 80], reed: [160, 130, 80], bitumen: [60, 62, 66], tar_paper: [60, 62, 66],
  asphalt: [70, 72, 76], eternit: [140, 140, 140], asbestos: [140, 140, 140], plastic: [180, 180, 180],
  grass: [70, 140, 60], gravel: [140, 136, 130], roofing_felt: [60, 62, 66],
};

/**
 * Wall colours of a building with no colour and no material in OSM: a palette per kind of building, each
 * entry [colour, weight], all of low saturation. Industrial: greys, whites, grey-blues. Residential:
 * warm (beige, sand, cream, brick), rarely grey or white. Commercial: anything but brick. Schools and
 * kindergartens: pale blue and white.
 */
type Palette = [RGB, number][];
const WALL_PALETTES: Record<string, Palette> = {
  residential: [
    [[222, 205, 175], 3], [[210, 195, 160], 3], [[235, 225, 200], 2], [[225, 190, 160], 2], [[220, 192, 140], 1],
    [[150, 96, 76], 3], [[128, 82, 66], 1], [[170, 170, 168], 1], [[236, 234, 228], 1],
  ],
  industrial: [
    [[175, 175, 175], 3], [[140, 142, 145], 3], [[112, 116, 122], 1], [[232, 232, 228], 2],
    [[150, 165, 180], 3], [[185, 198, 210], 2], [[120, 135, 150], 1],
  ],
  commercial: [
    [[238, 236, 230], 3], [[180, 180, 178], 2], [[222, 205, 175], 2], [[210, 195, 160], 1], [[170, 195, 210], 2],
    [[190, 210, 225], 1], [[190, 210, 185], 1], [[235, 222, 170], 1], [[225, 185, 165], 1], [[150, 165, 180], 1],
    [[100, 104, 110], 1],
  ],
  school: [[[185, 210, 230], 3], [[160, 195, 225], 2], [[234, 237, 240], 3], [[215, 225, 235], 2]],
  civic: [[[238, 236, 230], 3], [[200, 200, 198], 2], [[235, 225, 200], 2], [[210, 195, 160], 1], [[235, 222, 170], 1]],
  religious: [[[240, 238, 232], 3], [[210, 195, 160], 2], [[235, 222, 170], 2], [[235, 225, 200], 2]],
  agricultural: [[[130, 100, 75], 3], [[150, 96, 76], 2], [[160, 160, 158], 2], [[200, 185, 155], 1]],
  mixed: [
    [[222, 205, 175], 2], [[210, 195, 160], 2], [[236, 234, 228], 2], [[180, 180, 178], 2], [[150, 96, 76], 2],
    [[225, 190, 160], 1], [[150, 165, 180], 1], [[235, 225, 200], 1],
  ],
};
const PALETTE_OF_TYPE: Record<string, string> = {};
for (const [palette, types] of Object.entries({
  residential: 'house detached semidetached_house terrace residential apartments bungalow dormitory cabin hut farm static_caravan',
  industrial: 'industrial warehouse manufacture factory hangar storage_tank silo service transformer_tower garage garages shed roof carport bunker digester',
  commercial: 'commercial retail office supermarket kiosk hotel shop mall train_station transportation parking',
  school: 'school kindergarten',
  civic: 'hospital university college public civic government townhall fire_station sports_hall',
  religious: 'church cathedral chapel mosque temple synagogue religious monastery',
  agricultural: 'barn farm_auxiliary stable cowshed sty',
})) for (const t of types.split(' ')) PALETTE_OF_TYPE[t] = palette;

/** the palette for a building type (unknown and `yes`: mixed) */
export function wallPalette(type: string): Palette {
  return WALL_PALETTES[PALETTE_OF_TYPE[type] ?? 'mixed'];
}

function pickWeighted(p: Palette, t: number): RGB {
  const total = p.reduce((s, [, w]) => s + w, 0);
  let x = t * total;
  for (const [c, w] of p) {
    if (x < w) return c;
    x -= w;
  }
  return p[p.length - 1][0];
}

/** any colour as it is: lit and fogged in the shader like the terrain (palette.ts) */
const rgbRamp = (c: RGB) => colourOf(c);

/** a colour tag written as a CSS name ("red", "light grey"), not as an exact hex or rgb() value */
function isNamedColor(v: string): boolean {
  return CSS_COLORS[v.split(';')[0].trim().toLowerCase().replace(/[\s_-]+/g, '')] !== undefined;
}

/** hue in degrees, saturation and value 0..1 */
function hsv([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max / 255];
}

/** a named colour's saturation is kept up to this: a building shade, not a CSS swatch */
const MUTED_MAX_SATURATION = 0.45;
/** a named colour's lightness is kept to this range: no pure white or black buildings */
const MUTED_LIGHTNESS: [number, number] = [0.15, 0.85];

/** hue in degrees, saturation and value 0..1 → RGB 0..255 */
function fromHsv(h: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

/**
 * A CSS-named colour → a muted colour of its hue: lightness clamped to MUTED_LIGHTNESS, saturation
 * to MUTED_MAX_SATURATION, the hue kept. "red" on a wall reads as a red-brown facade, not a swatch.
 */
export function mutedColour(c: RGB): RGB {
  const max = Math.max(...c), min = Math.min(...c);
  const l = (max + min) / 510;
  const lc = Math.min(MUTED_LIGHTNESS[1], Math.max(MUTED_LIGHTNESS[0], l));
  const t = c.map((v) => Math.max(0, Math.min(255, v + (lc - l) * 255))) as unknown as RGB; // lightness clamped, hue kept
  const [h, s, v] = hsv(t);
  // a little under the cap, so rounding to 8 bits per channel stays within it
  return s <= MUTED_MAX_SATURATION ? t : fromHsv(h, MUTED_MAX_SATURATION - 0.005, v);
}

function mutedRamp(c: RGB): number {
  return colourOf(mutedColour(c));
}

/** a tagged colour with more saturation than this is toned down (pastelColour) */
const TAGGED_MAX_SATURATION = 0.5;
/** a loud colour this bright (HSV value) or brighter becomes a pastel; darker ones only lose saturation */
const PASTEL_MIN_VALUE = 0.6;
const PASTEL_SATURATION = 0.3;
const PASTEL_VALUE = 0.88;

/**
 * A too saturated colour as a building shade, hue kept: a bright one (#ff0000, #00ff00) → a pastel of
 * it (saturation 0.3, light), a dark one (#800000) → its saturation capped at 0.5. Others as they are.
 */
export function pastelColour(c: RGB): RGB {
  const [h, s, v] = hsv(c);
  if (s <= TAGGED_MAX_SATURATION) return c;
  if (v >= PASTEL_MIN_VALUE) return fromHsv(h, PASTEL_SATURATION, Math.max(v, PASTEL_VALUE));
  // a little under the cap, so rounding to 8 bits per channel stays within it
  return fromHsv(h, TAGGED_MAX_SATURATION - 0.005, v);
}

/**
 * Ramp of the first usable colour among the colour tags (a CSS name muted, a hex or rgb() value
 * as tagged unless too saturated: pastelColour), else of the material's colour.
 */
function taggedRamp(tags: Record<string, string>, colourKeys: string[], materialKey: string): number | undefined {
  for (const k of colourKeys) {
    const c = parseColor(tags[k]);
    if (c) return isNamedColor(tags[k]) ? mutedRamp(c) : rgbRamp(pastelColour(c));
  }
  const mat = tags[materialKey]?.split(';')[0].trim().toLowerCase();
  return mat && MATERIAL_RGB[mat] ? rgbRamp(MATERIAL_RGB[mat]) : undefined;
}

/**
 * Wall colour from OSM (Simple 3D Buildings: building:colour, then building:material), else one of
 * the type's palette (wallPalette), deterministic by the building seed. A hex or rgb() value is taken
 * as tagged unless too saturated (pastelColour); a CSS colour name as a muted shade of it.
 */
export function wallRamp(tags: Record<string, string>, seed = 0.5): number {
  const tagged = taggedRamp(tags, ['building:colour', 'building:color', 'colour', 'color'], 'building:material');
  if (tagged !== undefined) return tagged;
  const type = tags['building:part'] || tags.building || 'yes';
  if (type === 'greenhouse') return rgbRamp([...GREENHOUSE.GLASS]);
  const t = (seed * 104729 + 0.5) % 1; // a draw decorrelated from the roof's (roofRamp)
  return rgbRamp(pickWeighted(wallPalette(type), t));
}

/** the pitched roof of a building up to this height (wall + roof, above its base) may be orange */
const LOW_RISE_MAX_M = 12;
// roof colours when OSM gives none: shares of the 0..1 seed
const ROOF_GREY: RGB[] = [[168, 168, 168], [144, 144, 144], [128, 128, 132]];
const ROOF_DARK_GREY: RGB[] = [[96, 96, 98], [80, 80, 84], [64, 64, 68]];
const ROOF_ORANGE: RGB[] = [[184, 96, 56], [168, 84, 48], [196, 112, 64]];

/** deterministic 0..1 seed of a building from its first footprint vertex (stable when a tile is rebuilt) */
export function buildingSeed(ring: LonLat[] | undefined): number {
  if (!ring?.length) return 0.5;
  return hash01(ring[0][0] * 1e5, ring[0][1] * 1e5, 0);
}

/** the roof is drawn flat: no roof:shape (or `flat`), or no height left for a shaped roof */
export function isFlatRoof(tags: Record<string, string>): boolean {
  return roofShape(tags) === 'flat' || computeHeights(tags).roof < 0.01;
}

/** any colour → the pure grey of its luminance */
function greyRamp(c: RGB): number {
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return colourOf([y, y, y]);
}

/**
 * Roof colour from OSM (roof:colour, then roof:material) — OSM wins over every default. Without either:
 * pseudo-random but deterministic by seed: grey or dark grey, and for low-rise pitched roofs also orange
 * (an untagged flat roof is always grey).
 */
export function roofRamp(tags: Record<string, string>, seed = 0.5): number {
  const tagged = taggedRamp(tags, ['roof:colour', 'roof:color'], 'roof:material');
  if (tagged !== undefined) return tagged;
  if (isGlasshouse(tags)) return rgbRamp([...GREENHOUSE.GLASS]);
  const flat = isFlatRoof(tags);
  const h = computeHeights(tags);
  const lowRise = !flat && h.wall + h.roof <= LOW_RISE_MAX_M && tags.building !== 'industrial' && tags.building !== 'warehouse';
  const pick = (list: RGB[], t: number) => list[Math.min(list.length - 1, Math.floor(t * list.length))];
  const [orange, grey] = lowRise ? [0.45, 0.8] : [0, 0.5];
  const t = (seed * 7919) % 1; // second, decorrelated draw for the shade inside the group
  if (seed < orange) return rgbRamp(pick(ROOF_ORANGE, t));
  return greyRamp(pick(seed < grey ? ROOF_GREY : ROOF_DARK_GREY, t));
}

type V3 = [number, number, number];

/** drop repeated vertices and the closing duplicate of an OSM ring */
function dedupe(ring: XZ[]): XZ[] {
  const out: XZ[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-4) out.pop();
  return out;
}

function bbox(ring: XZ[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

/** area centroid of a ring (the vertex mean drifts toward densely noded curves) */
function areaCentroid(ring: XZ[]): XZ {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  return [cx / (3 * a), cz / (3 * a)];
}

/** outward normal of the first edge of the ring as drawn in OSM: the low side of a skillion (OSM-4D) */
function firstEdgeOutward(ring: XZ[]): XZ | undefined {
  if (ring.length < 3) return undefined;
  const [p, q] = ring;
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 1e-9) return undefined;
  const n: XZ = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len];
  // the interior lies on the side of positive signed area
  return ringAreaXZ(ring) > 0 ? n : [-n[0], -n[1]];
}

function ringAreaXZ(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** a point inside a ring (even-odd) */
function insideXZ(p: XZ, ring: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function normalizeRing(ring: XZ[], ccw: boolean): XZ[] {
  const area = ringAreaXZ(ring);
  if ((area > 0) !== ccw) return [...ring].reverse();
  return ring;
}

/**
 * A house on a slope stands at the highest ground under its outline, on a plinth down to the lowest
 * (nothing of it buried in the hill), but never more than this over the lowest ground: on steeper
 * ground it is cut into the hill by the rest
 */
export const PLINTH_MAX_M = 6;
/** a plinth reaches this far into the ground under its lowest point: no gap where the ground dips between outline points */
const PLINTH_SINK_M = 0.5;
/** a plinth's colour without the terrain's: earth */
const PLINTH_EARTH = snowy(colour(112, 94, 70));

/**
 * Where a building stands: `base` the foot of its walls (the highest ground under its outline and
 * the midpoints of its edges, at most PLINTH_MAX_M over the lowest), `low` the lowest ground there
 * (both at least sea level)
 */
export function buildingFooting(ring: ReadonlyArray<LonLat>, sampleHeight: HeightSampler): { base: number; low: number } {
  let lo = Infinity, hi = -Infinity;
  const at = (lon: number, lat: number) => {
    const h = sampleHeight(lon, lat);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  };
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i], [lon2, lat2] = ring[(i + 1) % ring.length];
    at(lon, lat);
    at((lon + lon2) / 2, (lat + lat2) / 2);
  }
  if (!Number.isFinite(lo)) return { base: 0, low: 0 };
  const low = Math.max(lo, 0);
  return { base: Math.max(Math.min(hi, lo + PLINTH_MAX_M), 0), low };
}

export function buildBuildingMesh(opts: BuildingMeshOptions): BuildingMeshData {
  const { tile, buildings, sampleHeight } = opts;
  const center = tileCenter(tile);
  // the small parts go to their own arrays, appended after the rest (coreVertexCount)
  const core = { verts: [] as number[], ramps: [] as number[], win: [] as number[] };
  const small = { verts: [] as number[], ramps: [] as number[], win: [] as number[] };
  // see-through faces (greenhouses): their own mesh; window attributes are kept only to be dropped
  const glass = { verts: [] as number[], ramps: [] as number[], win: [] as number[] };
  let verts = core.verts;
  let ramps = core.ramps;
  let win = core.win;
  const acs: number[] = [];
  const detail = <T>(make: () => T): T => {
    ({ verts, ramps, win } = small);
    try { return make(); } finally { ({ verts, ramps, win } = core); }
  };

  const toXZ = (ll: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, ll[1], ll[0], 0);
    return [e, -n];
  };
  const entrances = entranceGrid((opts.points ?? []).filter((p) => p.tags.entrance !== undefined && p.tags.entrance !== 'no'), toXZ, sampleHeight);
  const emitTri = (a: V3, b: V3, c: V3, ramp: number, up: boolean): void => {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) return; // a sliver (twice the area in m²)
    nx /= len; ny /= len; nz /= len;
    if (up ? ny < 0 : ny > 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) {
      verts.push(p[0], p[1], p[2], nx, ny, nz);
      ramps.push(ramp);
      win.push(0, 0, 0, 0, 0);
    }
  };

  for (const b of buildings) {
    // a ruin is its broken walls, no roof nor window (ruin-mesher.ts)
    if (isRuin(b.tags)) continue;
    const tags = buildingTags(b);
    if (!b.rings.length || !b.rings[0].length) continue;
    const outerLL = b.rings[0];
    const rawOuter = dedupe(outerLL.map(toXZ));
    const outer = normalizeRing(rawOuter, true);
    if (outer.length < 3) continue;
    const holes = b.rings.slice(1).map((r) => normalizeRing(dedupe(r.map(toXZ)), false)).filter((r) => r.length >= 3);

    // the walls stand at the highest ground under the footprint (a plinth below, see PLINTH_MAX_M)
    const { base, low } = buildingFooting(outer.map(([x, z]) => { const ll = enuToLatLon(center, x, -z, 0); return [ll.lon, ll.lat] as LonLat; }), sampleHeight);
    const shape = roofShape(tags);
    const frame = roofFrame(outer, tags);
    const h = computeHeights(tags, roofRun(shape, frame));
    const wallBase = base + h.min;
    const wallTop = wallBase + h.wall;
    const wRamp = wallRamp(tags, buildingSeed(outerLL));
    const rRamp = roofRamp(tags, buildingSeed(outerLL));
    const isCanopy = tags.building === 'roof';
    const roof = roofModel(shape, frame, h.roof, outer, tags, firstEdgeOutward(rawOuter));
    const creases = roof.kind === 'planar' ? roofCreases(roof, bbox(outer)) : [];
    const centroid = areaCentroid(outer);
    // windows on the facades of buildings people live or work in, below the roof (not in gables)
    // between the plinth and (under a flat roof) the technical floor (FACADE_ZONES)
    const zoned = hasFacadeZones(tags);
    const winBase = wallBase + (zoned && h.min < 0.5 ? FACADE_ZONES.PLINTH_M : 0);
    const winH = wallTop - winBase - (roof.kind === 'flat' && hasTechFloor(tags, shape) ? FACADE_ZONES.TECH_FLOOR_M : 0);
    const windowed = zoned && winH >= WINDOWS.MIN_WALL_M;
    // residential: balconies on some edges, rare signs on the ground floor
    const balconies = windowed && hasBalconies(tags, winH);
    // hospitals and supermarkets keep their lights on all night
    const flags = isAllNight(tags) ? FACADE_ALL_NIGHT : 0;

    // a plinth of the ground's colour from under the lowest ground up to the walls: a house on a slope
    if (!isCanopy && h.min < 0.5 && base - low > 0.05) {
      for (const ring of [outer, ...holes]) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], c = ring[(i + 1) % ring.length];
          const mid = enuToLatLon(center, (a[0] + c[0]) / 2, -(a[1] + c[1]) / 2, 0);
          const ramp = opts.groundColour?.(mid.lon, mid.lat) ?? PLINTH_EARTH;
          const y0 = low - PLINTH_SINK_M;
          emitWallQuad([a[0], y0, a[1]], [a[0], base, a[1]], [c[0], base, c[1]], [c[0], y0, c[1]], ramp, centroid);
          for (let k = 0; k < 6; k++) win.push(0, 0, 0, 0, 0);
        }
      }
    }

    // a greenhouse's walls and roof are glass (their own mesh), its frame opaque (after the roof)
    const glassy = isGlasshouse(tags);
    if (glassy) ({ verts, ramps, win } = glass);

    // walls up to the roof profile (gable ends close themselves); none under a canopy
    if (!isCanopy) {
      for (const ring of [outer, ...holes]) {
        for (let i = 0; i < ring.length; i++) {
          wallUnderRoof(ring[i], ring[(i + 1) % ring.length], wallBase, wallTop, roof, creases, wRamp, centroid, windowed ? winH : 0, winBase, balconies, flags);
        }
      }
      // doors where OSM marks entrances on the outline, on walls standing on the ground
      if (h.min < 0.5 && h.wall >= 2.4 && !glassy) {
        for (const e of entrances.near(bbox(outer), ENTRANCE_SNAP_M)) {
          detail(() => door(e, [outer, ...holes], wallBase, wallTop, wRamp, windowed ? winH : 0, winBase, balconies, flags));
        }
      }
      if (windowed && AC_TYPES.has(tags.building)) airConditioners(outer, winBase, winH);
    }

    // ceiling under elevated parts (arches, bridges)
    if (h.min > 0.01 && !isCanopy) capRing(outer, holes, wallBase, wRamp, false);

    if (roof.kind === 'flat') {
      // a flat roof holds snow in winter
      // a parapet along the edges, the roof sunk behind it (not on a canopy or a too small building)
      const bb = bbox(outer);
      const withParapet = !isCanopy && !glassy && h.wall >= PARAPET.MIN_WALL_M && Math.min(bb.maxX - bb.minX, bb.maxZ - bb.minZ) >= PARAPET.MIN_SIDE_M;
      if (withParapet && isChimney(tags)) {
        const soot = rgbRamp(CHIMNEY.SOOT);
        const floorY = wallTop - CHIMNEY.DEPTH * h.wall;
        const inOuter = detail(() => parapet(outer, floorY, wallTop, wRamp, soot, CHIMNEY.WALL_M));
        const inHoles = detail(() => holes.map((r) => parapet(r, floorY, wallTop, wRamp, soot, CHIMNEY.WALL_M)));
        capRing(inOuter, inHoles, floorY, soot, true);
      } else if (withParapet) {
        const roofY = wallTop - PARAPET.HEIGHT_M;
        const inOuter = detail(() => parapet(outer, roofY, wallTop, wRamp));
        const inHoles = detail(() => holes.map((r) => parapet(r, roofY, wallTop, wRamp)));
        capRing(inOuter, inHoles, roofY, snowy(rRamp), true);
        detail(() => rooftop(inOuter, inHoles, roofY, buildingSeed(outerLL)));
      } else {
        capRing(outer, holes, wallTop, snowy(rRamp), true);
      }
    } else if (roof.kind === 'fan') {
      const apex: V3 = [centroid[0], wallTop + h.roof, centroid[1]];
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i], c = outer[(i + 1) % outer.length];
        emitTri([a[0], wallTop, a[1]], [c[0], wallTop, c[1]], apex, rRamp, true);
      }
    } else if (roof.kind === 'radial') {
      radialRoof(outer, centroid, wallTop, h.roof, roof.profile, rRamp);
    } else {
      planarRoof(outer, holes, wallTop, roof.field, creases, rRamp);
    }

    if (glassy) {
      ({ verts, ramps, win } = core);
      // the frame is a small part: the far LOD draws the glass alone
      detail(() => glassFrame(outer, wallBase, wallTop, roof, creases, frame, rgbRamp([...GREENHOUSE.FRAME]), centroid, isCanopy));
    }
  }

  /**
   * A greenhouse's frame as flat bars just outside its glass (2 triangles a bar: thousands of
   * greenhouses to a tile): posts up the walls at most BAY_M apart, a beam along their tops (up the
   * gables), and on a pitched or flat roof rafters across the ridge every BAY_M and purlins along it
   * every PURLIN_M, one on the ridge line. Radial and fan roofs get the walls' bars only.
   */
  function glassFrame(outer: XZ[], yBase: number, yTop: number, roof: RoofModel, creases: Plane[], rf: RoofFrame, ramp: number, centroid: XZ, canopy: boolean): void {
    const field = roof.kind === 'planar' ? roof.field : () => 0;
    const top = (p: XZ): number => yTop + field(p);
    const W = GREENHOUSE.BAR_M / 2, L = GREENHOUSE.LIFT_M;
    if (!canopy) {
      for (let i = 0; i < outer.length; i++) {
        const p = outer[i], q = outer[(i + 1) % outer.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 1e-3) continue;
        const ex = (q[0] - p[0]) / len, ez = (q[1] - p[1]) / len;
        // outward: away from the footprint's centroid, as emitWallQuad turns the face
        let ox = ez, oz = -ex;
        if (ox * ((p[0] + q[0]) / 2 - centroid[0]) + oz * ((p[1] + q[1]) / 2 - centroid[1]) < 0) { ox = -ox; oz = -oz; }
        const at = (t: number, s: number): XZ => [p[0] + ex * (t * len + s) + ox * L, p[1] + ez * (t * len + s) + oz * L];
        const n = Math.max(1, Math.ceil(len / GREENHOUSE.BAY_M));
        // a bar on the wall: a quad with no window attributes
        const wallBar = (a0: V3, a1: V3, c1: V3, c0: V3): void => {
          emitWallQuad(a0, a1, c1, c0, ramp, centroid);
          for (let j = 0; j < 6; j++) win.push(0, 0, 0, 0, 0);
        };
        for (let k = 0; k <= n; k++) {
          // posts, kept on the edge at its ends
          const s0 = k === 0 ? 0 : -W, s1 = k === n ? 0 : W;
          const a = at(k / n, s0), c = at(k / n, s1);
          wallBar([a[0], yBase, a[1]], [a[0], top(a), a[1]], [c[0], top(c), c[1]], [c[0], yBase, c[1]]);
        }
        // the beam along the top, broken where the roof bends over the edge
        const ts = [0, ...crossings(p, q, creases), 1];
        for (let k = 0; k + 1 < ts.length; k++) {
          const a = at(ts[k], 0), c = at(ts[k + 1], 0);
          const ya = top(a), yc = top(c);
          wallBar([a[0], ya - 2 * W, a[1]], [a[0], ya, a[1]], [c[0], yc, c[1]], [c[0], yc - 2 * W, c[1]]);
        }
      }
    }
    if (roof.kind !== 'planar' && roof.kind !== 'flat') return;
    // bars on the roof: along `dir` through `origin`, where the line is inside the footprint
    const bar = (origin: XZ, dir: XZ, side: XZ): void => {
      for (const [t0, t1] of lineInside(origin, dir, outer)) {
        const p: XZ = [origin[0] + dir[0] * t0, origin[1] + dir[1] * t0];
        const q: XZ = [origin[0] + dir[0] * t1, origin[1] + dir[1] * t1];
        const ts = [0, ...crossings(p, q, creases), 1];
        for (let k = 0; k + 1 < ts.length; k++) {
          const a: XZ = [p[0] + (q[0] - p[0]) * ts[k], p[1] + (q[1] - p[1]) * ts[k]];
          const c: XZ = [p[0] + (q[0] - p[0]) * ts[k + 1], p[1] + (q[1] - p[1]) * ts[k + 1]];
          const v = (b: XZ, s: number): V3 => {
            const x: XZ = [b[0] + side[0] * s, b[1] + side[1] * s];
            return [x[0], top(b) + L, x[1]];
          };
          emitTri(v(a, -W), v(c, -W), v(c, W), ramp, true);
          emitTri(v(a, -W), v(c, W), v(a, W), ramp, true);
        }
      }
    };
    const { origin, u, v, halfU, halfV } = rf;
    const rafters = Math.max(1, Math.ceil((2 * halfU) / GREENHOUSE.BAY_M));
    for (let k = 1; k < rafters; k++) {
      const s = -halfU + (2 * halfU * k) / rafters;
      bar([origin[0] + u[0] * s, origin[1] + u[1] * s], v, u);
    }
    for (let k = 0; k * GREENHOUSE.PURLIN_M < halfV; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const s = sign * k * GREENHOUSE.PURLIN_M;
        bar([origin[0] + v[0] * s, origin[1] + v[1] * s], u, v);
      }
    }
  }

  /**
   * windowH: the height of the facade with windows (0: none), from winBase up (the facade's v is
   * measured from there: the plinth under it is negative, no windows); balconies: some edges may carry them
   */
  function wallUnderRoof(
    p: XZ, q: XZ, yBase: number, yTop: number, roof: RoofModel, creases: Plane[], ramp: number, centroid: XZ, windowH: number, winBase: number, balconies: boolean, flags: number,
  ): void {
    const field = roof.kind === 'planar' ? roof.field : () => 0;
    const ts = [0, ...crossings(p, q, creases), 1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const wallH = len >= WINDOWS.MIN_EDGE_M ? windowH : 0;
    // stable across rebuilds: from the edge's start in tile-centre ENU; the code is an integer below 2^24, exact in a float
    const seed = wallH > 0 ? edgeCode(p, yBase, len, balconies) + flags : 0;
    for (let k = 0; k + 1 < ts.length; k++) {
      const a: XZ = [p[0] + (q[0] - p[0]) * ts[k], p[1] + (q[1] - p[1]) * ts[k]];
      const c: XZ = [p[0] + (q[0] - p[0]) * ts[k + 1], p[1] + (q[1] - p[1]) * ts[k + 1]];
      const ya = yTop + field(a), yc = yTop + field(c);
      if (ya - yBase < 0.01 && yc - yBase < 0.01) continue;
      emitWallQuad([a[0], yBase, a[1]], [a[0], ya, a[1]], [c[0], yc, c[1]], [c[0], yBase, c[1]], ramp, centroid);
      // where each of the six vertices is on the facade (emitWallQuad order: a0, c0, c1, a0, c1, a1)
      const ua = ts[k] * len, uc = ts[k + 1] * len;
      const v0 = yBase - winBase;
      for (const [u, v] of [[ua, v0], [uc, v0], [uc, yc - winBase], [ua, v0], [uc, yc - winBase], [ua, ya - winBase]]) {
        win.push(u, v, len, wallH, seed);
      }
    }
  }

  function planarRoof(outer: XZ[], holes: XZ[][], wallTop: number, field: (p: XZ) => number, creases: Plane[], ramp: number): void {
    const flat: number[] = [];
    const holeIdx: number[] = [];
    const pts: XZ[] = [];
    outer.forEach((p) => { flat.push(p[0], p[1]); pts.push(p); });
    for (const hole of holes) {
      holeIdx.push(pts.length);
      for (const p of hole) { flat.push(p[0], p[1]); pts.push(p); }
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    for (let i = 0; i < tris.length; i += 3) {
      // cut each footprint triangle along the creases: every piece is one roof plane
      let cells: XZ[][] = [[pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]]]];
      for (const line of creases) cells = cells.flatMap((c) => splitConvex(c, line));
      for (const cell of cells) {
        const lifted = cell.map((p): V3 => [p[0], wallTop + field(p), p[1]]);
        for (let k = 1; k + 1 < lifted.length; k++) emitTri(lifted[0], lifted[k], lifted[k + 1], ramp, true);
      }
    }
  }

  function radialRoof(outer: XZ[], c: XZ, wallTop: number, roofH: number, profile: [number, number][], ramp: number): void {
    const ring = (s: number, f: number): V3[] => outer.map((p) => [c[0] + (p[0] - c[0]) * s, wallTop + roofH * f, c[1] + (p[1] - c[1]) * s]);
    for (let k = 0; k + 1 < profile.length; k++) {
      const lo = ring(...profile[k]);
      const hi = ring(...profile[k + 1]);
      const apex = profile[k + 1][0] === 0;
      for (let i = 0; i < outer.length; i++) {
        const j = (i + 1) % outer.length;
        if (apex) emitTri(lo[i], lo[j], hi[i], ramp, true);
        else {
          emitTri(lo[i], lo[j], hi[j], ramp, true);
          emitTri(lo[i], hi[j], hi[i], ramp, true);
        }
      }
    }
  }

  function emitWallQuad(a0: V3, a1: V3, c1: V3, c0: V3, ramp: number, centroid: XZ): void {
    // outward horizontal normal from edge midpoint away from centroid
    const mx = (a0[0] + c0[0]) / 2 - centroid[0];
    const mz = (a0[2] + c0[2]) / 2 - centroid[1];
    const ex = c0[0] - a0[0], ez = c0[2] - a0[2];
    let nx = ez, nz = -ex;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    for (const p of [a0, c0, c1, a0, c1, a1]) {
      verts.push(p[0], p[1], p[2], nx, 0, nz);
      ramps.push(ramp);
    }
  }

  /** a vertical rectangle on the wall: u0..u1 along p→q, y0..y1, `off` metres out along the outward normal n */
  /**
   * facade: [edge length, wall height, code, wall base] to carry the facade attributes (u along the
   * edge, v above the wall base) as the wall under it does; without, no windows on the rectangle
   */
  function wallRect(
    p: XZ, dir: XZ, n: XZ, u0: number, u1: number, y0: number, y1: number, off: number, ramp: number, facade?: [number, number, number, number],
  ): void {
    const at = (u: number, y: number): [number, number] => [u, y];
    for (const [u, y] of [at(u0, y0), at(u1, y0), at(u1, y1), at(u0, y0), at(u1, y1), at(u0, y1)]) {
      verts.push(p[0] + dir[0] * u + n[0] * off, y, p[1] + dir[1] * u + n[1] * off, n[0], 0, n[1]);
      ramps.push(ramp);
      if (facade) win.push(u, y - facade[3], facade[0], facade[1], facade[2]);
      else win.push(0, 0, 0, 0, 0);
    }
  }

  /**
   * A door at entrance e on the nearest wall edge of the rings (outer ccw, holes cw: (dz, -dx) is
   * outward for both) that it fits on. It is moved to the centre of the nearest window slot, and
   * that slot's ground floor is covered by a blind patch of the wall (the edge's facade code with
   * FACADE_BLIND: the ground floor's tint, no openings), so no pane or shop window shows round the door.
   */
  function door(e: Entrance, rings: XZ[][], wallBase: number, wallTop: number, wRamp: number, windowH: number, winBase: number, residential: boolean, flags: number): void {
    const [w, hgt] = DOOR_SIZE[e.kind] ?? DOOR_SIZE.default;
    let best: { p: XZ; dir: XZ; len: number; u: number; d: number } | undefined;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < w + 0.4) continue;
        const dir: XZ = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        const u = Math.max(0, Math.min(len, (e.at[0] - p[0]) * dir[0] + (e.at[1] - p[1]) * dir[1]));
        const d = Math.hypot(p[0] + dir[0] * u - e.at[0], p[1] + dir[1] * u - e.at[1]);
        // on a corner vertex, the longer of its two edges
        if (d <= ENTRANCE_SNAP_M && (!best || d < best.d - 0.05 || (Math.abs(d - best.d) <= 0.05 && len > best.len))) best = { p, dir, len, u, d };
      }
    }
    if (!best) return;
    const { p, dir, len } = best;
    const n: XZ = [dir[1], -dir[0]];
    const slots = Math.max(1, Math.floor(len / WINDOWS.SPACING_M));
    const cw = len / slots;
    const k = Math.max(0, Math.min(slots - 1, Math.floor(best.u / cw)));
    const u = Math.max(w / 2 + 0.2, Math.min(len - w / 2 - 0.2, (k + 0.5) * cw));
    // the ground under the entrance, never below the foundation
    const y0 = Math.max(wallBase, e.ground);
    const top = Math.min(wallTop - 0.1, y0 + hgt);
    if (top - y0 < 1.8) return;
    const wallH = len >= WINDOWS.MIN_EDGE_M ? windowH : 0;
    if (wallH > 0) {
      // the slot's whole ground floor (wallUnderRoof gives the edge the same code)
      const fh = wallH / Math.max(1, Math.floor(wallH / WINDOWS.FLOOR_M));
      const code = edgeCode(p, wallBase, len, residential) + flags + FACADE_BLIND;
      wallRect(p, dir, n, k * cw + 0.02, (k + 1) * cw - 0.02, wallBase, winBase + fh - 0.02, DOOR_LAYERS_M[0], wRamp, [len, wallH, code, winBase]);
    }
    const garage = e.kind === 'garage';
    wallRect(p, dir, n, u - w / 2 - 0.1, u + w / 2 + 0.1, y0, top + 0.1, DOOR_LAYERS_M[1], rgbRamp(DOOR_FRAME_RGB));
    const leaf = garage ? GARAGE_DOOR_RGB : DOOR_LEAF_RGB[Math.floor(hash01(e.at[0], y0, e.at[1]) * DOOR_LEAF_RGB.length)];
    if (e.kind === 'main') {
      // double door: two leaves with a frame line between
      wallRect(p, dir, n, u - w / 2, u - 0.03, y0, top, DOOR_LAYERS_M[2], rgbRamp(leaf));
      wallRect(p, dir, n, u + 0.03, u + w / 2, y0, top, DOOR_LAYERS_M[2], rgbRamp(leaf));
    } else {
      wallRect(p, dir, n, u - w / 2, u + w / 2, y0, top, DOOR_LAYERS_M[2], rgbRamp(leaf));
    }
  }

  /** air-conditioner instances under the windows of the outer walls (ring ccw: outward is to the right of each edge) */
  function airConditioners(ring: XZ[], winBase: number, winH: number): void {
    const floors = Math.max(1, Math.floor(winH / WINDOWS.FLOOR_M));
    const fh = winH / floors;
    // the pane of WORLD_FS windowAt: centred 0.55 of the floor up, half as high as min(0.75, 0.27 fh)
    const sill = 0.55 * fh - Math.min(0.75, 0.27 * fh) - AC.GAP_M - AC_SIZE.HEIGHT;
    if (sill < 0) return;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const ex = q[0] - p[0], ez = q[1] - p[1], len = Math.hypot(ex, ez);
      if (len < WINDOWS.MIN_EDGE_M) continue;
      const ox = ez / len, oz = -ex / len;
      const yaw = Math.atan2(oz, ox);
      const slots = Math.max(1, Math.floor(len / WINDOWS.SPACING_M));
      for (let f = floors >= 2 ? 1 : 0; f < floors; f++) {
        const y = winBase + f * fh + sill;
        for (let k = 0; k < slots; k++) {
          const t = (k + 0.5) / slots;
          const x = p[0] + ex * t, z = p[1] + ez * t;
          if (hash01(x, y, z) >= AC.PROBABILITY) continue;
          pushInstance(acs, x, y, z, 1, rgbRamp(AC_RGB), INSTANCE.AC, yaw);
        }
      }
    }
  }

  /** ROOFTOP structures on a flat roof surface (inside the parapet), placed by the building's seed */
  function rooftop(outer: XZ[], holes: XZ[][], y: number, seed: number): void {
    const area = Math.abs(ringAreaXZ(outer)) - holes.reduce((s, r) => s + Math.abs(ringAreaXZ(r)), 0);
    if (area < ROOFTOP.MIN_AREA_M2) return;
    const want = Math.min(ROOFTOP.MAX, Math.max(1, Math.round(area / ROOFTOP.AREA_PER_UNIT_M2)));
    // along the longest outer edge
    let ux = 1, uz = 0, best = 0;
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i], q = outer[(i + 1) % outer.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > best) { best = l; ux = (q[0] - p[0]) / l; uz = (q[1] - p[1]) / l; }
    }
    const vx = -uz, vz = ux;
    const bb = bbox(outer);
    let st = (Math.floor(seed * 4294967296) ^ 0x9e3779b9) >>> 0;
    const rnd = (): number => {
      st = (st + 0x6d2b79f5) >>> 0;
      let t = Math.imul(st ^ (st >>> 15), 1 | st);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const placed: [number, number, number][] = [];
    for (let attempt = 0; attempt < want * 12 && placed.length < want; attempt++) {
      const [len, wid, ht, rgb] = ROOFTOP.UNITS[Math.min(3, Math.floor(rnd() * 4))];
      const cx = bb.minX + rnd() * (bb.maxX - bb.minX), cz = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
      const hl = len / 2 + ROOFTOP.MARGIN_M, hw = wid / 2 + ROOFTOP.MARGIN_M;
      const corners: XZ[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + ux * a * hl + vx * b * hw, cz + uz * a * hl + vz * b * hw]);
      const inside = (pt: XZ) => insideXZ(pt, outer) && !holes.some((h) => insideXZ(pt, h));
      if (!inside([cx, cz]) || !corners.every(inside)) continue;
      if (holes.some((h) => h.some((pt) => Math.abs((pt[0] - cx) * ux + (pt[1] - cz) * uz) < hl && Math.abs((pt[0] - cx) * vx + (pt[1] - cz) * vz) < hw))) continue;
      const r = Math.hypot(hl, hw);
      if (placed.some(([px, pz, pr]) => Math.hypot(px - cx, pz - cz) < pr + r)) continue;
      placed.push([cx, cz, r]);
      const ramp = rgbRamp(rgb);
      const c = ([a, b]: number[], yy: number): V3 => [cx + ux * a * len / 2 + vx * b * wid / 2, yy, cz + uz * a * len / 2 + vz * b * wid / 2];
      const y1 = y + ht;
      const sides: [number[], number[], V3][] = [
        [[-1, -1], [1, -1], [-vx, 0, -vz]], [[1, -1], [1, 1], [ux, 0, uz]], [[1, 1], [-1, 1], [vx, 0, vz]], [[-1, 1], [-1, -1], [-ux, 0, -uz]],
      ];
      for (const [a, b, n] of sides) flatQuad(c(a, y), c(b, y), c(b, y1), c(a, y1), n, ramp);
      flatQuad(c([-1, -1], y1), c([1, -1], y1), c([1, 1], y1), c([-1, 1], y1), [0, 1, 0], snowy(ramp));
    }
  }

  /** a quad with one normal for all its vertices, no facade attributes */
  function flatQuad(a: V3, b: V3, c: V3, d: V3, n: V3, ramp: number): void {
    for (const p of [a, b, c, a, c, d]) {
      verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
      ramps.push(ramp);
      win.push(0, 0, 0, 0, 0);
    }
  }

  /**
   * Parapet on a flat roof along a ring (outer ccw, hole cw, so the roof is on the left of every edge):
   * the wall face is its outside; an inner face PARAPET.WIDTH_M inside it from the roof (y0) to the
   * wall top (y1), and a top. Returns the inner ring, the edge of the roof surface. The inner face
   * takes innerRamp (the wall's by default), the top the wall's colour (snow in winter).
   */
  function parapet(ring: XZ[], y0: number, y1: number, ramp: number, innerRamp = ramp, width: number = PARAPET.WIDTH_M): XZ[] {
    const n = ring.length;
    const left = (p: XZ, q: XZ): XZ => {
      const ex = q[0] - p[0], ez = q[1] - p[1], len = Math.hypot(ex, ez) || 1;
      return [-ez / len, ex / len];
    };
    const inner = ring.map((p, i): XZ => {
      const n1 = left(ring[(i + n - 1) % n], p), n2 = left(p, ring[(i + 1) % n]);
      const denom = 1 + n1[0] * n2[0] + n1[1] * n2[1];
      // a miter, but at a near-reversal corner only the next edge's offset (no long spike)
      const k = denom < 0.2 ? 0 : width / denom;
      return k ? [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k] : [p[0] + n2[0] * width, p[1] + n2[1] * width];
    });
    const top = snowy(ramp);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = ring[i], q = ring[j], pi = inner[i], qi = inner[j];
      const [lx, lz] = left(p, q);
      flatQuad([pi[0], y0, pi[1]], [qi[0], y0, qi[1]], [qi[0], y1, qi[1]], [pi[0], y1, pi[1]], [lx, 0, lz], innerRamp);
      flatQuad([p[0], y1, p[1]], [q[0], y1, q[1]], [qi[0], y1, qi[1]], [pi[0], y1, pi[1]], [0, 1, 0], top);
    }
    return inner;
  }

  function capRing(outer: XZ[], holes: XZ[][], y: number, ramp: number, up: boolean): void {
    const flat: number[] = [];
    const holeIdx: number[] = [];
    const pts: XZ[] = [];
    outer.forEach((p) => { flat.push(p[0], p[1]); pts.push(p); });
    for (const hole of holes) {
      holeIdx.push(pts.length);
      for (const p of hole) { flat.push(p[0], p[1]); pts.push(p); }
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    for (let i = 0; i < tris.length; i += 3) {
      const a = pts[tris[i]], b = pts[tris[i + 1]], c = pts[tris[i + 2]];
      emitTri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], ramp, up);
    }
  }

  const coreVertexCount = core.ramps.length;
  const vertexCount = coreVertexCount + small.ramps.length;
  const join = <T extends Float32Array | Uint32Array>(out: T, a: number[], b: number[]): T => {
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  return {
    vertices: join(new Float32Array(core.verts.length + small.verts.length), core.verts, small.verts),
    ramps: join(new Uint32Array(vertexCount), core.ramps, small.ramps),
    vertexCount,
    coreVertexCount,
    windows: join(new Float32Array(core.win.length + small.win.length), core.win, small.win),
    acs: new Float32Array(acs),
    glass: { vertices: new Float32Array(glass.verts), ramps: new Uint32Array(glass.ramps), vertexCount: glass.ramps.length },
  };
}

/**
 * Where the line origin + t·dir runs inside a ring: [t0, t1] intervals in order (even-odd over the
 * ring's edges; a vertex on the line counted once, by the half-open edge test).
 */
export function lineInside(origin: XZ, dir: XZ, ring: XZ[]): [number, number][] {
  const ts: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    // signed distances of the edge's ends across the line
    const da = (a[0] - origin[0]) * dir[1] - (a[1] - origin[1]) * dir[0];
    const db = (b[0] - origin[0]) * dir[1] - (b[1] - origin[1]) * dir[0];
    if ((da > 0) === (db > 0)) continue;
    const s = da / (da - db);
    const x = a[0] + (b[0] - a[0]) * s, z = a[1] + (b[1] - a[1]) * s;
    ts.push((x - origin[0]) * dir[0] + (z - origin[1]) * dir[1]);
  }
  ts.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > 1e-6) out.push([ts[i], ts[i + 1]]);
  return out;
}

/**
 * The code of a windowed wall edge (BuildingMeshData.windows): a seed from its start and, on a
 * residential building, FACADE_RESIDENTIAL and (on an edge long enough) maybe a balcony style.
 */
function edgeCode(p: XZ, yBase: number, len: number, residential: boolean): number {
  const seed = Math.floor(hash01(p[0], yBase, p[1]) * (1 << FACADE_SEED_BITS));
  let style: number = FACADE.WINDOWS;
  if (residential && len >= BALCONY_MIN_EDGE_M) {
    const r = hash01(p[1], p[0], yBase + 17);
    style = r < GLAZED_SHARE ? FACADE.GLAZED_BALCONIES : r < GLAZED_SHARE + OPEN_SHARE ? FACADE.OPEN_BALCONIES : FACADE.WINDOWS;
  }
  return (residential ? FACADE_RESIDENTIAL : 0) + style * (1 << FACADE_SEED_BITS) + seed;
}

interface Entrance {
  at: XZ;
  /** the entrance tag: main, garage, service, … */
  kind: string;
  /** terrain height under it */
  ground: number;
}

/** entrance nodes in tile-centre metres, bucketed in a grid for the per-building lookup */
function entranceGrid(points: OsmPoint[], toXZ: (ll: LonLat) => XZ, sampleHeight?: HeightSampler): { near(b: ReturnType<typeof bbox>, pad: number): Entrance[] } {
  const CELL = 25;
  const cells = new Map<string, Entrance[]>();
  for (const pt of points) {
    const at = toXZ(pt.at);
    const e: Entrance = { at, kind: pt.tags.entrance, ground: sampleHeight ? Math.max(0, sampleHeight(pt.at[0], pt.at[1])) : -Infinity };
    const key = `${Math.floor(at[0] / CELL)},${Math.floor(at[1] / CELL)}`;
    const list = cells.get(key);
    if (list) list.push(e);
    else cells.set(key, [e]);
  }
  return {
    near(b, pad) {
      const out: Entrance[] = [];
      if (!cells.size) return out;
      for (let i = Math.floor((b.minX - pad) / CELL); i <= Math.floor((b.maxX + pad) / CELL); i++) {
        for (let j = Math.floor((b.minZ - pad) / CELL); j <= Math.floor((b.maxZ + pad) / CELL); j++) {
          for (const e of cells.get(`${i},${j}`) ?? []) {
            if (e.at[0] >= b.minX - pad && e.at[0] <= b.maxX + pad && e.at[1] >= b.minZ - pad && e.at[1] <= b.maxZ + pad) out.push(e);
          }
        }
      }
      return out;
    },
  };
}

/**
 * Far stand-in for buildings: two points per building at its centroid, half-way up the building:
 * first in its wall colour, then in its roof colour (both lit step 9). The renderer draws them as
 * square dots of one size, the roof one stacked on screen right above the wall one (draw order:
 * even vertex = wall, odd = roof). Per point: x, y, z (tile-centre ENU like the meshes), palette index.
 */
export function buildingDots(buildings: OsmBuilding[], tile: Tile, sampleHeight: HeightSampler): Float32Array {
  const center = tileCenter(tile);
  const out: number[] = [];
  for (const b of buildings) {
    const ring = b.rings[0];
    if (!ring?.length) continue;
    let lon = 0, lat = 0;
    for (const [lo, la] of ring) { lon += lo; lat += la; }
    lon /= ring.length;
    lat /= ring.length;
    const h = buildingHeights(b);
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    const y = buildingFooting(ring, sampleHeight).base + h.min + (h.wall + h.roof) * 0.5;
    out.push(e, y, -n, pointValue(wallRamp(b.tags, buildingSeed(ring))));
    out.push(e, y, -n, pointValue(roofRamp(buildingTags(b), buildingSeed(ring))));
  }
  return new Float32Array(out);
}

/**
 * A ruin (building=ruins, or a building tagged historic=ruins or ruins=*: Kayaköy's hundreds of
 * roofless stone houses are building=yes + historic=ruins): its broken walls only (ruin-mesher.ts),
 * dark at night
 */
export function isRuin(tags: Record<string, string>): boolean {
  return tags.building === 'ruins' || tags['building:part'] === 'ruins' || tags.historic === 'ruins' || (tags.ruins !== undefined && tags.ruins !== 'no');
}

/** hospitals and supermarkets: lit all night (FACADE_ALL_NIGHT) */
export function isAllNight(tags: Record<string, string>): boolean {
  const b = tags['building:part'] || tags.building;
  return b === 'hospital' || b === 'supermarket' || tags.amenity === 'hospital' || tags.healthcare === 'hospital'
    || tags.shop === 'supermarket' || tags.shop === 'hypermarket';
}

/** buildings that nobody lives or works in stay dark at night */
const UNLIT_TYPES = new Set([
  'garage', 'garages', 'carport', 'shed', 'hut', 'cabin', 'roof', 'barn', 'greenhouse', 'storage_tank',
  'silo', 'transformer_tower', 'service', 'ruins', 'construction', 'bunker', 'kiosk', 'toilets',
  'chimney', 'water_tower', 'cooling_tower',
]);
/** structures mapped as buildings (man_made) that have no windows: chimneys, towers, tanks, silos */
const UNLIT_MAN_MADE = new Set([
  'chimney', 'tower', 'water_tower', 'silo', 'storage_tank', 'gasometer', 'kiln', 'bunker_silo', 'mast', 'reservoir_covered',
]);
export function isLitBuilding(tags: Record<string, string>): boolean {
  return !isRuin(tags) && !UNLIT_TYPES.has(tags['building:part'] || tags.building || 'yes') && !UNLIT_MAN_MADE.has(tags.man_made);
}

/** taller than this (top above ground), a building carries red obstruction lights on its roof */
export const TALL_BUILDING_M = 50;
/** deterministic 0..1 hash of a position (lights do not reshuffle when a tile is rebuilt) */
function hash01(x: number, y: number, z: number): number {
  let h = Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(y * 10) | 0, 19349663) ^ Math.imul(Math.round(z * 10) | 0, 83492791);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface NightLights {
  /** near (with the building mesh): red lights on the roof corners of tall buildings; the windows are on the walls (WORLD_FS) */
  roofLights: Float32Array;
  /**
   * far (instead of the roof-coloured dots): window cell dots on the facades (FAR_WINDOWS; palette
   * index WINDOW_YELLOW, WINDOW_WHITE on a building lit all night), red at roof height for tall ones
   */
  dots: Float32Array;
}

/**
 * Night lights of buildings as points; per point x, y, z (tile-centre ENU), palette index, like
 * buildingDots. Near buildings show lit windows on their walls instead of points (WORLD_FS); far, the
 * same facades carry a dot per cell `cellM` wide (FAR_WINDOWS), over the band the near windows take:
 * edges of at least WINDOWS.MIN_EDGE_M, between the plinth and the technical floor (none when `cellM`
 * is 0: the detailed tiles draw their lit facades at night instead).
 */
export function buildingNightLights(
  buildings: OsmBuilding[],
  tile: Tile,
  sampleHeight: HeightSampler,
  cellM: number = FAR_WINDOWS.CELL_M,
): NightLights {
  const center = tileCenter(tile);
  const roofLights: number[] = [];
  const dots: number[] = [];
  const toXZ = (ll: LonLat): XZ => {
    const [e, n] = latLonToEnu(center, ll[1], ll[0], 0);
    return [e, -n];
  };

  for (const b of buildings) {
    const ringLL = b.rings[0];
    if (!ringLL?.length) continue;
    const ring = ringLL.map(toXZ);
    // drop the closing duplicate
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) continue;
    const h = buildingHeights(b);
    const { base } = buildingFooting(ringLL, sampleHeight);
    const wallBase = base + h.min;
    const roofTop = wallBase + h.wall + h.roof;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const tall = h.min + h.wall + h.roof > TALL_BUILDING_M;
    const lit = isLitBuilding(b.tags) && b.tags.building !== 'roof';

    const tags = buildingTags(b);
    if (lit && cellM > 0 && hasFacadeZones(tags)) {
      const winBase = wallBase + (h.min < 0.5 ? FACADE_ZONES.PLINTH_M : 0);
      const winTop = wallBase + h.wall - (hasTechFloor(tags, roofShape(tags)) ? FACADE_ZONES.TECH_FLOOR_M : 0);
      const index = isAllNight(tags) ? LIGHT.WINDOW_WHITE : LIGHT.WINDOW_YELLOW;
      if (winTop - winBase >= WINDOWS.MIN_WALL_M) {
        const rows = Math.max(1, Math.round((winTop - winBase) / (cellM * FAR_WINDOWS.CELL_ASPECT)));
        const rowH = (winTop - winBase) / rows;
        let area2 = 0;
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          area2 += p[0] * q[1] - q[0] * p[1];
        }
        const sign = area2 > 0 ? 1 : -1;
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          const ex = q[0] - p[0], ez = q[1] - p[1];
          const len = Math.hypot(ex, ez);
          if (len < WINDOWS.MIN_EDGE_M) continue;
          // out of the footprint: the right of a counter-clockwise edge (x east, z south)
          const ox = (sign * ez / len) * FAR_WINDOWS.OUT_M, oz = (-sign * ex / len) * FAR_WINDOWS.OUT_M;
          const cols = Math.max(1, Math.round(len / cellM));
          for (let c = 0; c < cols; c++) {
            const t = (c + 0.5) / cols;
            for (let r = 0; r < rows; r++) dots.push(p[0] + ex * t + ox, winBase + (r + 0.5) * rowH, p[1] + ez * t + oz, index);
          }
        }
      }
    }
    if (tall) dots.push(cx, roofTop, cz, LIGHT.RED);

    if (tall) {
      // the outermost corners of the footprint, just above the roof
      const ext = new Set<XZ>();
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        let best = ring[0], bv = -Infinity;
        for (const p of ring) {
          const v = sx * (p[0] - cx) + sz * (p[1] - cz);
          if (v > bv) { bv = v; best = p; }
        }
        ext.add(best);
      }
      // on the eaves of a pitched roof (its ridge is not at the corners)
      for (const p of ext) roofLights.push(p[0], wallBase + h.wall + 0.5, p[1], LIGHT.RED);
    }
  }
  return { roofLights: new Float32Array(roofLights), dots: new Float32Array(dots) };
}
