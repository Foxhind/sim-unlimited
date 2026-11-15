import { RetryableError } from '../engine/queue';
import { tileBounds, tileKey, type Tile } from './geodesy';
import { fetchOsmApiTile } from './osm-api';
import { getOsmRaw, putOsmRaw } from './tile-cache';
import { overpassQuery, parseOverpass, type OverpassJson } from './overpass';
import type { OsmDetail, OsmTileData, TileSource } from './osm-types';

/** bump when the filter changes: cached raw tiles lack what it newly selects (3: antenna masts) */
export const OSM_SCHEMA_VERSION = 4;

// Overpass rejects browser User-Agents (406) and fetch cannot override UA,
// so dev goes through a same-origin Vite proxy that injects a descriptive UA (Q42).
const ENDPOINT = import.meta.env.DEV ? '/overpass/api/interpreter' : 'https://overpass-api.de/api/interpreter';

/** which upstream serves OSM: Overpass, the OSM API 0.6, or Overpass with the API as fallback */
export type OsmSourceMode = 'auto' | 'overpass' | 'osm-api';
/** after Overpass fails as unreachable, go straight to the API for this long */
const OVERPASS_DOWN_MS = 60000;

async function fetchOverpass(tile: Tile, detail: OsmDetail): Promise<string> {
  return fetchOverpassQuery(overpassQuery(tile, detail));
}

/** one Overpass query; unreachable, 429 and 5xx fail as retryable */
export async function fetchOverpassQuery(query: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // network outage / timeout: retry later instead of killing the tile
    throw new RetryableError(5000, `overpass unreachable: ${err instanceof Error ? err.message : err}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(5000, `overpass ${res.status}`);
  }
  if (!res.ok) throw new Error(`overpass fetch failed: ${res.status}`);
  return res.text();
}

/** OSM API 0.6: near tiles only; far tiles get nothing (and are not cached, so Overpass can fill them later) */
async function fetchOsmApi(tile: Tile, detail: OsmDetail): Promise<string | null> {
  if (detail !== 'full') return null;
  return JSON.stringify(await fetchOsmApiTile(tileBounds(tile), detail));
}

const EMPTY: OsmTileData = { areas: [], lines: [], points: [], buildings: [] };

export function osmSourceMode(): OsmSourceMode {
  const v = (import.meta.env.VITE_OSM_SOURCE as string | undefined) ?? 'auto';
  return v === 'overpass' || v === 'osm-api' ? v : 'auto';
}

/**
 * Raw OSM per tile, cached in IndexedDB (Overpass-shaped JSON whichever upstream filled it).
 * 'auto': Overpass first; when it is unreachable (network error, 5xx, 429) use the OSM API 0.6
 * and keep using it for a minute before trying Overpass again.
 */
export class OsmSource implements TileSource {
  readonly name: string;
  private overpassDownUntil = 0;

  constructor(private readonly mode: OsmSourceMode = osmSourceMode()) {
    this.name = mode;
  }

  async fetch(tile: Tile, detail: OsmDetail): Promise<OsmTileData> {
    const key = `${tileKey('osm', tile, OSM_SCHEMA_VERSION)}/${detail}`;
    const cached = await getOsmRaw(key);
    if (cached) return parseOverpass(JSON.parse(cached.json) as OverpassJson);
    const json = await this.fetchJson(tile, detail);
    if (json === null) return EMPTY;
    await putOsmRaw({ key, ts: Date.now(), json });
    return parseOverpass(JSON.parse(json) as OverpassJson);
  }

  private async fetchJson(tile: Tile, detail: OsmDetail): Promise<string | null> {
    if (this.mode === 'osm-api') return fetchOsmApi(tile, detail);
    if (this.mode === 'overpass') return fetchOverpass(tile, detail);
    if (Date.now() >= this.overpassDownUntil) {
      try {
        return await fetchOverpass(tile, detail);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        this.overpassDownUntil = Date.now() + OVERPASS_DOWN_MS;
        console.warn(`[osm] ${err.message}; using the OSM API 0.6 for ${OVERPASS_DOWN_MS / 1000} s`);
      }
    }
    return fetchOsmApi(tile, detail);
  }
}
