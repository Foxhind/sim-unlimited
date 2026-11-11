import { RetryableError } from '../engine/queue';
import { getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildOsmMesh } from '../world/osm-mesher';
import { buildProps } from '../world/props-mesher';
import { OsmSource, OSM_SCHEMA_VERSION } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import type { OsmDetail } from '../world/osm-types';
import { decodePngToSampler, decodePngToTile, fetchTerrariumPng } from '../world/terrain-source';
import { buildTerrainTin, tinSampler } from '../world/terrain-tin';
import { flattenRunways } from '../world/runway';
import { gridForZoom } from '../world/chunks';
import { loadLandsatTerrain } from '../world/landsat-process';

export const OSM_MESH_SCHEMA = 9;

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
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  runways: number;
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
const source = new OsmSource();

async function runwayCount(tile: Tile): Promise<number> {
  const raw = await getOsmRaw(`${tileKey('osm', tile, OSM_SCHEMA_VERSION)}/full`).catch(() => undefined);
  if (!raw) return 0;
  try {
    return parseOverpass(JSON.parse(raw.json)).lines.filter((l) => l.tags.aeroway === 'runway').length;
  } catch {
    return 0;
  }
}

ctx.onmessage = async (e: MessageEvent<OsmRequest>) => {
  const { id, tile, detail } = e.data;
  const key = `${tileKey('osmmesh', tile, OSM_MESH_SCHEMA)}/${detail}`;
  try {
    const cached = await getCachedMesh(key);
    if (cached) {
      const runways = detail === 'full' ? await runwayCount(tile) : 0;
      const trees = cached.trees ?? new ArrayBuffer(0);
      const lights = cached.lights ?? new ArrayBuffer(0);
      const res: OsmMeshResponse = { type: 'mesh', id, vertices: cached.vertices, ramps: cached.ramps, trees, lights, runways };
      ctx.postMessage(res, [res.vertices, res.ramps, trees, lights]);
      return;
    }
    const data = await source.fetch(tile, detail);
    const png = await fetchTerrariumPng(tile);
    const sampleHeight = await decodePngToSampler(png, tile);
    const grid = gridForZoom(tile.z);
    // Q40: one shared lattice surface (runway-flattened for 'full') → the same isoline TIN the terrain mesh renders
    const { heights: lattice, borders } = await decodePngToTile(png, grid);
    if (detail === 'full') flattenRunways(lattice, tile, grid, data.lines, sampleHeight);
    // the same TIN as the terrain mesh, Landsat colour boundaries included
    const ls = await loadLandsatTerrain(tile, grid);
    const drape = tinSampler(buildTerrainTin(tile, grid, lattice, { borders, colourLines: ls ? { lines: ls.lines, maxVerts: ls.maxVerts } : undefined }), tile);
    const mesh = buildOsmMesh({ tile, detail, data, sampleHeight: drape });
    const props = buildProps({ tile, detail, data, sampleHeight: drape });
    const vertices = mesh.vertices.slice().buffer;
    const ramps = mesh.ramps.slice().buffer;
    const trees = props.trees.slice().buffer;
    const lights = props.lights.slice().buffer;
    // without imagery the drape is the plain TIN: do not cache it (see terrain.worker)
    if (ls && (mesh.vertexCount > 0 || props.trees.length > 0 || props.lights.length > 0)) {
      await putCachedMesh({ key, ts: Date.now(), vertices, ramps, trees, lights });
    }
    const runways = data.lines.filter((l) => l.tags.aeroway === 'runway').length;
    const res: OsmMeshResponse = { type: 'mesh', id, vertices, ramps, trees, lights, runways };
    ctx.postMessage(res, [vertices, ramps, trees, lights]);
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