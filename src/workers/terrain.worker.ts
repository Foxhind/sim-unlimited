import { RetryableError } from '../engine/queue';
import { SCHEMA_VERSION, getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildTerrainMesh } from '../world/terrain-mesher';
import { loadTileDem } from '../world/terrain-source';
import { osmRawKey, osmSourceMode } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import { coastlineWays } from '../world/coast';
import type { LonLat } from '../world/osm-types';
import { applyPads, loadPads, type Pad } from '../world/aerodrome';
import { fetchRoadSurface, type RoadSurface } from '../world/surface-tin';
import { isNeutralGrade, NEUTRAL_GRADE, type ColourGrade } from '../world/landsat-process';
import { climateFaceColor } from '../world/climate-colour';

export interface TileRequest {
  type: 'tile';
  id: number;
  tile: Tile;
  grid: number;
  /** Landsat colour correction (relief inspector); a graded mesh is neither read from nor written to the cache */
  grade?: ColourGrade;
}

export interface MeshResponse {
  type: 'mesh';
  id: number;
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  morph?: ArrayBuffer;
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
  const grade = e.data.grade ?? NEUTRAL_GRADE;
  const useCache = isNeutralGrade(grade);
  try {
    // Q40: when OSM is cached for this tile, build with the aerodromes on their pads;
    // the '/o' suffix keeps pre-OSM and flattened meshes in separate cache slots
    const osmRaw = tile.z >= 12
      ? await getOsmRaw(osmRawKey(tile)).catch(() => undefined)
      : undefined;
    // meshes flattened by our own tiles' aerodromes (M6) are kept apart from Overpass-flattened ones
    const key = tileKey('dem', tile, SCHEMA_VERSION) + (osmRaw ? (osmSourceMode() === 'pmtiles' ? '/op' : '/o') : '');
    const cached = useCache ? await getCachedMesh(key) : undefined;
    if (cached) {
      const res: MeshResponse = { type: 'mesh', id, vertices: cached.vertices, ramps: cached.ramps, morph: cached.morph };
      ctx.postMessage(res, [res.vertices, res.ramps, ...(res.morph ? [res.morph] : [])]);
      return;
    }
    const dem = await loadTileDem(tile, grid);
    const { heights, borders } = dem;
    let coast: LonLat[][] | undefined;
    let pads: Pad[] = [];
    let roads: RoadSurface | undefined;
    if (osmRaw) {
      let data: ReturnType<typeof parseOverpass> | undefined;
      try {
        data = parseOverpass(JSON.parse(osmRaw.json));
      } catch {
        // corrupt raw cache: fall back to unflattened relief and the DEM's shoreline
      }
      if (data) {
        // aerodromes on their pads (a DEM outage fails the tile as retryable, like its own DEM)
        pads = await loadPads(data);
        applyPads(dem, tile, grid, pads);
        coast = coastlineWays(data.lines);
        // the roads with their heights (z14): the surface is built under them
        roads = await fetchRoadSurface(tile, data, pads);
      }
    }
    // experimental: faces coloured by height × temperature at that height (climate-colour.ts), no imagery
    const mesh = buildTerrainMesh({
      tile, grid, heights, borders,
      faceColor: climateFaceColor(tile, grid, heights),
      coast,
      pads,
      roads,
    });
    const vertices = mesh.vertices.slice().buffer;
    const ramps = mesh.ramps.slice().buffer;
    const morph = mesh.morph?.slice().buffer;
    if (useCache) await putCachedMesh({ key, ts: Date.now(), vertices, ramps, morph });
    const res: MeshResponse = { type: 'mesh', id, vertices, ramps, morph };
    ctx.postMessage(res, [vertices, ramps, ...(morph ? [morph] : [])]);
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