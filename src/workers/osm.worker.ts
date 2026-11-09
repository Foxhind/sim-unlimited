import { RetryableError } from '../engine/queue';
import { getCachedMesh, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildOsmMesh } from '../world/osm-mesher';
import { OverpassSource } from '../world/osm-source';
import type { OsmDetail } from '../world/osm-types';
import { decodePngToSampler, fetchTerrariumPng } from '../world/terrain-source';

export const OSM_MESH_SCHEMA = 2;

export interface OsmRequest {
  type: 'osm';
  id: number;
  tile: Tile;
  detail: OsmDetail;
}

export interface OsmMeshResponse {
  type: 'mesh';
  id: number;
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
}

export interface OsmErrorResponse {
  type: 'error';
  id: number;
  retryable: boolean;
  message: string;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<OsmRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;
const source = new OverpassSource();

ctx.onmessage = async (e: MessageEvent<OsmRequest>) => {
  const { id, tile, detail } = e.data;
  const key = `${tileKey('osmmesh', tile, OSM_MESH_SCHEMA)}/${detail}`;
  try {
    const cached = await getCachedMesh(key);
    if (cached) {
      const res: OsmMeshResponse = { type: 'mesh', id, vertices: cached.vertices, ramps: cached.ramps };
      ctx.postMessage(res, [res.vertices, res.ramps]);
      return;
    }
    const data = await source.fetch(tile, detail);
    const png = await fetchTerrariumPng(tile);
    const sampleHeight = await decodePngToSampler(png, tile);
    const mesh = buildOsmMesh({ tile, detail, data, sampleHeight });
    const vertices = mesh.vertices.slice().buffer;
    const ramps = mesh.ramps.slice().buffer;
    if (mesh.vertexCount > 0) await putCachedMesh({ key, ts: Date.now(), vertices, ramps });
    const res: OsmMeshResponse = { type: 'mesh', id, vertices, ramps };
    ctx.postMessage(res, [vertices, ramps]);
  } catch (err) {
    const res: OsmErrorResponse = {
      type: 'error',
      id,
      retryable: err instanceof RetryableError,
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(res);
  }
};