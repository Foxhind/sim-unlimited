import { RAMP } from '../engine/palette';
import { contourLevels, delaunay, extractIsolines, simplifyOpen, simplifyRing, type Pt } from './contours';
import { gridLatLon, latLonToEnu, tileCenter, tileSizeMeters, type Tile } from './geodesy';

export interface TerrainMeshData {
  vertices: Float32Array; // interleaved pos.xyz + normal.xyz
  ramps: Uint8Array;
  vertexCount: number;
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
  /** contour simplification tolerance in lattice cells (default 2) */
  epsCells?: number;
}

/** Vertical thickness of one belt: coarser for distant (low-zoom) tiles. */
export function beltStepForZoom(z: number): number {
  if (z >= 13) return 50;
  if (z >= 11) return 120;
  if (z >= 9) return 300;
  return 600;
}

const MAX_VERTS = 120;

function faceRamp(avgH: number, ny: number): number {
  if (avgH > 2200 && ny > 0.6) return RAMP.SNOW;
  if (ny < 0.75 || avgH > 2600) return RAMP.ROCK;
  if (avgH < 3) return RAMP.SAND;
  if (avgH > 250 && avgH < 1600) return RAMP.FOREST;
  return RAMP.GRASS;
}

/**
 * Relief as simplified isoline belts: contours every `step` meters are traced
 * on the work lattice, simplified (Douglas–Peucker), joined with a simplified
 * tile border, and triangulated (Delaunay). Flat normals, one ramp per face.
 */
export function buildTerrainMesh(opts: TerrainMeshOptions): TerrainMeshData {
  const { tile, grid, heights } = opts;
  const skirt = opts.skirtDepth ?? Math.min(tileSizeMeters(tile) / 2, 2000);
  let step = opts.step ?? beltStepForZoom(tile.z);
  const center = tileCenter(tile);
  const side = grid + 1;
  if (heights.length !== side * side) throw new Error('heights grid size mismatch');
  const cellM = tileSizeMeters(tile) / grid;

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
  /** lattice coords → world x/z, bilinear inside the cell */
  const world = (gx: number, gy: number): [number, number] => {
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

  let minH = Infinity, maxH = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    minH = Math.min(minH, heights[k]);
    maxH = Math.max(maxH, heights[k]);
  }
  let raw: ReturnType<typeof extractIsolines> = [];

  let vx: number[] = [];
  let vy: number[] = [];
  let vh: number[] = [];
  const collect = (eps: number): void => {
    vx = [];
    vy = [];
    vh = [];
    const seen = new Map<string, number>();
    const add = (x: number, y: number, h: number) => {
      const key = `${Math.round(x * 4096)},${Math.round(y * 4096)}`;
      if (seen.has(key)) return;
      seen.set(key, vx.length);
      vx.push(x);
      vy.push(y);
      vh.push(h);
    };
    // border: corners + height-significant nodes of each edge (vertical tolerance = half a belt)
    const edgeNodes: Array<(s: number) => [number, number, number]> = [
      (s) => [s, 0, heights[s]],
      (s) => [s, grid, heights[grid * side + s]],
      (s) => [0, s, heights[s * side]],
      (s) => [grid, s, heights[s * side + grid]],
    ];
    for (const at of edgeNodes) {
      const prof: Pt[] = [];
      for (let s = 0; s <= grid; s++) prof.push({ x: s * cellM, y: at(s)[2] });
      for (const p of simplifyOpen(prof, (step / 2) * Math.max(1, eps / 2))) {
        const [x, y, h] = at(Math.round(p.x / cellM));
        add(x, y, h);
      }
    }
    for (const line of raw) {
      const pts = line.closed ? simplifyRing(line.pts, eps) : simplifyOpen(line.pts, eps);
      if (line.closed) {
        // rings smaller than the tolerance are noise at this detail level
        const xs = line.pts.map((p) => p.x), ys = line.pts.map((p) => p.y);
        const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (pts.length < 3 || ext < eps * 2) continue;
      }
      for (const p of pts) add(p.x, p.y, line.level);
    }
  };
  // over budget → thicker belts and a looser tolerance (every open isoline costs
  // two border vertices, so tolerance alone cannot meet the budget on rough terrain)
  let eps = opts.epsCells ?? 2;
  for (let attempt = 0; ; attempt++) {
    raw = contourLevels(minH, maxH, step).flatMap((l) => extractIsolines(heights, grid, l));
    collect(eps);
    if (vx.length <= MAX_VERTS || attempt >= 8) break;
    step *= 1.5;
    eps *= 1.3;
  }

  const wx: number[] = [];
  const wz: number[] = [];
  for (let k = 0; k < vx.length; k++) {
    const [x, z] = world(vx[k], vy[k]);
    wx.push(x);
    wz.push(z);
  }
  const vyH = vh.map((h) => Math.max(h, 0));
  const tris = delaunay(vx.map((x, k) => ({ x, y: vy[k] })));

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
  const ramps = new Uint8Array(vertexCount);
  let fi = 0;
  let ri = 0;
  const pushV = (x: number, y: number, z: number, n: [number, number, number], ramp: number) => {
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
  for (const t of tris) {
    const idx = [t.a, t.b, t.c];
    const e1x = wx[t.b] - wx[t.a], e1y = vyH[t.b] - vyH[t.a], e1z = wz[t.b] - wz[t.a];
    const e2x = wx[t.c] - wx[t.a], e2y = vyH[t.c] - vyH[t.a], e2z = wz[t.c] - wz[t.a];
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
    const water = idx.every((k) => vh[k] <= 0);
    const avgH = water ? -1 : (vh[t.a] + vh[t.b] + vh[t.c]) / 3;
    const ramp = water ? RAMP.WATER : faceRamp(avgH, ay);
    const info = { n: [ax, ay, az] as [number, number, number], ramp };
    edgeInfo.set(ekey(t.a, t.b), info);
    edgeInfo.set(ekey(t.b, t.c), info);
    edgeInfo.set(ekey(t.c, t.a), info);
    for (const k of idx) pushV(wx[k], vyH[k], wz[k], info.n, ramp);
  }

  for (const line of borders) {
    for (let q = 0; q + 1 < line.length; q++) {
      const a = line[q], b = line[q + 1];
      const info = edgeInfo.get(ekey(a, b));
      const ramp = info ? info.ramp : RAMP.GRASS;
      const n = info ? info.n : ([0, 1, 0] as [number, number, number]);
      const ya = vyH[a], yb = vyH[b];
      const quad: Array<[number, number, number]> = [
        [wx[a], ya, wz[a]], [wx[b], yb, wz[b]], [wx[b], yb - skirt, wz[b]],
        [wx[a], ya, wz[a]], [wx[b], yb - skirt, wz[b]], [wx[a], ya - skirt, wz[a]],
      ];
      for (const [x, y, z] of quad) pushV(x, y, z, n, ramp);
    }
  }

  return { vertices: vertices.subarray(0, fi), ramps: ramps.subarray(0, ri), vertexCount: ri };
}
