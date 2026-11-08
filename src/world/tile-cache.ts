export const SCHEMA_VERSION = 4;
const DB_NAME = 'sim-unlimited';
const DB_VERSION = 2;
const STORE = 'meshes';
const META = 'meta';
export const MAX_ENTRIES = 4000;
export const MAX_BYTES = 1_000_000_000;

export interface CachedMesh {
  key: string;
  ts: number;
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
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
          meta.put({ key: m.key, ts: m.ts, bytes: m.vertices.byteLength + m.ramps.byteLength });
          cur.continue();
        };
      }
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
    const meta: CacheEntryMeta = { key, ts: Date.now(), bytes: hit.vertices.byteLength + hit.ramps.byteLength };
    // bookkeeping must never fail the tile read
    void tx('readwrite', (s) => s.put(meta), META).catch(() => {});
  }
  return hit;
}

export async function putCachedMesh(mesh: CachedMesh): Promise<void> {
  const meta: CacheEntryMeta = {
    key: mesh.key,
    ts: mesh.ts,
    bytes: mesh.vertices.byteLength + mesh.ramps.byteLength,
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