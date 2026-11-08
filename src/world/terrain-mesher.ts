import { RAMP } from '../engine/palette';
import { gridLatLon, latLonToEnu, tileCenter, tileSizeMeters, type Tile } from './geodesy';

export interface TerrainMeshData {
  vertices: Float32Array; // interleaved pos.xyz + normal.xyz
  ramps: Uint8Array;
  vertexCount: number;
}

export interface TerrainMeshOptions {
  tile: Tile;
  grid: number;
  /** (grid+1)² elevations, row-major north→south */
  heights: Float32Array;
  skirtDepth?: number;
}

function faceRamp(avgH: number, ny: number): number {
  if (avgH > 2200 && ny > 0.6) return RAMP.SNOW;
  if (ny < 0.75 || avgH > 2600) return RAMP.ROCK;
  if (avgH < 3) return RAMP.SAND;
  if (avgH > 250 && avgH < 1600) return RAMP.FOREST;
  return RAMP.GRASS;
}

export function buildTerrainMesh(opts: TerrainMeshOptions): TerrainMeshData {
  const { tile, grid, heights } = opts;
  const skirt = opts.skirtDepth ?? Math.min(tileSizeMeters(tile) / 2, 2000);
  const center = tileCenter(tile);
  const side = grid + 1;
  if (heights.length !== side * side) throw new Error('heights grid size mismatch');

  const px = new Float64Array(side * side);
  const py = new Float64Array(side * side);
  const pz = new Float64Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const ll = gridLatLon(tile, i, j, grid);
      const h = heights[j * side + i];
      const [e, n] = latLonToEnu(center, ll.lat, ll.lon, 0);
      const k = j * side + i;
      px[k] = e;
      py[k] = Math.max(h, 0);
      pz[k] = -n;
    }
  }

  const landTris = grid * grid * 2;
  const skirtTris = grid * 4 * 2;
  const vertexCount = (landTris + skirtTris) * 3;
  const vertices = new Float32Array(vertexCount * 6);
  const ramps = new Uint8Array(vertexCount);
  let fi = 0;
  let ri = 0;

  const emitTri = (a: number, b: number, c: number, ramp: number, ya: number, yb: number, yc: number) => {
    const ax = px[a], az = pz[a];
    const bx = px[b], bz = pz[b];
    const cx = px[c], cz = pz[c];
    const e1x = bx - ax, e1y = yb - ya, e1z = bz - az;
    const e2x = cx - ax, e2y = yc - ya, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return; // degenerate; dropped, counts adjusted below
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const [k, y] of [[a, ya], [b, yb], [c, yc]] as const) {
      vertices[fi++] = px[k];
      vertices[fi++] = y;
      vertices[fi++] = pz[k];
      vertices[fi++] = nx;
      vertices[fi++] = ny;
      vertices[fi++] = nz;
      ramps[ri++] = ramp;
    }
  };

  const idx = (i: number, j: number) => j * side + i;
  const rawH = (i: number, j: number) => heights[j * side + i];
  // boundary edge → adjacent land face normal/ramp, so skirts shade like terrain
  const edgeInfo = new Map<number, { n: [number, number, number]; ramp: number }>();

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      const hs = [rawH(i, j), rawH(i + 1, j), rawH(i + 1, j + 1), rawH(i, j + 1)];
      const water = hs.every((h) => h <= 0);
      const avgH = water ? -1 : (hs[0] + hs[1] + hs[2] + hs[3]) / 4;
      const ya = py[a], yb = py[b], yc = py[c], yd = py[d];
      const e1x = px[b] - px[a], e1y = yb - ya, e1z = pz[b] - pz[a];
      const e2x = px[c] - px[a], e2y = yc - ya, e2z = pz[c] - pz[a];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen;
      ny /= nlen;
      nz /= nlen;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const ramp = water ? RAMP.WATER : faceRamp(avgH, Math.abs(ny));
      const info = { n: [nx, ny, nz] as [number, number, number], ramp };
      if (j === 0) edgeInfo.set(i, info);
      if (j === grid - 1) edgeInfo.set(grid + i, info);
      if (i === 0) edgeInfo.set(2 * grid + j, info);
      if (i === grid - 1) edgeInfo.set(3 * grid + j, info);
      emitTri(a, b, c, ramp, ya, yb, yc);
      emitTri(a, c, d, ramp, ya, yc, yd);
    }
  }

  // skirts: vertical quads hanging off each boundary edge hide LOD cracks
  const edges: number[][] = [
    Array.from({ length: side }, (_, i) => idx(i, 0)),
    Array.from({ length: side }, (_, i) => idx(i, grid)),
    Array.from({ length: side }, (_, j) => idx(0, j)),
    Array.from({ length: side }, (_, j) => idx(grid, j)),
  ];
  edges.forEach((line, sideIdx) => {
    for (let k = 0; k < grid; k++) {
      const a = line[k], b = line[k + 1];
      const info = edgeInfo.get(sideIdx * grid + k);
      const ramp = info ? info.ramp : RAMP.GRASS;
      const normal = info ? info.n : ([0, 1, 0] as [number, number, number]);
      emitSkirtQuad(px[a], pz[a], py[a], px[b], pz[b], py[b], skirt, ramp, normal);
    }
  });

  function emitSkirtQuad(
    ax: number, az: number, ya: number,
    bx: number, bz: number, yb: number,
    depth: number, ramp: number,
    normal: [number, number, number],
  ): void {
    const yab = ya - depth;
    const ybb = yb - depth;
    const quad: Array<[number, number, number]> = [
      [ax, ya, az], [bx, yb, bz], [bx, ybb, bz],
      [ax, ya, az], [bx, ybb, bz], [ax, yab, az],
    ];
    for (const [x, y, z] of quad) {
      vertices[fi++] = x;
      vertices[fi++] = y;
      vertices[fi++] = z;
      vertices[fi++] = normal[0];
      vertices[fi++] = normal[1];
      vertices[fi++] = normal[2];
      ramps[ri++] = ramp;
    }
  }

  return { vertices: vertices.subarray(0, fi), ramps: ramps.subarray(0, ri), vertexCount: ri };
}