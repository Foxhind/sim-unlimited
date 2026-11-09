import { tileBounds, type Tile } from './geodesy';
import type { LonLat, OsmArea, OsmBuilding, OsmDetail, OsmLine, OsmPoint, OsmTileData } from './osm-types';

const FULL_FILTER = `
  way["building"]; relation["building"]["type"="multipolygon"];
  way["building:part"]; relation["building:part"]["type"="multipolygon"];
  relation["type"="building"];
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified"];
  way["railway"="rail"];
  way["aeroway"~"runway|taxiway|apron|helipad"]; node["aeroway"="helipad"];
  way["natural"~"water|wood|scrub|beach|bare_rock"]; relation["natural"="water"];
  way["waterway"~"river|riverbank|canal"];
  way["landuse"]; relation["landuse"];
  way["leisure"~"park|pitch|golf_course"];
`;

const LARGE_FILTER = `
  way["natural"~"water|wood"]; relation["natural"~"water|wood"];
  way["landuse"~"forest|farmland|meadow|grass|residential|industrial"]; relation["landuse"~"forest|farmland|meadow|grass|residential|industrial"];
  way["waterway"="river"];
  way["aeroway"~"runway|aerodrome"]; relation["aeroway"="aerodrome"];
  way["highway"~"motorway|trunk"];
`;

export function overpassQuery(tile: Tile, detail: OsmDetail): string {
  const b = tileBounds(tile);
  const filter = detail === 'full' ? FULL_FILTER : LARGE_FILTER;
  return `[out:json][timeout:25][bbox:${b.south},${b.west},${b.north},${b.east}];(${filter});out body; >; out skel qt;`;
}

interface RawNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
interface RawWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}
interface RawRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}
export type OverpassJson = { elements: (RawNode | RawWay | RawRelation)[] };

const AREA_KEYS = ['natural', 'landuse', 'leisure', 'aeroway', 'waterway', 'building'];

function isAreaTags(tags: Record<string, string>): boolean {
  if (tags.area === 'no') return false;
  return AREA_KEYS.some((k) => tags[k] !== undefined);
}

function isLineTags(tags: Record<string, string>): boolean {
  return tags.highway !== undefined || tags.railway !== undefined || tags.waterway !== undefined || tags.aeroway !== undefined;
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
      if (el.tags && (el.tags.aeroway !== undefined || el.tags.man_made !== undefined)) {
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

  const memberRings = (rel: RawRelation): { rings: LonLat[][][]; partWays: RawWay[] } => {
    const outer: LonLat[][] = [];
    const inner: LonLat[][] = [];
    const partWays: RawWay[] = [];
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) continue;
      usedWays.add(w.id);
      if (m.role === 'part') partWays.push(w);
      else if (m.role === 'inner') inner.push(wayGeom(w));
      else outer.push(wayGeom(w));
    }
    const outers = assembleRings(outer);
    const inners = assembleRings(inner);
    const rings = outers.map((o) => [o, ...inners.filter((h) => pointInRing(h[0], o))]);
    return { rings, partWays };
  };

  for (const rel of relations) {
    const tags = rel.tags ?? {};
    if (tags.type === 'building') {
      if (!buildingVisible(tags)) continue;
      const { rings, partWays } = memberRings(rel);
      if (partWays.length) {
        // S3DB: when parts exist, the outline itself is not drawn
        for (const p of partWays) {
          const geom = wayGeom(p);
          if (geom.length > 3 && buildingVisible(p.tags ?? {})) buildings.push({ rings: [geom], tags: p.tags ?? {} });
        }
      } else {
        for (const r of rings) buildings.push({ rings: r, tags });
      }
      continue;
    }
    if (tags.type !== 'multipolygon' || !isAreaTags(tags)) continue;
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
  return { areas, lines, points, buildings };
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