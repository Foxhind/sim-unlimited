import { RetryableError } from '../engine/queue';
import { SCHEMA_VERSION, getCachedMesh, getOsmRaw, putCachedMesh } from '../world/tile-cache';
import { tileKey, type Tile } from '../world/geodesy';
import { buildOsmMesh } from '../world/osm-mesher';
import { buildBuildingMesh, buildingDots, buildingNightLights, WINDOW_ATTR_FLOATS } from '../world/building-mesher';
import { buildMasts } from '../world/mast-mesher';
import { clipTileData } from '../world/clip';
import { buildProps } from '../world/props-mesher';
import { insertAt } from '../world/bridge-mesher';
import { buildPiers } from '../world/pier-mesher';
import { buildRuins } from '../world/ruin-mesher';
import { buildMinarets, isMappedMinaret, minaretSites } from '../world/minaret-mesher';
import { buildPower } from '../world/power-mesher';
import { OsmSource, osmRawKey, osmSourceMode } from '../world/osm-source';
import { parseOverpass } from '../world/overpass';
import type { OsmDetail, OsmTileData } from '../world/osm-types';
import { loadTileDem } from '../world/terrain-source';
import { COAST_LEVEL, tinLocator, tinSampler } from '../world/terrain-tin';
import { buildSurfaceTin, fetchRoadSurface } from '../world/surface-tin';
import { greenColour, isMaterial, RAMP, snowy } from '../engine/palette';
import { applyPads, loadPads, padSources } from '../world/aerodrome';
import { applyPeaks, peaksOf } from '../world/peaks';
import { DETAIL_Z, gridForZoom } from '../world/chunks';
import { buildGroundCover, type GroundCover } from '../world/ground-cover';
import { isNeutralGrade, NEUTRAL_GRADE, type ColourGrade } from '../world/landsat-process';
import { climateFaceColor } from '../world/climate-colour';
import { coastlineWays } from '../world/coast';
import { isDefaultAreaStyles, type AreaStyles } from '../world/area-styles';
import { applyGlow, applyGlowToTrees, buildingCoverage, glowLevels } from '../world/night-glow';

// 83: orchard trees, greenhouse glass (gVertices, gRamps) on a frame; 84: summits, cliff bands; 85: piers, yachts; 86: minarets; 87: power lines (wires); 88: double-circuit pylons; 89: pools; 90: land zones (the junior zone cover); 91: ruins (roofless walls)
export const OSM_MESH_SCHEMA = 91;

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
  /**
   * per vertex of the drape, the roads and the water: its depth level (osm-mesher depthLevels, WORLD_VS
   * aDepthLevel), or empty when none has one
   */
  levels: ArrayBuffer;
  rLevels: ArrayBuffer;
  wLevels: ArrayBuffer;
  /** buildings (near), their facade window attributes (building-mesher BuildingMeshData.windows) and their dots (far: x, y, z, palette index) */
  bVertices: ArrayBuffer;
  bRamps: ArrayBuffer;
  bWindows: ArrayBuffer;
  /** the first bCore building vertices: the buildings without their small parts (the far LOD) */
  bCore: number;
  /** see-through faces: greenhouse glass (building-mesher BuildingMeshData.glass), drawn blended */
  gVertices: ArrayBuffer;
  gRamps: ArrayBuffer;
  dots: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  /** night: roof obstruction lights (near; lit windows are on the walls), building lights (far), mast beacons (any distance) */
  roofLights: ArrayBuffer;
  nightDots: ArrayBuffer;
  beacons: ArrayBuffer;
  /** far stand-in for masts: GL line vertex pairs (x, y, z, palette index) */
  mastLines: ArrayBuffer;
  /** road ribbons (near, pos+normal with Uint32 face colours) and their far 1 px GL lines (x, y, z, palette index) */
  rVertices: ArrayBuffer;
  rRamps: ArrayBuffer;
  /** per road vertex WINDOW_ATTR_FLOATS: the railway track's u, v (osm-mesher roadAttrs) */
  rAttrs: ArrayBuffer;
  /** water areas and river ribbons (pos+normal with Uint32 face colours), drawn with depth writes: nothing overlaps them */
  wVertices: ArrayBuffer;
  wRamps: ArrayBuffer;
  roadLines: ArrayBuffer;
  /** pitch markings: near 1 px GL lines (x, y, z, palette index) */
  pitchLines: ArrayBuffer;
  /** night: lamp heads (x, y, z, palette index); far, the street-lit roads' dotted line */
  lamps: ArrayBuffer;
  /** power line conductors: 1 px GL lines (x, y, z, palette index), near and far (power-mesher.ts) */
  wires: ArrayBuffer;
  runways: number;
  /**
   * The tile's OSM, just downloaded, decides its shore (a coastline, or DEM sea without one): its
   * terrain was built without it and is rebuilt (TinOptions.coast). From the cache it is false: the raw OSM was there when the
   * terrain worker built the tile, so the terrain already has the coastline.
   */
  coast: boolean;
  /**
   * The tile's OSM, just downloaded, gave this build its ground covers (z14: ground-cover.ts, roads or
   * not; the surface is built under the roads and the covers): the terrain was built without them and
   * is rebuilt. From the cache false, like `coast`.
   */
  roads: boolean;
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
  // draped on the terrain TIN: a cached mesh is only valid for the terrain version it was built on,
  // and near ('full': on the surface built under its roads and covers) for the raw OSM it was built
  // from, by its download time (`raw`), as the terrain worker's mesh is: a raw fetched anew by
  // whoever is another surface
  const keyOf = (raw?: { ts: number }) =>
    `${tileKey(osmSourceMode() === 'pmtiles' ? 'osmmesh-pm' : 'osmmesh', tile, OSM_MESH_SCHEMA)}/t${SCHEMA_VERSION}/${detail}${detail === 'full' && raw ? `@${raw.ts}` : ''}`;
  const rawNow = () => (detail === 'full' ? getOsmRaw(osmRawKey(tile)).catch(() => undefined) : Promise.resolve(undefined));
  const send = (m: Omit<OsmMeshResponse, 'type' | 'id'>) => {
    const res: OsmMeshResponse = { type: 'mesh', id, ...m };
    ctx.postMessage(res, [
      res.vertices, res.ramps, res.levels, res.rLevels, res.wLevels, res.bVertices, res.bRamps, res.bWindows, res.gVertices, res.gRamps, res.dots, res.trees, res.lights,
      res.roofLights, res.nightDots, res.beacons, res.mastLines,
      res.rVertices, res.rRamps, res.rAttrs, res.wVertices, res.wRamps, res.roadLines, res.pitchLines, res.lamps, res.wires,
    ]);
  };
  const empty = () => new ArrayBuffer(0);
  try {
    // the cached drape lies on a surface built under the roads of the tile's raw OSM; once that has
    // expired the terrain and the collision ground are built without them: build again (the OSM is
    // fetched anew, and the terrain rebuilt on the 'roads' flag)
    const raw = useCache ? await rawNow() : undefined;
    const cached = useCache && (detail !== 'full' || raw) ? await getCachedMesh(keyOf(raw)) : undefined;
    if (cached) {
      send({
        vertices: cached.vertices, ramps: cached.ramps,
        levels: cached.levels ?? empty(), rLevels: cached.rLevels ?? empty(), wLevels: cached.wLevels ?? empty(),
        bVertices: cached.bVertices ?? empty(), bRamps: cached.bRamps ?? empty(), bWindows: cached.bWindows ?? empty(),
        bCore: cached.bCore ?? (cached.bRamps?.byteLength ?? 0) / 4,
        gVertices: cached.gVertices ?? empty(), gRamps: cached.gRamps ?? empty(),
        dots: cached.dots ?? empty(),
        trees: cached.trees ?? empty(), lights: cached.lights ?? empty(),
        roofLights: cached.roofLights ?? empty(), nightDots: cached.nightDots ?? empty(),
        beacons: cached.beacons ?? empty(), mastLines: cached.mastLines ?? empty(),
        rVertices: cached.rVertices ?? empty(), rRamps: cached.rRamps ?? empty(), rAttrs: cached.rAttrs ?? empty(), roadLines: cached.roadLines ?? empty(), pitchLines: cached.pitchLines ?? empty(),
        wVertices: cached.wVertices ?? empty(), wRamps: cached.wRamps ?? empty(),
        lamps: cached.lamps ?? empty(), wires: cached.wires ?? empty(),
        ...(detail === 'full' ? await cachedTerrainFlags(tile) : { runways: 0, coast: false }),
        roads: false,
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
    // mapped summits up to their height, as the terrain worker raises them (peaks.ts)
    applyPeaks(dem, tile, grid, peaksOf(data.points));
    // the same face colours as the terrain mesh (height × temperature, climate-colour.ts)
    const ls = { faceColor: climateFaceColor(tile, grid, lattice) };
    // the same TIN as the terrain worker builds from the same OSM: coastline and roads included
    const roads = detail === 'full' ? await fetchRoadSurface(tile, data, pads) : undefined;
    // and the covers the terrain worker builds (z14 with its OSM, roads or not): the drape is on the same faces
    const cover: GroundCover | undefined = detail === 'full' && tile.z === DETAIL_Z ? buildGroundCover(tile, grid, data, roads) : undefined;
    const tin = buildSurfaceTin(tile, grid, lattice, { borders, coast: coastlineWays(data.lines), pads, roads, cover });
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
    const mesh = buildOsmMesh({ tile, detail, data, sampleHeight: drape, tin, buildings: false, faceColor: ls.faceColor, areaStyles, roads, cover });
    const clipped = clipTileData(data, tile);
    const own = clipped.buildings;
    // entrances from the whole fetch, not only the tile's own share: one by the border may belong to an own building
    // a house's plinth on a slope takes the colour of the terrain face under it, as the terrain mesh draws it
    const groundColour = (lon: number, lat: number): number | undefined => {
      const r = locate(lon, lat);
      if (!r) return undefined;
      const t = tin.tris[r.tri];
      const ramp = ls.faceColor(tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]);
      return ramp === RAMP.WATER ? ramp : snowy(ramp);
    };
    const houses = buildBuildingMesh({ tile, buildings: own, sampleHeight: drape, points: data.points, groundColour });
    // antenna trusses are drawn with the buildings (near), as lines far away
    const masts = buildMasts(clipped.points, tile, drape);
    // bridge bodies and embankments (bridge-mesher.ts) are solid like the buildings and drawn with
    // them: after the buildings' core, as part of it (the far LOD and the shadows draw the core only)
    // piers and breakwaters (pier-mesher.ts) likewise: solid, with the bridges in the core
    const piers = buildPiers(tile, clipped.lines, clipped.areas, drape);
    // and the minarets (minaret-mesher.ts): mapped, or guessed by the tile's mosques; the whole fetch's
    // mapped ones keep a mosque by the border from a guess; far away a line each, as the masts
    const known = [
      ...data.points.filter((p) => isMappedMinaret(p.tags)).map((p) => p.at),
      ...data.buildings.filter((b) => isMappedMinaret(b.tags) && b.rings[0]?.length).map((b) => b.rings[0][0]),
    ];
    const minarets = buildMinarets(minaretSites(clipped.points, own, known), tile, drape);
    // and the power lines' pylons and poles (power-mesher.ts), from the whole lines; their conductors are GL lines
    const power = buildPower(tile, data.lines, drape);
    // and the ruins (ruin-mesher.ts): roofless walls, left out of the houses (building-mesher isRuin)
    const ruins = buildRuins(tile, own, drape);
    const solid = {
      vertices: concatF32(concatF32(concatF32(concatF32(mesh.bridges.vertices, piers.vertices), minarets.vertices), power.vertices), ruins.vertices),
      ramps: concatU32(concatU32(concatU32(concatU32(mesh.bridges.ramps, piers.ramps), minarets.ramps), power.ramps), ruins.ramps),
    };
    const core = houses.coreVertexCount, decks = solid.ramps.length;
    const bmesh = {
      vertices: concatF32(insertAt(houses.vertices, solid.vertices, core * 6), masts.vertices),
      ramps: concatU32(insertAt(houses.ramps, solid.ramps, core), masts.ramps),
      // masts and bridges have no windows
      windows: concatF32(insertAt(houses.windows, new Float32Array(decks * WINDOW_ATTR_FLOATS), core * WINDOW_ATTR_FLOATS), new Float32Array(masts.ramps.length * WINDOW_ATTR_FLOATS)),
    };
    const dotData = buildingDots(own, tile, drape);
    // no far window dots: the detailed tiles draw their lit facades at any distance at night
    const night = buildingNightLights(own, tile, drape, 0);
    const props = buildProps({ tile, detail, data, sampleHeight: drape, treeRamp });
    // night glow: each terrain triangle lit by how densely it is built up, and everything on it too
    const levels = glowLevels(buildingCoverage(tin, tile, own, locate));
    applyGlow(mesh.vertices, mesh.ramps, tile, locate, levels);
    applyGlow(mesh.roads.vertices, mesh.roads.ramps, tile, locate, levels);
    applyGlow(mesh.water.vertices, mesh.water.ramps, tile, locate, levels);
    applyGlow(bmesh.vertices, bmesh.ramps, tile, locate, levels);
    // sorted by type: trees, air conditioners, lamp posts, then the marinas' yachts (props-mesher INSTANCE)
    const instances = concatF32(concatF32(concatF32(props.trees, houses.acs), mesh.lampPosts), props.yachts);
    applyGlowToTrees(instances, tile, locate, levels);
    const out = {
      vertices: mesh.vertices.slice().buffer, ramps: mesh.ramps.slice().buffer,
      levels: mesh.depthLevels.slice().buffer, rLevels: mesh.roadDepthLevels.slice().buffer, wLevels: mesh.waterDepthLevels.slice().buffer,
      bVertices: bmesh.vertices.slice().buffer, bRamps: bmesh.ramps.slice().buffer, bWindows: bmesh.windows.slice().buffer,
      // the masts come after the houses: small parts too
      bCore: core + decks,
      gVertices: houses.glass.vertices.slice().buffer, gRamps: houses.glass.ramps.slice().buffer,
      dots: dotData.slice().buffer,
      // instances sorted by type: trees, then air conditioners, then lamp posts (props-mesher INSTANCE)
      trees: instances.buffer as ArrayBuffer, lights: props.lights.slice().buffer,
      roofLights: night.roofLights.slice().buffer, nightDots: night.dots.slice().buffer,
      beacons: masts.beacons.slice().buffer, mastLines: concatF32(masts.lines, minarets.lines).buffer as ArrayBuffer,
      rVertices: mesh.roads.vertices.slice().buffer, rRamps: mesh.roads.ramps.slice().buffer, rAttrs: mesh.roadAttrs.slice().buffer,
      wVertices: mesh.water.vertices.slice().buffer, wRamps: mesh.water.ramps.slice().buffer,
      roadLines: mesh.roadLines.slice().buffer,
      pitchLines: mesh.pitchLines.slice().buffer,
      lamps: mesh.lamps.slice().buffer,
      wires: power.wires.slice().buffer,
    };
    // under the raw it was built from (just fetched, or kept)
    if (useCache) await putCachedMesh({ key: keyOf(await rawNow()), ts: Date.now(), ...out });
    send({ ...out, ...(detail === 'full' ? terrainFlags(data, lattice) : { runways: 0, coast: false }), roads: cover !== undefined });
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