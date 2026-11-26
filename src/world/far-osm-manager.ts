import { mat4, vec3, vec4 } from 'gl-matrix';
import { must } from '../engine/gl';
import { RequestQueue, RetryableError } from '../engine/queue';
import type { Renderer } from '../engine/renderer';
import { frustumPlanes, sphereInFrustum, type CameraWorld } from './chunks';
import { frameYaw, latLonToEnu, tileCenter, tileSizeMeters, type LatLon, type Tile } from './geodesy';
import { farLightSize } from './osm-manager';
import { FAR_WINDOWS } from '../engine/palette';

const UNLOAD_DELAY_MS = 15000;
const RETRY_DELAY_MS = 10000;
/**
 * Depth pull of the far ring (renderer.drawLights `pull`): its heights are the DEM's, and the
 * coarse terrain under it is a simplified TIN that may lie a few tens of metres above them.
 */
const FAR_PULL: readonly [number, number] = [30, 0.004];

interface PointSet {
  vao: WebGLVertexArrayObject;
  count: number;
}

interface FarChunk {
  tile: Tile;
  key: string;
  status: 'pending' | 'ready' | 'error';
  dots?: PointSet;
  nightDots?: PointSet;
  roadLines?: PointSet;
  buffers: WebGLBuffer[];
  vaos: WebGLVertexArrayObject[];
  /** xyz: tile centre in the world; w: yaw of the tile frame */
  offset: vec4;
  centerEnu: vec3;
  radius: number;
  lastUsed: number;
  lastAttempt: number;
}

interface Payload {
  dots: ArrayBuffer;
  nightDots: ArrayBuffer;
  roadLines: ArrayBuffer;
}

/**
 * The far OSM ring (far-osm.ts): wall + roof dots, night lights and road lines of the z14 tiles
 * beyond the detailed ones, out to FAR_OSM_RADIUS_M, over the coarse terrain.
 */
export class FarOsmManager {
  readonly chunks = new Map<string, FarChunk>();
  private renderList: FarChunk[] = [];
  private origin: LatLon;
  private queue = new RequestQueue(4);
  private workers: Worker[] = [];
  private waiting = new Map<number, { resolve: (p: Payload) => void; reject: (e: unknown) => void }>();
  private nextId = 1;
  private rr = 0;
  private vp = mat4.create();

  constructor(private gl: WebGL2RenderingContext, origin: LatLon, workerCount = 2) {
    this.origin = origin;
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('../workers/far-osm.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const msg = e.data as { type: string; id: number; retryable?: boolean; message?: string } & Partial<Payload>;
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        const buf = (b?: ArrayBuffer) => b ?? new ArrayBuffer(0);
        if (msg.type === 'far') w.resolve({ dots: buf(msg.dots), nightDots: buf(msg.nightDots), roadLines: buf(msg.roadLines) });
        else if (msg.retryable) w.reject(new RetryableError(0, msg.message));
        else w.reject(new Error(msg.message));
      };
      this.workers.push(worker);
    }
  }

  get stats(): { chunks: number; ready: number; pending: number; errors: number } {
    let ready = 0, pending = 0, errors = 0;
    for (const c of this.chunks.values()) {
      if (c.status === 'ready') ready++;
      else if (c.status === 'pending') pending++;
      else errors++;
    }
    return { chunks: this.chunks.size, ready, pending, errors };
  }

  private refreshOffset(c: FarChunk): void {
    const center = tileCenter(c.tile);
    const [e, n] = latLonToEnu(this.origin, center.lat, center.lon, 0);
    vec3.set(c.centerEnu, e, 0, -n);
    vec4.set(c.offset, e, 0, -n, frameYaw(this.origin, center));
  }

  /** `tiles`: the ring this frame (far-osm.ts farOsmTiles); `shownDetail`: detailed tiles drawn this frame */
  update(cam: CameraWorld, view: mat4, proj: mat4, now: number, origin: LatLon, tiles: Tile[], shownDetail: Set<string>): void {
    if (origin !== this.origin) {
      this.origin = origin;
      for (const c of this.chunks.values()) this.refreshOffset(c);
    }
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      let c = this.chunks.get(key);
      if (!c) {
        c = {
          tile, key, status: 'pending', buffers: [], vaos: [],
          offset: vec4.create(), centerEnu: vec3.create(), radius: tileSizeMeters(tile), lastUsed: now, lastAttempt: now,
        };
        this.refreshOffset(c);
        this.chunks.set(key, c);
        this.request(c, cam);
      } else if (c.status === 'error' && now - c.lastAttempt > RETRY_DELAY_MS) {
        c.status = 'pending';
        c.lastAttempt = now;
        this.request(c, cam);
      }
      c.lastUsed = now;
    }

    mat4.multiply(this.vp, proj, view);
    const planes = frustumPlanes(this.vp);
    this.renderList = [];
    for (const [key, c] of this.chunks) {
      // a tile that turned detailed keeps its far dots until its detailed OSM is drawn
      if (c.status === 'ready' && !shownDetail.has(key) && now - c.lastUsed <= UNLOAD_DELAY_MS &&
        sphereInFrustum(planes, c.centerEnu, c.radius + 2000)) {
        this.renderList.push(c);
      }
      if (now - c.lastUsed > UNLOAD_DELAY_MS) {
        this.queue.cancel(key);
        this.dispose(c);
        this.chunks.delete(key);
      }
    }
  }

  private request(c: FarChunk, cam: CameraWorld): void {
    const priority = Math.hypot(c.centerEnu[0] - cam.pos[0], c.centerEnu[2] - cam.pos[2]);
    void this.queue
      .submit(c.key, priority, () => this.build(c.tile))
      .then((p) => this.upload(c, p))
      .catch(() => {
        c.status = 'error';
        c.lastAttempt = performance.now();
      });
  }

  private build(tile: Tile): Promise<Payload> {
    const worker = this.workers[this.rr++ % this.workers.length];
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, tile });
    });
  }

  private points(c: FarChunk, data: ArrayBuffer): PointSet | undefined {
    if (data.byteLength === 0) return undefined;
    const gl = this.gl;
    const vao = must(gl.createVertexArray(), 'far OSM VAO');
    gl.bindVertexArray(vao);
    const buffer = must(gl.createBuffer(), 'far OSM points');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
    c.buffers.push(buffer);
    c.vaos.push(vao);
    return { vao, count: data.byteLength / 16 };
  }

  private upload(c: FarChunk, p: Payload): void {
    if (this.chunks.get(c.key) !== c) return; // unloaded while in flight
    this.dispose(c);
    c.dots = this.points(c, p.dots);
    c.nightDots = this.points(c, p.nightDots);
    c.roadLines = this.points(c, p.roadLines);
    c.status = 'ready';
  }

  private dispose(c: FarChunk): void {
    for (const b of c.buffers) this.gl.deleteBuffer(b);
    for (const v of c.vaos) this.gl.deleteVertexArray(v);
    c.buffers = [];
    c.vaos = [];
    c.dots = c.nightDots = c.roadLines = undefined;
  }

  /**
   * as the detailed tiles' far mode (OsmManager.draw): 1 px wall + roof dots and road lines by day,
   * window cell dots by night; `dayWindows`: the window dots over the day's while the windows come
   * on before the dusk or go off after the dawn (palette.ts windowsOn, the share in renderer.litShare)
   */
  draw(renderer: Renderer, view: mat4, proj: mat4, camPos: vec3, lightsOn: boolean, pointSize: number, fogStart = 1e9, fogEnd = 2e9, dayWindows = false): void {
    const px = farLightSize(pointSize);
    for (const c of this.renderList) {
      if (!lightsOn) {
        if (c.roadLines) renderer.drawLights(c.roadLines.vao, c.roadLines.count, c.offset, view, proj, camPos, 1, true, 'lines', false, FAR_PULL);
        if (c.dots) renderer.drawLights(c.dots.vao, c.dots.count, c.offset, view, proj, camPos, px, true, 'points', true, FAR_PULL);
      }
      if ((lightsOn || dayWindows) && c.nightDots) {
        renderer.windowCellM = FAR_WINDOWS.CELL_M * FAR_WINDOWS.FAR_RING_SCALE;
        renderer.pointFog = [fogStart, fogEnd];
        renderer.drawLights(c.nightDots.vao, c.nightDots.count, c.offset, view, proj, camPos, px, true, 'points', false, FAR_PULL);
        renderer.windowCellM = FAR_WINDOWS.CELL_M;
        renderer.pointFog = [1e9, 2e9];
      }
    }
  }

  /** draw calls this frame (HUD) */
  get drawCalls(): number {
    return this.renderList.reduce((n, c) => n + (c.dots ? 1 : 0) + (c.roadLines ? 1 : 0), 0);
  }

  disposeAll(): void {
    for (const c of this.chunks.values()) this.dispose(c);
    this.chunks.clear();
    for (const w of this.workers) w.terminate();
  }
}
