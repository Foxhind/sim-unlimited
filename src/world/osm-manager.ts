import { mat4, vec3, vec4 } from 'gl-matrix';
import { RequestQueue, RetryableError } from '../engine/queue';
import type { Mesh, Renderer } from '../engine/renderer';
import { must } from '../engine/gl';
import { frustumPlanes, sphereInFrustum, type CameraWorld } from './chunks';
import { frameYaw, latLonToEnu, tileCenter, tileSizeMeters, type LatLon, type Tile } from './geodesy';
import { CONE_VERTICES } from './props-mesher';
import { NEUTRAL_GRADE, type ColourGrade } from './landsat-process';

/** within this slant distance a detailed tile draws its buildings; beyond, roof-coloured dots */
export const HOUSE_RADIUS_M = 3500;
const UNLOAD_DELAY_MS = 15000;
const RETRY_DELAY_MS = 5000;

interface PropSet {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

interface OsmChunk {
  tile: Tile;
  key: string;
  status: 'pending' | 'ready' | 'error';
  /** drape: areas, roads, points */
  mesh?: Mesh;
  /** buildings, and their far stand-in dots */
  bmesh?: Mesh;
  dots?: PropSet;
  trees?: PropSet;
  lights?: PropSet;
  /** night: lit windows (near), building lights (far), mast beacons (any distance) */
  windows?: PropSet;
  nightDots?: PropSet;
  beacons?: PropSet;
  /** masts beyond the building radius: vertical GL lines */
  mastLines?: PropSet;
  /** night: street-lit copy of the built-up terrain faces */
  glow?: Mesh;
  buffers: WebGLBuffer[];
  vaos: WebGLVertexArrayObject[];
  /** xyz: tile centre in the world; w: yaw of the tile frame (see frameYaw) */
  offset: vec4;
  centerEnu: vec3;
  radius: number;
  lastUsed: number;
  lastAttempt: number;
}

interface MeshPayload {
  vertices: ArrayBuffer;
  ramps: ArrayBuffer;
  bVertices: ArrayBuffer;
  bRamps: ArrayBuffer;
  dots: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  windows: ArrayBuffer;
  nightDots: ArrayBuffer;
  beacons: ArrayBuffer;
  mastLines: ArrayBuffer;
  glowVertices: ArrayBuffer;
  glowRamps: ArrayBuffer;
  runways: number;
}

interface WorkerSlot {
  worker: Worker;
  nextId: number;
  waiting: Map<number, { resolve: (m: MeshPayload) => void; reject: (e: unknown) => void }>;
}

/** far building lights at night: one device pixel (pointSize is 3 device pixels) */
export function farLightSize(pointSize: number): number {
  return Math.max(1, Math.round(pointSize / 3));
}

/**
 * OSM of the detailed z14 tiles (Q32, M2). The terrain manager decides which tiles are detailed
 * and shows one only when its OSM here is ready; this draws the OSM of exactly the shown ones.
 */
export class OsmManager {
  readonly chunks = new Map<string, OsmChunk>();
  renderList: OsmChunk[] = [];
  /** fired once per tile when its mesh first becomes ready (Q40 rebuild trigger) */
  onTileReady?: (tile: Tile, runways: number) => void;
  /** Landsat colour correction for tiles built from now on (relief inspector; invalidate() to rebuild) */
  grade: ColourGrade = NEUTRAL_GRADE;
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
        const msg = e.data as { type: string; id: number; retryable?: boolean; message?: string } & Partial<MeshPayload>;
        const w = slot.waiting.get(msg.id);
        if (!w) return;
        slot.waiting.delete(msg.id);
        const buf = (b?: ArrayBuffer) => b ?? new ArrayBuffer(0);
        if (msg.type === 'mesh') {
          w.resolve({
            vertices: buf(msg.vertices), ramps: buf(msg.ramps),
            bVertices: buf(msg.bVertices), bRamps: buf(msg.bRamps), dots: buf(msg.dots),
            trees: buf(msg.trees), lights: buf(msg.lights),
            windows: buf(msg.windows), nightDots: buf(msg.nightDots),
            beacons: buf(msg.beacons), mastLines: buf(msg.mastLines),
            glowVertices: buf(msg.glowVertices), glowRamps: buf(msg.glowRamps), runways: msg.runways ?? 0,
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
      draws += (c.mesh ? 1 : 0) + (c.bmesh || c.dots ? 1 : 0) + (c.trees ? 1 : 0) + (c.lights ? 1 : 0) +
        (c.windows || c.nightDots ? 1 : 0) + (c.beacons ? 1 : 0) + (c.mastLines ? 1 : 0) + (c.glow ? 1 : 0);
    }
    return { chunks: this.chunks.size, pending, drawCalls: draws, errors };
  }

  /** the OSM of tile `key` (z/x/y) is loaded and uploaded */
  ready(key: string): boolean {
    return this.chunks.get(key)?.status === 'ready';
  }

  private refreshOffset(c: OsmChunk): void {
    const center = tileCenter(c.tile);
    const [e, n] = latLonToEnu(this.origin, center.lat, center.lon, 0);
    vec3.set(c.centerEnu, e, 0, -n);
    vec4.set(c.offset, e, 0, -n, frameYaw(this.origin, center));
  }

  /** `tiles`: the detailed tiles the terrain wants; `shown`: those it draws this frame */
  update(cam: CameraWorld, view: mat4, proj: mat4, now: number, origin: LatLon, tiles: Tile[], shown: Set<string>): void {
    if (origin !== this.origin) {
      this.origin = origin;
      for (const c of this.chunks.values()) this.refreshOffset(c);
    }
    mat4.multiply(this.vp, proj, view);
    this.planes = frustumPlanes(this.vp);

    const needed = new Set<string>();
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      needed.add(key);
      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = {
          tile, key,
          status: 'pending',
          buffers: [],
          vaos: [],
          offset: vec4.create(),
          centerEnu: vec3.create(),
          radius: tileSizeMeters(tile),
          lastUsed: now,
          lastAttempt: now,
        };
        this.refreshOffset(chunk);
        this.chunks.set(key, chunk);
        this.request(chunk, cam);
      } else if (chunk.status === 'error' && now - chunk.lastAttempt > RETRY_DELAY_MS) {
        chunk.status = 'pending';
        chunk.lastAttempt = now;
        this.request(chunk, cam);
      }
      chunk.lastUsed = now;
    }

    this.renderList = [];
    for (const key of shown) {
      const c = this.chunks.get(key);
      if (!c || c.status !== 'ready') continue;
      c.lastUsed = now;
      if (sphereInFrustum(this.planes, c.centerEnu, c.radius + 2000)) this.renderList.push(c);
    }

    for (const [key, c] of this.chunks) {
      if (!needed.has(key) && !shown.has(key) && now - c.lastUsed > UNLOAD_DELAY_MS) {
        this.queue.cancel(key);
        this.dispose(c);
        this.chunks.delete(key);
      }
    }
  }

  private request(chunk: OsmChunk, cam: CameraWorld): void {
    // nearest first
    const priority = Math.hypot(chunk.centerEnu[0] - cam.pos[0], chunk.centerEnu[2] - cam.pos[2]);
    void this.queue
      .submit(chunk.key, priority, () => this.buildInWorker(chunk))
      .then((data) => this.upload(chunk, data))
      .catch(() => {
        chunk.status = 'error';
        chunk.lastAttempt = performance.now();
      });
  }

  private buildInWorker(chunk: OsmChunk): Promise<MeshPayload> {
    const slot = this.workers[this.rr++ % this.workers.length];
    const id = slot.nextId++;
    return new Promise((resolve, reject) => {
      slot.waiting.set(id, { resolve, reject });
      slot.worker.postMessage({ type: 'osm', id, tile: chunk.tile, detail: 'full', grade: this.grade });
    });
  }

  /** interleaved pos+normal (stride 24) with Uint16 ramps, as the world shader expects */
  private worldMesh(chunk: OsmChunk, vertices: ArrayBuffer, ramps: ArrayBuffer): Mesh | undefined {
    if (ramps.byteLength === 0) return undefined;
    const gl = this.gl;
    const vao = must(gl.createVertexArray(), 'osm VAO');
    gl.bindVertexArray(vao);
    const vb = must(gl.createBuffer(), 'osm vertices');
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const rb = must(gl.createBuffer(), 'osm ramps');
    gl.bindBuffer(gl.ARRAY_BUFFER, rb);
    gl.bufferData(gl.ARRAY_BUFFER, ramps, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, 2, 0); // Uint16 ramps (VGA colours)
    gl.bindVertexArray(null);
    chunk.buffers.push(vb, rb);
    chunk.vaos.push(vao);
    return { vao, vertexCount: ramps.byteLength / 2 };
  }

  /** x, y, z, palette index per point */
  private points(chunk: OsmChunk, data: ArrayBuffer): PropSet | undefined {
    if (data.byteLength === 0) return undefined;
    const gl = this.gl;
    const vao = must(gl.createVertexArray(), 'point VAO');
    gl.bindVertexArray(vao);
    const buffer = must(gl.createBuffer(), 'points');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
    chunk.buffers.push(buffer);
    chunk.vaos.push(vao);
    return { vao, buffer, count: data.byteLength / 16 };
  }

  private upload(chunk: OsmChunk, data: MeshPayload): void {
    if (this.chunks.get(chunk.key) !== chunk) return; // unloaded (or replaced) while in flight
    this.dispose(chunk);
    const gl = this.gl;
    chunk.mesh = this.worldMesh(chunk, data.vertices, data.ramps);
    chunk.bmesh = this.worldMesh(chunk, data.bVertices, data.bRamps);
    chunk.dots = this.points(chunk, data.dots);
    chunk.lights = this.points(chunk, data.lights);
    chunk.windows = this.points(chunk, data.windows);
    chunk.nightDots = this.points(chunk, data.nightDots);
    chunk.beacons = this.points(chunk, data.beacons);
    chunk.mastLines = this.points(chunk, data.mastLines);
    chunk.glow = this.worldMesh(chunk, data.glowVertices, data.glowRamps);
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
      chunk.buffers.push(ib);
      chunk.vaos.push(vao);
      chunk.trees = { vao, buffer: ib, count };
    }
    chunk.status = 'ready';
    if (!this.readyFired.has(chunk.key)) {
      this.readyFired.add(chunk.key);
      this.onTileReady?.(chunk.tile, data.runways);
    }
  }

  private dispose(chunk: OsmChunk): void {
    const gl = this.gl;
    for (const b of chunk.buffers) gl.deleteBuffer(b);
    for (const v of chunk.vaos) gl.deleteVertexArray(v);
    chunk.buffers = [];
    chunk.vaos = [];
    chunk.mesh = chunk.bmesh = undefined;
    chunk.dots = chunk.trees = chunk.lights = undefined;
    chunk.windows = chunk.nightDots = chunk.beacons = chunk.mastLines = undefined;
    chunk.glow = undefined;
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
      const dx = camPos[0] - c.centerEnu[0];
      const dz = camPos[2] - c.centerEnu[2];
      const slant = Math.hypot(dx, dz, camPos[1]);
      // the ground of built-up terrain faces, street-lit (renderer.nightGlow), just above the terrain
      if (c.glow && lightsOn) renderer.drawWorld(c.glow, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
      if (c.mesh) renderer.drawWorld(c.mesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
      if (slant < HOUSE_RADIUS_M) {
        if (c.bmesh) renderer.drawWorld(c.bmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
        if (c.windows && lightsOn) {
          renderer.drawLights(c.windows.vao, c.windows.count, c.offset, view, proj, camPos, Math.max(2, pointSize * 0.67), true);
        }
      } else {
        // far buildings: fat roof-coloured dots at their centroids by day, thin (1 px) yellow/white lights by night
        const dots = lightsOn ? c.nightDots : c.dots;
        if (dots) renderer.drawLights(dots.vao, dots.count, c.offset, view, proj, camPos, lightsOn ? farLightSize(pointSize) : pointSize * 1.5, true);
        if (c.mastLines) {
          renderer.drawLights(c.mastLines.vao, c.mastLines.count, c.offset, view, proj, camPos, 1, true, 'lines');
        }
      }
      if (c.beacons && lightsOn) {
        renderer.drawLights(c.beacons.vao, c.beacons.count, c.offset, view, proj, camPos, pointSize, true);
      }
      if (c.trees && Math.hypot(dx, dz) < 2000 + c.radius * 0.71) {
        renderer.drawTrees(c.trees.vao, c.trees.count, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
      }
      if (c.lights && lightsOn) {
        renderer.drawLights(c.lights.vao, c.lights.count, c.offset, view, proj, camPos, pointSize, true);
      }
    }
  }

  /** Drop one tile (or all with no argument): it is requested again when the terrain wants it. */
  invalidate(tile?: Tile): void {
    for (const [key, c] of this.chunks) {
      if (tile && key !== `${tile.z}/${tile.x}/${tile.y}`) continue;
      this.queue.cancel(key);
      this.dispose(c);
      this.chunks.delete(key);
      this.readyFired.delete(key);
    }
  }

  disposeAll(): void {
    for (const c of this.chunks.values()) this.dispose(c);
    this.chunks.clear();
    for (const w of this.workers) w.worker.terminate();
  }
}
