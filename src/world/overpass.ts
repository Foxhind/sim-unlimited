import { tileBounds, type Tile, type TileBounds } from './geodesy';
import { isAntenna } from './mast-mesher';
import type { LonLat, OsmArea, OsmBuilding, OsmDetail, OsmLine, OsmPoint, OsmTileData } from './osm-types';

/** the drawn roads (osm-mesher classifyLine), as an Overpass statement without its bbox */
export const ROAD_SELECTOR = 'way["highway"~"^((motorway|trunk|primary|secondary|tertiary)(_link)?|residential|unclassified|road|living_street|service|track|pedestrian|busway|raceway)$"]';
/**
 * A near tile also gets the drawn roads this far round it: how a road's ribbon starts or ends
 * (a fork's branches shifted onto the trunk over FORK_TAPER_M, a lane tapering over ROAD_TAPER_M,
 * a cap or a mitre) depends on every road at its end node, and the tiles either side of a border
 * must see the same ones there, or the ribbon steps at the seam. A road crossing a corner of the
 * tile with no node inside it comes along too.
 */
export const ROAD_REACH_M = 100;

/** a tile's bounds grown by ROAD_REACH_M */
export function roadReachBounds(b: TileBounds): TileBounds {
  const dLat = ROAD_REACH_M / 111320;
  const dLon = dLat / Math.max(0.1, Math.cos((((b.north + b.south) / 2) * Math.PI) / 180));
  return { west: b.west - dLon, south: b.south - dLat, east: b.east + dLon, north: b.north + dLat };
}

// Land cover comes from Landsat (terrain colours): of OSM areas only farmland, water, beach, scrub,
// bare rock, parks and airfield surfaces are filled; wood/forest is fetched only to plant trees,
// other landuse is not fetched.
const FULL_FILTER = `
  way["building"]; relation["building"]["type"="multipolygon"];
  way["building:part"]; relation["building:part"]["type"="multipolygon"];
  relation["type"="building"];
  ${ROAD_SELECTOR};
  way["railway"~"^(rail|narrow_gauge|light_rail)$"];
  way["aeroway"~"runway|taxiway|apron|helipad"]; node["aeroway"="helipad"];
  way["aeroway"="aerodrome"]; relation["aeroway"="aerodrome"];
  way["natural"~"water|wood|scrub|beach|bare_rock"]; relation["natural"="water"];
  way["landuse"="forest"]; relation["landuse"="forest"]; relation["natural"="wood"];
  way["waterway"~"^(river|riverbank|canal|stream|brook|ditch|drain)$"];
  way["natural"="coastline"];
  way["landuse"="farmland"]; relation["landuse"="farmland"];
  way["leisure"~"park|pitch|golf_course"];
  node["man_made"~"^(mast|antenna)$"]; node["man_made"="tower"]["tower:type"="communication"];
  way["man_made"~"^(mast|antenna)$"]; way["man_made"="tower"]["tower:type"="communication"];
  node["entrance"];
`;

const LARGE_FILTER = `
  way["natural"="water"]; relation["natural"="water"];
  way["landuse"="farmland"]; relation["landuse"="farmland"];
  way["waterway"="river"];
  way["aeroway"~"runway|aerodrome"]; relation["aeroway"="aerodrome"];
  way["highway"~"motorway|trunk"];
`;

/** Overpass filter statements for a detail level (also the client-side filter of the OSM API) */
export function osmFilter(detail: OsmDetail): string {
  return detail === 'full' ? FULL_FILTER : LARGE_FILTER;
}

/**
 * Aerodrome outlines are fetched from AERODROME_REACH_DEG around a near tile too: a tile inside a
 * large aerodrome, or beside one, must know it to put its terrain on the aerodrome's pad (see
 * aerodrome.ts) even when no outline vertex or edge lies in the tile itself.
 */
export const AERODROME_REACH_DEG = 0.05;

export function overpassQuery(tile: Tile, detail: OsmDetail): string {
  const b = tileBounds(tile);
  let filter = osmFilter(detail);
  if (detail === 'full') {
    const dLat = AERODROME_REACH_DEG;
    const dLon = AERODROME_REACH_DEG / Math.max(0.1, Math.cos((((b.north + b.south) / 2) * Math.PI) / 180));
    const wide = `(${b.south - dLat},${b.west - dLon},${b.north + dLat},${b.east + dLon})`;
    // an explicit bbox overrides the global one for its statement
    filter += `  way["aeroway"="aerodrome"]${wide}; relation["aeroway"="aerodrome"]${wide};\n`;
    const r = roadReachBounds(b);
    filter += `  ${ROAD_SELECTOR}(${r.south},${r.west},${r.north},${r.east});\n`;
  }
  return `[out:json][timeout:25][bbox:${b.south},${b.west},${b.north},${b.east}];(${filter});out body; >; out skel qt;`;
}

export interface RawNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
export interface RawWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}
export interface RawRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}
export type OverpassJson = { elements: (RawNode | RawWay | RawRelation)[] };

const AREA_KEYS = ['natural', 'landuse', 'leisure', 'aeroway', 'waterway', 'building'];

function isAreaTags(tags: Record<string, string>): boolean {
  if (tags.area === 'no') return false;
  // an island's coastline closes on itself, but it is a line: land on its left (see coast.ts)
  if (tags.natural === 'coastline') return false;
  return AREA_KEYS.some((k) => tags[k] !== undefined);
}

function isLineTags(tags: Record<string, string>): boolean {
  return tags.highway !== undefined || tags.railway !== undefined || tags.waterway !== undefined || tags.aeroway !== undefined ||
    tags.natural === 'coastline';
}

function hasBuildingTags(tags: Record<string, string>): boolean {
  return (tags.building !== undefined && tags.building !== 'no') || tags['building:part'] !== undefined;
}

function buildingVisible(tags: Record<string, string>): boolean {
  if (tags.location === 'underground' || tags.building === 'underground') return false;
  const layer = Number(tags.layer);
  if (Number.isFinite(layer) && layer < 0) return false;
  return true;
}

/** Join way segments into closed rings by matching endpoints. */
function assembleRings(segments: LonLat[][]): LonLat[][] {
  const rings: LonLat[][] = [];
  const open = segments.map((s) => s.slice());
  const same = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (open.length) {
    let ring = open.pop()!;
    let guard = 0;
    while (!same(ring[0], ring[ring.length - 1]) && guard++ < segments.length) {
      const head = ring[0];
      const tail = ring[ring.length - 1];
      const idx = open.findIndex((s) => same(s[0], tail) || same(s[s.length - 1], tail) || same(s[0], head) || same(s[s.length - 1], head));
      if (idx < 0) break;
      const seg = open.splice(idx, 1)[0];
      if (same(seg[0], tail)) ring = ring.concat(seg.slice(1));
      else if (same(seg[seg.length - 1], tail)) ring = ring.concat(seg.slice(0, -1).reverse());
      else if (same(seg[seg.length - 1], head)) ring = seg.slice(0, -1).concat(ring);
      else ring = seg.slice(1).reverse().concat(ring);
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}

export function parseOverpass(json: OverpassJson): OsmTileData {
  const nodes = new Map<number, LonLat>();
  const ways = new Map<number, RawWay>();
  const relations: RawRelation[] = [];
  const points: OsmPoint[] = [];
  for (const el of json.elements) {
    if (el.type === 'node') {
      nodes.set(el.id, [el.lon, el.lat]);
      if (el.tags && (el.tags.aeroway !== undefined || el.tags.man_made !== undefined || el.tags.entrance !== undefined)) {
        points.push({ at: [el.lon, el.lat], tags: el.tags });
      }
    } else if (el.type === 'way') ways.set(el.id, el);
    else relations.push(el);
  }
  const wayGeom = (w: RawWay): LonLat[] =>
    w.nodes.map((id) => nodes.get(id)).filter((p): p is LonLat => p !== undefined);

  const areas: OsmArea[] = [];
  const lines: OsmLine[] = [];
  const buildings: OsmBuilding[] = [];
  const usedWays = new Set<number>();

  const relById = new Map(relations.map((r) => [r.id, r]));
  const memberRings = (rel: RawRelation): { rings: LonLat[][][]; partWays: RawWay[]; partRelations: number; outlineTags?: Record<string, string> } => {
    const outer: LonLat[][] = [];
    const inner: LonLat[][] = [];
    const partWays: RawWay[] = [];
    let partRelations = 0;
    let outlineTags: Record<string, string> | undefined;
    for (const m of rel.members) {
      if (m.type === 'relation' && m.role === 'part' && relById.has(m.ref)) partRelations++;
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) continue;
      usedWays.add(w.id);
      if (m.role === 'part') partWays.push(w);
      else if (m.role === 'inner') inner.push(wayGeom(w));
      else {
        if (m.role === 'outline' && w.tags) outlineTags ??= w.tags;
        outer.push(wayGeom(w));
      }
    }
    const outers = assembleRings(outer);
    const inners = assembleRings(inner);
    const rings = outers.map((o) => [o, ...inners.filter((h) => pointInRing(h[0], o))]);
    return { rings, partWays, partRelations, outlineTags };
  };

  for (const rel of relations) {
    const tags = rel.tags ?? {};
    if (tags.type === 'building') {
      if (!buildingVisible(tags)) continue;
      const { rings, partWays, partRelations, outlineTags } = memberRings(rel);
      // S3DB: when parts exist, the outline itself is not drawn (part relations are drawn as multipolygons)
      for (const p of partWays) {
        const geom = wayGeom(p);
        if (geom.length > 3 && buildingVisible(p.tags ?? {})) buildings.push({ rings: [geom], tags: p.tags ?? {} });
      }
      if (!partWays.length && !partRelations) {
        // the heights and colours live on the outline way; the relation adds what the way lacks
        const outline = { ...tags, ...(outlineTags ?? {}) };
        delete outline.type;
        if (buildingVisible(outline)) for (const r of rings) buildings.push({ rings: r, tags: outline });
      }
      continue;
    }
    if (tags.type !== 'multipolygon' || !isAreaTags(tags) && tags['building:part'] === undefined) continue;
    const { rings } = memberRings(rel);
    if (hasBuildingTags(tags)) {
      if (buildingVisible(tags)) for (const r of rings) buildings.push({ rings: r, tags });
      continue;
    }
    for (const r of rings) areas.push({ rings: r, tags });
  }

  for (const w of ways.values()) {
    const tags = w.tags ?? {};
    const geom = wayGeom(w);
    if (geom.length < 2) continue;
    const closed = geom.length > 3 && geom[0][0] === geom[geom.length - 1][0] && geom[0][1] === geom[geom.length - 1][1];
    // a mast mapped by its footprint (often the guyed giants, e.g. the 442 m Balashikha mast) stands at its vertex mean
    if (!usedWays.has(w.id) && !hasBuildingTags(tags) && isAntenna(tags)) {
      const n = closed ? geom.length - 1 : geom.length;
      let lon = 0, lat = 0;
      for (let i = 0; i < n; i++) { lon += geom[i][0]; lat += geom[i][1]; }
      points.push({ at: [lon / n, lat / n], tags });
      continue;
    }
    if (closed && !usedWays.has(w.id)) {
      if (hasBuildingTags(tags)) {
        if (buildingVisible(tags)) buildings.push({ rings: [geom], tags });
        continue;
      }
      if (isAreaTags(tags)) {
        areas.push({ rings: [geom], tags });
        continue;
      }
    }
    if (isLineTags(tags)) lines.push({ points: geom, tags });
  }
  return { areas, lines, points, buildings: hideOutlinesWithParts(buildings) };
}

const isPart = (b: OsmBuilding) => b.tags['building:part'] !== undefined && b.tags['building:part'] !== 'no';

/**
 * S3DB: a building outline with building:part areas inside is drawn by its parts only. Parts of a
 * type=building relation are handled with the relation; this catches the far more common untied case,
 * where every part lying in the outline belongs to it. A part is in an outline when a point inside the
 * part (its vertex mean, or a vertex nudged toward it) lies in the outline.
 */
export function hideOutlinesWithParts(buildings: OsmBuilding[]): OsmBuilding[] {
  const parts = buildings.filter(isPart);
  if (!parts.length) return buildings;
  const CELL = 0.001;
  const grid = new Map<string, LonLat[]>();
  for (const p of parts) {
    const ring = p.rings[0];
    if (!ring?.length) continue;
    const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
    let lon = 0, lat = 0;
    for (let i = 0; i < n; i++) { lon += ring[i][0]; lat += ring[i][1]; }
    let probe: LonLat = [lon / n, lat / n];
    if (!pointInRing(probe, ring)) {
      // concave part: a vertex pulled a little toward the mean usually lands inside
      for (let i = 0; i < n; i++) {
        const q: LonLat = [ring[i][0] + (probe[0] - ring[i][0]) * 0.02, ring[i][1] + (probe[1] - ring[i][1]) * 0.02];
        if (pointInRing(q, ring)) { probe = q; break; }
      }
    }
    const key = `${Math.floor(probe[0] / CELL)},${Math.floor(probe[1] / CELL)}`;
    const list = grid.get(key);
    if (list) list.push(probe);
    else grid.set(key, [probe]);
  }
  return buildings.filter((b) => {
    if (isPart(b) || !b.rings[0]?.length) return true;
    const outer = b.rings[0];
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const [lo, la] of outer) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
    for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
      for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
        for (const p of grid.get(`${x},${y}`) ?? []) {
          if (pointInRing(p, outer) && !b.rings.slice(1).some((h) => pointInRing(p, h))) return false;
        }
      }
    }
    return true;
  });
}

function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}