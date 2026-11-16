import { RetryableError } from '../engine/queue';
import { buildFarOsm, FAR_OSM_SCHEMA, openFreeMapTemplate } from '../world/far-osm';
import { tileKey, type Tile } from '../world/geodesy';
import { decodePngToSampler, fetchTerrariumPng } from '../world/terrain-source';
import { getCachedMesh, putCachedMesh } from '../world/tile-cache';

/**
 * Far OSM ring tiles (far-osm.ts): an OpenFreeMap z14 vector tile → building dots, their night
 * lights and road lines, at heights from the Terrarium DEM. Built tiles are cached like meshes.
 */

export interface FarOsmRequest {
  id: number;
  tile: Tile;
}

export interface FarOsmResponse {
  type: 'far';
  id: number;
  dots: ArrayBuffer;
  nightDots: ArrayBuffer;
  roadLines: ArrayBuffer;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<FarOsmRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;
/** the coarse terrain under the ring is z ≤ 13: heights from a z12 DEM tile (shared by 16 far tiles, cached) */
const DEM_Z = 12;

async function fetchMvt(tile: Tile): Promise<Uint8Array> {
  const url = (await openFreeMapTemplate()).replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new RetryableError(5000, `openfreemap unreachable: ${err instanceof Error ? err.message : err}`);
  }
  // no tile: nothing mapped there (sea, wilderness)
  if (res.status === 204 || res.status === 404) return new Uint8Array(0);
  if (res.status === 429 || res.status >= 500) throw new RetryableError(5000, `openfreemap ${res.status}`);
  if (!res.ok) throw new Error(`openfreemap fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

ctx.onmessage = async (e: MessageEvent<FarOsmRequest>) => {
  const { id, tile } = e.data;
  const key = tileKey('farosm', tile, FAR_OSM_SCHEMA);
  const send = (dots: ArrayBuffer, nightDots: ArrayBuffer, roadLines: ArrayBuffer) => {
    const res: FarOsmResponse = { type: 'far', id, dots, nightDots, roadLines };
    ctx.postMessage(res, [dots, nightDots, roadLines]);
  };
  try {
    const cached = await getCachedMesh(key).catch(() => undefined);
    if (cached) {
      send(cached.dots ?? new ArrayBuffer(0), cached.nightDots ?? new ArrayBuffer(0), cached.roadLines ?? new ArrayBuffer(0));
      return;
    }
    const k = 2 ** (tile.z - DEM_Z);
    const demTile = { z: DEM_Z, x: Math.floor(tile.x / k), y: Math.floor(tile.y / k) };
    const [mvt, png] = await Promise.all([fetchMvt(tile), fetchTerrariumPng(demTile)]);
    const sample = await decodePngToSampler(png, demTile);
    const data = buildFarOsm(mvt, tile, sample);
    const out = { dots: data.dots.slice().buffer, nightDots: data.nightDots.slice().buffer, roadLines: data.roadLines.slice().buffer };
    const empty = new ArrayBuffer(0);
    await putCachedMesh({ key, ts: Date.now(), vertices: empty, ramps: empty, ...out }).catch(() => {});
    send(out.dots, out.nightDots, out.roadLines);
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id,
      retryable: err instanceof RetryableError,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
