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

/** Full-resolution heights of the four tile edges (one sample per DEM pixel), shared by all LODs. */
export interface TileBorders {
  /** top row, west→east */
  n: Float32Array;
  /** bottom row, west→east */
  s: Float32Array;
  /** left column, north→south */
  w: Float32Array;
  /** right column, north→south */
  e: Float32Array;
}

export async function decodePngToTile(
  png: ArrayBuffer,
  grid: number,
): Promise<{ heights: Float32Array; borders: TileBorders }> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable in worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const elev = (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const o = (cy * width + cx) * 4;
    return decodeTerrarium(data[o], data[o + 1], data[o + 2]);
  };

  const side = grid + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const fx = (i / grid) * (width - 1);
      const fy = (j / grid) * (height - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const h00 = elev(x0, y0);
      const h10 = elev(x0 + 1, y0);
      const h01 = elev(x0, y0 + 1);
      const h11 = elev(x0 + 1, y0 + 1);
      heights[j * side + i] =
        h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
    }
  }
  const borders: TileBorders = {
    n: new Float32Array(width),
    s: new Float32Array(width),
    w: new Float32Array(height),
    e: new Float32Array(height),
  };
  for (let x = 0; x < width; x++) {
    borders.n[x] = elev(x, 0);
    borders.s[x] = elev(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    borders.w[y] = elev(0, y);
    borders.e[y] = elev(width - 1, y);
  }
  return { heights, borders };
}

export async function decodePngToHeights(png: ArrayBuffer, grid: number): Promise<Float32Array> {
  return (await decodePngToTile(png, grid)).heights;
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
