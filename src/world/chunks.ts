import { mat4, vec3, vec4 } from 'gl-matrix';
import { RequestQueue, RetryableError } from '../engine/queue';
import type { Mesh, Renderer } from '../engine/renderer';
import { must } from '../engine/gl';
import { NEUTRAL_GRADE, type ColourGrade } from './landsat-process';
import {
  enuToLatLon,
  frameYaw,
  latLonToEnu,
  tileBounds,
  tileCenter,
  tileForLatLon,
  tileSizeMeters,
  type LatLon,
  type Tile,
} from './geodesy';

export const MIN_Z = 8;
export const MAX_Z = 14;
export const VIEW_RADIUS_M = 90000;
export const REBASE_DISTANCE_M = 5000;
const LOD_FACTOR = 1.7;
const ALT_WEIGHT = 1.5;
const UNLOAD_DELAY_MS = 10000;
const RETRY_DELAY_MS = 5000;
/**
 * Two tile variants: coarse terrain without OSM (z8–z13 by distance) and detailed z14 terrain
 * with OSM, used within this slant distance of the camera.
 */
export const DETAIL_RADIUS_M = 7000;
export const DETAIL_Z = 14;

/** Work-lattice resolution on which terrain contours are traced (not the mesh density). */
export const TERRAIN_GRID = 48;

/** the same lattice at every zoom (tuned in the terrain inspector) */
export function gridForZoom(_z: number): number {
  return TERRAIN_GRID;
}

function horizontalDistance(a: LatLon, b: LatLon): number {
  const [e, n] = latLonToEnu(a, b.lat, b.lon, 0);
  return Math.hypot(e, n);
}

/**
 * Quadtree chunked LOD. Coarse levels (up to z13) subdivide while the distance metric (horizontal
 * distance plus weighted altitude, minimized over camera and velocity lookahead) is below
 * LOD_FACTOR × tile size; detailed z14 tiles (with OSM) are used exactly where a tile comes
 * within DETAIL_RADIUS_M slant distance (nearest point of the tile, altitude included).
 */
export function selectLeaves(cam: LatLon, alt: number, lookahead?: LatLon): Tile[] {
  const leaves: Tile[] = [];
  const degLat = VIEW_RADIUS_M / 111320;
  const degLon = degLat / Math.max(0.2, Math.cos((cam.lat * Math.PI) / 180));
  const n = 2 ** MIN_Z;
  const x0 = Math.floor(((cam.lon - degLon + 180) / 360) * n);
  const x1 = Math.floor(((cam.lon + degLon + 180) / 360) * n);
  const y0 = Math.max(0, tileForLatLon(cam.lat + degLat, cam.lon, MIN_Z).y - 1);
  const y1 = Math.min(n - 1, tileForLatLon(cam.lat - degLat, cam.lon, MIN_Z).y + 1);

  const visit = (t: Tile): void => {
    const center = tileCenter(t);
    const size = tileSizeMeters(t);
    let d = horizontalDistance(cam, center);
    if (lookahead) d = Math.min(d, horizontalDistance(lookahead, center));
    const metric = Math.hypot(d, alt * ALT_WEIGHT);
    // nearest point of the tile (camera or lookahead), slant with the altitude
    const b = tileBounds(t);
    const near = (p: LatLon) => horizontalDistance(p, {
      lat: Math.max(b.south, Math.min(b.north, p.lat)),
      lon: Math.max(b.west, Math.min(b.east, p.lon)),
    });
    const dn = lookahead ? Math.min(near(cam), near(lookahead)) : near(cam);
    const detail = Math.hypot(dn, alt) < DETAIL_RADIUS_M;
    if (detail ? t.z < DETAIL_Z : t.z < DETAIL_Z - 1 && metric < size * LOD_FACTOR) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        visit({ z: t.z + 1, x: (t.x * 2 + dx) % (2 ** (t.z + 1)), y: t.y * 2 + dy });
      }
    } else {
      leaves.push(t);
    }
  };

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      visit({ z: MIN_Z, x: ((x % n) + n) % n, y });
    }
  }
  return leaves;
}

/**
 * Which tiles to draw for a set of leaves: each leaf, or while it is not ready its nearest ready
 * ancestor. A tile that stands in for one leaf covers its whole area, so its descendants that are
 * ready for other leaves are not drawn with it (`drawn: false`) — no overlap, no mixed variants.
 */
export function shownTiles(leaves: Tile[], ready: (t: Tile) => boolean): Array<{ tile: Tile; drawn: boolean }> {
  const shown = new Map<string, Tile>();
  for (const leaf of leaves) {
    for (let t: Tile | undefined = leaf; t; t = t.z > MIN_Z ? { z: t.z - 1, x: t.x >> 1, y: t.y >> 1 } : undefined) {
      if (ready(t)) {
        shown.set(`${t.z}/${t.x}/${t.y}`, t);
        break;
      }
    }
  }
  return [...shown.values()].map((t) => {
    let covered = false;
    for (let z = t.z - 1; z >= MIN_Z && !covered; z--) covered = shown.has(`${z}/${t.x >> (t.z - z)}/${t.y >> (t.z - z)}`);
    return { tile: t, drawn: !covered };
  });
}

/**
 * Edges of a drawn tile (bits 1 n, 2 s, 4 w, 8 e) whose neighbour is drawn coarser. Only an edge
 * on the parent's boundary can be one: across the other two lies a sibling or its descendants.
 */
export function coarseEdges(t: Tile, drawn: (key: string) => boolean): number {
  const n = 2 ** t.z;
  let mask = 0;
  [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy], e) => {
    if (e < 2 ? (t.y % 2 === 0) !== (e === 0) : (t.x % 2 === 0) !== (e === 2)) return;
    const y = t.y + dy;
    if (y < 0 || y >= n) return;
    const x = (t.x + dx + n) % n;
    for (let z = t.z - 1; z >= MIN_Z; z--) {
      if (drawn(`${z}/${x >> (t.z - z)}/${y >> (t.z - z)}`)) {
        mask |= 1 << e;
        return;
      }
    }
  });
  return mask;
}

/** Six frustum planes from a view-projection matrix (Gribble–Hartmann). */
export function frustumPlanes(vp: mat4): Float32Array[] {
  const m = vp;
  const planes: Float32Array[] = [];
  const rows = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ];
  for (const r of rows) {
    const len = Math.hypot(r[0], r[1], r[2]) || 1;
    planes.push(new Float32Array([r[0] / len, r[1] / len, r[2] / len, r[3] / len]));
  }
  return planes;
}

export function sphereInFrustum(planes: Float32Array[], center: vec3, radius: number): boolean {
  for (const p of planes) {
    if (p[0] * center[0] + p[1] * center[1] + p[2] * center[2] + p[3] < -radius) return false;
  }
  return true;
}

export type ChunkStatus = 'pending' | 'ready' | 'error';

export interface Chunk {
  tile: Tile;
  key: string;
  grid: number;
  status: ChunkStatus;
  mesh?: Mesh;
  buffers: WebGLBuffer[];
  vao?: WebGLVertexArrayObject;
  /** xyz: tile centre in the world; w: yaw of the tile frame (see frameYaw) */
  offset: vec4;
  centerEnu: vec3;
  /** edges stitched to a coarser neighbour this frame (see coarseEdges) */
  coarse: number;
  radius: number;
  lastUsed: number;
  lastAttempt: number;
}

export interface CameraWorld {
  /** ENU meters relative to manager origin: [east, up, -north] */
  pos: vec3;
  latLon: LatLon;
  alt: number;
  velocity: vec3;
}

interface TileBuffers {
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  morph?: ArrayBuffer;
}

interface WorkerSlot {
  worker: Worker;
  nextId: number;
  waiting: Map<number, { resolve: (m: TileBuffers) => void; reject: (e: unknown) => void }>;
}

export class ChunkManager {
  readonly chunks = new Map<string, Chunk>();
  origin: LatLon;
  renderList: Chunk[] = [];
  /** stitch the edges of tiles to coarser neighbours (off in the overview tool to see the raw seams) */
  stitch = true;
  /** Landsat colour correction for tiles built from now on (relief inspector; invalidate() to rebuild) */
  grade: ColourGrade = NEUTRAL_GRADE;
  /** z14 leaves wanted this frame: the detailed tiles whose OSM must load */
  detailTiles: Tile[] = [];
  /** z14 tiles drawn this frame (terrain and OSM both ready): only these show their OSM */
  shownDetail = new Set<string>();
  private queue = new RequestQueue(4);
  private workers: WorkerSlot[] = [];
  private rr = 0;
  private vp = mat4.create();
  private planes: Float32Array[] = [];

  constructor(private gl: WebGL2RenderingContext, origin: LatLon, workerCount = 2) {
    this.origin = origin;
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' });
      const slot: WorkerSlot = { worker, nextId: 1, waiting: new Map() };
      worker.onmessage = (e) => {
        const msg = e.data as { type: string; id: number; vertices?: ArrayBuffer; ramps?: ArrayBuffer; morph?: ArrayBuffer; retryable?: boolean; message?: string };
        const w = slot.waiting.get(msg.id);
        if (!w) return;
        slot.waiting.delete(msg.id);
        if (msg.type === 'mesh') w.resolve({ vertices: msg.vertices!, ramps: msg.ramps!, morph: msg.morph });
        else if (msg.retryable) w.reject(new RetryableError(0, msg.message));
        else w.reject(new Error(msg.message));
      };
      worker.onerror = (e) => {
        for (const w of slot.waiting.values()) w.reject(new Error(e.message));
        slot.waiting.clear();
      };
      this.workers.push(slot);
    }
  }

  get stats(): { chunks: number; pending: number; drawCalls: number; gpuBuffers: number } {
    let pending = 0;
    let gpuBuffers = 0;
    for (const c of this.chunks.values()) {
      if (c.status === 'pending') pending++;
      gpuBuffers += c.buffers.length;
    }
    return { chunks: this.chunks.size, pending, drawCalls: this.renderList.length, gpuBuffers };
  }

  /** Rebase when the camera drifts >5 km: offsets become uniforms again, buffers untouched. */
  rebaseIfNeeded(cam: CameraWorld): boolean {
    const dist = Math.hypot(cam.pos[0], cam.pos[2]);
    if (!(dist >= REBASE_DISTANCE_M)) return false; // also guards NaN
    this.origin = cam.latLon;
    cam.pos[0] = 0;
    cam.pos[2] = 0;
    for (const c of this.chunks.values()) this.refreshOffset(c);
    return true;
  }

  private refreshOffset(c: Chunk): void {
    const center = tileCenter(c.tile);
    const [e, n] = latLonToEnu(this.origin, center.lat, center.lon, 0);
    vec3.set(c.centerEnu, e, 0, -n);
    vec4.set(c.offset, e, 0, -n, frameYaw(this.origin, center));
  }

  /**
   * `detailReady(key)` says whether the OSM of a z14 tile is loaded: a detailed tile is shown only
   * with all its data; until then its coarse ancestor stands in, and a tile shown whole is never
   * drawn together with parts of itself.
   */
  update(cam: CameraWorld, view: mat4, proj: mat4, now: number, detailReady: (key: string) => boolean = () => true): void {
    mat4.multiply(this.vp, proj, view);
    this.planes = frustumPlanes(this.vp);

    const speed = vec3.length(cam.velocity);
    const lookahead =
      speed > 20
        ? (() => {
            const ahead = vec3.scaleAndAdd(vec3.create(), cam.pos, cam.velocity, 8);
            const ll = this.enuToLatLon(ahead);
            return ll;
          })()
        : undefined;

    const leaves = selectLeaves(cam.latLon, cam.alt, lookahead);
    this.detailTiles = leaves.filter((t) => t.z === DETAIL_Z);
    // every detailed tile also loads its coarse parent: it stands in until the detail is complete
    const wanted = [...leaves];
    const parents = new Set<string>();
    for (const t of this.detailTiles) {
      const p = { z: t.z - 1, x: t.x >> 1, y: t.y >> 1 };
      const k = `${p.z}/${p.x}/${p.y}`;
      if (!parents.has(k)) { parents.add(k); wanted.push(p); }
    }
    const needed = new Set<string>();
    for (const tile of wanted) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      needed.add(key);
      let chunk = this.chunks.get(key);
      if (chunk?.status === 'error' && now - chunk.lastAttempt > RETRY_DELAY_MS) {
        // imagery or DEM was unreachable: try again
        this.chunks.delete(key);
        chunk = undefined;
      }
      if (!chunk) {
        chunk = {
          tile,
          key,
          grid: gridForZoom(tile.z),
          status: 'pending',
          buffers: [],
          offset: vec4.create(),
          centerEnu: vec3.create(),
          coarse: 0,
          radius: tileSizeMeters(tile),
          lastUsed: now,
          lastAttempt: now,
        };
        this.refreshOffset(chunk);
        this.chunks.set(key, chunk);
        const center = tileCenter(tile);
        const priority = horizontalDistance(lookahead ?? cam.latLon, center);
        void this.queue
          .submit(key, priority, () => this.buildInWorker(chunk!))
          .then((data) => this.upload(chunk!, data))
          .catch(() => {
            chunk!.status = 'error';
            chunk!.lastAttempt = performance.now();
          });
      }
      if (chunk.status === 'ready') chunk.lastUsed = now;
    }

    // render leaves, falling back to the nearest ready ancestor while children load; a z14 leaf
    // is ready only with its OSM. A tile shown whole hides any of its descendants shown too.
    const seen = new Set<string>();
    const list: Chunk[] = [];
    const isReady = (t: Tile) => {
      const c = this.chunks.get(`${t.z}/${t.x}/${t.y}`);
      return c?.status === 'ready' && (t.z !== DETAIL_Z || detailReady(c.key));
    };
    for (const { tile: t, drawn } of shownTiles(leaves, isReady)) {
      const c = this.chunks.get(`${t.z}/${t.x}/${t.y}`)!;
      seen.add(c.key); // keep loaded either way
      c.lastUsed = now;
      if (drawn) list.push(c);
    }
    const drawnKeys = new Set(list.map((c) => c.key));
    for (const c of list) c.coarse = coarseEdges(c.tile, (k) => drawnKeys.has(k));
    this.shownDetail = new Set(list.filter((c) => c.tile.z === DETAIL_Z).map((c) => c.key));

    // planes come from proj*view where view is a full lookAt (translation included): they live in
    // the same world frame as centerEnu, so the sphere centre must NOT be made camera-relative
    this.renderList = list.filter((c) => sphereInFrustum(this.planes, c.centerEnu, c.radius + 2500));

    for (const [key, c] of this.chunks) {
      if (!needed.has(key) && !seen.has(key) && now - c.lastUsed > UNLOAD_DELAY_MS) {
        this.queue.cancel(key);
        this.dispose(c);
        this.chunks.delete(key);
      }
    }
  }

  private enuToLatLon(p: vec3): LatLon {
    return enuToLatLon(this.origin, p[0], -p[2], p[1]);
  }

  private buildInWorker(chunk: Chunk): Promise<TileBuffers> {
    const slot = this.workers[this.rr++ % this.workers.length];
    const id = slot.nextId++;
    return new Promise((resolve, reject) => {
      slot.waiting.set(id, { resolve, reject });
      slot.worker.postMessage({ type: 'tile', id, tile: chunk.tile, grid: chunk.grid, grade: this.grade });
    });
  }

  private upload(chunk: Chunk, data: TileBuffers): void {
    if (this.chunks.get(chunk.key) !== chunk) return; // unloaded (or replaced) while in flight
    const gl = this.gl;
    const vao = must(gl.createVertexArray(), 'chunk VAO');
    gl.bindVertexArray(vao);
    const vb = must(gl.createBuffer(), 'chunk vertices');
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const rb = must(gl.createBuffer(), 'chunk ramps');
    gl.bindBuffer(gl.ARRAY_BUFFER, rb);
    gl.bufferData(gl.ARRAY_BUFFER, data.ramps, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0); // Uint32 face colours (palette.ts)
    chunk.buffers = [vb, rb];
    if (data.morph) {
      const mb = must(gl.createBuffer(), 'chunk morph');
      gl.bindBuffer(gl.ARRAY_BUFFER, mb);
      gl.bufferData(gl.ARRAY_BUFFER, data.morph, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 8, 0);
      chunk.buffers.push(mb);
    }
    gl.bindVertexArray(null);
    chunk.vao = vao;
    chunk.mesh = { vao, vertexCount: data.ramps.byteLength / 4 };
    chunk.status = 'ready';
  }

  private dispose(chunk: Chunk): void {
    const gl = this.gl;
    for (const b of chunk.buffers) gl.deleteBuffer(b);
    if (chunk.vao) gl.deleteVertexArray(chunk.vao);
    chunk.buffers = [];
    chunk.mesh = undefined;
    chunk.vao = undefined;
  }

  draw(renderer: Renderer, view: mat4, proj: mat4, camPos: vec3, sunDir: vec3, fogStart: number, fogEnd: number): void {
    renderer.speckle = true;
    for (const c of this.renderList) {
      if (c.mesh) renderer.drawWorld(c.mesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd, this.stitch ? c.coarse : 0);
    }
    renderer.speckle = false;
  }

  nearReady(cam: LatLon, radiusM: number): boolean {
    let near = 0;
    for (const c of this.chunks.values()) {
      if (horizontalDistance(cam, tileCenter(c.tile)) < radiusM) {
        near++;
        if (c.status !== 'ready') return false;
      }
    }
    return near > 0;
  }

  /** Q40: drop near chunks so they rebuild with runway flattening once OSM arrives. */
  invalidateNear(center: LatLon, radiusM: number, minZ: number): void {
    for (const [key, c] of this.chunks) {
      if (c.tile.z < minZ) continue;
      if (horizontalDistance(center, tileCenter(c.tile)) > radiusM + tileSizeMeters(c.tile)) continue;
      this.queue.cancel(key);
      this.dispose(c);
      this.chunks.delete(key);
    }
  }

  /** Drop one tile (or all with no argument): it is requested again on the next update. */
  invalidate(tile?: Tile): void {
    for (const [key, c] of this.chunks) {
      if (tile && key !== `${tile.z}/${tile.x}/${tile.y}`) continue;
      this.queue.cancel(key);
      this.dispose(c);
      this.chunks.delete(key);
    }
  }

  disposeAll(): void {
    for (const c of this.chunks.values()) this.dispose(c);
    this.chunks.clear();
    for (const w of this.workers) w.worker.terminate();
  }
}