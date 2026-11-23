/**
 * The far OSM ring: z14 tiles between the detailed radius (DETAIL_RADIUS_M) and FAR_OSM_RADIUS_M,
 * over the coarse terrain, from OpenFreeMap vector tiles (OpenMapTiles schema) instead of Overpass.
 * Only what the detailed tiles show at that distance: buildings as wall + roof dots (and their
 * night lights), roads as 1 px lines. No meshes, no trees, no lamps.
 */
import { buildingDots, buildingNightLights } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, tileForLatLon, type LatLon, type Tile } from './geodesy';
import { decodeMvt, ringArea, type MvtLayer } from './mvt';
import type { LonLat, OsmBuilding } from './osm-types';
import { FAR_WINDOWS, rampIndex, RAMP } from '../engine/palette';
import type { HeightSampler } from './terrain-source';

/** OSM is drawn (as dots and lines) out to this slant distance; within DETAIL_RADIUS_M the detailed tiles take over */
export const FAR_OSM_RADIUS_M = 21000;
export const FAR_OSM_Z = 14;
/** bump when what a far tile is built from or into changes (cached far tiles are rebuilt) */
export const FAR_OSM_SCHEMA = 3;
/** far window dots here cover larger facade cells than on the detailed tiles (palette.ts FAR_WINDOWS) */
export const FAR_RING_CELL_M = FAR_WINDOWS.CELL_M * FAR_WINDOWS.FAR_RING_SCALE;

export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles';

/** OpenMapTiles road classes drawn far, as the near tiles draw highway=motorway…tertiary, residential, unclassified */
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);
/** the near far-lines' colour (osm-mesher ROAD_LINE_INDEX) */
const ROAD_LINE_INDEX = rampIndex(RAMP.ASPHALT, 8);
/** long road segments are split so the line follows the terrain between OSM nodes */
const ROAD_STEP_M = 150;

export interface FarOsmData {
  /** wall + roof pairs (buildingDots) */
  dots: Float32Array;
  /** night lights (buildingNightLights dots) */
  nightDots: Float32Array;
  /** GL line vertex pairs: x, y, z, palette index */
  roadLines: Float32Array;
}

/** tile units (0..extent, y down) → lon, lat */
function toLonLat(tile: Tile, extent: number): (p: [number, number]) => LonLat {
  const n = 2 ** tile.z;
  return ([px, py]) => {
    const x = (tile.x + px / extent) / n;
    const y = (tile.y + py / extent) / n;
    return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
  };
}

/**
 * OpenMapTiles buildings → OsmBuilding: one per exterior ring whose centroid lies in this tile
 * (a building across the border is in both tiles' data, clipped). Tags: `height` and `min_height`
 * from render_height / render_min_height, `building:colour` from colour. The outline of a building
 * drawn by its parts (hide_3d) is left out: the parts are there too.
 */
export function mvtBuildings(layer: MvtLayer | undefined, tile: Tile): OsmBuilding[] {
  if (!layer) return [];
  const ll = toLonLat(tile, layer.extent);
  const out: OsmBuilding[] = [];
  for (const f of layer.features) {
    if (f.type !== 3 || f.props.hide_3d === true) continue;
    const tags: Record<string, string> = { building: 'yes' };
    if (f.props.render_height !== undefined) tags.height = String(f.props.render_height);
    if (f.props.render_min_height) tags.min_height = String(f.props.render_min_height);
    if (typeof f.props.colour === 'string') tags['building:colour'] = f.props.colour;
    for (const ring of f.parts) {
      if (ring.length < 4 || ringArea(ring) <= 0) continue;
      let cx = 0, cy = 0;
      for (let i = 0; i < ring.length - 1; i++) { cx += ring[i][0]; cy += ring[i][1]; }
      cx /= ring.length - 1;
      cy /= ring.length - 1;
      if (cx < 0 || cy < 0 || cx >= layer.extent || cy >= layer.extent) continue;
      out.push({ rings: [ring.map(ll)], tags });
    }
  }
  return out;
}

/** OpenMapTiles roads of the drawn classes (no tunnels) as lon/lat polylines */
export function mvtRoads(layer: MvtLayer | undefined, tile: Tile): LonLat[][] {
  if (!layer) return [];
  const ll = toLonLat(tile, layer.extent);
  const out: LonLat[][] = [];
  for (const f of layer.features) {
    if (f.type !== 2 || !ROAD_CLASSES.has(String(f.props.class)) || f.props.brunnel === 'tunnel') continue;
    for (const line of f.parts) if (line.length >= 2) out.push(line.map(ll));
  }
  return out;
}

export function buildFarOsm(mvt: Uint8Array, tile: Tile, sampleHeight: HeightSampler): FarOsmData {
  const layers = decodeMvt(mvt, new Set(['building', 'transportation']));
  const buildings = mvtBuildings(layers.find((l) => l.name === 'building'), tile);
  const roads = mvtRoads(layers.find((l) => l.name === 'transportation'), tile);

  const center = tileCenter(tile);
  const lines: number[] = [];
  for (const road of roads) {
    let prev: [number, number, number] | undefined;
    for (let i = 0; i < road.length; i++) {
      const [lon, lat] = road[i];
      const [e, n] = latLonToEnu(center, lat, lon, 0);
      const cur: [number, number, number] = [e, 0, -n];
      if (prev) {
        const steps = Math.min(32, Math.max(1, Math.ceil(Math.hypot(cur[0] - prev[0], cur[2] - prev[2]) / ROAD_STEP_M)));
        const [plon, plat] = road[i - 1];
        let a = prev;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const slon = plon + (lon - plon) * t, slat = plat + (lat - plat) * t;
          const b: [number, number, number] = [prev[0] + (cur[0] - prev[0]) * t, Math.max(0, sampleHeight(slon, slat)), prev[2] + (cur[2] - prev[2]) * t];
          lines.push(a[0], a[1], a[2], ROAD_LINE_INDEX, b[0], b[1], b[2], ROAD_LINE_INDEX);
          a = b;
        }
        cur[1] = a[1];
      } else {
        cur[1] = Math.max(0, sampleHeight(lon, lat));
      }
      prev = cur;
    }
  }

  return {
    dots: buildingDots(buildings, tile, sampleHeight),
    nightDots: buildingNightLights(buildings, tile, sampleHeight, FAR_RING_CELL_M).dots,
    roadLines: new Float32Array(lines),
  };
}

let template: Promise<string> | undefined;

/** the z/x/y URL template of the current OpenFreeMap planet build (its TileJSON names it) */
export function openFreeMapTemplate(fetchImpl: typeof fetch = fetch): Promise<string> {
  template ??= fetchImpl(OPENFREEMAP_TILEJSON)
    .then((r) => {
      if (!r.ok) throw new Error(`openfreemap tilejson ${r.status}`);
      return r.json() as Promise<{ tiles?: string[] }>;
    })
    .then((j) => {
      const t = j.tiles?.[0];
      if (!t) throw new Error('openfreemap tilejson without tiles');
      return t;
    })
    .catch((err) => {
      template = undefined;
      throw err;
    });
  return template;
}

/**
 * The far ring's tiles: every z14 tile whose nearest point is within FAR_OSM_RADIUS_M slant
 * distance of the camera, except the detailed tiles (`detail`: their z/x/y keys), which draw their own OSM.
 */
export function farOsmTiles(cam: LatLon, alt: number, detail: ReadonlySet<string>): Tile[] {
  const r = Math.sqrt(Math.max(0, FAR_OSM_RADIUS_M ** 2 - alt ** 2));
  if (r === 0) return [];
  const dLat = r / 111320;
  const dLon = dLat / Math.max(0.2, Math.cos((cam.lat * Math.PI) / 180));
  const a = tileForLatLon(cam.lat + dLat, cam.lon - dLon, FAR_OSM_Z);
  const b = tileForLatLon(cam.lat - dLat, cam.lon + dLon, FAR_OSM_Z);
  const out: Tile[] = [];
  for (let y = a.y; y <= b.y; y++) {
    for (let x = a.x; x <= b.x; x++) {
      const t = { z: FAR_OSM_Z, x, y };
      if (detail.has(`${t.z}/${t.x}/${t.y}`)) continue;
      const bb = tileBounds(t);
      const [e, n] = latLonToEnu(cam, Math.max(bb.south, Math.min(bb.north, cam.lat)), Math.max(bb.west, Math.min(bb.east, cam.lon)), 0);
      if (Math.hypot(e, n, alt) < FAR_OSM_RADIUS_M) out.push(t);
    }
  }
  return out;
}
