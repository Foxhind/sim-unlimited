import { RetryableError } from '../engine/queue';
import { decodeTerrarium, type Tile } from './geodesy';

const PNG_CACHE = 'terrarium-v1';
export const TERRARIUM_URL = (t: Tile) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png`;

/** PNG tiles live in the Cache API; raw responses are immutable DEM data. */
export async function fetchTerrariumPng(t: Tile): Promise<ArrayBuffer> {
  const url = TERRARIUM_URL(t);
  const cache = await caches.open(PNG_CACHE);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (res.status === 429 || res.status === 504 || res.status === 503) {
    throw new RetryableError(0, `terrarium ${res.status}`);
  }
  if (!res.ok) throw new Error(`terrarium fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'image/png' } }));
  return buf;
}

/**
 * Heights of the four tile edges, one sample per DEM pixel corner (pixels + 1 samples, both tile
 * corners included). A sample is the mean of the DEM over about one lattice cell around the point,
 * taken across the seam from both tiles, so the two neighbours of an edge — and the four tiles of
 * a corner — get bit-identical profiles.
 */
export interface TileBorders {
  /** top edge, west→east */
  n: Float32Array;
  /** bottom edge, west→east */
  s: Float32Array;
  /** left edge, north→south */
  w: Float32Array;
  /** right edge, north→south */
  e: Float32Array;
  /**
   * For the edges that lie on the parent tile's boundary (two of the four): the parent's profile
   * of its whole edge there. A coarser neighbour draws that line, so the mesh carries, per border
   * vertex, the way down or up to it (TerrainTin.coarse).
   */
  coarse?: { n?: Float32Array; s?: Float32Array; w?: Float32Array; e?: Float32Array };
}

/** DEM pixels read beyond each tile edge from the neighbouring tiles */
export const DEM_PAD = 8;

/** A tile's DEM with a margin of `pad` pixels from its eight neighbours: (size + 2·pad)² heights. */
export interface PaddedDem {
  size: number;
  pad: number;
  elev: Float32Array;
}

/**
 * `around`: the 3×3 block of tiles, row-major from the north-west (index 4 is the tile itself).
 * A missing neighbour (pole, failed download) repeats the tile's own edge pixels.
 */
export function padDem(size: number, around: ReadonlyArray<Float32Array | null>, pad = DEM_PAD): PaddedDem {
  const centre = around[4];
  if (!centre || centre.length !== size * size) throw new Error('DEM tile size mismatch');
  const w = size + 2 * pad;
  const elev = new Float32Array(w * w);
  const clamp = (v: number) => Math.max(0, Math.min(size - 1, v));
  for (let y = -pad; y < size + pad; y++) {
    const dy = y < 0 ? -1 : y >= size ? 1 : 0;
    for (let x = -pad; x < size + pad; x++) {
      const dx = x < 0 ? -1 : x >= size ? 1 : 0;
      const src = around[(dy + 1) * 3 + dx + 1];
      elev[(y + pad) * w + x + pad] = src && src.length === centre.length
        ? src[(y - dy * size) * size + (x - dx * size)]
        : centre[clamp(y) * size + clamp(x)];
    }
  }
  return { size, pad, elev };
}

/**
 * Lattice heights and edge profiles of a tile. Pixel k covers [k, k+1] of the tile's `size` units,
 * so a lattice node on an edge lies between the edge pixels of two tiles and both of them compute
 * the same height for it; the same holds for the edge profiles (see TileBorders).
 */
export function sampleDem(dem: PaddedDem, grid: number): { heights: Float32Array; borders: TileBorders } {
  const { size, pad, elev } = dem;
  const w = size + 2 * pad;
  const at = (x: number, y: number) => elev[(y + pad) * w + x + pad];

  const side = grid + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const fx = (i / grid) * size - 0.5;
      const fy = (j / grid) * size - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      heights[j * side + i] =
        at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty) + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty;
    }
  }

  // Edge profiles: box mean over one lattice cell. The interior sees the relief only at lattice
  // nodes, so DEM pixel noise kept on the border (±15 m on flat z14 tiles) would stand out as
  // tilted slivers along the seam. Summed in raster order: the same for every tile that shares it.
  const r = Math.max(1, Math.min(pad, Math.round(size / grid / 2)));
  const mean = (cx: number, cy: number): number => {
    let sum = 0;
    for (let y = cy - r; y < cy + r; y++) for (let x = cx - r; x < cx + r; x++) sum += at(x, y);
    return sum / (4 * r * r);
  };
  const borders: TileBorders = {
    n: Float32Array.from({ length: size + 1 }, (_, k) => mean(k, 0)),
    s: Float32Array.from({ length: size + 1 }, (_, k) => mean(k, size)),
    w: Float32Array.from({ length: size + 1 }, (_, k) => mean(0, k)),
    e: Float32Array.from({ length: size + 1 }, (_, k) => mean(size, k)),
  };
  return { heights, borders };
}

async function decodePngElev(png: ArrayBuffer): Promise<Float32Array> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable in worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (width !== height) throw new Error('DEM tile is not square');
  const elev = new Float32Array(width * height);
  for (let k = 0; k < elev.length; k++) elev[k] = decodeTerrarium(data[k * 4], data[k * 4 + 1], data[k * 4 + 2]);
  return elev;
}

/** decoded DEM tiles, most recent last: a tile is read again as the neighbour of up to eight others */
const ELEV_CACHE_MAX = 48;
const elevCache = new Map<string, Promise<Float32Array>>();

function tileElev(t: Tile): Promise<Float32Array> {
  const key = `${t.z}/${t.x}/${t.y}`;
  let hit = elevCache.get(key);
  if (hit) elevCache.delete(key);
  else {
    hit = fetchTerrariumPng(t).then(decodePngElev);
    hit.catch(() => elevCache.delete(key));
  }
  elevCache.set(key, hit);
  if (elevCache.size > ELEV_CACHE_MAX) elevCache.delete(elevCache.keys().next().value!);
  return hit;
}

/**
 * Lattice heights and edge profiles of a tile, read together with a margin from its eight
 * neighbours so that seams are computed from the same pixels on both sides. A neighbour that does
 * not exist is replaced by the tile's own edge; one that is only temporarily unavailable fails the
 * tile as retryable (a seam built without it would not match the neighbour's).
 */
export async function loadTileDem(tile: Tile, grid: number): Promise<{ heights: Float32Array; borders: TileBorders }> {
  const own = await loadOwnDem(tile, grid);
  if (tile.z === 0) return own;
  // the parent's view of the two edges on its boundary; without it the tile only loses the
  // stitching to a coarser neighbour (skirts still cover that seam)
  const parent = await loadOwnDem({ z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 }, grid).catch((err) => {
    if (err instanceof RetryableError) throw err;
    return null;
  });
  if (parent) own.borders.coarse = parentEdges(tile, parent.borders);
  return own;
}

/** the parent's profiles of the two edges of `tile` that lie on the parent's boundary */
export function parentEdges(tile: Tile, parent: TileBorders): NonNullable<TileBorders['coarse']> {
  return {
    ...(tile.y % 2 === 0 ? { n: parent.n } : { s: parent.s }),
    ...(tile.x % 2 === 0 ? { w: parent.w } : { e: parent.e }),
  };
}

async function loadOwnDem(tile: Tile, grid: number): Promise<{ heights: Float32Array; borders: TileBorders }> {
  const n = 2 ** tile.z;
  const around = await Promise.all(
    Array.from({ length: 9 }, (_, k) => {
      const t = { z: tile.z, x: (tile.x + (k % 3) - 1 + n) % n, y: tile.y + Math.floor(k / 3) - 1 };
      if (k === 4) return tileElev(t);
      if (t.y < 0 || t.y >= n) return null;
      return tileElev(t).catch((err) => {
        if (err instanceof RetryableError) throw err;
        return null;
      });
    }),
  );
  const centre = around[4]!;
  return sampleDem(padDem(Math.round(Math.sqrt(centre.length)), around), grid);
}

export type HeightSampler = (lon: number, lat: number) => number;

/** Bilinear DEM sampler over a tile's Mercator extent, for draping OSM geometry. */
export async function decodePngToSampler(png: ArrayBuffer, tile: Tile): Promise<HeightSampler> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable in worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const n = 2 ** tile.z;
  const elev = (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const o = (cy * width + cx) * 4;
    return decodeTerrarium(data[o], data[o + 1], data[o + 2]);
  };
  return (lon, lat) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin((clamped * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    const fx = (((lon + 180) / 360) * n - tile.x) * (width - 1);
    const fy = (merc * n - tile.y) * (height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    return (
      elev(x0, y0) * (1 - tx) * (1 - ty) +
      elev(x0 + 1, y0) * tx * (1 - ty) +
      elev(x0, y0 + 1) * (1 - tx) * ty +
      elev(x0 + 1, y0 + 1) * tx * ty
    );
  };
}

/**
 * Bilinear sampler over a (grid+1)^2 height lattice covering the tile's Mercator extent.
 * Shared by terrain, drape, lights and physics so they all see the same (flattened) surface.
 */
export function latticeSampler(heights: Float32Array, tile: Tile, grid: number): HeightSampler {
  const n = 2 ** tile.z;
  const side = grid + 1;
  const at = (i: number, j: number): number =>
    heights[Math.max(0, Math.min(grid, j)) * side + Math.max(0, Math.min(grid, i))];
  return (lon, lat) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin((clamped * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    const fx = Math.max(0, Math.min(grid, (((lon + 180) / 360) * n - tile.x) * grid));
    const fy = Math.max(0, Math.min(grid, (merc * n - tile.y) * grid));
    const i0 = Math.min(grid - 1, Math.floor(fx));
    const j0 = Math.min(grid - 1, Math.floor(fy));
    const tx = fx - i0;
    const ty = fy - j0;
    return (
      at(i0, j0) * (1 - tx) * (1 - ty) +
      at(i0 + 1, j0) * tx * (1 - ty) +
      at(i0, j0 + 1) * (1 - tx) * ty +
      at(i0 + 1, j0 + 1) * tx * ty
    );
  };
}
