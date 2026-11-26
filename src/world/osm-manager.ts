import { mat4, vec3, vec4 } from 'gl-matrix';
import { RequestQueue, RetryableError, tileWorkerCount } from '../engine/queue';
import { osmSourceMode } from './osm-source';
import type { Mesh, Renderer } from '../engine/renderer';
import { bindIndex } from '../engine/indexed';
import { must } from '../engine/gl';
import { CULL_MARGIN_M, frustumPlanes, slantTo, sphereInFrustum, type CameraWorld } from './chunks';
import { frameYaw, latLonToEnu, tileCenter, tileSizeMeters, type LatLon, type Tile } from './geodesy';
import { GREENHOUSE, WINDOW_ATTR_FLOATS } from './building-mesher';
import { FLASH_STRIDE, litFlashes } from './lighthouse-mesher';
import { LENS_VERTICES, litLenses, MAX_LIT, signalAspects, SIGNAL_STRIDE } from './traffic-signals';
import { INSTANCE, lampLenses, TREE_GEOMETRY, TREE_MESHES, TREE_STRIDE, TREE_TYPES, TREE_VERTEX_FLOATS, treeKeep } from './props-mesher';
import { NEUTRAL_GRADE, type ColourGrade } from './landsat-process';
import type { AreaStyles } from './area-styles';
import { ALL_STRUCTURES, shownRanges, STRUCTURE } from './structure-kinds';

/** pitch markings toward the eye: metres, plus per metre of distance (renderer.drawLights pull) */
const PITCH_LINE_PULL = [0.05, 0.0004] as const;

/** within this slant distance a detailed tile draws its buildings and road ribbons; beyond, wall + roof dots and 1 px road lines (at night its lit buildings still) */
/** trees cast shadows while a shadow-map texel is no coarser than this, m (a crown is a few metres) */
const SHADOW_TREE_TEXEL_M = 1.5;
/** how far the relief may stand above or below the shadow box's ground, m (drawShadows) */
const SHADOW_RELIEF_M = 1500;

export const HOUSE_RADIUS_M = 3500;
/** the drape (areas and covers on the terrain's faces) is drawn within this slant of the eye, m (draw) */
export const DRAPE_RADIUS_M = HOUSE_RADIUS_M;
/**
 * Building LOD: a tile whose nearest buildings are farther than this (slant, m) draws them without
 * their small parts (parapets, roof plant, doors, masts: building-mesher coreVertexCount), each a
 * pixel or two from here on.
 */
export const BUILDING_DETAIL_M = 1500;
/**
 * Prop LOD: wall air conditioners (0.8 m) and lamp posts (0.24 m thick) on a tile whose nearest
 * point is farther than this (slant, m) are not drawn: under a pixel from there on.
 */
/** power line conductors are drawn within this slant distance of a tile's nearest part, m */
const WIRE_RADIUS_M = 4000;
/** a lighthouse's flash drawn this much larger than a beacon */
const FLASH_SIZE = 2;
const PROP_DETAIL_M: Partial<Record<number, number>> ={ [INSTANCE.AC]: 1000, [INSTANCE.LAMP]: 1500, [INSTANCE.SIGNAL]: 1000 };
const UNLOAD_DELAY_MS = 15000;
const RETRY_DELAY_MS = 5000;

interface PropSet {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

/** the instances of one tree type: their VAO and the type's slice of TREE_GEOMETRY */
interface TreeSet extends PropSet {
  /** the instance type (props-mesher: tree types, then INSTANCE) */
  type: number;
  first: number;
  vertexCount: number;
}

/** a world mesh rewritten while drawn: its vertex (pos + normal) and face colour buffers */
interface LensSet {
  mesh: Mesh;
  vertices: WebGLBuffer;
  ramps: WebGLBuffer;
}

interface OsmChunk {
  tile: Tile;
  key: string;
  status: 'pending' | 'ready' | 'error';
  /** drape: areas, roads, points */
  mesh?: Mesh;
  /** road ribbons (near) and their far 1 px lines */
  rmesh?: Mesh;
  /** water areas and river ribbons: drawn after every drape */
  wmesh?: Mesh;
  roadLines?: PropSet;
  /** pitch markings (near) */
  pitchLines?: PropSet;
  /** night: lamp heads near, and far the street-lit roads' dotted line */
  lamps?: PropSet;
  /** night, near: the street lamps' lit lenses (props-mesher lampLenses), self-lit faces */
  lampLenses?: Mesh;
  /** buildings, and their far stand-in dots */
  bmesh?: Mesh;
  /** the same buildings without their small parts (the same VAO, its first vertices): the far LOD */
  bcore?: Mesh;
  /** greenhouse glass: drawn blended with the sun's glints after everything else of the near tiles */
  gmesh?: Mesh;
  /** the structure kind of each building vertex (structure-kinds KindRuns pairs) */
  bKinds?: Uint32Array;
  /** bmesh and bcore cut to the shown structure kinds, for the mask they were cut for */
  bParts?: { mask: number; near: Mesh[]; far: Mesh[] };
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
  /** power line conductors: 1 px GL lines within WIRE_RADIUS_M */
  wires?: PropSet;
  /** night: the lighthouses' lights (lighthouse-mesher FLASH_STRIDE), and the points of those lit now, written each frame */
  flashData?: Float32Array;
  flashes?: PropSet;
  /**
   * the traffic lights (traffic-signals SIGNAL_STRIDE), the lenses lit of each as last written, and
   * the lit lenses' faces: rewritten when any light changes
   */
  signalData?: Float32Array;
  signalLit?: Uint8Array;
  lenses?: LensSet;
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
  /** triangle lists into the welded vertices (weld.ts) of the drape, buildings, glass, roads, water; empty: the vertices are the list */
  index: ArrayBuffer;
  bIndex: ArrayBuffer;
  gIndex: ArrayBuffer;
  rIndex: ArrayBuffer;
  wIndex: ArrayBuffer;
  /** per vertex of the drape, the roads and the water: its depth level (WORLD_VS aDepthLevel), or empty */
  levels: ArrayBuffer;
  rLevels: ArrayBuffer;
  wLevels: ArrayBuffer;
  bVertices: ArrayBuffer;
  bRamps: ArrayBuffer;
  bWindows: ArrayBuffer;
  bCore: number;
  gVertices: ArrayBuffer;
  gRamps: ArrayBuffer;
  bKinds: ArrayBuffer;
  dots: ArrayBuffer;
  trees: ArrayBuffer;
  lights: ArrayBuffer;
  roofLights: ArrayBuffer;
  nightDots: ArrayBuffer;
  beacons: ArrayBuffer;
  mastLines: ArrayBuffer;
  wires: ArrayBuffer;
  flashes: ArrayBuffer;
  signals: ArrayBuffer;
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
  roads: boolean;
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

/** what of a tile's OSM is drawn (relief inspector); the buildings and structures by kind: OsmManager.structures */
export interface OsmLayers {
  /** the drape: areas, ground covers, points */
  areas: boolean;
  water: boolean;
  /** road and railway ribbons, their far lines, pitch markings */
  roads: boolean;
  trees: boolean;
  /** wall air conditioners and lamp posts */
  props: boolean;
  /** night lights: street lamps, windows' far dots, roof and mast beacons, point lights */
  lights: boolean;
}

export const ALL_OSM_LAYERS: Readonly<OsmLayers> = { areas: true, water: true, roads: true, trees: true, props: true, lights: true };

export function farLightSize(pointSize: number): number {
  return Math.max(1, Math.round(pointSize / 3));
}

/**
 * OSM of the detailed z14 tiles (Q32, M2). The terrain manager decides which tiles are detailed
 * and shows one only when its OSM here is ready; this draws the OSM of exactly the shown ones.
 */
/**
 * How many of a tile's instances of one type to draw: of the trees the first share kept at the
 * tile's nearest point to the eye (props-mesher TREE_THIN: no tree of the tile is kept past it, the
 * shader thins the rest by each one's own distance); every other prop.
 */
function thinned(t: TreeSet, c: { centerEnu: vec3; radius: number }, camPos: vec3): number {
  if (t.type >= TREE_TYPES) return t.count;
  const near = Math.hypot(camPos[0] - c.centerEnu[0], camPos[2] - c.centerEnu[2]) - c.radius * 0.71;
  return Math.ceil(t.count * treeKeep(near));
}

export class OsmManager {
  readonly chunks = new Map<string, OsmChunk>();
  renderList: OsmChunk[] = [];
  /** every tile shown this frame, in view or not: the shadow casters */
  private shownList: OsmChunk[] = [];
  /** fired once per tile when its mesh first becomes ready (Q40 rebuild trigger) */
  /** a tile's OSM arrived: `runways` and `coast` reshape its terrain, which then needs a rebuild */
  onTileReady?: (tile: Tile, runways: number, coast: boolean, roads: boolean) => void;
  /** Landsat colour correction for tiles built from now on (relief inspector; invalidate() to rebuild) */
  grade: ColourGrade = NEUTRAL_GRADE;
  /** filters of the areas for tiles built from now on (area style editor; invalidate() to rebuild); undefined: the game's */
  areaStyles: AreaStyles | undefined = undefined;
  /** trees in a wood or forest × the game's, for tiles built from now on (relief inspector; invalidate() to rebuild) */
  treeDensity = 1;
  /** the layers drawn (relief inspector); the game draws them all */
  layers: OsmLayers = { ...ALL_OSM_LAYERS };
  /** the structure kinds drawn, a bit per kind (structure-kinds STRUCTURE); the game draws them all */
  structures = ALL_STRUCTURES;
  /** the sim clock, epoch seconds, and the local mean solar hour (palette solarHour): the traffic lights' cycle */
  simSeconds = 0;
  localHour = 12;
  private readyFired = new Set<string>();
  private origin: LatLon;
  /** one tile in flight per worker */
  private queue: RequestQueue;
  private workers: WorkerSlot[] = [];
  private rr = 0;
  private vp = mat4.create();
  private planes: Float32Array[] = [];
  private treeGeometry: WebGLBuffer;

  /** by the cores with our own tiles; 2 against a public API (Overpass, the OSM API: their rate limits) */
  constructor(private gl: WebGL2RenderingContext, origin: LatLon, workerCount = osmSourceMode() === 'pmtiles' ? tileWorkerCount() : 2) {
    this.origin = origin;
    this.queue = new RequestQueue(workerCount);
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
            index: buf(msg.index), bIndex: buf(msg.bIndex), gIndex: buf(msg.gIndex), rIndex: buf(msg.rIndex), wIndex: buf(msg.wIndex),
            levels: buf(msg.levels), rLevels: buf(msg.rLevels), wLevels: buf(msg.wLevels),
            bVertices: buf(msg.bVertices), bRamps: buf(msg.bRamps), bWindows: buf(msg.bWindows), bCore: msg.bCore ?? (buf(msg.bIndex).byteLength || buf(msg.bRamps).byteLength) / 4, bKinds: buf(msg.bKinds), dots: buf(msg.dots),
            gVertices: buf(msg.gVertices), gRamps: buf(msg.gRamps),
            trees: buf(msg.trees), lights: buf(msg.lights),
            roofLights: buf(msg.roofLights), nightDots: buf(msg.nightDots),
            beacons: buf(msg.beacons), mastLines: buf(msg.mastLines), wires: buf(msg.wires), flashes: buf(msg.flashes), signals: buf(msg.signals),
            rVertices: buf(msg.rVertices), rRamps: buf(msg.rRamps), rAttrs: buf(msg.rAttrs), roadLines: buf(msg.roadLines), pitchLines: buf(msg.pitchLines),
            wVertices: buf(msg.wVertices), wRamps: buf(msg.wRamps),
            lamps: buf(msg.lamps), runways: msg.runways ?? 0, coast: msg.coast ?? false, roads: msg.roads ?? false,
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
        (c.roofLights || c.nightDots ? 1 : 0) + (c.beacons ? 1 : 0) + (c.mastLines ? 1 : 0) + (c.wires ? 1 : 0);
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
    this.shownList = [];
    for (const key of shown) {
      const c = this.chunks.get(key);
      if (!c || c.status !== 'ready') continue;
      c.lastUsed = now;
      this.shownList.push(c);
      if (sphereInFrustum(this.planes, c.centerEnu, c.radius + CULL_MARGIN_M)) this.renderList.push(c);
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
      slot.worker.postMessage({ type: 'osm', id, tile: chunk.tile, detail: 'full', grade: this.grade, areaStyles: this.areaStyles, treeDensity: this.treeDensity });
    });
  }

  /**
   * interleaved pos+normal (stride 24) with Uint32 face colours, as the world shader expects; for
   * buildings also the facade window attributes (WORLD_VS aWinUV, aWinEdge), for the ribbons on the
   * ground's own faces their depth levels (WORLD_VS aDepthLevel; without them the shader reads 0)
   */
  private worldMesh(chunk: OsmChunk, vertices: ArrayBuffer, ramps: ArrayBuffer, windows?: ArrayBuffer, levels?: ArrayBuffer, index?: ArrayBuffer): Mesh | undefined {
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
    if (levels && levels.byteLength === ramps.byteLength) {
      const lb = must(gl.createBuffer(), 'osm depth levels');
      gl.bindBuffer(gl.ARRAY_BUFFER, lb);
      gl.bufferData(gl.ARRAY_BUFFER, levels, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(6);
      gl.vertexAttribPointer(6, 1, gl.FLOAT, false, 4, 0);
      chunk.buffers.push(lb);
    }
    // a welded mesh: drawn by its index (the counts of its ranges are the index's), its element buffer the VAO's
    const ib = bindIndex(gl, vao, index);
    if (ib) chunk.buffers.push(ib);
    gl.bindVertexArray(null);
    chunk.vaos.push(vao);
    return { vao, vertexCount: (ib ? index! : ramps).byteLength / 4 };
  }

  /**
   * A world mesh of room for `vertexCount` vertices, none drawn yet, its buffers written while drawn
   * (the traffic lights' lit lenses)
   */
  private dynamicWorldMesh(chunk: OsmChunk, vertexCount: number): LensSet {
    const gl = this.gl;
    const vao = must(gl.createVertexArray(), 'osm dynamic VAO');
    gl.bindVertexArray(vao);
    const vb = must(gl.createBuffer(), 'osm dynamic vertices');
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, vertexCount * 24, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const rb = must(gl.createBuffer(), 'osm dynamic ramps');
    gl.bindBuffer(gl.ARRAY_BUFFER, rb);
    gl.bufferData(gl.ARRAY_BUFFER, vertexCount * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0);
    gl.bindVertexArray(null);
    chunk.buffers.push(vb, rb);
    chunk.vaos.push(vao);
    return { mesh: { vao, vertexCount: 0 }, vertices: vb, ramps: rb };
  }

  /** the lit lenses of a chunk, written when they change (litLenses) */
  private lensVerts = new Float32Array(0);
  private lensRamps = new Uint32Array(0);

  /** a chunk's traffic lights by the clock: their lit lenses rewritten when any light changed */
  private lightSignals(c: OsmChunk): void {
    if (!c.signalData || !c.signalLit || !c.lenses) return;
    if (!signalAspects(c.signalData, this.simSeconds, this.localHour, performance.now() / 1000, c.signalLit)) return;
    const room = c.signalLit.length * MAX_LIT * LENS_VERTICES;
    if (this.lensRamps.length < room) {
      this.lensVerts = new Float32Array(room * 6);
      this.lensRamps = new Uint32Array(room);
    }
    const n = litLenses(c.signalData, c.signalLit, this.lensVerts, this.lensRamps);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, c.lenses.vertices);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lensVerts.subarray(0, n * 6));
    gl.bindBuffer(gl.ARRAY_BUFFER, c.lenses.ramps);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lensRamps.subarray(0, n));
    c.lenses.mesh.vertexCount = n;
  }

  /** the lit flashes of a chunk, written each frame (litFlashes) */
  private flashOut = new Float32Array(0);
  private flashScratch(lights: number): Float32Array {
    if (this.flashOut.length < lights * 4) this.flashOut = new Float32Array(lights * 4);
    return this.flashOut;
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
    chunk.mesh = this.worldMesh(chunk, data.vertices, data.ramps, undefined, data.levels, data.index);
    chunk.bmesh = this.worldMesh(chunk, data.bVertices, data.bRamps, data.bWindows, undefined, data.bIndex);
    chunk.gmesh = this.worldMesh(chunk, data.gVertices, data.gRamps, undefined, undefined, data.gIndex);
    chunk.bcore = chunk.bmesh && { vao: chunk.bmesh.vao, vertexCount: Math.min(data.bCore, chunk.bmesh.vertexCount) };
    chunk.bKinds = new Uint32Array(data.bKinds);
    chunk.bParts = undefined;
    chunk.dots = this.points(chunk, data.dots);
    chunk.lights = this.points(chunk, data.lights);
    chunk.roofLights = this.points(chunk, data.roofLights);
    chunk.nightDots = this.points(chunk, data.nightDots);
    chunk.beacons = this.points(chunk, data.beacons);
    chunk.mastLines = this.points(chunk, data.mastLines);
    chunk.wires = this.points(chunk, data.wires);
    if (data.flashes.byteLength > 0) {
      chunk.flashData = new Float32Array(data.flashes);
      // room for every light at once; litFlashes writes the lit ones each frame
      chunk.flashes = this.points(chunk, new ArrayBuffer((chunk.flashData.length / FLASH_STRIDE) * 16));
    }
    if (data.signals.byteLength > 0) {
      chunk.signalData = new Float32Array(data.signals);
      const lights = chunk.signalData.length / SIGNAL_STRIDE;
      // none written yet: the first frame writes them all
      chunk.signalLit = new Uint8Array(lights).fill(255);
      // room for the most lit at once (red and yellow) of every light
      chunk.lenses = this.dynamicWorldMesh(chunk, lights * MAX_LIT * LENS_VERTICES);
    }
    chunk.rmesh = this.worldMesh(chunk, data.rVertices, data.rRamps, data.rAttrs, data.rLevels, data.rIndex);
    chunk.wmesh = this.worldMesh(chunk, data.wVertices, data.wRamps, undefined, data.wLevels, data.wIndex);
    chunk.roadLines = this.points(chunk, data.roadLines);
    chunk.pitchLines = this.points(chunk, data.pitchLines);
    chunk.lamps = this.points(chunk, data.lamps);
    if (data.lamps.byteLength > 0) {
      const lenses = lampLenses(new Float32Array(data.trees), new Float32Array(data.lamps));
      chunk.lampLenses = this.worldMesh(chunk, lenses.vertices.buffer as ArrayBuffer, lenses.ramps.buffer as ArrayBuffer);
    }
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
        sets.push({ vao, buffer: ib, type: type | 0, first: mesh.first, count: end - start, vertexCount: mesh.count });
        start = end;
      }
      chunk.trees = sets;
    }
    chunk.status = 'ready';
    if (!this.readyFired.has(chunk.key)) {
      this.readyFired.add(chunk.key);
      this.onTileReady?.(chunk.tile, data.runways, data.coast, data.roads);
    }
  }

  private dispose(chunk: OsmChunk): void {
    const gl = this.gl;
    for (const b of chunk.buffers) gl.deleteBuffer(b);
    for (const v of chunk.vaos) gl.deleteVertexArray(v);
    chunk.buffers = [];
    chunk.vaos = [];
    chunk.mesh = chunk.bmesh = chunk.bcore = undefined;
    chunk.bKinds = chunk.bParts = undefined;
    chunk.dots = chunk.trees = chunk.lights = undefined;
    chunk.roofLights = chunk.nightDots = chunk.beacons = chunk.mastLines = chunk.wires = chunk.flashes = chunk.flashData = undefined;
    chunk.signalData = chunk.signalLit = chunk.lenses = undefined;
    chunk.rmesh = chunk.wmesh = undefined;
    chunk.roadLines = chunk.pitchLines = chunk.lamps = chunk.lampLenses = undefined;
  }

  /** a structure kind is drawn */
  private shows(kind: number): boolean {
    return (this.structures & (1 << kind)) !== 0;
  }

  /** a tile's buildings (near: with their small parts; far: the core) cut to the shown structure kinds */
  private houseParts(c: OsmChunk, near: boolean): Mesh[] {
    const mesh = near ? c.bmesh : c.bcore;
    if (!mesh) return [];
    if (this.structures === ALL_STRUCTURES) return [mesh];
    if (c.bParts?.mask !== this.structures) {
      const cut = (m: Mesh | undefined): Mesh[] =>
        m ? shownRanges(c.bKinds ?? [], m.vertexCount, this.structures).map(([first, vertexCount]) => ({ vao: m.vao, first, vertexCount })) : [];
      c.bParts = { mask: this.structures, near: cut(c.bmesh), far: cut(c.bcore) };
    }
    return near ? c.bParts.near : c.bParts.far;
  }

  /** a prop type (props-mesher: tree types, then INSTANCE) is drawn */
  private showsProp(type: number): boolean {
    return type === INSTANCE.AC || type === INSTANCE.LAMP || type === INSTANCE.SIGNAL ? this.layers.props : this.layers.trees;
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
    /** some windows of the near facades are lit though it is day (a thunderstorm's gloom, the dusk) */
    dayWindows = false,
    /** and of the far ones too: the dusk and the dawn (palette.ts windowsOn), as lit facades as by night */
    farDayWindows = false,
  ): void {
    const L = this.layers;
    const lights = lightsOn && L.lights;
    const buildingsOn = this.shows(STRUCTURE.BUILDING);
    const mastsOn = this.shows(STRUCTURE.MAST);
    // the rim light (rim.ts) on buildings only: the weight the caller set goes to the houses, the
    // areas, water and roads take none, and only the houses take the silhouette band
    const houseRim = renderer.rimWeight;
    renderer.rimWeight = 0;
    for (const c of this.renderList) {
      if (!L.areas) break;
      // near only, as the roads: farther the terrain's own faces carry the covers (coloured by them,
      // roads and water among them) and the drape adds only what the TIN's budget left out (its loose
      // shapes). The frame is bound by vertices over a town: central Moscow 27 → 23.4 ms, 0.1 % of
      // the pixels changed, by the horizon
      if (slantTo(c, camPos) >= DRAPE_RADIUS_M) continue;
      renderer.speckle = true;
      if (c.mesh) renderer.drawWorld(c.mesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
      // the traffic lights' lit lenses over their dark ones in the drape, as the drape draws them
      if (c.mesh && c.lenses) {
        this.lightSignals(c);
        if (c.lenses.mesh.vertexCount > 0) {
          // light sources: above white on XDR (renderer HDR_EMISSION.trafficLights)
          renderer.selfLit = true;
          renderer.selfLitGain = renderer.emission('trafficLights');
          renderer.drawWorld(c.lenses.mesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
          renderer.selfLit = false;
          renderer.selfLitGain = 1;
        }
      }
      renderer.speckle = false;
    }
    // water over every tile's drape; nothing overlaps it any more (the ground leaves it out), so it writes depth
    for (const c of this.renderList) {
      if (c.wmesh && L.water) renderer.drawWorld(c.wmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
    }
    for (const c of this.renderList) {
      const dx = camPos[0] - c.centerEnu[0];
      const dz = camPos[2] - c.centerEnu[2];
      const slant = slantTo(c, camPos);
      if (slant < HOUSE_RADIUS_M) {
        if (c.rmesh && L.roads) renderer.drawWorld(c.rmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
        // pitch markings: 1 px white paint, pulled a hair toward the eye off the pitch under them
        if (c.pitchLines && L.roads) renderer.drawLights(c.pitchLines.vao, c.pitchLines.count, c.offset, view, proj, camPos, 1, true, 'lines', false, PITCH_LINE_PULL);
        const houses = this.houseParts(c, slant - c.radius * 0.71 < BUILDING_DETAIL_M);
        if (houses.length) {
          // windows on the facades: glass by day, about a third of them lit at night (no window points near)
          renderer.windows = lightsOn || dayWindows ? 'lit' : 'glass';
          renderer.rimWeight = houseRim;
          renderer.outlined = true;
          for (const h of houses) renderer.drawWorld(h, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
          renderer.outlined = false;
          renderer.rimWeight = 0;
          renderer.windows = 'off';
        }
        if (c.lamps && lights) {
          // the lenses under the lamp heads; their points only where a lens is smaller (POINTS_VS)
          if (c.lampLenses) {
            renderer.selfLit = true;
            renderer.selfLitGain = renderer.emission('cityLights');
            renderer.drawWorld(c.lampLenses, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
            renderer.selfLit = false;
            renderer.selfLitGain = 1;
          }
          renderer.drawLights(c.lamps.vao, c.lamps.count, c.offset, view, proj, camPos, lampSize(pointSize), true);
        }
        if (c.roofLights && lights && buildingsOn) {
          renderer.drawLights(c.roofLights.vao, c.roofLights.count, c.offset, view, proj, camPos, Math.max(2, pointSize * 0.67), true);
        }
      } else {
        // far buildings by day: a 1 px roof-coloured dot over a 1 px wall-coloured one. By night the
        // same lit facades as near (the windows shader keeps sub-pixel panes, the walls hide what is
        // behind them), so no border shows between near and far at night; so too while the windows
        // come on before the dusk, or go off after the dawn
        if (lightsOn || farDayWindows) {
          renderer.windows = 'lit';
          renderer.rimWeight = houseRim;
          renderer.outlined = true;
          for (const h of this.houseParts(c, false)) renderer.drawWorld(h, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
          renderer.outlined = false;
          renderer.rimWeight = 0;
          renderer.windows = 'off';
          if (c.roofLights && lights && buildingsOn) renderer.drawLights(c.roofLights.vao, c.roofLights.count, c.offset, view, proj, camPos, Math.max(2, pointSize * 0.67), true);
        } else if (c.dots && buildingsOn) {
          renderer.drawLights(c.dots.vao, c.dots.count, c.offset, view, proj, camPos, farLightSize(pointSize), true, 'points', true);
        }
        // far roads: 1 px asphalt lines on the terrain by day; at night only the street-lit ones, as a
        // dotted line of their lamps: the same lamps, the same size as near
        if (lightsOn) {
          if (c.lamps && lights && L.roads) renderer.drawLights(c.lamps.vao, c.lamps.count, c.offset, view, proj, camPos, lampSize(pointSize), true);
        } else if (c.roadLines && L.roads) {
          renderer.drawLights(c.roadLines.vao, c.roadLines.count, c.offset, view, proj, camPos, 1, true, 'lines');
        }
        // far lines: the masts' and the minarets'
        if (c.mastLines && (mastsOn || this.shows(STRUCTURE.MINARET))) {
          renderer.drawLights(c.mastLines.vao, c.mastLines.count, c.offset, view, proj, camPos, 1, true, 'lines');
        }
      }
      if (c.beacons && lights && mastsOn) {
        renderer.drawLights(c.beacons.vao, c.beacons.count, c.offset, view, proj, camPos, pointSize, true);
      }
      // the lighthouses' lights: those lit at this moment of their periods, larger than a beacon
      if (c.flashes && c.flashData && lights && this.shows(STRUCTURE.LIGHTHOUSE)) {
        // the eye in the tile's frame (WORLD_VS toWorld undone: the offset, then the frame's yaw)
        const ex = camPos[0] - c.offset[0], ez = camPos[2] - c.offset[2], cy = Math.cos(c.offset[3]), sy = Math.sin(c.offset[3]);
        const eye: [number, number] = [ex * cy + ez * sy, -ex * sy + ez * cy];
        const lit = litFlashes(c.flashData, performance.now() / 1000, this.flashScratch(c.flashData.length / FLASH_STRIDE), eye);
        if (lit > 0) {
          const gl = this.gl;
          gl.bindBuffer(gl.ARRAY_BUFFER, c.flashes.buffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flashOut.subarray(0, lit * 4));
          renderer.drawLights(c.flashes.vao, lit, c.offset, view, proj, camPos, pointSize * FLASH_SIZE, true);
        }
      }
      // power line conductors: thin, near and middle distance only (far they are less than a pixel)
      // (and the lifts' ropes)
      if (c.wires && slant - c.radius * 0.71 < WIRE_RADIUS_M && (this.shows(STRUCTURE.POWER) || this.shows(STRUCTURE.LIFT))) {
        renderer.drawLights(c.wires.vao, c.wires.count, c.offset, view, proj, camPos, 1, true, 'lines');
      }
      if (c.trees && Math.hypot(dx, dz) < 2000 + c.radius * 0.71) {
        for (const t of c.trees) {
          if (slant - c.radius * 0.71 > (PROP_DETAIL_M[t.type] ?? Infinity) || !this.showsProp(t.type)) continue;
          const n = thinned(t, c, camPos);
          renderer.drawTrees(t.vao, n, t.first, t.vertexCount, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd, t.type >= TREE_TYPES ? 0 : t.count);
        }
      }
      if (c.lights && lights) {
        renderer.drawLights(c.lights.vao, c.lights.count, c.offset, view, proj, camPos, pointSize, true);
      }
    }
    // greenhouse glass, last: see-through over the ground, the frame and the plants behind it, the
    // sun glinting off it (WORLD_FS uGloss); near tiles only, like the buildings it belongs to
    renderer.opacity = GREENHOUSE.OPACITY;
    renderer.gloss = 1;
    for (const c of this.renderList) {
      if (!c.gmesh || !buildingsOn) continue;
      const slant = Math.hypot(camPos[0] - c.centerEnu[0], camPos[2] - c.centerEnu[2], camPos[1]);
      if (slant < HOUSE_RADIUS_M) renderer.drawWorld(c.gmesh, c.offset, view, proj, camPos, sunDir, fogStart, fogEnd);
    }
    renderer.opacity = 1;
    renderer.gloss = 0;
    renderer.rimWeight = houseRim;
  }

  /**
   * The buildings and, near the ground, the trees into the sun's shadow map (renderer.beginShadows):
   * every tile shown over the box, not only those in view. The buildings' core (no doors, parapets
   * or roof details) is enough for their shadows.
   */
  drawShadows(renderer: Renderer, camPos: vec3): void {
    const at = vec3.create();
    const trees = renderer.shadowTexel <= SHADOW_TREE_TEXEL_M;
    for (const c of this.shownList) {
      vec3.set(at, c.centerEnu[0], renderer.shadowGround[1], c.centerEnu[2]);
      if (!renderer.shadowSees(at, c.radius * 0.71 + SHADOW_RELIEF_M)) continue;
      for (const h of this.houseParts(c, !c.bcore)) renderer.shadowMesh(h, c.offset);
      if (!trees || !c.trees) continue;
      const slant = slantTo(c, camPos) - c.radius * 0.71;
      for (const t of c.trees) {
        if (slant > (PROP_DETAIL_M[t.type] ?? Infinity) || !this.showsProp(t.type)) continue;
        const n = thinned(t, c, camPos);
        renderer.shadowTrees(t.vao, n, t.first, t.vertexCount, c.offset, t.type >= TREE_TYPES ? 0 : t.count);
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
