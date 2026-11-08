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

export async function decodePngToHeights(png: ArrayBuffer, grid: number): Promise<Float32Array> {
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
  return heights;
}