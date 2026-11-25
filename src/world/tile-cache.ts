// 70: summits raised to their ele (peaks.ts), cliff rock bands (cliffs.ts); 71: swimming pools; 72: land zones; 73: ruins are dark at night (night-glow); 74: summits pull the ground up within PEAK.REACH_M; 75: terrain, zone and roof colours matched to an aerial panorama (climate-colour, area-styles, building-mesher); 76: shaded forest floor; 77: transition belts round the land areas (ground-cover 'belt'); 78: untagged roofs by climate (warm: terracotta and pale concrete), rosier town zones; 79: every sports ground on a level pad; 80: the sea up to COAST_SEA_NEAR_MAX_M near the coastline; 81: the parts of a building in one style (overpass shareStyleInParts); 82: at-grade junctions as surfaces of their own, the roads trimmed to them (junctions.ts); 102: a footbridge's ramps and steps (the urban paths its lift holds up: NetWay.approach) structures like it, decks on walls with parapets over the ground left as it was, met with it and at their bends in mitres (bridge-mesher deckJoint), coming down at 45° (road-levels PATH_GRADE); every embankment a prism a stretch, swept round its bends; the parapets closed at a slab's cut ends; 104: traffic lights at the junctions mapped with them (ground-cover signals); 105: traffic lights on the right of their traffic, lit lenses on their heads; 106: junctions' shoulders round their kerbs, a road widening over its whole length, a branch wider than its trunk narrowing to it; 107: paths over the roads' shoulders, pedestrian crossings' yellow-white zebras
export const SCHEMA_VERSION = 107;
const DB_NAME = 'sim-unlimited';
const DB_VERSION = 4;
const STORE = 'meshes';
const META = 'meta';
const OSM_STORE = 'osm';
export const OSM_TTL_MS = 30 * 24 * 3600 * 1000;
export const MAX_ENTRIES = 4000;
export const MAX_BYTES = 1_000_000_000;

export interface CachedMesh {
  key: string;
  ts: number;
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  /** OSM tiles: per vertex of the drape, the roads and the water its depth level (osm-mesher depthLevels), or empty */
  levels?: ArrayBuffer;
  rLevels?: ArrayBuffer;
  wLevels?: ArrayBuffer;
  /** terrain tiles: stitching to a coarser neighbour (TerrainMeshData.morph) */
  morph?: ArrayBuffer;
  /** terrain tiles with a cover: vertices drawn near and far (TerrainMeshData.nearCount, farCount); absent: all */
  nearCount?: number;
  farCount?: number;
  trees?: ArrayBuffer;
  lights?: ArrayBuffer;
  /** OSM tiles: building mesh (vertices, ramps, facade window attributes) and far building dots */
  bVertices?: ArrayBuffer;
  bRamps?: ArrayBuffer;
  bWindows?: ArrayBuffer;
  /** the building vertices without the small parts (BuildingMeshData.coreVertexCount): the far LOD */
  bCore?: number;
  /** OSM tiles: see-through faces (greenhouse glass), drawn blended */
  gVertices?: ArrayBuffer;
  gRamps?: ArrayBuffer;
  /** structure kinds of the building vertices (structure-kinds KindRuns pairs) */
  bKinds?: ArrayBuffer;
  dots?: ArrayBuffer;
  /** OSM tiles, night: roof obstruction lights (near), building night dots (far), mast lines (far), mast beacons */
  roofLights?: ArrayBuffer;
  nightDots?: ArrayBuffer;
  mastLines?: ArrayBuffer;
  beacons?: ArrayBuffer;
  /** OSM tiles: road ribbons (near) and their far 1 px lines */
  rVertices?: ArrayBuffer;
  rRamps?: ArrayBuffer;
  /** per road vertex: the railway track's u, v (WORLD_VS aWinUV, aWinEdge) */
  rAttrs?: ArrayBuffer;
  /** OSM tiles: water areas and river ribbons */
  wVertices?: ArrayBuffer;
  wRamps?: ArrayBuffer;
  roadLines?: ArrayBuffer;
  /** OSM tiles: pitch markings (near 1 px lines) */
  pitchLines?: ArrayBuffer;
  /** OSM tiles, night: lamp heads (near, and far as the street-lit roads' dotted line) */
  lamps?: ArrayBuffer;
  /** OSM tiles: power line conductors (1 px lines, near and far) */
  wires?: ArrayBuffer;
  /** OSM tiles, night: lighthouses' flashes (lighthouse-mesher FLASH_STRIDE) */
  flashes?: ArrayBuffer;
  /** OSM tiles: traffic lights (traffic-signals SIGNAL_STRIDE) */
  signals?: ArrayBuffer;
}

type MeshBuffers = 'vertices' | 'ramps' | 'levels' | 'rLevels' | 'wLevels' | 'morph' | 'trees' | 'lights' | 'bVertices' | 'bRamps' | 'bWindows' | 'bKinds' | 'gVertices' | 'gRamps' | 'dots' | 'roofLights' | 'nightDots' | 'mastLines' | 'beacons' | 'rVertices' | 'rRamps' | 'rAttrs' | 'wVertices' | 'wRamps' | 'roadLines' | 'pitchLines' | 'lamps' | 'wires' | 'flashes' | 'signals';
export function meshBytes(m: Pick<CachedMesh, 'vertices' | 'ramps'> & Partial<Pick<CachedMesh, MeshBuffers>>): number {
  return m.vertices.byteLength + m.ramps.byteLength + (m.levels?.byteLength ?? 0) + (m.rLevels?.byteLength ?? 0) + (m.wLevels?.byteLength ?? 0) +
    (m.morph?.byteLength ?? 0) + (m.trees?.byteLength ?? 0) + (m.lights?.byteLength ?? 0) +
    (m.bVertices?.byteLength ?? 0) + (m.bRamps?.byteLength ?? 0) + (m.bWindows?.byteLength ?? 0) + (m.bKinds?.byteLength ?? 0) + (m.dots?.byteLength ?? 0) +
    (m.roofLights?.byteLength ?? 0) + (m.nightDots?.byteLength ?? 0) + (m.mastLines?.byteLength ?? 0) + (m.beacons?.byteLength ?? 0) +
    (m.rVertices?.byteLength ?? 0) + (m.rRamps?.byteLength ?? 0) + (m.rAttrs?.byteLength ?? 0) + (m.roadLines?.byteLength ?? 0) + (m.pitchLines?.byteLength ?? 0) +
    (m.wVertices?.byteLength ?? 0) + (m.wRamps?.byteLength ?? 0) +
    (m.gVertices?.byteLength ?? 0) + (m.gRamps?.byteLength ?? 0) + (m.wires?.byteLength ?? 0) + (m.flashes?.byteLength ?? 0) + (m.signals?.byteLength ?? 0) +
    (m.lamps?.byteLength ?? 0);
}

export interface CacheEntryMeta {
  key: string;
  ts: number;
  bytes: number;
}

/** Oldest-first eviction until both quotas hold. Pure for testability. */
export function pickEvictions(entries: CacheEntryMeta[], maxEntries: number, maxBytes: number): string[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  let count = sorted.length;
  let bytes = sorted.reduce((s, e) => s + e.bytes, 0);
  const evict: string[] = [];
  for (const e of sorted) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    evict.push(e.key);
    count--;
    bytes -= e.bytes;
  }
  return evict;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDB(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
        // backfill metadata for meshes written by db version 1
        const t = req.transaction!;
        const meta = t.objectStore(META);
        t.objectStore(STORE).openCursor().onsuccess = (e) => {
          const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cur) return;
          const m = cur.value as CachedMesh;
          meta.put({ key: m.key, ts: m.ts, bytes: meshBytes(m) });
          cur.continue();
        };
      }
      if (!db.objectStoreNames.contains(OSM_STORE)) db.createObjectStore(OSM_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function getCachedMesh(key: string): Promise<CachedMesh | undefined> {
  const hit = await tx<CachedMesh | undefined>('readonly', (s) => s.get(key));
  if (hit) {
    const meta: CacheEntryMeta = { key, ts: Date.now(), bytes: meshBytes(hit) };
    // bookkeeping must never fail the tile read
    void tx('readwrite', (s) => s.put(meta), META).catch(() => {});
  }
  return hit;
}

export async function putCachedMesh(mesh: CachedMesh): Promise<void> {
  const meta: CacheEntryMeta = {
    key: mesh.key,
    ts: mesh.ts,
    bytes: meshBytes(mesh),
  };
  await openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction([STORE, META], 'readwrite');
        t.objectStore(STORE).put(mesh);
        t.objectStore(META).put(meta);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }),
  );
  const all = await tx<CacheEntryMeta[]>('readonly', (s) => s.getAll(), META);
  const evict = pickEvictions(all, MAX_ENTRIES, MAX_BYTES);
  if (evict.length) {
    await openDB().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction([STORE, META], 'readwrite');
          for (const key of evict) {
            t.objectStore(STORE).delete(key);
            t.objectStore(META).delete(key);
          }
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        }),
    );
  }
}

/** Drops the cached meshes whose key matches (tools: rebuild a tile from its sources); returns how many. */
export async function deleteCachedMeshes(match: (key: string) => boolean): Promise<number> {
  const keys = (await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String).filter(match);
  if (!keys.length) return 0;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE, META], 'readwrite');
    for (const key of keys) {
      t.objectStore(STORE).delete(key);
      t.objectStore(META).delete(key);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return keys.length;
}

/** every cached mesh of a tile: terrain (with and without runway flattening) and OSM */
export function isTileMeshKey(key: string, t: { z: number; x: number; y: number }): boolean {
  return key.startsWith(`dem/${t.z}/${t.x}/${t.y}/`) || key.startsWith(`osmmesh/${t.z}/${t.x}/${t.y}/`);
}

export interface CachedOsmRaw {
  key: string;
  ts: number;
  json: string;
  /** the build of the archives it was read from (our own tiles: setOsmRawStamp) */
  src?: string;
}

/** the raw OSM keys a source build stamps, and that build (our own tiles: osm-source) */
let rawStamp: { prefix: string; stamp: () => Promise<string | undefined> } | undefined;
/**
 * Raw tiles under `prefix` are of a build of their source (`stamp`: our archives, rebuilt by
 * tiles/build.sh): one cached from another build is stale, whatever its age
 */
export function setOsmRawStamp(prefix: string, stamp: () => Promise<string | undefined>): void {
  rawStamp = { prefix, stamp };
}
const stampOf = async (key: string): Promise<string | undefined> =>
  rawStamp && key.startsWith(rawStamp.prefix) ? rawStamp.stamp().catch(() => undefined) : undefined;

export async function getOsmRaw(key: string): Promise<CachedOsmRaw | undefined> {
  const hit = await tx<CachedOsmRaw | undefined>('readonly', (s) => s.get(key), OSM_STORE);
  if (hit && Date.now() - hit.ts > OSM_TTL_MS) return undefined;
  if (hit) {
    const now = await stampOf(key);
    if (now !== undefined && hit.src !== now) return undefined;
  }
  return hit;
}

export async function putOsmRaw(entry: CachedOsmRaw): Promise<void> {
  const src = entry.src ?? (await stampOf(entry.key));
  await tx('readwrite', (s) => s.put(src === undefined ? entry : { ...entry, src }), OSM_STORE);
}