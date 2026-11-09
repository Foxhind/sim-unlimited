import { mat4, vec3 } from 'gl-matrix';
import { RequestQueue, RetryableError } from '../engine/queue';
import type { Mesh, Renderer } from '../engine/renderer';
import { must } from '../engine/gl';
import { frustumPlanes, sphereInFrustum, type CameraWorld } from './chunks';
import {
  latLonToEnu,
  tileCenter,
  tileForLatLon,
  tileSizeMeters,
  type LatLon,
  type Tile,
} from './geodesy';
import type { OsmDetail } from './osm-types';
import { CONE_VERTICES } from './props-mesher';

export const OSM_NEAR_Z = 14;
export const OSM_FAR_Z = 10;
export const OSM_NEAR_RADIUS_M = 3500;
export const OSM_FAR_RADIUS_M = 60000;
const UNLOAD_DELAY_MS = 15000;
const RETRY_DELAY_MS = 5000;

function tilesInRadius(cam: LatLon, radiusM: number, z: number): Tile[] {
  const degLat = radiusM / 111320;
  const degLon = degLat / Math.max(0.2, Math.cos((cam.lat * Math.PI) / 180));
  const n = 2 ** z;
  const x0 = tileForLatLon(cam.lat, cam.lon - degLon, z).x;
  const x1 = tileForLatLon(cam.lat, cam.lon + degLon, z).x;
  const y0 = tileForLatLon(cam.lat + degLat, cam.lon, z).y;
  const y1 = tileForLatLon(cam.lat - degLat, cam.lon, z).y;
  const tiles: Tile[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
      tiles.push({ z, x: ((x % n) + n) % n, y });
    }
  }
  return tiles;
}

interface PropSet {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

interface OsmChunk {
  tile: Tile;
  detail: OsmDetail;
  key: string;
  status: 'pending' | 'ready' | 'error';
  mesh?: Mesh;
  trees?: PropSet;
  lights?: PropSet;
  buffers: WebGLBuffer[];
  vao?: WebGLVertexArrayObject;
  offset: vec3;
  centerEnu: vec3;
  radius: number;
  lastUsed: number;
  lastAttempt: number;
}

interface MeshPayload {
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  runways: number;
}

interface WorkerSlot {
  worker: Worker;
  nextId: number;
  waiting: Map<number, { resolve: (m: MeshPayload) => void; reject: (e: unknown) => void }>;
}

/** Draped OSM overlay: a detailed near ring plus a coarse far layer (Q32, M2). */
export class OsmManager {
  readonly chunks = new Map<string, OsmChunk>();
  renderList: OsmChunk[] = [];
  /** fired once per tile when its mesh first becomes ready (Q40 rebuild trigger) */
  onTileReady?: (tile: Tile, detail: OsmDetail, runways: number) => void;
  private readyFired = new Set<string>();
  private origin: LatLon;
  private queue = new RequestQueue(2);
  private workers: WorkerSlot[] = [];
  private rr = 0;
  private vp = mat4.create();
  private planes: Float32Array[] = [];
  private coneBuffer: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext, origin: LatLon, workerCount = 2) {
    this.origin = origin;
    this.coneBuffer = must(gl.createBuffer(), 'cone geometry');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coneBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CONE_VERTICES, gl.STATIC_DRAW);
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('../workers/osm.worker.ts', import.meta.url), { type: 'module' });
      const slot: WorkerSlot = { worker, nextId: 1, waiting: new Map() };
      worker.onmessage = (e) => {
        const msg = e.data as { type: string; id: number; vertices?: ArrayBuffer; ramps?: ArrayBuffer; trees?: ArrayBuffer; lights?: ArrayBuffer; runways?: number; retryable?: boolean; message?: string };
        const w = slot.waiting.get(msg.id);
        if (!w) return;
        slot.waiting.delete(msg.id);
        if (msg.type === 'mesh') {
          w.resolve({
            vertices: msg.vertices!,
            ramps: msg.ramps!,
            trees: msg.trees ?? new ArrayBuffer(0),
            lights: msg.lights ?? new ArrayBuffer(0),
            runways: msg.runways ?? 0,
          });
        } else if (msg.retryable) w.reject(new RetryableError(0, msg.message));
        else w.reject(new Error(msg.message));
      };
      worker.onerror = (e) => {
        for (const w of slot.waiting.values()) w.reject(new Error(e.message));
        slot.waiting.clear();
      };
      this.workers.push(slot);
    }
  }

  get stats(): { chunks: number; pending: number; drawCalls: number; errors: number } {
    let pending = 0;
    let errors = 0;
    let draws = 0;
    for (const c of this.chunks.values()) {
      if (c.status === 'pending') pending++;
      if (c.status === 'error') errors++;
    }
    for (const c of this.renderList) {
      if (c.mesh) draws++;
      if (c.trees) draws++;
      if (c.lights) draws++;
    }
    return { chunks: this.chunks.size, pending, drawCalls: draws, errors };
  }

  private refreshOffset(c: OsmChunk): void {
    const center = tileCenter(c.tile);
    const [e, n] = latLonToEnu(this.origin, center.lat, center.lon, 0);
    vec3.set(c.centerEnu, e, 0, -n);
    vec3.copy(c.offset, c.centerEnu);
  }

  update(cam: CameraWorld, view: mat4, proj: mat4, now: number, origin: LatLon): void {
    if (origin !== this.origin) {
      this.origin = origin;
      for (const c of this.chunks.values()) this.refreshOffset(c);
    }
    mat4.multiply(this.vp, proj, view);
    this.planes = frustumPlanes(this.vp);

    const wanted: { tile: Tile; detail: OsmDetail }[] = [
      ...tilesInRadius(cam.latLon, OSM_NEAR_RADIUS_M, OSM_NEAR_Z).map((tile) => ({ tile, detail: 'full' as const })),
      ...tilesInRadius(cam.latLon, OSM_FAR_RADIUS_M, OSM_FAR_Z).map((tile) => ({ tile, detail: 'large' as const })),
    ];
    const needed = new Set<string>();
    for (const { tile, detail } of wanted) {
      const key = `${tile.z}/${tile.x}/${tile.y}/${detail}`;
      needed.add(key);
      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = {
          tile, detail, key,
          status: 'pending',
          buffers: [],
          offset: vec3.create(),
          centerEnu: vec3.create(),
          radius: tileSizeMeters(tile),
          lastUsed: now,
          lastAttempt: now,
        };
        this.refreshOffset(chunk);
        this.chunks.set(key, chunk);
        this.request(chunk);
      } else if (chunk.status === 'error' && now - chunk.lastAttempt > RETRY_DELAY_MS) {
        chunk.status = 'pending';
        chunk.lastAttempt = now;
        this.request(chunk);
      }
      if (chunk.status === 'ready') chunk.lastUsed = now;
    }

    this.renderList = [];
    for (const c of this.chunks.values()) {
      if (c.status !== 'ready' || !c.mesh || c.mesh.vertexCount === 0) continue;
      // world-space planes (view includes the camera translation): test the world-space centre
      if (sphereInFrustum(this.planes, c.centerEnu, c.radius + 2000)) {
        this.renderList.push(c);
        c.lastUsed = now;
      }
    }
    // far layer first so the higher-biased near layer wins depth where they overlap
    this.renderList.sort((a, b) => (a.detail === b.detail ? 0 : a.detail === 'large' ? -1 : 1));

    for (const [key, c] of this.chunks) {
      if (!needed.has(key) && now - c.lastUsed > UNLOAD_DELAY_MS) {
        this.queue.cancel(key);
        this.dispose(c);
        this.chunks.delete(key);
      }
    }
  }

  private request(chunk: OsmChunk): void {
    const priority = chunk.detail === 'full' ? 0 : 1;
    void this.queue
      .submit(chunk.key, priority, () => this.buildInWorker(chunk))
      .then((data) => this.upload(chunk, data))
      .catch(() => {
        chunk.status = 'error';
      });
  }

  private buildInWorker(chunk: OsmChunk): Promise<MeshPayload> {
    const slot = this.workers[this.rr++ % this.workers.length];
    const id = slot.nextId++;
    return new Promise((resolve, reject) => {
      slot.waiting.set(id, { resolve, reject });
      slot.worker.postMessage({ type: 'osm', id, tile: chunk.tile, detail: chunk.detail });
    });
  }

  private upload(chunk: OsmChunk, data: MeshPayload): void {
    if (!this.chunks.has(chunk.key)) return;
    const gl = this.gl;
    if (data.ramps.byteLength > 0) {
      const vao = must(gl.createVertexArray(), 'osm VAO');
      gl.bindVertexArray(vao);
      const vb = must(gl.createBuffer(), 'osm vertices');
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const rb = must(gl.createBuffer(), 'osm ramps');
      gl.bindBuffer(gl.ARRAY_BUFFER, rb);
      gl.bufferData(gl.ARRAY_BUFFER, data.ramps, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 1, 0);
      gl.bindVertexArray(null);
      chunk.vao = vao;
      chunk.buffers = [vb, rb];
      chunk.mesh = { vao, vertexCount: data.ramps.byteLength };
    }
    if (data.trees.byteLength > 0) {
      const count = data.trees.byteLength / 20;
      const vao = must(gl.createVertexArray(), 'tree VAO');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.coneBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const ib = must(gl.createBuffer(), 'tree instances');
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      gl.bufferData(gl.ARRAY_BUFFER, data.trees, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 20, 12);
      gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);
      chunk.trees = { vao, buffer: ib, count };
    }
    if (data.lights.byteLength > 0) {
      const count = data.lights.byteLength / 16;
      const vao = must(gl.createVertexArray(), 'light VAO');
      gl.bindVertexArray(vao);
      const lb = must(gl.createBuffer(), 'light points');
      gl.bindBuffer(gl.ARRAY_BUFFER, lb);
      gl.bufferData(gl.ARRAY_BUFFER, data.lights, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      gl.bindVertexArray(null);
      chunk.lights = { vao, buffer: lb, count };
    }
    chunk.status = 'ready';
    if (!this.readyFired.has(chunk.key)) {
      this.readyFired.add(chunk.key);
      this.onTileReady?.(chunk.tile, chunk.detail, data.runways);
    }
  }

  private dispose(chunk: OsmChunk): void {
    const gl = this.gl;
    for (const b of chunk.buffers) gl.deleteBuffer(b);
    if (chunk.vao) gl.deleteVertexArray(chunk.vao);
    if (chunk.trees) {
      gl.deleteBuffer(chunk.trees.buffer);
      gl.deleteVertexArray(chunk.trees.vao);
    }
    if (chunk.lights) {
      gl.deleteBuffer(chunk.lights.buffer);
      gl.deleteVertexArray(chunk.lights.vao);
    }
    chunk.buffers = [];
    chunk.mesh = undefined;
    chunk.vao = undefined;
    chunk.trees = undefined;
    chunk.lights = undefined;
  }

  draw(
    renderer: Renderer,
    view: mat4,
    proj: mat4,
    camPos: vec3,
    sunDir: vec3,
    fogStart: number,
    fogEnd: number,
    lightsOn: boolean,
    pointSize: number,
  ): void {
    for (const c of this.renderList) {
      if (c.mesh) renderer.drawWorld(c.mesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
      if (c.trees) {
        const dx = camPos[0] - c.centerEnu[0];
        const dz = camPos[2] - c.centerEnu[2];
        if (Math.hypot(dx, dz) < 2000 + c.radius * 0.71) {
          renderer.drawTrees(c.trees.vao, c.trees.count, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
        }
      }
      if (c.lights && lightsOn) {
        renderer.drawLights(c.lights.vao, c.lights.count, c.offset, view, proj, camPos, pointSize, true);
      }
    }
  }

  /** Q40 gate: every near overlay tile must be ready (errored tiles retry until they are). */
  nearReady(cam: LatLon, radiusM: number): boolean {
    let near = 0;
    for (const c of this.chunks.values()) {
      if (c.detail !== 'full') continue;
      const center = tileCenter(c.tile);
      const [e, n] = latLonToEnu(cam, center.lat, center.lon, 0);
      if (Math.hypot(e, n) < radiusM) {
        near++;
        if (c.status !== 'ready') return false;
      }
    }
    return near > 0;
  }

  disposeAll(): void {
    for (const c of this.chunks.values()) this.dispose(c);
    this.chunks.clear();
    for (const w of this.workers) w.worker.terminate();
  }
}