/**
 * Terrain colours from Landsat imagery: NASA GIBS, Global WELD true-colour annual composite
 * (cloud-free, 30 m Landsat, year 2000), Web Mercator WMTS — the same z/x/y grid as the
 * Terrarium DEM. The layer stops at z12, so z13/z14 tiles read their part of the z12 ancestor.
 *
 * landsat-process.ts turns it into terrain colours (the land palette, RGB face colours lit in the
 * shader) and colour boundaries for the TIN.
 */
import { RetryableError } from '../engine/queue';
import type { Tile } from './geodesy';

export const LANDSAT_LAYER = 'Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual';
export const LANDSAT_TIME = '2000-12-01';
export const LANDSAT_MAX_Z = 12;
export const LANDSAT_ATTRIBUTION = 'Landsat/WELD: NASA GIBS';
const IMAGE_CACHE = 'landsat-weld-v1';

export const LANDSAT_URL = (t: Tile) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${LANDSAT_LAYER}/default/${LANDSAT_TIME}/GoogleMapsCompatible_Level12/${t.z}/${t.y}/${t.x}.jpeg`;

/** the imagery tile covering `t` and where `t` sits in it, as fractions of the image */
export function landsatSource(t: Tile): { tile: Tile; x0: number; y0: number; scale: number } {
  if (t.z <= LANDSAT_MAX_Z) return { tile: t, x0: 0, y0: 0, scale: 1 };
  const k = 2 ** (t.z - LANDSAT_MAX_Z);
  const tile = { z: LANDSAT_MAX_Z, x: Math.floor(t.x / k), y: Math.floor(t.y / k) };
  return { tile, x0: (t.x - tile.x * k) / k, y0: (t.y - tile.y * k) / k, scale: 1 / k };
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** face colour in lattice coordinates (0..grid over the tile) → ramp */
export type FaceColor = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => number;

/** one imagery tile (z ≤ 12) from the Cache API or GIBS, decoded to RGBA (OffscreenCanvas) */
export async function fetchLandsatTile(s: Tile): Promise<RgbaImage> {
  const url = LANDSAT_URL(s);
  const cache = await caches.open(IMAGE_CACHE);
  let buf: ArrayBuffer;
  const hit = await cache.match(url);
  if (hit) buf = await hit.arrayBuffer();
  else {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new RetryableError(5000, `landsat unreachable: ${err instanceof Error ? err.message : err}`);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(5000, `landsat ${res.status}`);
    if (!res.ok) throw new Error(`landsat fetch failed: ${res.status}`);
    buf = await res.arrayBuffer();
    await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'image/jpeg' } }));
  }
  const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width, height };
}
