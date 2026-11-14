import { RetryableError } from '../engine/queue';
import { SCHEMA_VERSION, getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildOsmMesh } from '../world/osm-mesher';
import { buildBuildingMesh, buildingDots, buildingNightLights } from '../world/building-mesher';
import { buildMasts } from '../world/mast-mesher';
import { clipTileData } from '../world/clip';
import { buildProps } from '../world/props-mesher';
import { OsmSource, OSM_SCHEMA_VERSION } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import type { OsmDetail } from '../world/osm-types';
import { decodePngToSampler, loadTileDem, fetchTerrariumPng } from '../world/terrain-source';
import { buildTerrainTin, tinLocator, tinSampler } from '../world/terrain-tin';
import { greenVga, RAMP, TERRAIN_RAMP_BASE } from '../engine/palette';
import { flattenRunways } from '../world/runway';
import { gridForZoom } from '../world/chunks';
import { isNeutralGrade, loadLandsatTerrain, NEUTRAL_GRADE, type ColourGrade } from '../world/landsat-process';
import { buildGlowGround } from '../world/terrain-mesher';
import { applyGlow, applyGlowToTrees, buildingCoverage, glowLevels } from '../world/night-glow';

export const OSM_MESH_SCHEMA = 16;

export interface OsmRequest {
  type: 'osm';
  id: number;
  tile: Tile;
  detail: OsmDetail;
  /** Landsat colour correction (relief inspector); a graded mesh is neither read from nor written to the cache */
  grade?: ColourGrade;
}

export interface OsmMeshResponse {
  type: 'mesh';
  id: number;
  /** drape: areas, roads, points */
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  /** buildings (near) and their dots (far: x, y, z, palette index) */
  bVertices: ArrayBuffer;
  bRamps: ArrayBuffer;
  dots: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  /** night: lit windows and roof obstruction lights (near), building lights (far), mast beacons (any distance) */
  windows: ArrayBuffer;
  nightDots: ArrayBuffer;
  beacons: ArrayBuffer;
  /** far stand-in for masts: GL line vertex pairs (x, y, z, palette index) */
  mastLines: ArrayBuffer;
  /** night: street-lit copy of the built-up terrain faces (pos+normal, Uint16 ramps with glow level) */
  glowVertices: ArrayBuffer;
  glowRamps: ArrayBuffer;
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

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function concatU16(a: Uint16Array, b: Uint16Array): Uint16Array {
  const out = new Uint16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

ctx.onmessage = async (e: MessageEvent<OsmRequest>) => {
  const { id, tile, detail } = e.data;
  const grade = e.data.grade ?? NEUTRAL_GRADE;
  const useCache = isNeutralGrade(grade);
  // draped on the terrain TIN: a cached mesh is only valid for the terrain version it was built on
  const key = `${tileKey('osmmesh', tile, OSM_MESH_SCHEMA)}/t${SCHEMA_VERSION}/${detail}`;
  const send = (m: Omit<OsmMeshResponse, 'type' | 'id'>) => {
    const res: OsmMeshResponse = { type: 'mesh', id, ...m };
    ctx.postMessage(res, [
      res.vertices, res.ramps, res.bVertices, res.bRamps, res.dots, res.trees, res.lights,
      res.windows, res.nightDots, res.beacons, res.mastLines, res.glowVertices, res.glowRamps,
    ]);
  };
  const empty = () => new ArrayBuffer(0);
  try {
    const cached = useCache ? await getCachedMesh(key) : undefined;
    if (cached) {
      send({
        vertices: cached.vertices, ramps: cached.ramps,
        bVertices: cached.bVertices ?? empty(), bRamps: cached.bRamps ?? empty(), dots: cached.dots ?? empty(),
        trees: cached.trees ?? empty(), lights: cached.lights ?? empty(),
        windows: cached.windows ?? empty(), nightDots: cached.nightDots ?? empty(),
        beacons: cached.beacons ?? empty(), mastLines: cached.mastLines ?? empty(),
        glowVertices: cached.glowVertices ?? empty(), glowRamps: cached.glowRamps ?? empty(),
        runways: detail === 'full' ? await runwayCount(tile) : 0,
      });
      return;
    }
    const data = await source.fetch(tile, detail);
    const png = await fetchTerrariumPng(tile);
    const sampleHeight = await decodePngToSampler(png, tile);
    const grid = gridForZoom(tile.z);
    // Q40: one shared lattice surface (runway-flattened for 'full') → the same isoline TIN the terrain mesh renders
    const { heights: lattice, borders } = await loadTileDem(tile, grid);
    if (detail === 'full') flattenRunways(lattice, tile, grid, data.lines, sampleHeight);
    // the same TIN as the terrain mesh, Landsat colour boundaries included; a tile is shown only
    // with all its data, so without imagery fail as retryable like the terrain worker
    const ls = await loadLandsatTerrain(tile, grid, grade);
    if (!ls) throw new RetryableError(5000, `landsat unavailable for ${tile.z}/${tile.x}/${tile.y}`);
    const tin = buildTerrainTin(tile, grid, lattice, { borders, colourLines: { lines: ls.lines, maxVerts: ls.maxVerts } });
    const drape = tinSampler(tin, tile);
    // foliage: the colour of the land face under the tree, pulled to the nearest green VGA colour
    const locate = tinLocator(tin, tile);
    const treeRamp = (lon: number, lat: number) => {
      const r = locate(lon, lat);
      if (!r) return RAMP.FOREST;
      const t = tin.tris[r.tri];
      const ramp = ls.faceColor(tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]);
      return ramp >= TERRAIN_RAMP_BASE ? TERRAIN_RAMP_BASE + greenVga(ramp - TERRAIN_RAMP_BASE) : RAMP.FOREST;
    };
    const mesh = buildOsmMesh({ tile, detail, data, sampleHeight: drape, tin, buildings: false });
    const clipped = clipTileData(data, tile);
    const own = clipped.buildings;
    const houses = buildBuildingMesh({ tile, buildings: own, sampleHeight: drape });
    // antenna trusses are drawn with the buildings (near), as lines far away
    const masts = buildMasts(clipped.points, tile, drape);
    const bmesh = {
      vertices: concatF32(houses.vertices, masts.vertices),
      ramps: concatU16(houses.ramps, masts.ramps),
    };
    const dotData = buildingDots(own, tile, drape);
    const night = buildingNightLights(own, tile, drape);
    const props = buildProps({ tile, detail, data, sampleHeight: drape, treeRamp });
    // night glow: each terrain triangle lit by how densely it is built up, and everything on it too
    const levels = glowLevels(buildingCoverage(tin, tile, own, locate));
    const glow = buildGlowGround(tile, tin, levels, ls.faceColor);
    applyGlow(mesh.vertices, mesh.ramps, tile, locate, levels);
    applyGlow(bmesh.vertices, bmesh.ramps, tile, locate, levels);
    applyGlowToTrees(props.trees, tile, locate, levels);
    const out = {
      vertices: mesh.vertices.slice().buffer, ramps: mesh.ramps.slice().buffer,
      bVertices: bmesh.vertices.slice().buffer, bRamps: bmesh.ramps.slice().buffer, dots: dotData.slice().buffer,
      trees: props.trees.slice().buffer, lights: props.lights.slice().buffer,
      windows: night.windows.slice().buffer, nightDots: night.dots.slice().buffer,
      beacons: masts.beacons.slice().buffer, mastLines: masts.lines.slice().buffer,
      glowVertices: glow.vertices.slice().buffer, glowRamps: glow.ramps.slice().buffer,
    };
    if (useCache) await putCachedMesh({ key, ts: Date.now(), ...out });
    send({ ...out, runways: data.lines.filter((l) => l.tags.aeroway === 'runway').length });
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