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
import { applyPeaks, groundPeaks, peaksOf } from '../world/peaks';
import { fetchRoadSurface, type RoadSurface, type SurfaceTin } from '../world/surface-tin';
import { DETAIL_Z } from '../world/chunks';
import { buildGroundCover, type GroundCover } from '../world/ground-cover';
import { clipTileData } from '../world/clip';
import { tinLocator } from '../world/terrain-tin';
import { buildingCoverage, glowLevels } from '../world/night-glow';
import { isDefaultAreaStyles, type AreaStyles } from '../world/area-styles';
import { isNeutralGrade, NEUTRAL_GRADE, type ColourGrade } from '../world/landsat-process';
import { climateFaceColor } from '../world/climate-colour';

export interface TileRequest {
  type: 'tile';
  id: number;
  tile: Tile;
  grid: number;
  /** Landsat colour correction (relief inspector); a graded mesh is neither read from nor written to the cache */
  grade?: ColourGrade;
  /** the area filters (area styles editor); not the defaults: the mesh is neither read from nor written to the cache */
  areaStyles?: AreaStyles;
}

export interface MeshResponse {
  type: 'mesh';
  id: number;
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  morph?: ArrayBuffer;
  /** vertices drawn near (ground and skirts) and far (also the road, rail and runway faces); undefined: all */
  nearCount?: number;
  farCount?: number;
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
  const areaStyles = e.data.areaStyles;
  const useCache = isNeutralGrade(grade) && (!areaStyles || isDefaultAreaStyles(areaStyles));
  try {
    // Q40: when OSM is cached for this tile, build with the aerodromes on their pads;
    // the '/o' suffix keeps pre-OSM and flattened meshes in separate cache slots
    const osmRaw = tile.z >= 12
      ? await getOsmRaw(osmRawKey(tile)).catch(() => undefined)
      : undefined;
    // meshes flattened by our own tiles' aerodromes (M6) are kept apart from Overpass-flattened ones;
    // and a mesh is of the raw OSM that built it (its download time): once that has expired and was
    // fetched anew the OSM mesh is built from the new one, on a surface this mesh must share face for
    // face (a cached mesh of the old one left holes and overlaps along the roads and the water)
    const key = tileKey('dem', tile, SCHEMA_VERSION) + (osmRaw ? `${osmSourceMode() === 'pmtiles' ? '/op' : '/o'}@${osmRaw.ts}` : '');
    const cached = useCache ? await getCachedMesh(key) : undefined;
    if (cached) {
      const res: MeshResponse = { type: 'mesh', id, vertices: cached.vertices, ramps: cached.ramps, morph: cached.morph, nearCount: cached.nearCount, farCount: cached.farCount };
      ctx.postMessage(res, [res.vertices, res.ramps, ...(res.morph ? [res.morph] : [])]);
      return;
    }
    const dem = await loadTileDem(tile, grid);
    const { heights, borders } = dem;
    let coast: LonLat[][] | undefined;
    let pads: Pad[] = [];
    let roads: RoadSurface | undefined;
    let cover: GroundCover | undefined;
    let glow: ((tin: SurfaceTin) => Uint8Array) | undefined;
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
        // mapped summits up to their height (peaks.ts)
        applyPeaks(dem, tile, grid, await groundPeaks(peaksOf(data.points), tile.z));
        coast = coastlineWays(data.lines);
        // the roads with their heights (z14): the surface is built under them
        roads = await fetchRoadSurface(tile, data, pads);
        if (tile.z === DETAIL_Z) {
          // z14 with its OSM, roads or not: every ground cover in the surface, the faces coloured by their cover
          const raw = data;
          cover = buildGroundCover(tile, grid, raw, roads);
          glow = (tin) => glowLevels(buildingCoverage(tin, tile, clipTileData(raw, tile).buildings, tinLocator(tin, tile)));
        }
      }
    }
    // experimental: faces coloured by height × temperature at that height (climate-colour.ts), no imagery
    const mesh = buildTerrainMesh({
      tile, grid, heights, borders,
      faceColor: climateFaceColor(tile, grid, heights),
      coast,
      pads,
      roads,
      cover,
      areaStyles,
      glow,
    });
    const vertices = mesh.vertices.slice().buffer;
    const ramps = mesh.ramps.slice().buffer;
    const morph = mesh.morph?.slice().buffer;
    // without a cover the whole mesh is drawn at any distance, as ever
    const nearCount = cover ? mesh.nearCount : undefined;
    const farCount = cover ? mesh.farCount : undefined;
    if (useCache) await putCachedMesh({ key, ts: Date.now(), vertices, ramps, morph, nearCount, farCount });
    const res: MeshResponse = { type: 'mesh', id, vertices, ramps, morph, nearCount, farCount };
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