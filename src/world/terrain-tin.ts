import {
  contourLevels,
  delaunay,
  extractIsolines,
  simplifyOpen,
  simplifyRing,
  type Pt,
  type Tri,
} from './contours';
import { tileSizeMeters, type Tile } from './geodesy';
import type { HeightSampler, TileBorders } from './terrain-source';

/** Vertical thickness of one belt: coarser for distant (low-zoom) tiles. */
export function beltStepForZoom(z: number): number {
  if (z >= 13) return 50;
  if (z >= 11) return 120;
  if (z >= 9) return 300;
  return 600;
}

/** budget for contour vertices per tile; the (fixed-tolerance) border comes on top */
export const MAX_VERTS = 100;

/** Simplified isoline TIN of one tile, in lattice coordinates [0, grid]². */
export interface TerrainTin {
  grid: number;
  vx: number[];
  vy: number[];
  /** raw elevation per vertex (contour vertices sit exactly on their level) */
  vh: number[];
  tris: Tri[];
}

/**
 * Contours every `step` meters are traced on the (grid+1)² lattice, simplified
 * (Douglas–Peucker), joined with a simplified tile border and triangulated
 * (Delaunay). Pure and deterministic: the mesh, the collision probe and the
 * OSM drape all call this with the same lattice and see the same surface.
 */
export interface TinOptions {
  step?: number;
  eps?: number;
  /** full-resolution edge profiles; without them the lattice edge nodes are used */
  borders?: TileBorders;
}

export function buildTerrainTin(tile: Tile, grid: number, heights: Float32Array, opts: TinOptions = {}): TerrainTin {
  const stepOpt = opts.step;
  const epsOpt = opts.eps;
  const side = grid + 1;
  if (heights.length !== side * side) throw new Error('heights grid size mismatch');
  const baseStep = stepOpt ?? beltStepForZoom(tile.z);
  let step = baseStep;
  // Tile borders must not depend on per-tile escalation: neighbours simplify the shared edge
  // with the same tolerance, so seams stay within it (skirts hide the rest).
  const borderTol = baseStep / 6;
  let borderCount = 0;

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
    const seen = new Set<string>();
    const add = (x: number, y: number, h: number) => {
      const key = `${Math.round(x * 4096)},${Math.round(y * 4096)}`;
      if (seen.has(key)) return;
      seen.add(key);
      vx.push(x);
      vy.push(y);
      vh.push(h);
    };
    // Border: one shared profile per edge (DEM pixels when available), simplified with a fixed
    // tolerance, so every LOD of every neighbour describes the same seam. Order: n, s, w, e.
    const profiles: Float32Array[] = opts.borders
      ? [opts.borders.n, opts.borders.s, opts.borders.w, opts.borders.e]
      : [
          Float32Array.from({ length: side }, (_, s) => heights[s]),
          Float32Array.from({ length: side }, (_, s) => heights[grid * side + s]),
          Float32Array.from({ length: side }, (_, s) => heights[s * side]),
          Float32Array.from({ length: side }, (_, s) => heights[s * side + grid]),
        ];
    const place = (e: number, f: number): [number, number] =>
      e === 0 ? [f * grid, 0] : e === 1 ? [f * grid, grid] : e === 2 ? [0, f * grid] : [grid, f * grid];
    const edgeLen = tileSizeMeters(tile);
    profiles.forEach((prof, e) => {
      const pts: Pt[] = Array.from(prof, (h, k) => ({ x: (k / (prof.length - 1)) * edgeLen, y: h }));
      for (const p of simplifyOpen(pts, borderTol)) {
        const [x, y] = place(e, p.x / edgeLen);
        add(x, y, p.y);
      }
    });
    /** height of the shared border profile at a lattice point on the border, or undefined inside */
    const borderHeight = (x: number, y: number): number | undefined => {
      const e = y === 0 ? 0 : y === grid ? 1 : x === 0 ? 2 : x === grid ? 3 : -1;
      if (e < 0) return undefined;
      const prof = profiles[e];
      const f = (e < 2 ? x : y) / grid;
      const q = f * (prof.length - 1);
      const k = Math.min(prof.length - 2, Math.floor(q));
      return prof[k] + (prof[k + 1] - prof[k]) * (q - k);
    };
    borderCount = vx.length;
    for (const line of raw) {
      const pts = line.closed ? simplifyRing(line.pts, eps) : simplifyOpen(line.pts, eps);
      if (line.closed) {
        // rings smaller than the tolerance are noise at this detail level
        const xs = line.pts.map((p) => p.x), ys = line.pts.map((p) => p.y);
        const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (pts.length < 3 || ext < eps * 2) continue;
      }
      for (const p of pts) add(p.x, p.y, borderHeight(p.x, p.y) ?? line.level);
    }
  };
  // over budget → thicker belts and a looser tolerance (every open isoline costs
  // two border vertices, so tolerance alone cannot meet the budget on rough terrain)
  let eps = epsOpt ?? 2;
  for (let attempt = 0; ; attempt++) {
    raw = contourLevels(minH, maxH, step).flatMap((l) => extractIsolines(heights, grid, l));
    collect(eps);
    if (vx.length - borderCount <= MAX_VERTS || attempt >= 8) break;
    step *= 1.5;
    eps *= 1.3;
  }

  return { grid, vx, vy, vh, tris: delaunay(vx.map((x, k) => ({ x, y: vy[k] }))) };
}

/**
 * Height of the rendered surface (same triangles as the mesh, water clamped to
 * 0 m like the mesh) at a lon/lat inside `tile`; clamps to the tile outside it.
 */
export function tinSampler(tin: TerrainTin, tile: Tile): HeightSampler {
  const { grid, vx, vy, vh, tris } = tin;
  const n = 2 ** tile.z;
  const buckets: number[][] = Array.from({ length: grid * grid }, () => []);
  tris.forEach((t, ti) => {
    const xs = [vx[t.a], vx[t.b], vx[t.c]], ys = [vy[t.a], vy[t.b], vy[t.c]];
    const i0 = Math.max(0, Math.min(grid - 1, Math.floor(Math.min(...xs))));
    const i1 = Math.max(0, Math.min(grid - 1, Math.floor(Math.max(...xs))));
    const j0 = Math.max(0, Math.min(grid - 1, Math.floor(Math.min(...ys))));
    const j1 = Math.max(0, Math.min(grid - 1, Math.floor(Math.max(...ys))));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * grid + i].push(ti);
  });
  const h = vh.map((v) => Math.max(v, 0));

  return (lon, lat) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin((clamped * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    const fx = Math.max(0, Math.min(grid, (((lon + 180) / 360) * n - tile.x) * grid));
    const fy = Math.max(0, Math.min(grid, (merc * n - tile.y) * grid));
    const cell = Math.min(grid - 1, Math.floor(fy)) * grid + Math.min(grid - 1, Math.floor(fx));
    let best = -1;
    let bestMin = -Infinity;
    let bw: [number, number, number] = [0, 0, 0];
    for (const ti of buckets[cell]) {
      const t = tris[ti];
      const ax = vx[t.a], ay = vy[t.a];
      const d = (vx[t.b] - ax) * (vy[t.c] - ay) - (vx[t.c] - ax) * (vy[t.b] - ay);
      if (d === 0) continue;
      const w1 = ((fx - ax) * (vy[t.c] - ay) - (vx[t.c] - ax) * (fy - ay)) / d;
      const w2 = ((vx[t.b] - ax) * (fy - ay) - (fx - ax) * (vy[t.b] - ay)) / d;
      const w0 = 1 - w1 - w2;
      const m = Math.min(w0, w1, w2);
      if (m > bestMin) {
        bestMin = m;
        best = ti;
        bw = [w0, w1, w2];
        if (m >= -1e-9) break;
      }
    }
    if (best < 0) return 0;
    const t = tris[best];
    return h[t.a] * bw[0] + h[t.b] * bw[1] + h[t.c] * bw[2];
  };
}
