import { isMaterial, RAMP, rampGlowLevel, rgbOf, snowy, withGlow, type RGB } from '../engine/palette';
import { weld } from './weld';
import { DEFAULT_AREA_STYLES, type AreaStyles } from './area-styles';
import { coverRamp, type GroundCover } from './ground-cover';
import type { FaceColor } from './landsat';
import type { TileBorders } from './terrain-source';
import { isSeaFace, type TerrainTin, type TinOptions } from './terrain-tin';
import { buildSurfaceTin, type RoadSurface, type SurfaceTin } from './surface-tin';
import type { Tri } from './contours';
import { gridLatLon, latLonToEnu, tileCenter, tileSizeMeters, type Tile } from './geodesy';

export interface TerrainMeshData {
  vertices: Float32Array; // interleaved pos.xyz + normal.xyz
  /** face colour per vertex (palette.ts: RGB or a material ramp, glow and snow bits) */
  ramps: Uint32Array;
  vertexCount: number;
  /** per vertex: metres to the coarser neighbour's border line, and the edge bits it applies to (TerrainTin.coarse) */
  morph?: Float32Array;
  /**
   * With `cover`, the vertices in the order: the ground and the covers other than the below, the
   * skirts, the roads, rails and runways, the water. The first `nearCount` are the ground and the
   * skirts (what is drawn near), the first `farCount` also the roads, rails and runways (far); the
   * water faces are never drawn. Without `cover`: both are `vertexCount`. (Optional: the OSM and
   * building meshes share this shape and have no such split.)
   */
  nearCount?: number;
  farCount?: number;
}

export interface TerrainMeshOptions {
  tile: Tile;
  /** work lattice resolution: contours are traced on (grid+1)² nodes */
  grid: number;
  /** (grid+1)² elevations, row-major north→south */
  heights: Float32Array;
  skirtDepth?: number;
  /** belt height in meters (default: beltStepForZoom) */
  step?: number;
  /** land face colour from imagery (lattice coords of the corners) instead of height/slope rules */
  faceColor?: FaceColor;
  /** colour boundaries as fixed TIN edges (see TinOptions.colourLines) */
  colourLines?: TinOptions['colourLines'];
  /** contour simplification tolerance in lattice cells (default 2) */
  epsCells?: number;
  /** full-resolution edge profiles (see TileBorders) */
  borders?: TileBorders;
  /** OSM coastline ways (see TinOptions.coast) */
  coast?: TinOptions['coast'];
  /** aerodrome pads (see TinOptions.pads) */
  pads?: TinOptions['pads'];
  /** the tile's roads with their heights: the surface is built under them (surface-tin.ts) */
  roads?: RoadSurface;
  /** the tile's ground covers: each face is coloured by its cover (coverRamp), the surface is built along them */
  cover?: GroundCover;
  /** the area filters (default DEFAULT_AREA_STYLES) */
  areaStyles?: AreaStyles;
  /** the night glow level of each face of the surface TIN (night-glow.ts glowLevels), taken into the face's colour */
  glow?: (tin: SurfaceTin) => Uint8Array;
  /**
   * the surface already built from these same inputs (the OSM worker's, buildSurfaceTin with the
   * heights, borders, coast, pads, roads and cover above and no step, eps or colour lines): read, not built again
   */
  surface?: SurfaceTin;
}

function faceRamp(avgH: number, ny: number): number {
  if (avgH > 2200 && ny > 0.6) return RAMP.SNOW;
  if (ny < 0.75 || avgH > 2600) return RAMP.ROCK;
  if (avgH < 3) return RAMP.SAND;
  if (avgH > 250 && avgH < 1600) return RAMP.FOREST;
  return RAMP.GRASS;
}

/**
 * Lattice coords → tile-centre world x/z of a point of the tile (bilinear inside the lattice cell).
 * The one projection of a TIN vertex for every mesh drawn on its faces: the terrain's own and the
 * OSM mesh's road and water faces stand on the same float32 positions, bit for bit (a vertex
 * projected on its own, gridLatLon → latLonToEnu, came out a float32 step off: pinholes along the
 * road edges)
 */
export function latticeToWorld(tile: Tile, grid: number): (gx: number, gy: number) => [number, number] {
  const center = tileCenter(tile);
  const side = grid + 1;
  const nx = new Float64Array(side * side);
  const nz = new Float64Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const ll = gridLatLon(tile, i, j, grid);
      const [e, n] = latLonToEnu(center, ll.lat, ll.lon, 0);
      nx[j * side + i] = e;
      nz[j * side + i] = -n;
    }
  }
  return (gx, gy) => {
    const i = Math.min(grid - 1, Math.floor(gx));
    const j = Math.min(grid - 1, Math.floor(gy));
    const tx = gx - i, ty = gy - j;
    const k00 = j * side + i, k10 = k00 + 1, k01 = k00 + side, k11 = k01 + 1;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    return [
      nx[k00] * w00 + nx[k10] * w10 + nx[k01] * w01 + nx[k11] * w11,
      nz[k00] * w00 + nz[k10] * w10 + nz[k01] * w01 + nz[k11] * w11,
    ];
  };
}

/** lattice coords → tile-centre world x/z of every TIN vertex (latticeToWorld) */
export function tinToWorld(tile: Tile, grid: number, vx: number[], vy: number[]): { wx: number[]; wz: number[] } {
  const world = latticeToWorld(tile, grid);
  const wx: number[] = [];
  const wz: number[] = [];
  for (let k = 0; k < vx.length; k++) {
    const [x, z] = world(vx[k], vy[k]);
    wx.push(x);
    wz.push(z);
  }
  return { wx, wz };
}

/** upward unit normal of a TIN triangle */
function faceNormal(wx: number[], wy: number[], wz: number[], t: Tri): [number, number, number] {
  const e1x = wx[t.b] - wx[t.a], e1y = wy[t.b] - wy[t.a], e1z = wz[t.b] - wz[t.a];
  const e2x = wx[t.c] - wx[t.a], e2y = wy[t.c] - wy[t.a], e2z = wz[t.c] - wz[t.a];
  let ax = e1y * e2z - e1z * e2y;
  let ay = e1z * e2x - e1x * e2z;
  let az = e1x * e2y - e1y * e2x;
  const len = Math.hypot(ax, ay, az) || 1;
  ax /= len;
  ay /= len;
  az /= len;
  if (ay < 0) {
    ax = -ax;
    ay = -ay;
    az = -az;
  }
  return [ax, ay, az];
}

/** colour of a TIN face: sea, imagery colour, or height/slope rules; land (not water) takes snow */
function terrainFaceRamp(tin: TerrainTin, ti: number, ny: number, faceColor?: FaceColor): number {
  const { vx, vy, vh } = tin;
  const t = tin.tris[ti];
  if (isSeaFace(tin, ti)) return RAMP.SEA;
  const ramp = faceColor
    ? faceColor(vx[t.a], vy[t.a], vx[t.b], vy[t.b], vx[t.c], vy[t.c])
    : faceRamp((vh[t.a] + vh[t.b] + vh[t.c]) / 3, ny);
  return ramp === RAMP.WATER ? ramp : snowy(ramp);
}

/**
 * Relief as simplified isoline belts: contours every `step` meters are traced
 * on the work lattice, simplified (Douglas–Peucker), joined with a simplified
 * tile border, and triangulated (Delaunay). Flat normals, one ramp per face.
 */
/**
 * A terrain mesh as it is cached and sent: its buffers, and the near and far vertex counts with a
 * cover (without one the whole mesh is drawn at any distance, as ever)
 */
export function terrainMeshBuffers(mesh: TerrainMeshData, covered: boolean): { vertices: ArrayBuffer; ramps: ArrayBuffer; index: ArrayBuffer; morph?: ArrayBuffer; nearCount?: number; farCount?: number } {
  // welded (weld.ts): the near and far counts, ranges of the triangle list, are the same of the index
  const w = weld(mesh.vertexCount, [
    { data: mesh.vertices, size: 6, normal: true },
    { data: mesh.ramps, size: 1 },
    ...(mesh.morph ? [{ data: mesh.morph, size: 2 }] : []),
  ]);
  return {
    vertices: w.streams[0].buffer as ArrayBuffer,
    ramps: w.streams[1].buffer as ArrayBuffer,
    index: w.index.buffer as ArrayBuffer,
    morph: mesh.morph ? (w.streams[2].buffer as ArrayBuffer) : undefined,
    nearCount: covered ? mesh.nearCount : undefined,
    farCount: covered ? mesh.farCount : undefined,
  };
}

export function buildTerrainMesh(opts: TerrainMeshOptions): TerrainMeshData {
  const { tile, grid, heights } = opts;
  const skirt = opts.skirtDepth ?? Math.min(tileSizeMeters(tile) / 2, 2000);
  const side = grid + 1;
  if (heights.length !== side * side) throw new Error('heights grid size mismatch');
  const surface = opts.surface ?? buildSurfaceTin(tile, grid, heights, { step: opts.step, eps: opts.epsCells, borders: opts.borders, colourLines: opts.colourLines, coast: opts.coast, pads: opts.pads, roads: opts.roads, cover: opts.cover });
  const { vx, vy, vh, tris, coarse, sea } = surface;

  const { wx, wz } = tinToWorld(tile, grid, vx, vy);
  const vyH = vh.map((h) => Math.max(h, 0));

  const landTris = tris.length;
  // skirts: one quad per consecutive border-vertex pair
  const borders: number[][] = [[], [], [], []];
  for (let k = 0; k < vx.length; k++) {
    if (vy[k] === 0) borders[0].push(k);
    if (vy[k] === grid) borders[1].push(k);
    if (vx[k] === 0) borders[2].push(k);
    if (vx[k] === grid) borders[3].push(k);
  }
  borders[0].sort((a, b) => vx[a] - vx[b]);
  borders[1].sort((a, b) => vx[a] - vx[b]);
  borders[2].sort((a, b) => vy[a] - vy[b]);
  borders[3].sort((a, b) => vy[a] - vy[b]);
  const skirtQuads = borders.reduce((s, b) => s + Math.max(0, b.length - 1), 0);

  const vertexCount = (landTris + skirtQuads * 2) * 3;
  const vertices = new Float32Array(vertexCount * 6);
  const ramps = new Uint32Array(vertexCount);
  const morph = coarse ? new Float32Array(vertexCount * 2) : undefined;
  let fi = 0;
  let ri = 0;
  /** `k`: the TIN vertex this one stands on (a skirt's bottom moves with its top) */
  const pushV = (x: number, y: number, z: number, n: [number, number, number], ramp: number, k: number) => {
    if (morph && coarse) {
      morph[ri * 2] = coarse.dh[k];
      morph[ri * 2 + 1] = coarse.edges[k];
    }
    vertices[fi++] = x;
    vertices[fi++] = y;
    vertices[fi++] = z;
    vertices[fi++] = n[0];
    vertices[fi++] = n[1];
    vertices[fi++] = n[2];
    ramps[ri++] = ramp;
  };

  const edgeInfo = new Map<number, { n: [number, number, number]; ramp: number }>();
  const ekey = (u: number, v: number) => (u < v ? u * vx.length + v : v * vx.length + u);
  const tin = { vx, vy, vh, tris, grid, sea };
  const levels = opts.glow?.(surface);
  const styles = opts.areaStyles ?? DEFAULT_AREA_STYLES;
  /** the imagery colour of a face (none: a material ramp, or no imagery), as osm-mesher's imageryOf */
  const imageryOf = (t: Tri): RGB | undefined => {
    if (!opts.faceColor) return undefined;
    const packed = opts.faceColor(vx[t.a], vy[t.a], vx[t.b], vy[t.b], vx[t.c], vy[t.c]);
    return isMaterial(packed) ? undefined : rgbOf(packed);
  };
  /** the order of the faces: 0 ground and the covers drawn with it, 1 roads, rails and runways, 2 water */
  const GROUND = 0, ROAD = 1, WATER = 2;
  const faces: { n: [number, number, number]; ramp: number; group: number }[] = [];
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    const [ax, ay, az] = faceNormal(wx, vyH, wz, t);
    let ramp = terrainFaceRamp(tin, ti, ay, opts.faceColor);
    let group = GROUND;
    const shape = surface.cover && surface.cover[ti] >= 0 ? surface.cover[ti] : -1;
    if (opts.cover && shape >= 0) {
      const { kind } = opts.cover.shapes[shape];
      const causeway = kind === 'carriageway' || kind === 'ballast' || kind === 'runway';
      group = causeway ? ROAD : kind === 'water' ? WATER : GROUND;
      // the sea stays the sea, but for a road across it
      // a belt keeps the ground's own colour on a face without imagery (nothing to go halfway from)
      const imagery = imageryOf(t);
      if ((!isSeaFace(tin, ti) || causeway) && (kind !== 'belt' || imagery)) ramp = coverRamp(opts.cover.shapes[shape], styles, imagery);
    }
    if (levels) ramp = withGlow(ramp, Math.max(rampGlowLevel(ramp), levels[ti]));
    const info = { n: [ax, ay, az] as [number, number, number], ramp, group };
    faces.push(info);
    edgeInfo.set(ekey(t.a, t.b), info);
    edgeInfo.set(ekey(t.b, t.c), info);
    edgeInfo.set(ekey(t.c, t.a), info);
  }
  const pushFaces = (group: number) => {
    for (let ti = 0; ti < tris.length; ti++) {
      const f = faces[ti];
      if (f.group !== group) continue;
      const t = tris[ti];
      for (const k of [t.a, t.b, t.c]) pushV(wx[k], vyH[k], wz[k], f.n, f.ramp, k);
    }
  };
  pushFaces(GROUND);

  for (const line of borders) {
    for (let q = 0; q + 1 < line.length; q++) {
      const a = line[q], b = line[q + 1];
      const info = edgeInfo.get(ekey(a, b));
      const ramp = info ? info.ramp : RAMP.GRASS;
      const n = info ? info.n : ([0, 1, 0] as [number, number, number]);
      const ya = vyH[a], yb = vyH[b];
      // colours are flat from the provoking (last) vertex: keep it on the top edge, or the skirt
      // takes the fog of a point `skirt` metres deeper and shows as a light line along the seam
      const quad: Array<[number, number, number, number]> = [
        [wx[b], yb - skirt, wz[b], b], [wx[a], ya, wz[a], a], [wx[b], yb, wz[b], b],
        [wx[a], ya - skirt, wz[a], a], [wx[b], yb - skirt, wz[b], b], [wx[a], ya, wz[a], a],
      ];
      for (const [x, y, z, k] of quad) pushV(x, y, z, n, ramp, k);
    }
  }
  const nearCount = ri;
  pushFaces(ROAD);
  const farCount = ri;
  pushFaces(WATER);

  return { vertices: vertices.subarray(0, fi), ramps: ramps.subarray(0, ri), vertexCount: ri, morph: morph?.subarray(0, ri * 2), nearCount, farCount: opts.cover ? farCount : ri };
}
