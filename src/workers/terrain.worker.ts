import { RetryableError } from '../engine/queue';
import { SCHEMA_VERSION, getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildTerrainMesh } from '../world/terrain-mesher';
import { decodePngToHeights, fetchTerrariumPng } from '../world/terrain-source';
import { OSM_SCHEMA_VERSION } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import { flattenRunways } from '../world/runway';

export interface TileRequest {
  type: 'tile';
  id: number;
  tile: Tile;
  grid: number;
}

export interface MeshResponse {
  type: 'mesh';
  id: number;
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
}

export interface ErrorResponse {
  type: 'error';
  id: number;
  retryable: boolean;
  message: string;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<TileRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (e: MessageEvent<TileRequest>) => {
  const { id, tile, grid } = e.data;
  try {
    // Q40: when OSM is cached for this tile, build with runway flattening;
    // the '/o' suffix keeps pre-OSM and flattened meshes in separate cache slots
    const osmRaw = tile.z >= 12
      ? await getOsmRaw(tileKey('osm', tile, OSM_SCHEMA_VERSION)).catch(() => undefined)
      : undefined;
    const key = tileKey('dem', tile, SCHEMA_VERSION) + (osmRaw ? '/o' : '');
    const cached = await getCachedMesh(key);
    if (cached) {
      const res: MeshResponse = { type: 'mesh', id, vertices: cached.vertices, ramps: cached.ramps };
      ctx.postMessage(res, [res.vertices, res.ramps]);
      return;
    }
    const png = await fetchTerrariumPng(tile);
    const heights = await decodePngToHeights(png, grid);
    if (osmRaw) {
      try {
        flattenRunways(heights, tile, grid, parseOverpass(JSON.parse(osmRaw.json)).lines);
      } catch {
        // corrupt raw cache: fall back to unflattened relief
      }
    }
    const mesh = buildTerrainMesh({ tile, grid, heights });
    const vertices = mesh.vertices.slice().buffer;
    const ramps = mesh.ramps.slice().buffer;
    await putCachedMesh({ key, ts: Date.now(), vertices, ramps });
    const res: MeshResponse = { type: 'mesh', id, vertices, ramps };
    ctx.postMessage(res, [vertices, ramps]);
  } catch (err) {
    const res: ErrorResponse = {
      type: 'error',
      id,
      retryable: err instanceof RetryableError,
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(res);
  }
};