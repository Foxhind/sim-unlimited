export const SCHEMA_VERSION = 11;
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
  trees?: ArrayBuffer;
  lights?: ArrayBuffer;
  /** OSM tiles: building mesh (vertices, ramps) and far building dots */
  bVertices?: ArrayBuffer;
  bRamps?: ArrayBuffer;
  dots?: ArrayBuffer;
  /** OSM tiles, night: lit windows (near), building night dots (far), mast lines (far), mast beacons */
  windows?: ArrayBuffer;
  nightDots?: ArrayBuffer;
  glowVertices?: ArrayBuffer;
  glowRamps?: ArrayBuffer;
  mastLines?: ArrayBuffer;
  beacons?: ArrayBuffer;
}

type MeshBuffers = 'vertices' | 'ramps' | 'trees' | 'lights' | 'bVertices' | 'bRamps' | 'dots' | 'windows' | 'nightDots' | 'mastLines' | 'beacons' | 'glowVertices' | 'glowRamps';
export function meshBytes(m: Pick<CachedMesh, 'vertices' | 'ramps'> & Partial<Pick<CachedMesh, MeshBuffers>>): number {
  return m.vertices.byteLength + m.ramps.byteLength + (m.trees?.byteLength ?? 0) + (m.lights?.byteLength ?? 0) +
    (m.bVertices?.byteLength ?? 0) + (m.bRamps?.byteLength ?? 0) + (m.dots?.byteLength ?? 0) +
    (m.windows?.byteLength ?? 0) + (m.nightDots?.byteLength ?? 0) + (m.mastLines?.byteLength ?? 0) + (m.beacons?.byteLength ?? 0) +
    (m.glowVertices?.byteLength ?? 0) + (m.glowRamps?.byteLength ?? 0);
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

export interface CachedOsmRaw {
  key: string;
  ts: number;
  json: string;
}

export async function getOsmRaw(key: string): Promise<CachedOsmRaw | undefined> {
  const hit = await tx<CachedOsmRaw | undefined>('readonly', (s) => s.get(key), OSM_STORE);
  if (hit && Date.now() - hit.ts > OSM_TTL_MS) return undefined;
  return hit;
}

export async function putOsmRaw(entry: CachedOsmRaw): Promise<void> {
  await tx('readwrite', (s) => s.put(entry), OSM_STORE);
}