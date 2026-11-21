import { RetryableError } from '../engine/queue';
import { SCHEMA_VERSION, getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildOsmMesh } from '../world/osm-mesher';
import { buildBuildingMesh, buildingDots, buildingNightLights, WINDOW_ATTR_FLOATS } from '../world/building-mesher';
import { buildMasts } from '../world/mast-mesher';
import { clipTileData } from '../world/clip';
import { buildProps } from '../world/props-mesher';
import { OsmSource, osmRawKey, osmSourceMode } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import type { OsmDetail, OsmTileData } from '../world/osm-types';
import { loadTileDem } from '../world/terrain-source';
import { buildTerrainTin, COAST_LEVEL, tinLocator, tinSampler } from '../world/terrain-tin';
import { greenColour, isMaterial, RAMP } from '../engine/palette';
import { applyPads, loadPads, padSources } from '../world/aerodrome';
import { gridForZoom } from '../world/chunks';
import { isNeutralGrade, NEUTRAL_GRADE, type ColourGrade } from '../world/landsat-process';
import { climateFaceColor } from '../world/climate-colour';
import { buildGlowGround } from '../world/terrain-mesher';
import { coastlineWays } from '../world/coast';
import { isDefaultAreaStyles, type AreaStyles } from '../world/area-styles';
import { applyGlow, applyGlowToTrees, buildingCoverage, glowLevels } from '../world/night-glow';

export const OSM_MESH_SCHEMA = 56;

export interface OsmRequest {
  type: 'osm';
  id: number;
  tile: Tile;
  detail: OsmDetail;
  /** Landsat colour correction (relief inspector); a graded mesh is neither read from nor written to the cache */
  grade?: ColourGrade;
  /** filters of the areas over the imagery (area style editor); not the defaults: the mesh is neither read from nor written to the cache */
  areaStyles?: AreaStyles;
}

export interface OsmMeshResponse {
  type: 'mesh';
  id: number;
  /** drape: areas, roads, points */
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  /** buildings (near), their facade window attributes (building-mesher BuildingMeshData.windows) and their dots (far: x, y, z, palette index) */
  bVertices: ArrayBuffer;
  bRamps: ArrayBuffer;
  bWindows: ArrayBuffer;
  /** the first bCore building vertices: the buildings without their small parts (the far LOD) */
  bCore: number;
  dots: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  /** night: roof obstruction lights (near; lit windows are on the walls), building lights (far), mast beacons (any distance) */
  roofLights: ArrayBuffer;
  nightDots: ArrayBuffer;
  beacons: ArrayBuffer;
  /** far stand-in for masts: GL line vertex pairs (x, y, z, palette index) */
  mastLines: ArrayBuffer;
  /** night: street-lit copy of the built-up terrain faces (pos+normal, Uint32 face colours with glow level) */
  glowVertices: ArrayBuffer;
  glowRamps: ArrayBuffer;
  /** road ribbons (near, pos+normal with Uint32 face colours) and their far 1 px GL lines (x, y, z, palette index) */
  rVertices: ArrayBuffer;
  rRamps: ArrayBuffer;
  /** per road vertex WINDOW_ATTR_FLOATS: the railway track's u, v (osm-mesher roadAttrs) */
  rAttrs: ArrayBuffer;
  /** water areas and river ribbons (pos+normal with Uint32 face colours), drawn without depth writes */
  wVertices: ArrayBuffer;
  wRamps: ArrayBuffer;
  roadLines: ArrayBuffer;
  /** pitch markings: near 1 px GL lines (x, y, z, palette index) */
  pitchLines: ArrayBuffer;
  /** night: lamp heads (x, y, z, palette index); far, the street-lit roads' dotted line */
  lamps: ArrayBuffer;
  runways: number;
  /**
   * The tile's OSM, just downloaded, decides its shore (a coastline, or DEM sea without one): its
   * terrain was built without it and is rebuilt (TinOptions.coast). From the cache it is false: the raw OSM was there when the
   * terrain worker built the tile, so the terrain already has the coastline.
   */
  coast: boolean;
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

/**
 * What in a tile's OSM reshapes its terrain: runways (flattened) and the shore — a coastline, or
 * DEM sea in a tile without one (it becomes all land or all sea; see TinOptions.coast).
 */
/** `runways`: aerodromes and runways — what puts terrain on a pad (see aerodrome.ts) */
function terrainFlags(data: Pick<OsmTileData, 'areas' | 'lines'>, lattice?: Float32Array): { runways: number; coast: boolean } {
  const demSea = lattice ? lattice.some((h) => h < COAST_LEVEL) : false;
  return { runways: padSources(data).length, coast: coastlineWays(data.lines).length > 0 || demSea };
}

async function cachedTerrainFlags(tile: Tile): Promise<{ runways: number; coast: boolean }> {
  const raw = await getOsmRaw(osmRawKey(tile)).catch(() => undefined);
  if (!raw) return { runways: 0, coast: false };
  try {
    return { runways: terrainFlags(parseOverpass(JSON.parse(raw.json))).runways, coast: false };
  } catch {
    return { runways: 0, coast: false };
  }
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function concatU32(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

ctx.onmessage = async (e: MessageEvent<OsmRequest>) => {
  const { id, tile, detail } = e.data;
  const grade = e.data.grade ?? NEUTRAL_GRADE;
  const areaStyles = e.data.areaStyles;
  const useCache = isNeutralGrade(grade) && (!areaStyles || isDefaultAreaStyles(areaStyles));
  // draped on the terrain TIN: a cached mesh is only valid for the terrain version it was built on
  const key = `${tileKey(osmSourceMode() === 'pmtiles' ? 'osmmesh-pm' : 'osmmesh', tile, OSM_MESH_SCHEMA)}/t${SCHEMA_VERSION}/${detail}`;
  const send = (m: Omit<OsmMeshResponse, 'type' | 'id'>) => {
    const res: OsmMeshResponse = { type: 'mesh', id, ...m };
    ctx.postMessage(res, [
      res.vertices, res.ramps, res.bVertices, res.bRamps, res.bWindows, res.dots, res.trees, res.lights,
      res.roofLights, res.nightDots, res.beacons, res.mastLines, res.glowVertices, res.glowRamps,
      res.rVertices, res.rRamps, res.rAttrs, res.wVertices, res.wRamps, res.roadLines, res.pitchLines, res.lamps,
    ]);
  };
  const empty = () => new ArrayBuffer(0);
  try {
    const cached = useCache ? await getCachedMesh(key) : undefined;
    if (cached) {
      send({
        vertices: cached.vertices, ramps: cached.ramps,
        bVertices: cached.bVertices ?? empty(), bRamps: cached.bRamps ?? empty(), bWindows: cached.bWindows ?? empty(),
        bCore: cached.bCore ?? (cached.bRamps?.byteLength ?? 0) / 4,
        dots: cached.dots ?? empty(),
        trees: cached.trees ?? empty(), lights: cached.lights ?? empty(),
        roofLights: cached.roofLights ?? empty(), nightDots: cached.nightDots ?? empty(),
        beacons: cached.beacons ?? empty(), mastLines: cached.mastLines ?? empty(),
        glowVertices: cached.glowVertices ?? empty(), glowRamps: cached.glowRamps ?? empty(),
        rVertices: cached.rVertices ?? empty(), rRamps: cached.rRamps ?? empty(), rAttrs: cached.rAttrs ?? empty(), roadLines: cached.roadLines ?? empty(), pitchLines: cached.pitchLines ?? empty(),
        wVertices: cached.wVertices ?? empty(), wRamps: cached.wRamps ?? empty(),
        lamps: cached.lamps ?? empty(),
        ...(detail === 'full' ? await cachedTerrainFlags(tile) : { runways: 0, coast: false }),
      });
      return;
    }
    const data = await source.fetch(tile, detail);
    const grid = gridForZoom(tile.z);
    // Q40: one shared lattice surface (aerodromes on their pads for 'full') → the same isoline TIN the terrain mesh renders
    const dem = await loadTileDem(tile, grid);
    const { heights: lattice, borders } = dem;
    const pads = detail === 'full' ? await loadPads(data) : [];
    applyPads(dem, tile, grid, pads);
    // the same face colours as the terrain mesh (height × temperature, climate-colour.ts)
    const ls = { faceColor: climateFaceColor(tile, grid, lattice) };
    // the same TIN as the terrain worker builds from the same OSM: coastline included
    const tin = buildTerrainTin(tile, grid, lattice, { borders, coast: coastlineWays(data.lines), pads });
    const drape = tinSampler(tin, tile);
    // foliage: the colour of the land face under the tree, pulled to the nearest green land colour
    const locate = tinLocator(tin, tile);
    const treeRamp = (lon: number, lat: number) => {
      const r = locate(lon, lat);
      if (!r) return RAMP.FOREST;
      const t = tin.tris[r.tri];
      const ramp = ls.faceColor(tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]);
      return isMaterial(ramp) ? RAMP.FOREST : greenColour(ramp);
    };
    const mesh = buildOsmMesh({ tile, detail, data, sampleHeight: drape, tin, buildings: false, faceColor: ls.faceColor, areaStyles });
    const clipped = clipTileData(data, tile);
    const own = clipped.buildings;
    // entrances from the whole fetch, not only the tile's own share: one by the border may belong to an own building
    const houses = buildBuildingMesh({ tile, buildings: own, sampleHeight: drape, points: data.points });
    // antenna trusses are drawn with the buildings (near), as lines far away
    const masts = buildMasts(clipped.points, tile, drape);
    const bmesh = {
      vertices: concatF32(houses.vertices, masts.vertices),
      ramps: concatU32(houses.ramps, masts.ramps),
      // masts have no windows
      windows: concatF32(houses.windows, new Float32Array(masts.ramps.length * WINDOW_ATTR_FLOATS)),
    };
    const dotData = buildingDots(own, tile, drape);
    // no far window dots: the detailed tiles draw their lit facades at any distance at night
    const night = buildingNightLights(own, tile, drape, 0);
    const props = buildProps({ tile, detail, data, sampleHeight: drape, treeRamp });
    // night glow: each terrain triangle lit by how densely it is built up, and everything on it too
    const levels = glowLevels(buildingCoverage(tin, tile, own, locate));
    const glow = buildGlowGround(tile, tin, levels, ls.faceColor);
    applyGlow(mesh.vertices, mesh.ramps, tile, locate, levels);
    applyGlow(mesh.roads.vertices, mesh.roads.ramps, tile, locate, levels);
    applyGlow(mesh.water.vertices, mesh.water.ramps, tile, locate, levels);
    applyGlow(bmesh.vertices, bmesh.ramps, tile, locate, levels);
    const instances = concatF32(concatF32(props.trees, houses.acs), mesh.lampPosts);
    applyGlowToTrees(instances, tile, locate, levels);
    const out = {
      vertices: mesh.vertices.slice().buffer, ramps: mesh.ramps.slice().buffer,
      bVertices: bmesh.vertices.slice().buffer, bRamps: bmesh.ramps.slice().buffer, bWindows: bmesh.windows.slice().buffer,
      // the masts come after the houses: small parts too
      bCore: houses.coreVertexCount,
      dots: dotData.slice().buffer,
      // instances sorted by type: trees, then air conditioners, then lamp posts (props-mesher INSTANCE)
      trees: instances.buffer as ArrayBuffer, lights: props.lights.slice().buffer,
      roofLights: night.roofLights.slice().buffer, nightDots: night.dots.slice().buffer,
      beacons: masts.beacons.slice().buffer, mastLines: masts.lines.slice().buffer,
      glowVertices: glow.vertices.slice().buffer, glowRamps: glow.ramps.slice().buffer,
      rVertices: mesh.roads.vertices.slice().buffer, rRamps: mesh.roads.ramps.slice().buffer, rAttrs: mesh.roadAttrs.slice().buffer,
      wVertices: mesh.water.vertices.slice().buffer, wRamps: mesh.water.ramps.slice().buffer,
      roadLines: mesh.roadLines.slice().buffer,
      pitchLines: mesh.pitchLines.slice().buffer,
      lamps: mesh.lamps.slice().buffer,
    };
    if (useCache) await putCachedMesh({ key, ts: Date.now(), ...out });
    send({ ...out, ...(detail === 'full' ? terrainFlags(data, lattice) : { runways: 0, coast: false }) });
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