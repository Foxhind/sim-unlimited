/**
 * Dev tool (inspector.html): one terrain tile from the source DEM to the rendered TIN.
 * Uses the game's own pipeline — fetchTerrariumPng → loadTileDem(gridForZoom) →
 * buildTerrainTin(borders) — so what you see here is what the sim meshes.
 */
import { gridForZoom, MAX_Z, MIN_Z } from '../world/chunks';
import { decodeTerrarium, gridLatLon, tileCenter, tileForLatLon, tileSizeMeters, type Tile } from '../world/geodesy';
import { PRESETS, SOURCE } from './presets';
import { loadTileDem, fetchTerrariumPng, type TileBorders } from '../world/terrain-source';
import { beltStepForZoom, buildTerrainTin, EPS_START, isSeaFace, type TerrainTin, type TinDebug } from '../world/terrain-tin';
import { parseMapLink } from '../ui/map-links';
import { isMaterial, LAND_PALETTE, nearestLand, rgbOf } from '../engine/palette';
import { fetchLandsatTile, landsatSource, type RgbaImage } from '../world/landsat';
import { cleanLabels, colourBoundaries, faceColorByMode, LANDSAT_TUNING, neighbourTiles, processLandsat, stitch3x3, type ColourLine, type ProcessedLandsat } from '../world/landsat-process';

// ---------- data ----------

interface Dem {
  w: number;
  h: number;
  elev: Float32Array;
  min: number;
  max: number;
}

interface Built {
  tin: TerrainTin;
  dbg: TinDebug;
  ms: number;
  /** TIN height (water clamped) at every DEM pixel */
  atPx: Float32Array;
  locate: (u: number, v: number) => { tri: number; h: number } | null;
  flat: Uint8Array;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => {
  const v = parseFloat($<HTMLInputElement>(id).value);
  return Number.isFinite(v) ? v : undefined;
};

let tile: Tile = { z: 12, x: 0, y: 0 };
let dem: Dem | null = null;
let lattice: Float32Array | null = null;
let borders: TileBorders | null = null;
let grid = 32;
let built: Built | null = null;
let demImg: HTMLCanvasElement | null = null;
let errImg: HTMLCanvasElement | null = null;
let profileLine: [[number, number], [number, number]] | null = null;
let hover: [number, number] | null = null;
/** Landsat: stitched 3×3 mosaic around the imagery tile, its processing, and per-face land palette colours */
let lsMosaic: RgbaImage | null = null;
let lsProc: ProcessedLandsat | null = null;
let lsImgs: Record<'ls-raw' | 'ls-blur' | 'ls-quant', HTMLCanvasElement> | null = null;
let lsFace: Int16Array | null = null;
/** colour boundaries after cleanup and simplification (lattice coords) */
let lsLines: ColourLine[] = [];
/** point from a pasted map link, marked on the map while its tile (or a neighbour) is shown */
let pin: { lat: number; lon: number } | null = null;

/** lattice coords of a lon/lat in the current tile (may fall outside [0, grid]) */
function toUV(lat: number, lon: number): [number, number] {
  const n = 2 ** tile.z;
  const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  const merc = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [(((lon + 180) / 360) * n - tile.x) * grid, (merc * n - tile.y) * grid];
}
const pinUV = (): [number, number] | null => {
  if (!pin) return null;
  const [u, v] = toUV(pin.lat, pin.lon);
  return u >= 0 && v >= 0 && u <= grid && v <= grid ? [u, v] : null;
};

async function decodeDem(png: ArrayBuffer): Promise<Dem> {
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  const elev = new Float32Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < elev.length; k++) {
    elev[k] = decodeTerrarium(data[k * 4], data[k * 4 + 1], data[k * 4 + 2]);
    min = Math.min(min, elev[k]);
    max = Math.max(max, elev[k]);
  }
  return { w: width, h: height, elev, min, max };
}

/** DEM bilinear at lattice coords (same pixel mapping as sampleDem, clamped to the tile) */
function demAt(u: number, v: number): number {
  const d = dem!;
  const fx = Math.max(0, Math.min(d.w - 1, (u / grid) * d.w - 0.5));
  const fy = Math.max(0, Math.min(d.h - 1, (v / grid) * d.h - 0.5));
  const x0 = Math.min(d.w - 2, Math.floor(fx)), y0 = Math.min(d.h - 2, Math.floor(fy));
  const tx = fx - x0, ty = fy - y0;
  const e = (x: number, y: number) => d.elev[y * d.w + x];
  return e(x0, y0) * (1 - tx) * (1 - ty) + e(x0 + 1, y0) * tx * (1 - ty) + e(x0, y0 + 1) * (1 - tx) * ty + e(x0 + 1, y0 + 1) * tx * ty;
}

function latticeAt(u: number, v: number): number {
  const side = grid + 1;
  const fx = Math.max(0, Math.min(grid, u)), fy = Math.max(0, Math.min(grid, v));
  const i = Math.min(grid - 1, Math.floor(fx)), j = Math.min(grid - 1, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  const h = lattice!;
  return (
    h[j * side + i] * (1 - tx) * (1 - ty) + h[j * side + i + 1] * tx * (1 - ty) + h[(j + 1) * side + i] * (1 - tx) * ty + h[(j + 1) * side + i + 1] * tx * ty
  );
}

function bary(tin: TerrainTin, ti: number, u: number, v: number): [number, number, number] | null {
  const t = tin.tris[ti];
  const ax = tin.vx[t.a], ay = tin.vy[t.a];
  const d = (tin.vx[t.b] - ax) * (tin.vy[t.c] - ay) - (tin.vx[t.c] - ax) * (tin.vy[t.b] - ay);
  if (d === 0) return null;
  const w1 = ((u - ax) * (tin.vy[t.c] - ay) - (tin.vx[t.c] - ax) * (v - ay)) / d;
  const w2 = ((tin.vx[t.b] - ax) * (v - ay) - (u - ax) * (tin.vy[t.b] - ay)) / d;
  return [1 - w1 - w2, w1, w2];
}

function build(): void {
  if (!lattice || !dem) return;
  const dbg: TinDebug = {};
  const t0 = performance.now();
  const tin = buildTerrainTin(tile, grid, lattice, {
    step: num('step'),
    eps: num('eps'),
    inscribed: $<HTMLInputElement>('inscribed').checked,
    borders: borders ?? undefined,
    debug: dbg,
    colour: lsProc && $<HTMLInputElement>('lsMesh').checked
      ? { label: lsProc.quantized.index, size: lsProc.quantized.image.width, maxDh: num('lsMaxDh') }
      : undefined,
    colourLines: lsProc && $<HTMLInputElement>('lsEdges').checked
      ? { lines: lsLines, maxVerts: num('lsMaxVerts') }
      : undefined,
  });
  const ms = performance.now() - t0;
  const hv = tin.vh.map((h) => Math.max(h, 0));
  const flat = new Uint8Array(tin.tris.length);
  // flat = all three corners at one height on land; flat water at 0 m is what the sea should be
  tin.tris.forEach((t, k) => (flat[k] = tin.vh[t.a] === tin.vh[t.b] && tin.vh[t.b] === tin.vh[t.c] && tin.vh[t.a] > 0 ? 1 : 0));

  // TIN raster at DEM pixel centres
  const d = dem;
  const atPx = new Float32Array(d.w * d.h).fill(NaN);
  const sx = (d.w - 1) / grid, sy = (d.h - 1) / grid;
  tin.tris.forEach((t, ti) => {
    const xs = [tin.vx[t.a], tin.vx[t.b], tin.vx[t.c]], ys = [tin.vy[t.a], tin.vy[t.b], tin.vy[t.c]];
    const x0 = Math.max(0, Math.floor(Math.min(...xs) * sx)), x1 = Math.min(d.w - 1, Math.ceil(Math.max(...xs) * sx));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) * sy)), y1 = Math.min(d.h - 1, Math.ceil(Math.max(...ys) * sy));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const w = bary(tin, ti, px / sx, py / sy);
        if (!w || w[0] < -1e-9 || w[1] < -1e-9 || w[2] < -1e-9) continue;
        atPx[py * d.w + px] = hv[t.a] * w[0] + hv[t.b] * w[1] + hv[t.c] * w[2];
      }
    }
  });

  const locate = (u: number, v: number) => {
    let best = -1, bm = -Infinity, bw: [number, number, number] = [0, 0, 0];
    for (let ti = 0; ti < tin.tris.length; ti++) {
      const w = bary(tin, ti, u, v);
      if (!w) continue;
      const m = Math.min(...w);
      if (m > bm) {
        bm = m;
        best = ti;
        bw = w;
      }
    }
    if (best < 0 || bm < -0.05) return null;
    const t = tin.tris[best];
    return { tri: best, h: hv[t.a] * bw[0] + hv[t.b] * bw[1] + hv[t.c] * bw[2] };
  };

  built = { tin, dbg, ms, atPx, locate, flat };
  errImg = makeErrImage();
  colourFaces();
  renderStats();
  drawAll();
}

// ---------- colours ----------

const STOPS: Array<[number, [number, number, number]]> = [
  [0, [46, 94, 56]],
  [0.3, [110, 145, 62]],
  [0.55, [180, 165, 108]],
  [0.8, [140, 112, 86]],
  [1, [242, 242, 242]],
];
function hyps(h: number): [number, number, number] {
  if (h <= 0) return [44, 79, 124];
  const d = dem!;
  const t = Math.max(0, Math.min(1, (h - Math.max(d.min, 0)) / Math.max(1, d.max - Math.max(d.min, 0))));
  for (let k = 1; k < STOPS.length; k++) {
    if (t <= STOPS[k][0]) {
      const [t0, c0] = STOPS[k - 1], [t1, c1] = STOPS[k];
      const f = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((i) => c0[i] + (c1[i] - c0[i]) * f) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
const rgb = (c: [number, number, number], k = 1) => `rgb(${(c[0] * k) | 0},${(c[1] * k) | 0},${(c[2] * k) | 0})`;
/** Lambert shade for a surface normal (nx, ny up, nz), light from the north-west */
function shade(nx: number, ny: number, nz: number): number {
  const l = [-0.5, 0.75, -0.43];
  const len = Math.hypot(nx, ny, nz) || 1;
  return 0.35 + 0.65 * Math.max(0, (nx * l[0] + ny * l[1] + nz * l[2]) / len);
}

function makeDemImage(): HTMLCanvasElement {
  const d = dem!;
  const c = document.createElement('canvas');
  c.width = d.w;
  c.height = d.h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(d.w, d.h);
  const pm = tileSizeMeters(tile) / (d.w - 1);
  const e = (x: number, y: number) => Math.max(0, d.elev[Math.max(0, Math.min(d.h - 1, y)) * d.w + Math.max(0, Math.min(d.w - 1, x))]);
  for (let y = 0; y < d.h; y++) {
    for (let x = 0; x < d.w; x++) {
      const dx = (e(x + 1, y) - e(x - 1, y)) / (2 * pm), dz = (e(x, y + 1) - e(x, y - 1)) / (2 * pm);
      const s = shade(-dx, 1, -dz);
      const col = hyps(d.elev[y * d.w + x]);
      const o = (y * d.w + x) * 4;
      img.data[o] = col[0] * s;
      img.data[o + 1] = col[1] * s;
      img.data[o + 2] = col[2] * s;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeErrImage(): HTMLCanvasElement {
  const d = dem!, b = built!;
  const c = document.createElement('canvas');
  c.width = d.w;
  c.height = d.h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(d.w, d.h);
  const scale = b.dbg.step ?? 50;
  for (let k = 0; k < d.w * d.h; k++) {
    const t = b.atPx[k];
    const o = k * 4;
    if (Number.isNaN(t)) {
      img.data[o + 3] = 0;
      continue;
    }
    const e = Math.max(-1, Math.min(1, (t - Math.max(0, d.elev[k])) / scale));
    // blue: TIN below the DEM, red: above
    img.data[o] = e > 0 ? 235 : 235 + e * 200;
    img.data[o + 1] = 235 - Math.abs(e) * 190;
    img.data[o + 2] = e < 0 ? 235 : 235 - e * 200;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- stats ----------

function renderStats(): void {
  const b = built!, d = dem!, tin = b.tin;
  let se = 0, n = 0, maxE = 0, bias = 0;
  for (let k = 0; k < d.w * d.h; k++) {
    if (Number.isNaN(b.atPx[k])) continue;
    const e = b.atPx[k] - Math.max(0, d.elev[k]);
    se += e * e;
    bias += e;
    maxE = Math.max(maxE, Math.abs(e));
    n++;
  }
  let sl = 0, nl = 0, maxL = 0;
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const r = b.locate(i, j);
      if (!r) continue;
      const e = r.h - Math.max(0, lattice![j * (grid + 1) + i]);
      sl += e * e;
      maxL = Math.max(maxL, Math.abs(e));
      nl++;
    }
  }
  const rawPts = (b.dbg.raw ?? []).reduce((s, l) => s + l.pts.length, 0);
  const levels = new Set((b.dbg.raw ?? []).map((l) => l.level)).size;
  const flats = b.flat.reduce((s, v) => s + v, 0);
  const base = beltStepForZoom(tile.z);
  const f = (x: number) => x.toFixed(1);
  $('stats').innerHTML = [
    `DEM ${d.w}×${d.h} px, ${f(tileSizeMeters(tile) / (d.w - 1))} м/px`,
    `высоты ${f(d.min)} … ${f(d.max)} м`,
    `решётка ${grid}×${grid}, ${f(tileSizeMeters(tile) / grid)} м/ячейка`,
    ``,
    `шаг пояса ${b.dbg.step} м${b.dbg.step !== (num('step') ?? base) ? ' (поднят бюджетом)' : ''}`,
    `eps ${f(b.dbg.eps ?? 0)} ячеек, уровней ${levels}`,
    `изолиний ${(b.dbg.raw ?? []).length}, сырых точек ${rawPts}`,
    `вершин ${tin.vx.length}: граница ${b.dbg.borderVerts}, изолинии ${tin.vx.length - (b.dbg.borderVerts ?? 0) - (b.dbg.colourVerts ?? 0) - (b.dbg.colourCrossings ?? 0)}` +
      (b.dbg.colourVerts ? `, границы цветов ${b.dbg.colourVerts} + пересечения ${b.dbg.colourCrossings}` : ''),
    ...(b.dbg.inscribedMoved !== undefined
      ? [`внутрь грунта: сдвинуто вершин ${b.dbg.inscribedMoved}, возвращено ${b.dbg.inscribedReverted} (сдвиг пересекал соседей)`]
      : []),
    `треугольников ${tin.tris.length}, плоских ${flats}`,
    `рёбер-ограничений ${(b.dbg.constraints ?? []).length}` +
      (b.dbg.missing ? `, <span class="err">не вставлено ${b.dbg.missing}</span>` : ', все вставлены'),
    `сборка ${f(b.ms)} мс`,
    ``,
    `TIN − DEM: rms ${f(Math.sqrt(se / n))}, max ${f(maxE)}, смещение ${f(bias / n)} м`,
    `TIN − решётка: rms ${f(Math.sqrt(sl / nl))}, max ${f(maxL)} м`,
  ].join('\n');
}

// ---------- canvases ----------

function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// map view: screen = (u * s + ox, v * s + oy), CSS pixels
const view = { s: 0, ox: 0, oy: 0 };
function fitView(): void {
  const r = $('map').getBoundingClientRect();
  view.s = (Math.min(r.width, r.height) * 0.92) / grid;
  view.ox = (r.width - grid * view.s) / 2;
  view.oy = (r.height - grid * view.s) / 2;
}
const toScr = (u: number, v: number): [number, number] => [u * view.s + view.ox, v * view.s + view.oy];
const toLat = (x: number, y: number): [number, number] => [(x - view.ox) / view.s, (y - view.oy) / view.s];
const layer = (name: string) => document.querySelector<HTMLInputElement>(`[data-layer=${name}]`)!.checked;

function drawMap(): void {
  const c = $<HTMLCanvasElement>('map');
  const ctx = fitCanvas(c);
  const r = c.getBoundingClientRect();
  ctx.fillStyle = '#0c0e12';
  ctx.fillRect(0, 0, r.width, r.height);
  if (!built || !dem) return;
  const { tin, dbg, flat } = built;
  const fill = $<HTMLSelectElement>('fill').value;
  const tri = (ti: number) => {
    const t = tin.tris[ti];
    ctx.beginPath();
    for (const k of [t.a, t.b, t.c]) ctx.lineTo(...toScr(tin.vx[k], tin.vy[k]));
    ctx.closePath();
  };
  const pxImage = (img: HTMLCanvasElement) => {
    // pixel k is centred on u = k / (w − 1) · grid
    const cell = (grid / (dem!.w - 1)) * view.s;
    const [x, y] = toScr(0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x - cell / 2, y - cell / 2, cell * dem!.w, cell * dem!.h);
  };

  if (fill === 'dem' && demImg) pxImage(demImg);
  if ((fill === 'ls-raw' || fill === 'ls-blur' || fill === 'ls-quant') && lsImgs) {
    // the imagery crop covers exactly [0, grid]²
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lsImgs[fill], ...toScr(0, 0), grid * view.s, grid * view.s);
  }
  if (fill === 'ls-faces' && lsFace) {
    tin.tris.forEach((_, ti) => {
      ctx.fillStyle = faceRgb(ti);
      tri(ti);
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    });
  }
  if (fill === 'error' && errImg) pxImage(errImg);
  if (fill === 'tinshade' || fill === 'belts') {
    const size = tileSizeMeters(tile) / grid;
    const step = dbg.step ?? 50;
    tin.tris.forEach((t, ti) => {
      const h = [t.a, t.b, t.c].map((k) => Math.max(0, tin.vh[k]));
      const p = [t.a, t.b, t.c].map((k) => [tin.vx[k] * size, tin.vy[k] * size]);
      const e1 = [p[1][0] - p[0][0], h[1] - h[0], p[1][1] - p[0][1]], e2 = [p[2][0] - p[0][0], h[2] - h[0], p[2][1] - p[0][1]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      if (ny < 0) [nx, ny, nz] = [-nx, -ny, -nz];
      const avg = (h[0] + h[1] + h[2]) / 3;
      let col = hyps(avg);
      if (fill === 'belts') {
        const belt = Math.floor(Math.min(...h) / step + 1e-6);
        col = hyps((belt + 0.5) * step);
        const k = belt % 2 ? 0.8 : 1.05;
        col = [col[0] * k, col[1] * k, col[2] * k];
      }
      ctx.fillStyle = rgb(col, fill === 'tinshade' ? shade(nx, ny, nz) : 1);
      tri(ti);
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    });
  }

  // tile frame
  ctx.strokeStyle = '#3a4250';
  ctx.lineWidth = 1;
  ctx.strokeRect(...toScr(0, 0), grid * view.s, grid * view.s);

  if (layer('lattice')) {
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    const rad = Math.max(1, Math.min(2.5, view.s / 8));
    for (let j = 0; j <= grid; j++) for (let i = 0; i <= grid; i++) {
      const [x, y] = toScr(i, j);
      ctx.fillRect(x - rad / 2, y - rad / 2, rad, rad);
    }
  }
  if (layer('flat')) {
    ctx.fillStyle = 'rgba(255,77,109,.45)';
    flat.forEach((f, ti) => {
      if (!f) return;
      tri(ti);
      ctx.fill();
    });
  }
  if (layer('raw')) {
    ctx.strokeStyle = 'rgba(20,20,20,.55)';
    ctx.lineWidth = 1;
    for (const l of dbg.raw ?? []) {
      ctx.beginPath();
      for (const p of l.pts) ctx.lineTo(...toScr(p.x, p.y));
      if (l.closed) ctx.closePath();
      ctx.stroke();
    }
  }
  if (layer('edges')) {
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (const t of tin.tris) {
      ctx.moveTo(...toScr(tin.vx[t.a], tin.vy[t.a]));
      ctx.lineTo(...toScr(tin.vx[t.b], tin.vy[t.b]));
      ctx.lineTo(...toScr(tin.vx[t.c], tin.vy[t.c]));
      ctx.closePath();
    }
    ctx.stroke();
  }
  if (layer('constraints')) {
    const rim = (q: number) => q === 0 || q === grid;
    ctx.lineWidth = 2;
    for (const [a, b] of dbg.constraints ?? []) {
      const onEdge = (tin.vx[a] === tin.vx[b] && rim(tin.vx[a])) || (tin.vy[a] === tin.vy[b] && rim(tin.vy[a]));
      ctx.strokeStyle = onEdge ? '#4fc3d9' : '#f0b54a';
      ctx.beginPath();
      ctx.moveTo(...toScr(tin.vx[a], tin.vy[a]));
      ctx.lineTo(...toScr(tin.vx[b], tin.vy[b]));
      ctx.stroke();
    }
  }
  if (layer('verts')) {
    const nb = dbg.borderVerts ?? 0;
    for (let k = 0; k < tin.vx.length; k++) {
      ctx.fillStyle = k < nb ? '#4fc3d9' : '#f0b54a';
      const [x, y] = toScr(tin.vx[k], tin.vy[k]);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (hover) {
    const r = built.locate(...hover);
    if (r) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      tri(r.tri);
      ctx.stroke();
    }
  }
  const pu = pinUV();
  if (pu) {
    const [x, y] = toScr(...pu);
    for (const c of ['#000', '#ff3b30']) {
      ctx.strokeStyle = c;
      ctx.lineWidth = c === '#000' ? 4 : 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.moveTo(x - 12, y);
      ctx.lineTo(x - 4, y);
      ctx.moveTo(x + 4, y);
      ctx.lineTo(x + 12, y);
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x, y - 4);
      ctx.moveTo(x, y + 4);
      ctx.lineTo(x, y + 12);
      ctx.stroke();
    }
  }
  if (layer('lsLines') && lsLines.length) {
    ctx.strokeStyle = '#ff8c1a';
    ctx.lineWidth = 1.5;
    for (const l of lsLines) {
      ctx.beginPath();
      for (const p of l.pts) ctx.lineTo(...toScr(p.x, p.y));
      ctx.stroke();
    }
  }
  if (profileLine) {
    ctx.strokeStyle = '#ff5ad1';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(...toScr(...profileLine[0]));
    ctx.lineTo(...toScr(...profileLine[1]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function renderHover(): void {
  const el = $('hover');
  if (!hover || !built || !dem) {
    el.style.display = 'none';
    return;
  }
  const [u, v] = hover;
  if (u < 0 || v < 0 || u > grid || v > grid) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const ll = gridLatLon(tile, u, v, grid);
  const dh = demAt(u, v), lh = latticeAt(u, v);
  const r = built.locate(u, v);
  const tin = built.tin;
  let tri = '';
  if (r) {
    const t = tin.tris[r.tri];
    tri = `\nтреугольник #${r.tri}: ${[t.a, t.b, t.c].map((k) => `${k}@${tin.vh[k].toFixed(0)}`).join(' ')}${built.flat[r.tri] ? ' (плоский)' : ''}`;
  }
  el.innerHTML = `<pre>u ${u.toFixed(2)}  v ${v.toFixed(2)}   ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}
DEM ${dh.toFixed(1)}  решётка ${lh.toFixed(1)}  TIN ${r ? r.h.toFixed(1) : '—'}  Δ ${r ? (r.h - Math.max(0, dh)).toFixed(1) : '—'} м${tri}${lsHover(u, v, r?.tri)}</pre>`;
}

function lsHover(u: number, v: number, ti?: number): string {
  if (!lsProc) return '';
  const size = lsProc.raw.width;
  const i = Math.max(0, Math.min(size - 1, Math.floor((u / grid) * size)));
  const j = Math.max(0, Math.min(size - 1, Math.floor((v / grid) * size)));
  const o = (j * size + i) * 4;
  const px = (img: RgbaImage) => `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
  const q = lsProc.quantized.index[j * size + i];
  const face = ti !== undefined && lsFace ? (lsFace[ti] < 0 ? 'вода' : `цвет ${lsFace[ti]}`) : '—';
  return `\nLandsat ${px(lsProc.raw)} → размыт ${px(lsProc.blurred)} → палитра ${q}; грань: ${face}`;
}

// ---------- profile ----------

function drawProfile(): void {
  const c = $<HTMLCanvasElement>('profile');
  const ctx = fitCanvas(c);
  const r = c.getBoundingClientRect();
  ctx.fillStyle = '#0c0e12';
  ctx.fillRect(0, 0, r.width, r.height);
  if (!built || !dem || !profileLine) return;
  const [[u0, v0], [u1, v1]] = profileLine;
  const N = 400;
  const len = (Math.hypot(u1 - u0, v1 - v0) / grid) * tileSizeMeters(tile);
  const series = { dem: [] as number[], lat: [] as number[], tin: [] as number[] };
  for (let k = 0; k <= N; k++) {
    const u = u0 + ((u1 - u0) * k) / N, v = v0 + ((v1 - v0) * k) / N;
    series.dem.push(Math.max(0, demAt(u, v)));
    series.lat.push(Math.max(0, latticeAt(u, v)));
    series.tin.push(built.locate(u, v)?.h ?? NaN);
  }
  const all = [...series.dem, ...series.lat, ...series.tin].filter(Number.isFinite);
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max(10, (hi - lo) * 0.08);
  lo -= pad;
  hi += pad;
  const L = 52, R = 10, T = 24, B = 26;
  const W = r.width - L - R, H = r.height - T - B;
  const X = (k: number) => L + (k / N) * W;
  const Y = (h: number) => T + (1 - (h - lo) / (hi - lo)) * H;

  // belt levels
  const step = built.dbg.step ?? 50;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (let h = Math.ceil(lo / step) * step; h <= hi; h += step) {
    ctx.strokeStyle = 'rgba(240,181,74,.18)';
    ctx.beginPath();
    ctx.moveTo(L, Y(h));
    ctx.lineTo(L + W, Y(h));
    ctx.stroke();
    ctx.fillStyle = '#8a93a0';
    ctx.fillText(String(h), L - 4, Y(h) + 3);
  }
  const line = (s: number[], col: string, w: number) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    let pen = false;
    s.forEach((h, k) => {
      if (!Number.isFinite(h)) {
        pen = false;
        return;
      }
      if (pen) ctx.lineTo(X(k), Y(h));
      else ctx.moveTo(X(k), Y(h));
      pen = true;
    });
    ctx.stroke();
  };
  line(series.dem, '#8fd18f', 1);
  line(series.lat, '#6aa7ff', 1);
  line(series.tin, '#ffffff', 2);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8a93a0';
  ctx.fillText(`0 м`, L, r.height - 8);
  ctx.textAlign = 'right';
  ctx.fillText(`${len.toFixed(0)} м`, L + W, r.height - 8);
  ctx.textAlign = 'left';
  const legend: Array<[string, string]> = [['#8fd18f', 'DEM'], ['#6aa7ff', 'решётка'], ['#ffffff', 'TIN'], ['rgba(240,181,74,.6)', `уровни ×${step} м`]];
  let lx = L + 70;
  for (const [col, name] of legend) {
    ctx.fillStyle = col;
    ctx.fillRect(lx, 10, 10, 3);
    ctx.fillStyle = '#d6dbe2';
    ctx.fillText(name, lx + 14, 15);
    lx += ctx.measureText(name).width + 30;
  }
}

// ---------- 3D ----------

const cam = { yaw: -0.6, pitch: 0.75, zoom: 1 };

function drawView3d(): void {
  const c = $<HTMLCanvasElement>('view3d');
  const ctx = fitCanvas(c);
  const r = c.getBoundingClientRect();
  ctx.fillStyle = '#0c0e12';
  ctx.fillRect(0, 0, r.width, r.height);
  if (!built || !dem) return;
  const size = tileSizeMeters(tile);
  const exag = num('exag') ?? 1.5;
  const mid = (Math.max(0, dem.min) + dem.max) / 2;

  // surface as (u, v, h) triangles
  const tris: Array<[number, number, number][]> = [];
  const surf = $<HTMLSelectElement>('surf3d').value;
  if (surf === 'tin') {
    const t = built.tin;
    for (const q of t.tris) tris.push([q.a, q.b, q.c].map((k) => [t.vx[k], t.vy[k], Math.max(0, t.vh[k])] as [number, number, number]));
  } else {
    const n = surf === 'dem' ? 64 : grid;
    const h = (i: number, j: number) => {
      const u = (i / n) * grid, v = (j / n) * grid;
      return [u, v, Math.max(0, surf === 'dem' ? demAt(u, v) : latticeAt(u, v))] as [number, number, number];
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = h(i, j), b = h(i + 1, j), cc = h(i + 1, j + 1), d = h(i, j + 1);
      tris.push([a, b, cc], [a, cc, d]);
    }
  }

  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const scale = (Math.min(r.width, r.height) / (size * 1.5)) * cam.zoom;
  // world: x east, y up, z south (metres, centred); view: rotate yaw about y, pitch about x
  const proj = ([u, v, h]: [number, number, number]) => {
    const x = (u / grid - 0.5) * size, z = (v / grid - 0.5) * size, y = (h - mid) * exag;
    const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    return [r.width / 2 + x1 * scale, r.height / 2 - y2 * scale, z2] as const;
  };
  let items0 = 0;
  const items = tris.map((t) => {
    const p = t.map(proj);
    const e1 = [(t[1][0] - t[0][0]) * size / grid, (t[1][2] - t[0][2]) * exag, (t[1][1] - t[0][1]) * size / grid];
    const e2 = [(t[2][0] - t[0][0]) * size / grid, (t[2][2] - t[0][2]) * exag, (t[2][1] - t[0][1]) * size / grid];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (ny < 0) [nx, ny, nz] = [-nx, -ny, -nz];
    const avg = (t[0][2] + t[1][2] + t[2][2]) / 3;
    const ti = items0++;
    const ls = surf === 'tin' && lsFace && $<HTMLSelectElement>('fill').value.startsWith('ls');
    return { p, depth: (p[0][2] + p[1][2] + p[2][2]) / 3, col: ls ? faceRgb(ti, shade(nx, ny, nz)) : rgb(hyps(avg), shade(nx, ny, nz)) };
  });
  // painter: far (larger z2 is towards the viewer after the pitch) first
  items.sort((a, b) => a.depth - b.depth);
  const wire = surf === 'tin';
  for (const it of items) {
    ctx.beginPath();
    for (const q of it.p) ctx.lineTo(q[0], q[1]);
    ctx.closePath();
    ctx.fillStyle = it.col;
    ctx.fill();
    ctx.strokeStyle = wire ? 'rgba(0,0,0,.35)' : it.col;
    ctx.lineWidth = wire ? 0.6 : 0.5;
    ctx.stroke();
  }
  ctx.fillStyle = '#8a93a0';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${items.length} треуг.  ×${exag}`, 8, r.height - 8);
}

let pending = false;
function drawAll(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    drawMap();
    renderHover();
    drawProfile();
    drawView3d();
  });
}

// ---------- loading ----------

async function loadTile(t: Tile): Promise<void> {
  tile = t;
  location.hash = `${t.z}/${t.x}/${t.y}`;
  const center = tileCenter(t);
  $<HTMLInputElement>('lat').value = center.lat.toFixed(5);
  $<HTMLInputElement>('lon').value = center.lon.toFixed(5);
  $<HTMLInputElement>('z').value = String(t.z);
  $('tileInfo').textContent = `тайл ${t.z}/${t.x}/${t.y} · ${(tileSizeMeters(t) / 1000).toFixed(2)} км · загрузка…`;
  try {
    const png = await fetchTerrariumPng(t);
    if (tile !== t) return;
    applyGameDefaults(false);
    grid = num('grid') ?? gridForZoom(t.z);
    dem = await decodeDem(png);
    const lt = await loadTileDem(t, grid);
    lattice = lt.heights;
    borders = lt.borders;
    demImg = makeDemImage();
    $('tileInfo').textContent = `тайл ${t.z}/${t.x}/${t.y} · ${(tileSizeMeters(t) / 1000).toFixed(2)} км`;
    const pu = pinUV();
    profileLine = profileLine ?? [[0, pu ? pu[1] : grid / 2], [grid, pu ? pu[1] : grid / 2]];
    if (pu) {
      $<HTMLInputElement>('lat').value = pin!.lat.toFixed(5);
      $<HTMLInputElement>('lon').value = pin!.lon.toFixed(5);
    }
    fitView();
    build();
    void loadLandsat(t);
  } catch (e) {
    $('tileInfo').innerHTML = `<span class="err">ошибка: ${(e as Error).message}</span>`;
  }
}

// ---------- Landsat ----------

async function loadLandsat(t: Tile): Promise<void> {
  lsMosaic = lsProc = lsImgs = null;
  lsFace = null;
  $('lsInfo').textContent = 'Landsat: загрузка 3×3 тайлов…';
  const src = landsatSource(t).tile;
  const imgs = await Promise.all(neighbourTiles(src).map((n) => (n ? fetchLandsatTile(n).catch(() => null) : Promise.resolve(null))));
  if (tile !== t) return;
  if (!imgs[4]) {
    $('lsInfo').innerHTML = '<span class="err">Landsat: снимок тайла не загрузился</span>';
    return;
  }
  lsMosaic = stitch3x3(imgs);
  const missing = imgs.filter((x, k) => !x && k !== 4).length;
  $('lsInfo').dataset.missing = String(missing);
  processLs();
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

function processLs(): void {
  if (!lsMosaic) return;
  const t0 = performance.now();
  lsProc = processLandsat(lsMosaic, tile, { blurM: num('lsBlur') ?? 0, colours: Math.round(num('lsColours') ?? 0) });
  const ms = performance.now() - t0;
  lsImgs = { 'ls-raw': toCanvas(lsProc.raw), 'ls-blur': toCanvas(lsProc.blurred), 'ls-quant': toCanvas(lsProc.quantized.image) };
  const size = lsProc.quantized.image.width;
  const minPx = (num('lsMinArea') ?? 0) * (size / grid) ** 2;
  lsLines = colourBoundaries(cleanLabels(lsProc.quantized.index, size, minPx), size, grid, num('lsEps') ?? 1, LANDSAT_TUNING.borderMarginCells);
  if ($<HTMLInputElement>('lsMesh').checked || $<HTMLInputElement>('lsEdges').checked) build(); // the mesh follows the new colours
  else colourFaces();
  const p = lsProc, src = landsatSource(tile);
  const missing = Number($('lsInfo').dataset.missing ?? 0);
  $('lsInfo').innerHTML = [
    `тайл снимка ${src.tile.z}/${src.tile.x}/${src.tile.y}, ${p.raw.width}×${p.raw.height} px на этот тайл`,
    `σ ${p.sigmaPx.toFixed(1)} px, палитра ${p.palette.length} цв., использовано ${p.quantized.used.length}`,
    `граней цветов: ${lsFace ? new Set(lsFace).size : '—'} · ${ms.toFixed(0)} мс`,
    `чистота граней: ${lsPurity()}${built?.dbg.colourFlips ? ` · перекидок по цвету ${built.dbg.colourFlips}` : ''}`,
    `границ ${lsLines.length}, точек ${lsLines.reduce((s, l) => s + l.pts.length, 0)}` +
      (built?.dbg.colourVerts ? ` · в сетке вершин ${built.dbg.colourVerts} + пересечений ${built.dbg.colourCrossings}` : ''),
    missing ? `<span class="err">соседей без снимка: ${missing} (край продлён)</span>` : '',
    `<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:4px">${p.quantized.used.map((v) => `<span class="tag" title="цвет ${v}" style="background:rgb(${LAND_PALETTE[v].join(',')})"></span>`).join('')}</div>`,
  ].join('<br>');
  drawAll();
}

/** land palette colour per TIN face (−1: water) */
function colourFaces(): void {
  lsFace = null;
  if (!lsProc || !built) return;
  const tin = built.tin;
  const f = faceColorByMode(lsProc.quantized, lsProc.quantized.image.width, grid);
  lsFace = new Int16Array(tin.tris.length);
  tin.tris.forEach((t, ti) => {
    const c = isSeaFace(tin, ti) ? undefined : f(tin.vx[t.a], tin.vy[t.a], tin.vx[t.b], tin.vy[t.b], tin.vx[t.c], tin.vy[t.c]);
    // faces take land palette colours (or the water ramp): back to the palette index
    lsFace![ti] = c === undefined || isMaterial(c) ? -1 : nearestLand(...rgbOf(c));
  });
}

/** share of land pixels whose quantized colour equals the colour of the face over them */
function lsPurity(): string {
  if (!lsProc || !lsFace || !built) return '—';
  const size = lsProc.quantized.image.width;
  let same = 0, n = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = built.locate(((i + 0.5) / size) * grid, ((j + 0.5) / size) * grid);
      if (!r || lsFace[r.tri] < 0) continue;
      n++;
      if (lsFace[r.tri] === lsProc.quantized.index[j * size + i]) same++;
    }
  }
  return n ? `${((100 * same) / n).toFixed(1)} %` : '—';
}

function faceRgb(ti: number, k = 1): string {
  const v = lsFace![ti];
  return rgb(v < 0 ? [44, 79, 124] : (LAND_PALETTE[v] as [number, number, number]), k);
}

/** grid/step/eps inputs show the game's values for this zoom unless the user typed their own */
function applyGameDefaults(force: boolean): void {
  const set = (id: string, v: number) => {
    const el = $<HTMLInputElement>(id);
    if (force || el.dataset.user !== '1') {
      el.value = String(v);
      el.dataset.user = '';
    }
  };
  set('grid', gridForZoom(tile.z));
  set('step', beltStepForZoom(tile.z));
  set('eps', EPS_START);
  if (force) $<HTMLInputElement>('inscribed').checked = true; // the game's isolines are inscribed
}

async function relattice(): Promise<void> {
  const g = num('grid') ?? gridForZoom(tile.z);
  if (g !== grid && dem) {
    const old = grid;
    grid = Math.max(4, Math.round(g));
    const lt = await loadTileDem(tile, grid);
    lattice = lt.heights;
    borders = lt.borders;
    if (profileLine) profileLine = profileLine.map(([u, v]) => [(u / old) * grid, (v / old) * grid]) as typeof profileLine;
    fitView();
  }
  build();
}

// ---------- pasted map links ----------

function pasteMsg(text: string, error = false): void {
  const el = $('pasteMsg');
  el.textContent = text;
  el.className = error ? 'err' : 'hint';
}

/**
 * Ctrl/⌘+V anywhere (inputs included) with a map link or "lat, lon" jumps to that point: the tile
 * at the link's zoom (clamped to the sim's MIN_Z…MAX_Z, current zoom when the link has none),
 * with the point marked and the profile drawn through it. Anything else pastes as usual.
 */
async function onPaste(e: ClipboardEvent): Promise<void> {
  const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
  if (!text || text.length > 4000) return;
  const p = parseMapLink(text);
  if (!p) {
    if (/^https?:\/\//i.test(text)) pasteMsg(`в ссылке нет координат (короткие ссылки не поддерживаются): ${text.slice(0, 80)}`, true);
    return;
  }
  e.preventDefault();
  const z = p.zoom !== undefined ? Math.max(MIN_Z, Math.min(MAX_Z, Math.round(p.zoom))) : tile.z;
  pin = { lat: p.lat, lon: p.lon };
  pasteMsg(`${SOURCE[p.source]}: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` + (p.tile ? `, тайл z${z}` : p.zoom !== undefined ? `, zoom ${p.zoom.toFixed(1)} → z${z}` : `, z${z} (текущий)`));
  profileLine = null;
  await loadTile(tileForLatLon(p.lat, p.lon, z));
}

// ---------- UI wiring ----------

function init(): void {
  const T = LANDSAT_TUNING;
  for (const [id, v] of [['lsBlur', T.blurM], ['lsColours', T.colours], ['lsMinArea', T.minAreaCells], ['lsEps', T.eps], ['lsMaxVerts', T.maxVerts]] as const) {
    $<HTMLInputElement>(id).value = String(v);
  }
  $<HTMLInputElement>('lsEdges').checked = T.edges;
  $<HTMLInputElement>('lsMesh').checked = T.flips;
  const sel = $<HTMLSelectElement>('preset');
  sel.innerHTML = '<option value="">— пресеты —</option>' + PRESETS.map((p, k) => `<option value="${k}">${p[0]} (z${p[3]})</option>`).join('');
  sel.onchange = () => {
    const p = PRESETS[+sel.value];
    if (!p) return;
    profileLine = null;
    pin = null;
    void loadTile(tileForLatLon(p[1], p[2], p[3]));
  };
  $('load').onclick = () => {
    const lat = num('lat'), lon = num('lon'), z = num('z');
    if (lat === undefined || lon === undefined || z === undefined) return;
    profileLine = null;
    void loadTile(tileForLatLon(lat, lon, Math.round(z)));
  };
  $('toRelief').onclick = () => window.open(`relief.html#${tile.z}/${tile.x}/${tile.y}`, '_blank');
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const t = { ...tile };
      const n = 2 ** t.z;
      switch (b.dataset.nav) {
        case 'w': t.x = (t.x - 1 + n) % n; break;
        case 'e': t.x = (t.x + 1) % n; break;
        case 'n': t.y = Math.max(0, t.y - 1); break;
        case 's': t.y = Math.min(n - 1, t.y + 1); break;
        case 'out': if (t.z > 1) { t.z--; t.x >>= 1; t.y >>= 1; } break;
        case 'in': t.z++; t.x = t.x * 2 + 1; t.y = t.y * 2 + 1; break;
      }
      profileLine = null;
      void loadTile(t);
    };
  });
  for (const id of ['grid', 'step', 'eps']) {
    const el = $<HTMLInputElement>(id);
    el.onchange = () => {
      el.dataset.user = '1';
      void relattice();
    };
  }
  $('inscribed').onchange = build;
  $('asGame').onclick = () => {
    applyGameDefaults(true);
    void relattice();
  };
  $('fill').onchange = drawAll;
  $('lsBlur').onchange = processLs;
  // processLs rebuilds the mesh when it follows the colours; switching that off needs one plain rebuild
  $('lsMesh').onchange = () => {
    if (!$<HTMLInputElement>('lsMesh').checked) build();
    processLs();
  };
  $('lsMaxDh').onchange = processLs;
  $('lsEdges').onchange = () => {
    if (!$<HTMLInputElement>('lsEdges').checked) build();
    processLs();
  };
  for (const id of ['lsMinArea', 'lsEps', 'lsMaxVerts']) $(id).onchange = processLs;
  $('lsColours').onchange = processLs;
  $('surf3d').onchange = drawAll;
  $('exag').oninput = drawAll;
  document.querySelectorAll('[data-layer]').forEach((el) => el.addEventListener('change', drawAll));

  // map: wheel zoom, drag pan, shift-drag profile
  const map = $<HTMLCanvasElement>('map');
  const local = (e: MouseEvent): [number, number] => {
    const r = map.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  map.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    const [u, v] = toLat(x, y);
    view.s *= Math.exp(-e.deltaY * 0.0015);
    view.ox = x - u * view.s;
    view.oy = y - v * view.s;
    drawAll();
  }, { passive: false });
  let drag: { mode: 'pan' | 'profile'; x: number; y: number } | null = null;
  map.addEventListener('mousedown', (e) => {
    const [x, y] = local(e);
    drag = { mode: e.shiftKey ? 'profile' : 'pan', x, y };
    if (drag.mode === 'profile') {
      const p = toLat(x, y);
      profileLine = [p, p];
    }
  });
  window.addEventListener('mouseup', () => (drag = null));
  map.addEventListener('mousemove', (e) => {
    const [x, y] = local(e);
    hover = toLat(x, y);
    if (drag?.mode === 'pan') {
      view.ox += x - drag.x;
      view.oy += y - drag.y;
      drag.x = x;
      drag.y = y;
    } else if (drag?.mode === 'profile' && profileLine) {
      const clamp = (q: number) => Math.max(0, Math.min(grid, q));
      profileLine = [profileLine[0].map(clamp) as [number, number], hover.map(clamp) as [number, number]];
    }
    drawAll();
  });
  map.addEventListener('mouseleave', () => {
    hover = null;
    drawAll();
  });
  map.addEventListener('dblclick', () => {
    fitView();
    drawAll();
  });

  // 3D: drag rotate, wheel zoom
  const v3 = $<HTMLCanvasElement>('view3d');
  let rot: [number, number] | null = null;
  v3.addEventListener('mousedown', (e) => (rot = [e.clientX, e.clientY]));
  window.addEventListener('mouseup', () => (rot = null));
  window.addEventListener('mousemove', (e) => {
    if (!rot) return;
    cam.yaw += (e.clientX - rot[0]) * 0.008;
    cam.pitch = Math.max(0.05, Math.min(1.55, cam.pitch + (e.clientY - rot[1]) * 0.008));
    rot = [e.clientX, e.clientY];
    drawAll();
  });
  v3.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.zoom *= Math.exp(-e.deltaY * 0.0015);
    drawAll();
  }, { passive: false });

  new ResizeObserver(() => {
    if (built) fitView();
    drawAll();
  }).observe(document.body);

  document.addEventListener('paste', (e) => void onPaste(e));

  const m = /^#(\d+)\/(\d+)\/(\d+)$/.exec(location.hash);
  const p = PRESETS[0];
  void loadTile(m ? { z: +m[1], x: +m[2], y: +m[3] } : tileForLatLon(p[1], p[2], p[3]));
}

init();
