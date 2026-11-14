/**
 * Builds the land palette (src/engine/land-palette.ts) from Landsat imagery of many landscapes.
 * Run in the dev server's browser console on any page:
 *
 *   const g = await import('/src/tools/land-palette-gen.ts'); console.log(await g.generate());
 *
 * and paste the printed array into land-palette.ts. buildLandPalette is pure and tested.
 */
import { gaussianBlur } from '../world/landsat-process';
import { fetchLandsatTile } from '../world/landsat';
import { tileForLatLon, tileSizeMeters } from '../world/geodesy';
import { LAND_PALETTE_SIZE } from '../engine/palette';

/** places sampled for the palette: deserts, forests, mountains, snow, fields, steppe, tundra, water */
export const SAMPLE_SITES: Array<[string, number, number]> = [
  ['Innsbruck', 47.26, 11.39], ['Matterhorn', 45.976, 7.658], ['Grand Canyon', 36.1, -112.1], ['Monaco', 43.735, 7.42],
  ['Po valley', 45.43, 9.5], ['Elbrus', 43.35, 42.44], ['Kilimanjaro', -3.07, 37.35], ['Sochi', 43.6, 39.73],
  ['Moscow', 55.75, 37.6], ['Sahara', 27, 3], ['Namib', -24.7, 15.3], ['Uluru', -25.3, 131.0],
  ['Atacama', -23.5, -68.5], ['Death Valley', 36.5, -117], ['Monument Valley', 37, -110.1], ['Amazon', -3, -60],
  ['Congo', 0, 20], ['Borneo', 1, 114], ['Taiga', 60, 100], ['Tundra', 68, 60],
  ['Iceland', 64.5, -19], ['Greenland coast', 64.2, -51.5], ['Mont Blanc', 45.8, 6.9], ['Everest', 28, 86.9],
  ['Tibet', 32, 88], ['Gobi', 43, 105], ['Dasht-e Kavir', 33, 55], ['Arabia', 23, 47],
  ['Nile delta', 30.8, 31], ['Netherlands', 52.5, 5.5], ['Kansas', 38.5, -98], ['Ukraine steppe', 48, 35],
  ['Wheat belt', -31, 117], ['Central Valley', 36.5, -120], ['Patagonia', -48, -70], ['Andes', -13.2, -72],
  ['Fuji', 35.4, 138.7], ['Norway fjords', 61, 7], ['Scotland', 57, -5], ['Meseta', 40, -4],
  ['Kazakhstan', 47, 70], ['Deccan', 18, 76], ['Ganges', 26, 83], ['Mekong delta', 10, 105.8],
  ['Sahel', 14, 0], ['Serengeti', -2.5, 34.8], ['Kalahari', -22, 22], ['Lake Baikal', 53.5, 108],
];

/** zoom of the sampled imagery tiles and the blur the game applies (metres) */
const SAMPLE_Z = 10;
const BLUR_M = 360;

type Lab = [number, number, number];

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function oklab(r: number, g: number, b: number): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** colour counts on the 6-bit cube: index (r6 << 12) | (g6 << 6) | b6 */
export type Histogram = Map<number, number>;

export function addToHistogram(h: Histogram, data: ArrayLike<number>): void {
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2);
    h.set(k, (h.get(k) ?? 0) + 1);
  }
}

const to8 = (v6: number) => Math.round((v6 * 255) / 63);

/** fixed entries: a neutral grey scale, so no area is pushed to a tint it does not have */
const GREYS = 16;

/**
 * The land palette: GREYS neutral greys plus a weighted median cut of the histogram in OKLab.
 * Weights are counts^0.5, so rare colours (snow, red desert, water) still get boxes of their own.
 * Every entry is 6-bit (0..63 per channel, as the VGA DAC), distinct, sorted dark to light by hue.
 */
export function buildLandPalette(h: Histogram, size = LAND_PALETTE_SIZE): Array<[number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  for (let i = 0; i < GREYS; i++) {
    const v = Math.round((i * 63) / (GREYS - 1));
    out.set((v << 12) | (v << 6) | v, [v, v, v]);
  }
  interface Bin { k: number; w: number; lab: Lab }
  const bins: Bin[] = [...h].map(([k, n]) => ({ k, w: Math.sqrt(n), lab: oklab(to8(k >> 12), to8((k >> 6) & 63), to8(k & 63)) }));
  bins.sort((a, b) => a.k - b.k);
  const mean = (box: Bin[]): number => {
    let w = 0, L = 0, A = 0, B = 0;
    for (const b of box) { w += b.w; L += b.lab[0] * b.w; A += b.lab[1] * b.w; B += b.lab[2] * b.w; }
    // the bin nearest the weighted mean: an actual imagery colour, already 6-bit
    let best = box[0], bd = Infinity;
    for (const b of box) {
      const d = (b.lab[0] - L / w) ** 2 + (b.lab[1] - A / w) ** 2 + (b.lab[2] - B / w) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best.k;
  };
  let boxes: Bin[][] = [bins];
  const want = size - GREYS;
  const colours = () => new Set(boxes.map(mean).filter((k) => !out.has(k)));
  while (colours().size < want) {
    // split the box with the largest weighted spread along its widest OKLab axis
    let bi = -1, axis = 0, score = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      let w = 0;
      for (const b of box) w += b.w;
      for (let c = 0; c < 3; c++) {
        let lo = Infinity, hi = -Infinity;
        for (const b of box) { if (b.lab[c] < lo) lo = b.lab[c]; if (b.lab[c] > hi) hi = b.lab[c]; }
        const s = (hi - lo) * Math.sqrt(w);
        if (s > score) { score = s; bi = i; axis = c; }
      }
    });
    if (bi < 0) break;
    const box = boxes[bi].slice().sort((p, q) => p.lab[axis] - q.lab[axis] || p.k - q.k);
    let total = 0;
    for (const b of box) total += b.w;
    let acc = 0, m = 1;
    for (; m < box.length - 1; m++) { acc += box[m - 1].w; if (acc >= total / 2) break; }
    boxes = [...boxes.slice(0, bi), box.slice(0, m), box.slice(m), ...boxes.slice(bi + 1)];
  }
  for (const k of [...colours()].slice(0, want)) out.set(k, [k >> 12, (k >> 6) & 63, k & 63]);
  const hue = ([r, g, b]: [number, number, number]) => {
    const [, A, B] = oklab(to8(r), to8(g), to8(b));
    return Math.hypot(A, B) < 0.02 ? -1 : Math.round(((Math.atan2(B, A) / Math.PI) * 180 + 360) % 360 / 30);
  };
  const L = ([r, g, b]: [number, number, number]) => oklab(to8(r), to8(g), to8(b))[0];
  return [...out.values()].sort((p, q) => hue(p) - hue(q) || L(p) - L(q));
}

/** fetch the sample, blur it as the game does, and print the palette as source */
export async function generate(): Promise<string> {
  const h: Histogram = new Map();
  for (const [name, lat, lon] of SAMPLE_SITES) {
    const t = tileForLatLon(lat, lon, SAMPLE_Z);
    try {
      const img = await fetchLandsatTile(t);
      const sigma = BLUR_M / (tileSizeMeters(t) / img.width);
      addToHistogram(h, gaussianBlur(img, sigma).data);
    } catch (err) {
      console.warn(`[land palette] ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const p = buildLandPalette(h);
  const rows: string[] = [];
  for (let i = 0; i < p.length; i += 8) rows.push('  ' + p.slice(i, i + 8).map((c) => `[${c.join(', ')}]`).join(', ') + ',');
  return rows.join('\n');
}
