import { RetryableError } from '../engine/queue';
import { tileKey, type Tile } from './geodesy';
import { getOsmRaw, putOsmRaw } from './tile-cache';
import { overpassQuery, parseOverpass, type OverpassJson } from './overpass';
import type { OsmDetail, OsmTileData, TileSource } from './osm-types';

export const OSM_SCHEMA_VERSION = 2;

// Overpass rejects browser User-Agents (406) and fetch cannot override UA,
// so dev goes through a same-origin Vite proxy that injects a descriptive UA (Q42).
const ENDPOINT = import.meta.env.DEV ? '/overpass/api/interpreter' : 'https://overpass-api.de/api/interpreter';

export class OverpassSource implements TileSource {
  readonly name = 'overpass';

  async fetch(tile: Tile, detail: OsmDetail): Promise<OsmTileData> {
    const key = `${tileKey('osm', tile, OSM_SCHEMA_VERSION)}/${detail}`;
    const cached = await getOsmRaw(key);
    if (cached) return parseOverpass(JSON.parse(cached.json) as OverpassJson);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: overpassQuery(tile, detail) }),
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
    const json = await res.text();
    await putOsmRaw({ key, ts: Date.now(), json });
    return parseOverpass(JSON.parse(json) as OverpassJson);
  }
}