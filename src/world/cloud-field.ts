import { mat4, vec3, vec4 } from 'gl-matrix';
import { must } from '../engine/gl';
import type { Mesh, Renderer } from '../engine/renderer';
import { frustumPlanes, sphereInFrustum } from './chunks';
import { cloudDensity, cumulusTile, deckDensity, deckTile, TILE_M, type CloudLayer, type Puff } from './clouds';
import { enuToLatLon, frameYaw, latLonToEnu, type LatLon } from './geodesy';

/** how far the clouds of each look are kept around the camera, m (beyond the fog's end decks must still cover the sky) */
const RADIUS_M = { cumulus: 50000, deck: 64000 } as const;
/** new tiles built per frame (a cumulus tile takes about a millisecond) */
const BUILDS_PER_FRAME = 2;

interface Tile {
  layer: CloudLayer;
  ti: number;
  tj: number;
  mesh: Mesh;
  buffers: WebGLBuffer[];
  puffs: Puff[];
  /** this frame: xyz the tile centre in the world, w the yaw of the cloud frame; and whether it is in view */
  offset: vec4;
  visible: boolean;
}

/**
 * The cloud layers (clouds.ts) around the camera: tiles of a fixed east/north frame (`origin`, the
 * start point) built a few per frame nearest first, dropped when far, drifting with the wind at
 * their height, and placed in the world of the terrain's (moving) origin every frame.
 */
export class CloudField {
  private layers: CloudLayer[] = [];
  private tiles = new Map<string, Tile>();
  /** how far each layer has drifted with the wind, m east and north (by layer id: kept across weather updates) */
  private drift = new Map<CloudLayer['id'], [number, number]>();
  private planes: Float32Array[] = [];
  private readonly viewProj = mat4.create();
  private readonly center = vec3.create();
  /** tiles drawn last frame */
  drawCalls = 0;

  constructor(private readonly gl: WebGL2RenderingContext, readonly origin: LatLon) {}

  get current(): readonly CloudLayer[] {
    return this.layers;
  }

  /** new weather: tiles of layers that changed go (their replacements are built over the next frames) */
  setLayers(layers: CloudLayer[]): void {
    if (layers.length === this.layers.length && layers.every((l, i) => l.key === this.layers[i].key)) return;
    this.layers = layers;
    const keys = new Set(layers.map((l) => l.key));
    for (const [k, t] of this.tiles) if (!keys.has(t.layer.key)) this.drop(k, t);
  }

  /** moves the layers with the wind: `wind(alt)` gives [east, north] m/s at a height */
  advance(dt: number, wind: (alt: number) => [number, number]): void {
    for (const l of this.layers) {
      const [e, n] = wind((l.base + l.top) / 2);
      const d = this.drift.get(l.id) ?? [0, 0];
      d[0] += e * dt;
      d[1] += n * dt;
      this.drift.set(l.id, d);
    }
  }

  private driftOf(l: CloudLayer): [number, number] {
    return this.drift.get(l.id) ?? [0, 0];
  }

  /** the camera in the cloud frame, m east and north */
  private camera(camLatLon: LatLon): [number, number] {
    const [e, n] = latLonToEnu(this.origin, camLatLon.lat, camLatLon.lon, 0);
    return [e, n];
  }

  /**
   * Picks, builds and places the tiles for this frame. `worldOrigin` is the terrain's ENU origin
   * (chunks.origin): the world the meshes are drawn in.
   */
  update(camLatLon: LatLon, worldOrigin: LatLon, view: mat4, proj: mat4): void {
    mat4.multiply(this.viewProj, proj, view);
    this.planes = frustumPlanes(this.viewProj);
    const [ce, cn] = this.camera(camLatLon);
    const yaw = frameYaw(worldOrigin, this.origin);
    const wanted = new Set<string>();
    const missing: { l: CloudLayer; ti: number; tj: number; d: number; key: string }[] = [];
    for (const l of this.layers) {
      const [de, dn] = this.driftOf(l);
      const e = ce - de, n = cn - dn;
      const reach = RADIUS_M[l.kind] + TILE_M * 0.71;
      const r = Math.ceil(reach / TILE_M);
      const i0 = Math.floor(e / TILE_M), j0 = Math.floor(n / TILE_M);
      for (let ti = i0 - r; ti <= i0 + r; ti++) {
        for (let tj = j0 - r; tj <= j0 + r; tj++) {
          const d = Math.hypot((ti + 0.5) * TILE_M - e, (tj + 0.5) * TILE_M - n);
          if (d > reach) continue;
          const key = `${l.key}|${ti},${tj}`;
          wanted.add(key);
          if (!this.tiles.has(key)) missing.push({ l, ti, tj, d, key });
        }
      }
    }
    for (const [k, t] of this.tiles) if (!wanted.has(k)) this.drop(k, t);
    missing.sort((a, b) => a.d - b.d);
    for (const m of missing.slice(0, BUILDS_PER_FRAME)) this.build(m.l, m.ti, m.tj, m.key);

    for (const t of this.tiles.values()) {
      const [de, dn] = this.driftOf(t.layer);
      const ll = enuToLatLon(this.origin, (t.ti + 0.5) * TILE_M + de, (t.tj + 0.5) * TILE_M + dn, 0);
      const [we, wn] = latLonToEnu(worldOrigin, ll.lat, ll.lon, 0);
      vec4.set(t.offset, we, 0, -wn, yaw);
      const thick = t.layer.top - t.layer.base;
      vec3.set(this.center, we, (t.layer.base + t.layer.top) / 2, -wn);
      t.visible = sphereInFrustum(this.planes, this.center, TILE_M * 0.75 + thick);
    }
  }

  draw(r: Renderer, view: mat4, proj: mat4, camPos: vec3, lightDir: vec3, fogStart: number, fogEnd: number): void {
    this.drawCalls = 0;
    r.bare = true;
    for (const t of this.tiles.values()) {
      if (!t.visible || t.mesh.vertexCount === 0) continue;
      r.drawWorld(t.mesh, t.offset, view, proj, camPos, lightDir, fogStart, fogEnd);
      this.drawCalls++;
    }
    r.bare = false;
  }

  /** how deep in cloud a point (the camera) is, 0..1: the densest layer there */
  density(at: LatLon, alt: number): number {
    if (this.layers.length === 0) return 0;
    const [ce, cn] = this.camera(at);
    let best = 0;
    for (const l of this.layers) {
      if (alt < l.base - 1 || alt > l.top + 1) continue;
      if (l.kind === 'deck') {
        best = Math.max(best, deckDensity(l, alt));
        continue;
      }
      // the puffs of the tile under the point and its neighbours (clouds overhang tile edges)
      const [de, dn] = this.driftOf(l);
      const e = ce - de, n = cn - dn;
      const i0 = Math.floor(e / TILE_M), j0 = Math.floor(n / TILE_M);
      for (let ti = i0 - 1; ti <= i0 + 1; ti++) {
        for (let tj = j0 - 1; tj <= j0 + 1; tj++) {
          const t = this.tiles.get(`${l.key}|${ti},${tj}`);
          if (!t) continue;
          const x = e - (ti + 0.5) * TILE_M, z = -(n - (tj + 0.5) * TILE_M);
          best = Math.max(best, cloudDensity(t.puffs, x, alt, z));
        }
      }
    }
    return best;
  }

  private build(l: CloudLayer, ti: number, tj: number, key: string): void {
    const gl = this.gl;
    const m = l.kind === 'deck' ? deckTile(l, ti, tj) : cumulusTile(l, ti, tj);
    const vao = must(gl.createVertexArray(), 'cloud VAO');
    gl.bindVertexArray(vao);
    const vbo = must(gl.createBuffer(), 'cloud vertices');
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const rbo = must(gl.createBuffer(), 'cloud colours');
    gl.bindBuffer(gl.ARRAY_BUFFER, rbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.ramps, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, 0);
    gl.bindVertexArray(null);
    this.tiles.set(key, {
      layer: l, ti, tj, puffs: m.puffs, buffers: [vbo, rbo],
      mesh: { vao, vertexCount: m.verts.length / 6 }, offset: vec4.create(), visible: false,
    });
  }

  private drop(key: string, t: Tile): void {
    for (const b of t.buffers) this.gl.deleteBuffer(b);
    this.gl.deleteVertexArray(t.mesh.vao);
    this.tiles.delete(key);
  }
}
