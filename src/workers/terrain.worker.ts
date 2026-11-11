import { RetryableError } from '../engine/queue';
import { SCHEMA_VERSION, getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildTerrainMesh } from '../world/terrain-mesher';
import { decodePngToSampler, decodePngToTile, fetchTerrariumPng } from '../world/terrain-source';
import { OSM_SCHEMA_VERSION } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import { flattenRunways } from '../world/runway';
import { loadLandsatTerrain } from '../world/landsat-process';

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
      ? await getOsmRaw(`${tileKey('osm', tile, OSM_SCHEMA_VERSION)}/full`).catch(() => undefined)
      : undefined;
    const key = tileKey('dem', tile, SCHEMA_VERSION) + (osmRaw ? '/o' : '');
    const cached = await getCachedMesh(key);
    if (cached) {
      const res: MeshResponse = { type: 'mesh', id, vertices: cached.vertices, ramps: cached.ramps };
      ctx.postMessage(res, [res.vertices, res.ramps]);
      return;
    }
    const png = await fetchTerrariumPng(tile);
    const { heights, borders } = await decodePngToTile(png, grid);
    if (osmRaw) {
      try {
        const lines = parseOverpass(JSON.parse(osmRaw.json)).lines;
        flattenRunways(heights, tile, grid, lines, await decodePngToSampler(png, tile));
      } catch {
        // corrupt raw cache: fall back to unflattened relief
      }
    }
    // Landsat: colour boundaries shape the TIN and faces take the imagery colour. A tile is shown
    // only with all its data: without imagery it fails as retryable and is requested again later.
    const ls = await loadLandsatTerrain(tile, grid);
    if (!ls) throw new RetryableError(5000, `landsat unavailable for ${tile.z}/${tile.x}/${tile.y}`);
    const mesh = buildTerrainMesh({
      tile, grid, heights, borders,
      faceColor: ls.faceColor,
      colourLines: { lines: ls.lines, maxVerts: ls.maxVerts },
    });
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