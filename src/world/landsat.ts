/**
 * Terrain colours from Landsat imagery: NASA GIBS, Global WELD true-colour annual composite
 * (cloud-free, 30 m Landsat, year 2000), Web Mercator WMTS — the same z/x/y grid as the
 * Terrarium DEM. The layer stops at z12, so z13/z14 tiles read their part of the z12 ancestor.
 *
 * Each terrain face takes the mean imagery colour under it, snapped to the nearest colour of the
 * default VGA palette; lighting, fog and night are shades of that colour in the LUT.
 */
import { TERRAIN_RAMP_BASE, nearestVga } from '../engine/palette';
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

/** terrain ramp of an imagery colour: its nearest default-VGA colour, shaded through the LUT */
export function landsatRamp(r: number, g: number, b: number): number {
  return TERRAIN_RAMP_BASE + nearestVga(r, g, b);
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** face colour in lattice coordinates (0..grid over the tile) → ramp */
export type FaceColor = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => number;

/**
 * Ramp of a terrain face: the mean imagery colour of the pixels whose centres fall inside it
 * (the centroid pixel for a face thinner than a pixel), snapped to the nearest ramp.
 */
export function landsatFaceColor(img: RgbaImage, tile: Tile, grid: number): FaceColor {
  const src = landsatSource(tile);
  const k = (src.scale * img.width) / grid; // image pixels per lattice cell
  const px = (gx: number) => src.x0 * img.width + gx * k;
  const py = (gy: number) => src.y0 * img.height + gy * k;
  const at = (x: number, y: number) => {
    const ix = Math.max(0, Math.min(img.width - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
    return (iy * img.width + ix) * 4;
  };
  return (ax, ay, bx, by, cx, cy) => {
    const x0 = px(ax), y0 = py(ay), x1 = px(bx), y1 = py(by), x2 = px(cx), y2 = py(cy);
    const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    let r = 0, g = 0, b = 0, n = 0;
    if (d !== 0) {
      const i0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), i1 = Math.min(img.width - 1, Math.ceil(Math.max(x0, x1, x2)));
      const j0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), j1 = Math.min(img.height - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let j = j0; j <= j1; j++) {
        const sy = j + 0.5;
        for (let i = i0; i <= i1; i++) {
          const sx = i + 0.5;
          const w1 = ((sx - x0) * (y2 - y0) - (x2 - x0) * (sy - y0)) / d;
          const w2 = ((x1 - x0) * (sy - y0) - (sx - x0) * (y1 - y0)) / d;
          if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
          const o = (j * img.width + i) * 4;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
        }
      }
    }
    if (!n) {
      const o = at((x0 + x1 + x2) / 3, (y0 + y1 + y2) / 3);
      return landsatRamp(img.data[o], img.data[o + 1], img.data[o + 2]);
    }
    return landsatRamp(r / n, g / n, b / n);
  };
}

/** the imagery tile for `t` (Cache API), decoded to RGBA; worker-side (OffscreenCanvas) */
export async function fetchLandsat(t: Tile): Promise<RgbaImage> {
  const url = LANDSAT_URL(landsatSource(t).tile);
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
  if (!ctx) throw new Error('2d context unavailable in worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width, height };
}
