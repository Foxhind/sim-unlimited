import { RetryableError } from '../engine/queue';
import { tileBounds, tileForLatLon, type LatLon, type Tile } from './geodesy';
import type { OverpassJson } from './overpass';

/** what the minimap marks: settlements by size, airfields by kind */
export type MapFeatureKind = 'city' | 'town' | 'village' | 'airport' | 'airfield' | 'heliport';

export interface MapFeature {
  kind: MapFeatureKind;
  lat: number;
  lon: number;
  /** local name and its translations (name:ru, name:en, ...), as tagged */
  names: Record<string, string>;
  /** ICAO (or IATA, local) code of an airfield */
  code?: string;
}

/**
 * Two levels of detail: 'local' (z10 tiles, ~25–40 km) for the flight map — villages, every
 * aerodrome and heliport; 'region' (z7 tiles, ~200–300 km) for the start-screen map — cities and
 * towns, aerodromes with an ICAO code.
 */
export type MapLevel = 'local' | 'region';
export const MAP_LEVEL_ZOOM: Record<MapLevel, number> = { local: 10, region: 7 };
/** map spans up to this use the local level */
export const LOCAL_MAX_SPAN_M = 80000;

export function mapLevelForSpan(spanM: number): MapLevel {
  return spanM <= LOCAL_MAX_SPAN_M ? 'local' : 'region';
}

const FILTERS: Record<MapLevel, string> = {
  local: `node["place"~"^(city|town|village)$"]; nwr["aeroway"~"^(aerodrome|heliport)$"];`,
  region: `node["place"~"^(city|town)$"]; nwr["aeroway"="aerodrome"]["icao"];`,
};

/** bump when a filter changes (cached tiles lack what it newly selects) */
export const MAP_FEATURES_SCHEMA = 1;

export function mapFeatureQuery(tile: Tile, level: MapLevel): string {
  const b = tileBounds(tile);
  return `[out:json][timeout:25][bbox:${b.south},${b.west},${b.north},${b.east}];(${FILTERS[level]});out center tags;`;
}

type Element = { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

function airfieldKind(tags: Record<string, string>): MapFeatureKind {
  if (tags.aeroway === 'heliport') return 'heliport';
  // an airport: an ICAO code and an international/public/regional or military role
  const role = tags['aerodrome:type'] ?? tags.aerodrome ?? '';
  if (tags.icao && (tags.iata || /international|public|regional|military/.test(role))) return 'airport';
  return 'airfield';
}

/** Overpass `out center tags` JSON → map features (ways and relations at their centre) */
export function parseMapFeatures(json: OverpassJson): MapFeature[] {
  const out: MapFeature[] = [];
  for (const raw of json.elements as unknown as Element[]) {
    const tags = raw.tags ?? {};
    const lat = raw.lat ?? raw.center?.lat;
    const lon = raw.lon ?? raw.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) if (k === 'name' || k.startsWith('name:')) names[k] = v;
    let kind: MapFeatureKind | undefined;
    if (tags.aeroway === 'aerodrome' || tags.aeroway === 'heliport') kind = airfieldKind(tags);
    else if (tags.place === 'city' || tags.place === 'town' || tags.place === 'village') kind = tags.place;
    if (!kind) continue;
    const code = tags.icao || tags.iata || tags['local_ref'] || tags.ref;
    out.push({ kind, lat, lon, names, ...(code && kind !== 'city' && kind !== 'town' && kind !== 'village' ? { code } : {}) });
  }
  return out;
}

/** the label of a feature in the UI language: name:<lang>, then name:en, then the local name */
export function featureName(f: MapFeature, lang: string): string {
  const osmLang = lang === 'ua' ? 'uk' : lang;
  return f.names[`name:${osmLang}`] ?? f.names['name:en'] ?? f.names.name ?? '';
}

/** draw and label priority: lower first */
export const KIND_PRIORITY: Record<MapFeatureKind, number> = { city: 0, airport: 1, town: 2, airfield: 3, village: 4, heliport: 5 };

/** tiles of `level` covering a box around `center` */
export function featureTiles(center: LatLon, halfLat: number, halfLon: number, level: MapLevel): Tile[] {
  const z = MAP_LEVEL_ZOOM[level];
  const t0 = tileForLatLon(center.lat + halfLat, center.lon - halfLon, z);
  const t1 = tileForLatLon(center.lat - halfLat, center.lon + halfLon, z);
  const tiles: Tile[] = [];
  for (let x = t0.x; x <= t1.x; x++) for (let y = t0.y; y <= t1.y; y++) tiles.push({ z, x, y });
  return tiles;
}

export interface FeatureStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, json: string): Promise<void>;
}

/** after a failed fetch, a tile is not asked for again for this long */
const RETRY_MS = 30000;
/** a queued tile no map asked for in this long (flown past, map closed) is dropped */
const STALE_MS = 5000;

/**
 * Map features per tile: memory, then the IndexedDB cache, then Overpass, one request at a time
 * (the flight map asks for a handful of tiles; Overpass is shared with the scenery), the tile a map
 * asked for most recently first; tiles left behind are dropped. A failed tile is retried after RETRY_MS. `version` changes whenever a tile arrives, so maps know to redraw.
 */
export class MapFeatureSource {
  version = 0;
  private tiles = new Map<string, MapFeature[]>();
  private retryAt = new Map<string, number>();
  /** tiles waiting for a fetch, with when a map last asked for them */
  private queue = new Map<string, { tile: Tile; level: MapLevel; wanted: number }>();
  private busy = false;
  /** the time of the latest request (staleness is measured on the callers' clock) */
  private clock = 0;

  constructor(
    private readonly store: FeatureStore,
    private readonly fetchQuery: (query: string) => Promise<string>,
    private readonly maxTiles = 64,
  ) {}

  static key(tile: Tile, level: MapLevel): string {
    return `mapf/${level}/${tile.z}/${tile.x}/${tile.y}/${MAP_FEATURES_SCHEMA}`;
  }

  /** features of the tiles loaded so far (missing tiles are queued, not waited for) */
  features(tiles: Tile[], level: MapLevel, now = Date.now()): MapFeature[] {
    const out: MapFeature[] = [];
    this.clock = now;
    for (const tile of tiles) {
      const key = MapFeatureSource.key(tile, level);
      const hit = this.tiles.get(key);
      if (hit) {
        out.push(...hit);
        continue;
      }
      const queued = this.queue.get(key);
      if (queued) {
        queued.wanted = now;
        continue;
      }
      if ((this.retryAt.get(key) ?? 0) > now) continue;
      this.queue.set(key, { tile, level, wanted: now });
    }
    void this.pump();
    return out;
  }

  /** the most recently wanted queued tile; tiles no map asked for lately are dropped */
  private next(now: number): { key: string; tile: Tile; level: MapLevel } | undefined {
    let best: { key: string; tile: Tile; level: MapLevel; wanted: number } | undefined;
    for (const [key, q] of this.queue) {
      if (now - q.wanted > STALE_MS) {
        this.queue.delete(key);
        continue;
      }
      if (!best || q.wanted > best.wanted) best = { key, ...q };
    }
    if (best) this.queue.delete(best.key);
    return best;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.next(this.clock); job; job = this.next(this.clock)) {
        const { key, tile, level } = job;
        try {
          let json = await this.store.get(key).catch(() => undefined);
          if (json === undefined) {
            json = await this.fetchQuery(mapFeatureQuery(tile, level));
            await this.store.put(key, json).catch(() => undefined);
          }
          this.tiles.set(key, parseMapFeatures(JSON.parse(json) as OverpassJson));
          this.retryAt.delete(key);
          if (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value!);
          this.version++;
        } catch (err) {
          this.retryAt.set(key, Date.now() + (err instanceof RetryableError ? Math.max(err.retryMs, RETRY_MS) : RETRY_MS * 4));
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
