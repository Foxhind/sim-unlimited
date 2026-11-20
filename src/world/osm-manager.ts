import { mat4, vec3, vec4 } from 'gl-matrix';
import { RequestQueue, RetryableError } from '../engine/queue';
import type { Mesh, Renderer } from '../engine/renderer';
import { must } from '../engine/gl';
import { frustumPlanes, sphereInFrustum, type CameraWorld } from './chunks';
import { frameYaw, latLonToEnu, tileCenter, tileSizeMeters, type LatLon, type Tile } from './geodesy';
import { WINDOW_ATTR_FLOATS } from './building-mesher';
import { TREE_GEOMETRY, TREE_MESHES, TREE_STRIDE, TREE_VERTEX_FLOATS } from './props-mesher';
import { NEUTRAL_GRADE, type ColourGrade } from './landsat-process';

/** pitch markings toward the eye: metres, plus per metre of distance (renderer.drawLights pull) */
const PITCH_LINE_PULL = [0.05, 0.0004] as const;

/** within this slant distance a detailed tile draws its buildings and road ribbons; beyond, wall + roof dots and 1 px road lines */
export const HOUSE_RADIUS_M = 3500;
const UNLOAD_DELAY_MS = 15000;
const RETRY_DELAY_MS = 5000;

interface PropSet {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

/** the instances of one tree type: their VAO and the type's slice of TREE_GEOMETRY */
interface TreeSet extends PropSet {
  first: number;
  vertexCount: number;
}

interface OsmChunk {
  tile: Tile;
  key: string;
  status: 'pending' | 'ready' | 'error';
  /** drape: areas, roads, points */
  mesh?: Mesh;
  /** road ribbons (near) and their far 1 px lines */
  rmesh?: Mesh;
  /** water areas and river ribbons: drawn after every drape, without depth writes, so roads win */
  wmesh?: Mesh;
  roadLines?: PropSet;
  /** pitch markings (near) */
  pitchLines?: PropSet;
  /** night: lamp heads near, and far the street-lit roads' dotted line */
  lamps?: PropSet;
  /** buildings, and their far stand-in dots */
  bmesh?: Mesh;
  dots?: PropSet;
  /** one set per tree type present */
  trees?: TreeSet[];
  lights?: PropSet;
  /** night: roof obstruction lights (near; the lit windows are on the walls), building lights (far), mast beacons (any distance) */
  roofLights?: PropSet;
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
  bWindows: ArrayBuffer;
  dots: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  roofLights: ArrayBuffer;
  nightDots: ArrayBuffer;
  beacons: ArrayBuffer;
  mastLines: ArrayBuffer;
  glowVertices: ArrayBuffer;
  glowRamps: ArrayBuffer;
  rVertices: ArrayBuffer;
  rRamps: ArrayBuffer;
  rAttrs: ArrayBuffer;
  wVertices: ArrayBuffer;
  wRamps: ArrayBuffer;
  roadLines: ArrayBuffer;
  pitchLines: ArrayBuffer;
  lamps: ArrayBuffer;
  runways: number;
  coast: boolean;
}

interface WorkerSlot {
  worker: Worker;
  nextId: number;
  waiting: Map<number, { resolve: (m: MeshPayload) => void; reject: (e: unknown) => void }>;
}

/** far building lights at night: one device pixel (pointSize is 3 device pixels) */
/** street lamp heads, near and far alike (far they are the street-lit roads' dotted line) */
export function lampSize(pointSize: number): number {
  return Math.max(2, pointSize * 0.67);
}

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
  /** a tile's OSM arrived: `runways` and `coast` reshape its terrain, which then needs a rebuild */
  onTileReady?: (tile: Tile, runways: number, coast: boolean) => void;
  /** Landsat colour correction for tiles built from now on (relief inspector; invalidate() to rebuild) */
  grade: ColourGrade = NEUTRAL_GRADE;
  private readyFired = new Set<string>();
  private origin: LatLon;
  private queue = new RequestQueue(2);
  private workers: WorkerSlot[] = [];
  private rr = 0;
  private vp = mat4.create();
  private planes: Float32Array[] = [];
  private treeGeometry: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext, origin: LatLon, workerCount = 2) {
    this.origin = origin;
    this.treeGeometry = must(gl.createBuffer(), 'tree geometry');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.treeGeometry);
    gl.bufferData(gl.ARRAY_BUFFER, TREE_GEOMETRY, gl.STATIC_DRAW);
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
            bVertices: buf(msg.bVertices), bRamps: buf(msg.bRamps), bWindows: buf(msg.bWindows), dots: buf(msg.dots),
            trees: buf(msg.trees), lights: buf(msg.lights),
            roofLights: buf(msg.roofLights), nightDots: buf(msg.nightDots),
            beacons: buf(msg.beacons), mastLines: buf(msg.mastLines),
            glowVertices: buf(msg.glowVertices), glowRamps: buf(msg.glowRamps),
            rVertices: buf(msg.rVertices), rRamps: buf(msg.rRamps), rAttrs: buf(msg.rAttrs), roadLines: buf(msg.roadLines), pitchLines: buf(msg.pitchLines),
            wVertices: buf(msg.wVertices), wRamps: buf(msg.wRamps),
            lamps: buf(msg.lamps), runways: msg.runways ?? 0, coast: msg.coast ?? false,
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
      draws += (c.mesh ? 1 : 0) + (c.rmesh || c.roadLines ? 1 : 0) + (c.lamps ? 1 : 0) + (c.bmesh || c.dots ? 1 : 0) + (c.trees?.length ?? 0) + (c.lights ? 1 : 0) +
        (c.roofLights || c.nightDots ? 1 : 0) + (c.beacons ? 1 : 0) + (c.mastLines ? 1 : 0) + (c.glow ? 1 : 0);
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

  /**
   * interleaved pos+normal (stride 24) with Uint32 face colours, as the world shader expects; for
   * buildings also the facade window attributes (WORLD_VS aWinUV, aWinEdge)
   */
  private worldMesh(chunk: OsmChunk, vertices: ArrayBuffer, ramps: ArrayBuffer, windows?: ArrayBuffer): Mesh | undefined {
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
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0); // Uint32 face colours (palette.ts)
    chunk.buffers.push(vb, rb);
    if (windows && windows.byteLength / (WINDOW_ATTR_FLOATS * 4) === ramps.byteLength / 4) {
      const wb = must(gl.createBuffer(), 'osm windows');
      gl.bindBuffer(gl.ARRAY_BUFFER, wb);
      gl.bufferData(gl.ARRAY_BUFFER, windows, gl.STATIC_DRAW);
      const stride = WINDOW_ATTR_FLOATS * 4;
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 3, gl.FLOAT, false, stride, 8);
      chunk.buffers.push(wb);
    }
    gl.bindVertexArray(null);
    chunk.vaos.push(vao);
    return { vao, vertexCount: ramps.byteLength / 4 };
  }

  /** x, y, z and a colour value per point (palette.ts pointValue: a LUT index, or an RGB colour) */
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
    chunk.bmesh = this.worldMesh(chunk, data.bVertices, data.bRamps, data.bWindows);
    chunk.dots = this.points(chunk, data.dots);
    chunk.lights = this.points(chunk, data.lights);
    chunk.roofLights = this.points(chunk, data.roofLights);
    chunk.nightDots = this.points(chunk, data.nightDots);
    chunk.beacons = this.points(chunk, data.beacons);
    chunk.mastLines = this.points(chunk, data.mastLines);
    chunk.glow = this.worldMesh(chunk, data.glowVertices, data.glowRamps);
    chunk.rmesh = this.worldMesh(chunk, data.rVertices, data.rRamps, data.rAttrs);
    chunk.wmesh = this.worldMesh(chunk, data.wVertices, data.wRamps);
    chunk.roadLines = this.points(chunk, data.roadLines);
    chunk.pitchLines = this.points(chunk, data.pitchLines);
    chunk.lamps = this.points(chunk, data.lamps);
    if (data.trees.byteLength > 0) {
      // instances come sorted by type: one VAO per type, its instance attributes starting at the type's run
      const inst = new Float32Array(data.trees);
      const total = inst.length / TREE_STRIDE;
      const ib = must(gl.createBuffer(), 'tree instances');
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
      chunk.buffers.push(ib);
      const sets: TreeSet[] = [];
      const vStride = TREE_VERTEX_FLOATS * 4, iStride = TREE_STRIDE * 4;
      for (let start = 0; start < total;) {
        const type = inst[start * TREE_STRIDE + 5];
        let end = start + 1;
        while (end < total && inst[end * TREE_STRIDE + 5] === type) end++;
        const mesh = TREE_MESHES[Math.min(TREE_MESHES.length - 1, Math.max(0, type | 0))];
        const vao = must(gl.createVertexArray(), 'tree VAO');
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.treeGeometry);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, vStride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, vStride, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, vStride, 24);
        gl.bindBuffer(gl.ARRAY_BUFFER, ib);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 3, gl.FLOAT, false, iStride, start * iStride);
        gl.vertexAttribDivisor(3, 1);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 2, gl.FLOAT, false, iStride, start * iStride + 12);
        gl.vertexAttribDivisor(4, 1);
        gl.enableVertexAttribArray(5);
        gl.vertexAttribPointer(5, 1, gl.FLOAT, false, iStride, start * iStride + 24);
        gl.vertexAttribDivisor(5, 1);
        gl.enableVertexAttribArray(6);
        gl.vertexAttribPointer(6, 1, gl.FLOAT, false, iStride, start * iStride + 28);
        gl.vertexAttribDivisor(6, 1);
        gl.bindVertexArray(null);
        chunk.vaos.push(vao);
        sets.push({ vao, buffer: ib, count: end - start, first: mesh.first, vertexCount: mesh.count });
        start = end;
      }
      chunk.trees = sets;
    }
    chunk.status = 'ready';
    if (!this.readyFired.has(chunk.key)) {
      this.readyFired.add(chunk.key);
      this.onTileReady?.(chunk.tile, data.runways, data.coast);
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
    chunk.roofLights = chunk.nightDots = chunk.beacons = chunk.mastLines = undefined;
    chunk.glow = chunk.rmesh = chunk.wmesh = undefined;
    chunk.roadLines = chunk.pitchLines = chunk.lamps = undefined;
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
      // the ground of built-up terrain faces, street-lit (renderer.nightGlow), just above the terrain
      if (c.glow && lightsOn) renderer.drawWorld(c.glow, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
      if (c.mesh) renderer.drawWorld(c.mesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
    }
    // water over every tile's drape, but leaving no depth: roads (and all drawn after) always win over it
    for (const c of this.renderList) {
      if (c.wmesh) renderer.drawWorld(c.wmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd, 0, false);
    }
    for (const c of this.renderList) {
      const dx = camPos[0] - c.centerEnu[0];
      const dz = camPos[2] - c.centerEnu[2];
      const slant = Math.hypot(dx, dz, camPos[1]);
      if (slant < HOUSE_RADIUS_M) {
        if (c.rmesh) renderer.drawWorld(c.rmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
        // pitch markings: 1 px white paint, pulled a hair toward the eye off the pitch under them
        if (c.pitchLines) renderer.drawLights(c.pitchLines.vao, c.pitchLines.count, c.offset, view, proj, camPos, 1, true, 'lines', false, PITCH_LINE_PULL);
        if (c.bmesh) {
          // windows on the facades: glass by day, about a third of them lit at night (no window points near)
          renderer.windows = lightsOn ? 'lit' : 'glass';
          renderer.drawWorld(c.bmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
          renderer.windows = 'off';
        }
        if (c.lamps && lightsOn) {
          renderer.drawLights(c.lamps.vao, c.lamps.count, c.offset, view, proj, camPos, lampSize(pointSize), true);
        }
        if (c.roofLights && lightsOn) {
          renderer.drawLights(c.roofLights.vao, c.roofLights.count, c.offset, view, proj, camPos, Math.max(2, pointSize * 0.67), true);
        }
      } else {
        // far buildings by day: a 1 px roof-coloured dot over a 1 px wall-coloured one; by night only
        // their 1 px yellow/white lights, no roof
        if (lightsOn) {
          if (c.nightDots) renderer.drawLights(c.nightDots.vao, c.nightDots.count, c.offset, view, proj, camPos, farLightSize(pointSize), true);
        } else if (c.dots) {
          renderer.drawLights(c.dots.vao, c.dots.count, c.offset, view, proj, camPos, farLightSize(pointSize), true, 'points', true);
        }
        // far roads: 1 px asphalt lines on the terrain by day; at night only the street-lit ones, as a
        // dotted line of their lamps: the same lamps, the same size as near
        if (lightsOn) {
          if (c.lamps) renderer.drawLights(c.lamps.vao, c.lamps.count, c.offset, view, proj, camPos, lampSize(pointSize), true);
        } else if (c.roadLines) {
          renderer.drawLights(c.roadLines.vao, c.roadLines.count, c.offset, view, proj, camPos, 1, true, 'lines');
        }
        if (c.mastLines) {
          renderer.drawLights(c.mastLines.vao, c.mastLines.count, c.offset, view, proj, camPos, 1, true, 'lines');
        }
      }
      if (c.beacons && lightsOn) {
        renderer.drawLights(c.beacons.vao, c.beacons.count, c.offset, view, proj, camPos, pointSize, true);
      }
      if (c.trees && Math.hypot(dx, dz) < 2000 + c.radius * 0.71) {
        for (const t of c.trees) renderer.drawTrees(t.vao, t.count, t.first, t.vertexCount, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
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
