/**
 * Aerodrome pads: the whole territory of an aerodrome lies on one plane (it may be tilted, it may
 * not be bent). So does every sports ground (a pitch, a track, a stadium), on a pad of its own,
 * nearly level and with a narrow margin and blend (PITCH_PAD). The territory is the convex hull of the OSM aeroway=aerodrome outline, widened by
 * PAD_MARGIN_M; a runway outside any aerodrome outline gets a pad of its own. The plane is a
 * least-squares fit to the DEM inside the hull, sampled at fixed lon/lat points on fixed-zoom DEM
 * tiles: it depends on the outline alone, so every tile the pad touches — and the mesh, the drape
 * and the collision probe of each — gets the same plane.
 *
 * The lattice is set to the plane over the pad and blended into the relief around it
 * (applyPads); the TIN takes the pad outline as fixed edges and every vertex on or inside it at
 * the plane's height (TinOptions.pads), so no face inside the territory bends.
 */
import { EARTH_R, enuToLatLon, latLonToEnu, mercatorYToLat, tileRowMeters, type LatLon, type Tile } from './geodesy';
import type { LonLat, OsmArea, OsmLine } from './osm-types';
import { demHeights, type TileBorders } from './terrain-source';
import { parseLength } from './building-mesher';

/** the flat territory reaches this far beyond the hull of the aerodrome outline (or runway strip) */
export const PAD_MARGIN_M = 30;
/** the hull is simplified by cutting corners, at most this far (inside the margin) */
const HULL_TOL_M = 10;
/** the relief blends into the pad over this width beyond its flat part */
export const PAD_BLEND_M = 250;
/** steepest plane allowed: real aerodromes are within a couple of percent */
export const PAD_MAX_GRADE = 0.025;
/** aerodrome outlines larger than this across (military ranges, whole districts) get no pad */
const PAD_MAX_SIZE_M = 15000;
/**
 * A sports ground's pad: its outline (leisure=pitch | track | stadium, an area) widened by MARGIN_M,
 * blended into the relief over BLEND_M, no steeper than MAX_GRADE (a pitch is all but level); none
 * for one on a roof or indoors, or larger than MAX_AREA_M2 (a racecourse's grounds)
 */
export const PITCH_PAD = { MARGIN_M: 3, BLEND_M: 25, MAX_GRADE: 0.01, MAX_AREA_M2: 200_000 } as const;
const PITCH_LEISURE = new Set(['pitch', 'track', 'stadium']);

/** a sports ground to put on a pad of its own: on the ground, an area */
export function isPitchGround(tags: Record<string, string>): boolean {
  if (!PITCH_LEISURE.has(tags.leisure ?? '') || tags.indoor === 'yes' || tags.building !== undefined) return false;
  const loc = tags.location, layer = Number(tags.layer);
  return loc !== 'roof' && loc !== 'rooftop' && loc !== 'indoor' && loc !== 'underground' && !(Number.isFinite(layer) && layer !== 0);
}

/** DEM zoom the plane is fitted on (~19 m pixels at the equator) */
const FIT_ZOOM = 13;
/** at most about this many DEM samples per pad */
const FIT_SAMPLES = 1600;

export interface Pad {
  key: string;
  /** frame of the pad: ENU metres around this point */
  origin: LatLon;
  /** flat territory: convex, counter-clockwise, ENU (e, n) */
  hull: [number, number][];
  /** the same outline in lon/lat, closed (first point repeated) */
  ring: LonLat[];
  /** plane: h = h0 + ge·e + gn·n (metres, ENU of `origin`) */
  h0: number;
  ge: number;
  gn: number;
  /** the relief blends into it over this width beyond its flat part (PITCH_PAD.BLEND_M); PAD_BLEND_M unless given */
  blend?: number;
}

/** what a pad is made from: an outline (lon/lat) and a stable key; an aerodrome's sizes unless given */
export interface PadSource {
  key: string;
  pts: LonLat[];
  margin?: number;
  blend?: number;
  maxGrade?: number;
}

export function padHeightEnu(p: Pad, e: number, n: number): number {
  return p.h0 + p.ge * e + p.gn * n;
}

export function padHeight(p: Pad, lon: number, lat: number): number {
  const [e, n] = latLonToEnu(p.origin, lat, lon, 0);
  return padHeightEnu(p, e, n);
}

/** signed distance from (e, n) to the pad outline: negative inside */
export function padDistance(p: Pad, e: number, n: number): number {
  const h = p.hull;
  let inside = true;
  let d = Infinity;
  for (let k = 0; k < h.length; k++) {
    const [ax, ay] = h[k];
    const [bx, by] = h[(k + 1) % h.length];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (dx * (n - ay) - dy * (e - ax) < 0) inside = false;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / len2)) : 0;
    d = Math.min(d, Math.hypot(e - (ax + dx * t), n - (ay + dy * t)));
  }
  return inside ? -d : d;
}

const sameKey = (pts: ReadonlyArray<LonLat>) => `${pts.length}:${pts[0][0].toFixed(7)},${pts[0][1].toFixed(7)}`;

/** convex hull (monotone chain), counter-clockwise, no repeated point */
function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** the hull widened by `m` (corners rounded by eight directions) and simplified by cutting corners */
function widenHull(hull: [number, number][], m: number, tol: number): [number, number][] {
  const pts: [number, number][] = [];
  for (const [x, y] of hull) {
    for (let k = 0; k < 8; k++) {
      // a regular octagon around the corner, wide enough that its sides stay `m` out
      const a = (k * Math.PI) / 4, r = m / Math.cos(Math.PI / 8);
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
  }
  const h = convexHull(pts);
  // drop the corner that cuts least, while it cuts less than tol
  for (;;) {
    if (h.length <= 3) break;
    let best = -1, bestD = tol;
    for (let k = 0; k < h.length; k++) {
      const a = h[(k + h.length - 1) % h.length], b = h[k], c = h[(k + 1) % h.length];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const d = Math.abs(dx * (b[1] - a[1]) - dy * (b[0] - a[0])) / (Math.hypot(dx, dy) || 1);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0) break;
    h.splice(best, 1);
  }
  return h;
}

/**
 * The pads of a tile's OSM: one per aerodrome outline (outer rings), one per runway that lies
 * outside every aerodrome outline (its centreline widened by half its width).
 */
export function padSources(data: { areas: ReadonlyArray<OsmArea>; lines: ReadonlyArray<OsmLine> }): PadSource[] {
  const out: PadSource[] = [];
  const outlines: { origin: LatLon; hull: [number, number][] }[] = [];
  for (const a of data.areas) {
    if (a.tags.aeroway !== 'aerodrome') continue;
    const ring = a.rings[0];
    if (!ring || ring.length < 4) continue;
    out.push({ key: `a${sameKey(ring)}`, pts: ring });
    const origin = { lon: ring[0][0], lat: ring[0][1] };
    outlines.push({ origin, hull: convexHull(ring.map(([lon, lat]) => enu2(origin, lon, lat))) });
  }
  for (const l of data.lines) {
    if (l.tags.aeroway !== 'runway' || l.points.length < 2) continue;
    const inAerodrome = outlines.some((o) =>
      l.points.every(([lon, lat]) => {
        const [e, n] = enu2(o.origin, lon, lat);
        return hullContains(o.hull, e, n);
      }));
    if (inAerodrome) continue;
    const origin = { lon: l.points[0][0], lat: l.points[0][1] };
    const c = l.points.map(([lon, lat]) => enu2(origin, lon, lat));
    const half = (parseLength(l.tags.width) ?? 30) / 2;
    const pts: LonLat[] = [];
    for (let k = 0; k < c.length; k++) {
      const a = c[Math.max(0, k - 1)], b = c[Math.min(c.length - 1, k + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
      // ends stick out by half the width too
      const along = k === 0 ? -half : k === c.length - 1 ? half : 0;
      for (const s of [-1, 1]) {
        const ll = enuToLatLon(origin, c[k][0] + ux * along - uy * half * s, c[k][1] + uy * along + ux * half * s, 0);
        pts.push([ll.lon, ll.lat]);
      }
    }
    out.push({ key: `r${sameKey(l.points)}`, pts });
  }
  // every sports ground on a level pad of its own
  for (const a of data.areas) {
    if (!isPitchGround(a.tags)) continue;
    const ring = a.rings[0];
    if (!ring || ring.length < 4) continue;
    const origin = { lon: ring[0][0], lat: ring[0][1] };
    const xy = ring.map(([lon, lat]) => enu2(origin, lon, lat));
    let area2 = 0;
    for (let k = 0; k + 1 < xy.length; k++) area2 += xy[k][0] * xy[k + 1][1] - xy[k + 1][0] * xy[k][1];
    if (Math.abs(area2) / 2 > PITCH_PAD.MAX_AREA_M2) continue;
    out.push({ key: `p${sameKey(ring)}`, pts: ring, margin: PITCH_PAD.MARGIN_M, blend: PITCH_PAD.BLEND_M, maxGrade: PITCH_PAD.MAX_GRADE });
  }
  return out;
}

function enu2(origin: LatLon, lon: number, lat: number): [number, number] {
  const [e, n] = latLonToEnu(origin, lat, lon, 0);
  return [e, n];
}

function hullContains(h: [number, number][], e: number, n: number): boolean {
  if (h.length < 3) return false;
  for (let k = 0; k < h.length; k++) {
    const [ax, ay] = h[k];
    const [bx, by] = h[(k + 1) % h.length];
    if ((bx - ax) * (n - ay) - (by - ay) * (e - ax) < 0) return false;
  }
  return true;
}

/** least-squares plane h = a + b·e + c·n; null when the points do not span a plane */
function fitPlane(e: number[], n: number[], h: number[]): [number, number, number] | null {
  let s = 0, se = 0, sn = 0, see = 0, snn = 0, sen = 0, sh = 0, seh = 0, snh = 0;
  for (let k = 0; k < h.length; k++) {
    s++; se += e[k]; sn += n[k]; see += e[k] * e[k]; snn += n[k] * n[k]; sen += e[k] * n[k];
    sh += h[k]; seh += e[k] * h[k]; snh += n[k] * h[k];
  }
  if (s < 3) return null;
  // centred normal equations
  const me = se / s, mn = sn / s, mh = sh / s;
  const cee = see - s * me * me, cnn = snn - s * mn * mn, cen = sen - s * me * mn;
  const ceh = seh - s * me * mh, cnh = snh - s * mn * mh;
  const det = cee * cnn - cen * cen;
  if (!(Math.abs(det) > 1e-9 * Math.max(1, cee * cnn))) return [mh, 0, 0];
  const b = (ceh * cnn - cnh * cen) / det;
  const c = (cnh * cee - ceh * cen) / det;
  return [mh - b * me - c * mn, b, c];
}

/** Build a pad: hull, outline and plane. Null for an outline too large or with no DEM under it. */
export async function buildPad(src: PadSource): Promise<Pad | null> {
  const origin = { lon: src.pts[0][0], lat: src.pts[0][1] };
  const core = convexHull(src.pts.map(([lon, lat]) => enu2(origin, lon, lat)));
  if (core.length < 3) return null;
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const [e, n] of core) {
    minE = Math.min(minE, e); maxE = Math.max(maxE, e);
    minN = Math.min(minN, n); maxN = Math.max(maxN, n);
  }
  if (Math.max(maxE - minE, maxN - minN) > PAD_MAX_SIZE_M) return null;
  // DEM samples on a regular grid over the hull (and its corners: a narrow strip has few inside)
  const step = Math.max(15, Math.sqrt(((maxE - minE) * (maxN - minN)) / FIT_SAMPLES));
  const se: number[] = [], sn: number[] = [];
  for (let n = minN + step / 2; n < maxN; n += step) {
    for (let e = minE + step / 2; e < maxE; e += step) if (hullContains(core, e, n)) { se.push(e); sn.push(n); }
  }
  for (const [e, n] of core) { se.push(e); sn.push(n); }
  const ll = se.map((e, k) => {
    const p = enuToLatLon(origin, e, sn[k], 0);
    return [p.lon, p.lat] as const;
  });
  const dem = await demHeights(ll, FIT_ZOOM);
  let E: number[] = [], N: number[] = [], H: number[] = [];
  dem.forEach((h, k) => {
    if (Number.isNaN(h)) return;
    E.push(se[k]); N.push(sn[k]); H.push(h);
  });
  let plane = fitPlane(E, N, H);
  if (!plane) return null;
  // one more pass without the outliers (trees, buildings, cuttings the DEM carries)
  {
    const r = H.map((h, k) => h - (plane![0] + plane![1] * E[k] + plane![2] * N[k]));
    const sigma = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length);
    const lim = Math.max(2, 2 * sigma);
    const keep = r.map((v) => Math.abs(v) <= lim);
    const E2 = E.filter((_, k) => keep[k]), N2 = N.filter((_, k) => keep[k]), H2 = H.filter((_, k) => keep[k]);
    const p2 = fitPlane(E2, N2, H2);
    if (p2) {
      plane = p2;
      E = E2; N = N2; H = H2;
    }
  }
  let [, ge, gn] = plane;
  const grade = Math.hypot(ge, gn), maxGrade = src.maxGrade ?? PAD_MAX_GRADE;
  if (grade > maxGrade) {
    ge *= maxGrade / grade;
    gn *= maxGrade / grade;
  }
  // with the grade capped the plane keeps the mean height over the samples
  let h0 = 0;
  for (let k = 0; k < H.length; k++) h0 += H[k] - ge * E[k] - gn * N[k];
  h0 /= H.length;
  const margin = src.margin ?? PAD_MARGIN_M;
  const hull = widenHull(core, margin, Math.min(HULL_TOL_M, margin));
  const ring: LonLat[] = hull.map(([e, n]) => {
    const p = enuToLatLon(origin, e, n, 0);
    return [p.lon, p.lat];
  });
  ring.push(ring[0]);
  return { key: src.key, origin, hull, ring, h0, ge, gn, blend: src.blend ?? PAD_BLEND_M };
}

/** pads by key: neighbouring tiles share an aerodrome, and the fit costs DEM reads */
const padCache = new Map<string, Promise<Pad | null>>();
const PAD_CACHE_MAX = 64;

/** the pads of a tile's OSM (see padSources), each built once per thread */
export async function loadPads(data: { areas: ReadonlyArray<OsmArea>; lines: ReadonlyArray<OsmLine> }): Promise<Pad[]> {
  const pads = await Promise.all(padSources(data).map((s) => {
    let hit = padCache.get(s.key);
    if (hit) padCache.delete(s.key);
    else {
      hit = buildPad(s);
      hit.catch(() => padCache.delete(s.key));
    }
    padCache.set(s.key, hit);
    if (padCache.size > PAD_CACHE_MAX) padCache.delete(padCache.keys().next().value!);
    return hit;
  }));
  return pads.filter((p): p is Pad => p !== null);
}

/** lon/lat of lattice node (i, j) of a tile, from its global index: the same numbers in every tile that shares it */
function nodeLonLat(t: Tile, i: number, j: number, grid: number): [number, number] {
  const n = 2 ** t.z * grid;
  return [((t.x * grid + i) / n) * 360 - 180, mercatorYToLat((t.y * grid + j) / n)];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** a pad's hull box (ENU metres of its origin) and metres per degree there, for padOutOfReach */
const padBoxes = new WeakMap<Pad, { e0: number; e1: number; n0: number; n1: number; kx: number; ky: number }>();
/**
 * Whether lon/lat is surely beyond a pad's reach (flat margin and blend): its box on the sphere's
 * plane about the pad's origin, missed by more than the reach plus PAD_REACH_SLACK (the plane's
 * error against the ellipsoid's ENU, and more), so padNode weighs it 0 there anyway. A cheap test
 * before the exact ENU: the pitches of a town centre are dozens of pads for every road sample.
 */
function padOutOfReach(p: Pad, lon: number, lat: number, flatM: number): boolean {
  let b = padBoxes.get(p);
  if (!b) {
    const ky = (EARTH_R * Math.PI) / 180;
    b = { e0: Infinity, e1: -Infinity, n0: Infinity, n1: -Infinity, kx: ky * Math.cos((p.origin.lat * Math.PI) / 180), ky };
    for (const [e, n] of p.hull) {
      b.e0 = Math.min(b.e0, e); b.e1 = Math.max(b.e1, e);
      b.n0 = Math.min(b.n0, n); b.n1 = Math.max(b.n1, n);
    }
    padBoxes.set(p, b);
  }
  const e = (lon - p.origin.lon) * b.kx, n = (lat - p.origin.lat) * b.ky;
  const out = Math.max(b.e0 - e, e - b.e1, b.n0 - n, n - b.n1);
  return out > flatM + (p.blend ?? PAD_BLEND_M) + PAD_REACH_SLACK.M + PAD_REACH_SLACK.SHARE * (Math.abs(e) + Math.abs(n));
}
/** padOutOfReach's slack: metres, and a share of the distance from the pad's origin */
export const PAD_REACH_SLACK = { M: 30, SHARE: 0.02 } as const;

/**
 * A relief height at a lattice node moved onto the pads: the plane on the flat part (the hull and
 * `flatM` beyond, so every lattice cell the outline touches is flat), blended over PAD_BLEND_M.
 */
function padNode(h: number, lon: number, lat: number, pads: ReadonlyArray<Pad>, flatM: number): number {
  let bestW = 0, bestH = h;
  for (const p of pads) {
    if (padOutOfReach(p, lon, lat, flatM)) continue;
    const [e, n] = latLonToEnu(p.origin, lat, lon, 0);
    const d = padDistance(p, e, n) - flatM, blend = p.blend ?? PAD_BLEND_M;
    const w = d <= 0 ? 1 : d >= blend ? 0 : smooth(1 - d / blend);
    if (w > bestW) {
      bestW = w;
      bestH = padHeightEnu(p, e, n);
    }
  }
  return bestW >= 1 ? bestH : bestW > 0 ? h * (1 - bestW) + bestH * bestW : h;
}

/**
 * A raw height at lon/lat as applyPads leaves the lattice there: on the pad's plane (with the
 * flat margin of a z14 lattice of `grid` cells at that latitude), blended over PAD_BLEND_M. A
 * function of the point alone: the same in every tile.
 */
export function padAdjust(pads: ReadonlyArray<Pad>, lon: number, lat: number, h: number, grid = 64): number {
  if (!pads.length) return h;
  const row = ((2 * Math.PI * EARTH_R) / 2 ** 14) * Math.cos((lat * Math.PI) / 180);
  return padNode(h, lon, lat, pads, (1.5 * row) / grid);
}

/**
 * Put a tile's lattice and edge profiles on the pads. A node's new height depends on its global
 * position and its old height alone, so the two tiles of a seam (and the four of a corner) move
 * their shared nodes identically, and the profiles stay the lattice's own edge rows.
 */
export function applyPads(
  dem: { heights: Float32Array; borders?: TileBorders },
  tile: Tile,
  grid: number,
  pads: ReadonlyArray<Pad>,
): boolean {
  if (!pads.length) return false;
  const side = grid + 1;
  const flat = (t: Tile) => (1.5 * tileRowMeters(t.z, t.y + 0.5)) / grid;
  const flatM = flat(tile);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const [lon, lat] = nodeLonLat(tile, i, j, grid);
      dem.heights[j * side + i] = padNode(dem.heights[j * side + i], lon, lat, pads, flatM);
    }
  }
  const b = dem.borders;
  if (!b) return true;
  const edge = (prof: Float32Array, t: Tile, e: number, fm: number) => {
    const g = prof.length - 1;
    for (let k = 0; k < prof.length; k++) {
      const [i, j] = e === 0 ? [k, 0] : e === 1 ? [k, g] : e === 2 ? [0, k] : [g, k];
      const [lon, lat] = nodeLonLat(t, i, j, g);
      prof[k] = padNode(prof[k], lon, lat, pads, fm);
    }
  };
  [b.n, b.s, b.w, b.e].forEach((prof, e) => edge(prof, tile, e, flatM));
  if (b.coarse && tile.z > 0) {
    const parent = { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 };
    const fm = flat(parent);
    [b.coarse.n, b.coarse.s, b.coarse.w, b.coarse.e].forEach((prof, e) => {
      if (prof) edge(prof, parent, e, fm);
    });
  }
  return true;
}
