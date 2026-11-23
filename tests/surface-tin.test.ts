import { expect, it } from 'vitest';
import { buildGroundCover, type GroundCover } from '../src/world/ground-cover';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import type { P2 } from '../src/world/ribbon-shapes';
import { buildRoadNet } from '../src/world/road-net';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildSurfaceTin, MAX_SURFACE_VERTS, roadSurfaceOf, Z14_RELIEF_TOL_M, type SurfaceOptions, type SurfaceStats, type SurfaceTin } from '../src/world/surface-tin';
import { buildTerrainTin, tinLatticeSampler, type TerrainTin, type TinDebug } from '../src/world/terrain-tin';
import { BANK_M, BED_MARGIN_M } from '../src/world/road-pull';
import { classifyLine } from '../src/world/way-styles';
import { area, areaOf, at, bordersOf, coverTin, cracks, data, demOf, denseTown, GRID, lattice, M, padAround, polygon, randomTown, road, seeded, SIZE, TILE, townFixture } from './roads-helpers';

const slope = lattice((x, y) => 500 + 0.2 * x + 0.05 * y);
const surfaceOf = (roads: OsmLine[], h: Float32Array = slope, opts: SurfaceOptions = {}) => {
  const net = buildRoadNet(roads), z = solveRoadHeights(net, demOf(net, (x, y) => 500 + 0.2 * x + 0.05 * y));
  return { tin: buildSurfaceTin(TILE, GRID, h, { ...opts, roads: { net, z } }), net, z };
};
it('is the base TIN without roads (to the z14 tolerances)', () => {
  const hills = lattice((x, y) => 520 + 15 * Math.sin(x / 140) * Math.cos(y / 170));
  expect(buildSurfaceTin(TILE, GRID, hills)).toEqual(buildTerrainTin(TILE, GRID, hills, { borderTol: Z14_RELIEF_TOL_M, reliefTol: Z14_RELIEF_TOL_M }));
});
it('lays the ground level across a road on a hillside, at the road’s height', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]); // runs south across a 20 % cross slope
  const { tin } = surfaceOf([r]);
  for (const y of [400, 800, 1200]) { const h = at(tin, SIZE / 2, y); for (const off of [-9, -4, 4, 9]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(h, 1); }
});
it('leaves the ground beyond the bands as the base relief', () => {
  const base = buildTerrainTin(TILE, GRID, slope), { tin } = surfaceOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  for (const y of [300, 900]) for (const off of [-120, 120]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(at(base, SIZE / 2 + off, y), 3);
});
it('has no steeper ground beside the road than the pull makes', () => {
  const { tin } = surfaceOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  // 20 % cross slope: 9.5 m bed + 45 m band; no face steeper than 60 % across (no wall)
  for (let off = -60; off < 60; off += 2) expect(Math.abs(at(tin, SIZE / 2 + off + 2, 900) - at(tin, SIZE / 2 + off, 900)) / 2).toBeLessThan(0.6);
});
it('covers the tile once, with no vertex on another face’s edge', () => {
  const rnd = seeded(11);
  const roads = Array.from({ length: 60 }, () => road({ highway: rnd() < 0.3 ? 'primary' : 'residential' }, [[rnd() * 64, rnd() * 64], [rnd() * 64, rnd() * 64]]));
  const { tin } = surfaceOf(roads);
  expect(area(tin)).toBeCloseTo(GRID * GRID, 6);
  expect(cracks(tin)).toBe(0);
});
it('survives two ways along the same line', () => {
  const pts: [number, number][] = [[6, 30], [58, 34]];
  const { tin } = surfaceOf([road({ highway: 'primary' }, pts), road({ highway: 'primary' }, pts), road({ highway: 'residential' }, [pts[0], [32, 32]])]);
  expect(area(tin)).toBeCloseTo(GRID * GRID, 6);
  expect(cracks(tin)).toBe(0);
});
it('keeps the sea the sea beside a coast road and under a causeway', () => {
  const coast = lattice((x) => (x < SIZE / 2 ? 0 : 3 + 0.02 * (x - SIZE / 2)));
  const net = buildRoadNet([road({ highway: 'primary' }, [[33, 4], [33, 60]]), road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const tin = buildSurfaceTin(TILE, GRID, coast, { roads: { net, z: new Float64Array(net.samples.length).fill(4) } });
  for (const y of [300, 1200]) expect(at(tin, SIZE / 4, y)).toBe(0);
});
it('keeps an aerodrome pad flat under a road across it', () => {
  const pad = padAround(32, 32, 300), flat = lattice(() => 500);
  const net = buildRoadNet([road({ highway: 'service' }, [[20, 32], [44, 32]])]);
  const tin = buildSurfaceTin(TILE, GRID, flat, { pads: [pad], roads: { net, z: new Float64Array(net.samples.length).fill(506) } });
  expect(at(tin, SIZE / 2, SIZE / 2)).toBeCloseTo(500, 6);
});
it('lets the youngest roads’ edges go over the budget, and still steps nowhere', () => {
  const rnd = seeded(5);
  const roads = Array.from({ length: 8000 }, () => { const x = rnd() * 62 + 1, y = rnd() * 62 + 1; return road({ highway: 'residential' }, [[x, y], [x + rnd() - 0.5, y + rnd() - 0.5]]); });
  const { tin } = surfaceOf(roads);
  expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
  expect(tin.loose!.size).toBeGreaterThan(0);
  expect(cracks(tin)).toBe(0);
});
it('leaves a road without a height on the ground as ever', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]), net = buildRoadNet([r]);
  const tin = buildSurfaceTin(TILE, GRID, slope, { roads: { net, z: new Float64Array(net.samples.length).fill(NaN) } });
  expect(tin.vh).toEqual(buildTerrainTin(TILE, GRID, slope).vh);
});
it('lays a river level across in a valley with a cross slope, its banks pulled to it', () => {
  const r = road({ waterway: 'river' }, [[32, 4], [32, 60]]); // 18 m wide, the valley side rising east at 20 %
  const { tin } = surfaceOf([r]);
  for (const y of [400, 800, 1200]) {
    const h = at(tin, SIZE / 2, y);
    for (const off of [-8, -4, 4, 8]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(h, 1);
  }
});
it('carries the fall from a diagonal road along it, not stepped by the lattice', () => {
  // a road at 30° to the lattice on a 20 % cross slope: the ground 25 m off it, followed along it,
  // runs as smoothly as the relief and the road do (no zigzag from lattice nodes)
  const r = road({ highway: 'primary' }, [[6, 10], [58, 40]]);
  const { tin } = surfaceOf([r]);
  const ux = 52 / Math.hypot(52, 30), uy = 30 / Math.hypot(52, 30);
  const prof: number[] = [];
  for (let s = 400; s <= 1400; s += 5) {
    const xm = 6 / M + ux * s - uy * 25, ym = 10 / M + uy * s + ux * 25;
    prof.push(at(tin, xm, ym));
  }
  let worst = 0;
  for (let i = 1; i + 1 < prof.length; i++) worst = Math.max(worst, Math.abs(prof[i + 1] - 2 * prof[i] + prof[i - 1]));
  expect(worst).toBeLessThan(0.25);
});
it('follows the relief within Z14_RELIEF_TOL_M on a z14 tile, hills lower than a belt included', () => {
  const hills = (x: number, y: number) => 520 + 15 * Math.sin(x / 140) * Math.cos(y / 170);
  const h = lattice(hills), tin = buildSurfaceTin(TILE, GRID, h);
  const s = tinLatticeSampler(tin);
  let worst = 0;
  for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) worst = Math.max(worst, Math.abs(s(i, j) - h[j * (GRID + 1) + i]));
  expect(worst).toBeLessThanOrEqual(Z14_RELIEF_TOL_M + 0.01);
});
it('outlines the roads before the rivers when the vertices run short', () => {
  const rnd = seeded(5);
  const roads = Array.from({ length: 8000 }, () => { const x = rnd() * 62 + 1, y = rnd() * 62 + 1; return road({ highway: 'residential' }, [[x, y], [x + rnd() - 0.5, y + rnd() - 0.5]]); });
  const canal = road({ waterway: 'canal' }, [[2, 30], [62, 34]]);
  const { tin } = surfaceOf([canal, ...roads]);
  expect(tin.loose!.has(canal)).toBe(true);
});

// --- the ground covers in the surface ---

const coverSurface = (d: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }) => coverTin(d, (x, y) => 500 + 0.2 * x + 0.05 * y);

/**
 * a TIN edge passes this close to a point of a cover edge it carries, lattice cells: the fixed lines
 * snap to a vertex or an edge within 1e-3 (terrain-tin.ts insertFixedLines, a few centimetres)
 */
const ON_EDGE = 1.1e-3;
/** the TIN's edges by lattice cell: ax, ay, bx, by */
const edgeIndex = new WeakMap<TerrainTin, Map<number, number[][]>>();
function edgesAround(tin: TerrainTin, x: number, y: number): number[][] {
  let index = edgeIndex.get(tin);
  if (!index) {
    const idx = new Map<number, number[][]>();
    for (const t of tin.tris) for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const e = [tin.vx[p], tin.vy[p], tin.vx[q], tin.vy[q]];
      for (let i = Math.floor(Math.min(e[0], e[2])); i <= Math.floor(Math.max(e[0], e[2])); i++) {
        for (let j = Math.floor(Math.min(e[1], e[3])); j <= Math.floor(Math.max(e[1], e[3])); j++) {
          const k = i * 4096 + j;
          (idx.get(k) ?? idx.set(k, []).get(k)!).push(e);
        }
      }
    }
    edgeIndex.set(tin, (index = idx));
  }
  const out: number[][] = [];
  for (let i = Math.floor(x - ON_EDGE); i <= Math.floor(x + ON_EDGE); i++) {
    for (let j = Math.floor(y - ON_EDGE); j <= Math.floor(y + ON_EDGE); j++) out.push(...(index.get(i * 4096 + j) ?? []));
  }
  return out;
}
/** whether the part of a cover edge (lattice polyline) inside the tile runs along edges of the TIN */
function edgeInTin(tin: TerrainTin, line: P2[]): boolean {
  const g = tin.grid;
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], [bx, by] = line[k], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len === 0) continue;
    // the segment clipped to the tile
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-dx, ax], [dx, g - ax], [-dy, ay], [dy, g - ay]]) {
      if (p === 0) { if (q < 0) t1 = -1; continue; }
      if (p < 0) t0 = Math.max(t0, q / p);
      else t1 = Math.min(t1, q / p);
    }
    if ((t1 - t0) * len < 1e-6) continue;
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const t = t0 + (t1 - t0) * f, x = ax + dx * t, y = ay + dy * t;
      // a TIN edge along it through the point
      const along = edgesAround(tin, x, y).some(([px, py, qx, qy]) => {
        const ex = qx - px, ey = qy - py, el = Math.hypot(ex, ey);
        // along it, but for the turn a snapped end gives a short edge
        if (el === 0 || Math.abs(ex * dy - ey * dx) / (el * len) > 0.02 + (2 * ON_EDGE) / el) return false;
        const s = ((x - px) * ex + (y - py) * ey) / (el * el);
        return s >= -ON_EDGE / el && s <= 1 + ON_EDGE / el && Math.abs((x - px) * ey - (y - py) * ex) / el < ON_EDGE;
      });
      if (!along) return false;
    }
  }
  return true;
}
const centre = (tin: TerrainTin, f: number): [number, number] => {
  const t = tin.tris[f];
  return [(tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3];
};
/** faces with a point inside them (30 % of the way from the centre to a corner) under another cover than their centre */
function straddling(tin: TerrainTin, cover: GroundCover): number {
  let n = 0;
  tin.tris.forEach((t, f) => {
    const [cx, cy] = centre(tin, f), at0 = cover.locate(cx, cy);
    if ([t.a, t.b, t.c].some((v) => cover.locate(cx + 0.3 * (tin.vx[v] - cx), cy + 0.3 * (tin.vy[v] - cy)) !== at0)) n++;
  });
  return n;
}
/** the summed area of the faces with cover `s`, lattice cells² */
function coverArea(tin: SurfaceTin, s: number, cover?: GroundCover): number {
  let a = 0;
  tin.tris.forEach((t, f) => {
    // a road's bank: in its river's shape, the ground's
    if (tin.cover![f] !== s && !(cover && bankFace(tin, cover, f) && cover.locate(...centre(tin, f)) === s)) return;
    a += Math.abs((tin.vx[t.b] - tin.vx[t.a]) * (tin.vy[t.c] - tin.vy[t.a]) - (tin.vx[t.c] - tin.vx[t.a]) * (tin.vy[t.b] - tin.vy[t.a])) / 2;
  });
  return a;
}
/**
 * The area of each shape inside the tile less its seniors', lattice cells²: on rows across the tile
 * (exact along a row, rows 0.008 cells apart), each shape's triangles' spans less its seniors'
 */
const ownAreas = new WeakMap<GroundCover, Float64Array>();
function ownArea(cover: GroundCover, s: number): number {
  let own = ownAreas.get(cover);
  if (!own) {
    own = new Float64Array(cover.shapes.length);
    const rows = 8000, dy = GRID / rows;
    const tris: { s: number; t: Float64Array; o: number; y0: number; y1: number }[] = [];
    cover.shapes.forEach((sh, si) => {
      for (let o = 0; o < sh.tris.length; o += 6) {
        const ys = [sh.tris[o + 1], sh.tris[o + 3], sh.tris[o + 5]];
        tris.push({ s: si, t: sh.tris, o, y0: Math.min(...ys), y1: Math.max(...ys) });
      }
    });
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) * dy;
      // the spans of each shape on the row, the senior first
      const spans: [number, number, number][] = [];
      for (const { s: si, t, o, y0, y1 } of tris) {
        if (y < y0 || y > y1) continue;
        let lo = Infinity, hi = -Infinity;
        for (let e = 0; e < 3; e++) {
          const px = t[o + 2 * e], py = t[o + 2 * e + 1], qx = t[o + (2 * e + 2) % 6], qy = t[o + (2 * e + 3) % 6];
          if (py === qy || y < Math.min(py, qy) || y > Math.max(py, qy)) continue;
          const x = px + ((qx - px) * (y - py)) / (qy - py);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
        lo = Math.max(lo, 0);
        hi = Math.min(hi, GRID);
        if (hi > lo) spans.push([si, lo, hi]);
      }
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      /** the row covered by the seniors so far: disjoint spans in order */
      let taken: [number, number][] = [];
      for (let i = 0; i < spans.length;) {
        const si = spans[i][0];
        // the shape's own spans merged
        const mine: [number, number][] = [];
        for (; i < spans.length && spans[i][0] === si; i++) {
          const [, lo, hi] = spans[i];
          if (mine.length && lo <= mine[mine.length - 1][1]) mine[mine.length - 1][1] = Math.max(mine[mine.length - 1][1], hi);
          else mine.push([lo, hi]);
        }
        // less what the seniors took
        for (const [lo, hi] of mine) {
          let len = hi - lo;
          for (const [tl, th] of taken) len -= Math.max(0, Math.min(hi, th) - Math.max(lo, tl));
          own[si] += len * dy;
        }
        // and taken with them
        const all = [...taken, ...mine].sort((a, b) => a[0] - b[0]);
        taken = [];
        for (const [lo, hi] of all) {
          if (taken.length && lo <= taken[taken.length - 1][1]) taken[taken.length - 1][1] = Math.max(taken[taken.length - 1][1], hi);
          else taken.push([lo, hi]);
        }
      }
    }
    ownAreas.set(cover, own);
  }
  return own[s];
}
/** the kinds of the shapes whose edges (outside their seniors) are not all in the surface */
const droppedKinds = (tin: TerrainTin, cover: GroundCover): string[] =>
  [...new Set(cover.shapes.filter((s, si) => !s.outline.every((l) => cover.outside(l, si).every((piece) => edgeInTin(tin, piece)))).map((s) => s.kind))].sort();

it('puts every edge of every cover into the surface, but where it lies inside a senior one', () => {
  const { tin, cover } = coverSurface(townFixture());
  cover.shapes.forEach((s, si) => {
    for (const line of s.outline) for (const piece of cover.outside(line, si)) expect(edgeInTin(tin, piece)).toBe(true);
  });
});
it('leaves out the edges of a junior cover inside a senior one: they part no faces of different covers', () => {
  const primary = road({ highway: 'primary' }, [[10.2, 30.1], [54.3, 31.4]]);
  const street = road({ highway: 'residential' }, [[30.4, 12.2], [31.1, 50.3]]);
  const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
  const net = buildRoadNet([primary, street]), roads = { net, z: solveRoadHeights(net, demOf(net, relief)) };
  const cover = buildGroundCover(TILE, GRID, data([primary, street]), roads);
  const debug = {} as TinDebug;
  const tin = buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), roads, cover, debug });
  const asphalt = (way: OsmLine) => cover.shapes.findIndex((s) => s.kind === 'carriageway' && s.source === way);
  const p = asphalt(primary), s = asphalt(street);
  expect(p).toBeLessThan(s);
  /** distance from (x, y) to the street's asphalt edge */
  const offEdge = (x: number, y: number) => Math.min(...cover.shapes[s].outline.flatMap((line) => line.slice(1).map(([bx, by], k) => {
    const [ax, ay] = line[k], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    return Math.hypot(x - ax - dx * f, y - ay - dy * f);
  })));
  // the fixed edges along the street's sides, more than 5 cm into the primary's asphalt: none
  const margin = 0.05 * M;
  const deep = (x: number, y: number) => [[-1, -1], [-1, 1], [1, -1], [1, 1]].every(([i, j]) => cover.locate(x + i * margin, y + j * margin) === p);
  let along = 0, inside = 0;
  for (const [u, v] of debug.constraints!) {
    const x = (tin.vx[u] + tin.vx[v]) / 2, y = (tin.vy[u] + tin.vy[v]) / 2;
    if (offEdge(x, y) > 1e-3) continue;
    along++;
    if (deep(x, y)) inside++;
  }
  expect(along).toBeGreaterThan(4);
  expect(inside).toBe(0);
  // and where it enters the primary's asphalt it is in, to its edge
  for (const line of cover.shapes[s].outline) for (const piece of cover.outside(line, s)) expect(edgeInTin(tin, piece)).toBe(true);
});
/**
 * whether face f lies in a river's shape with a corner under a road's cover (within 6 cm): a road's
 * bank, the ground's (the footway across the town's river, its corners raised off the water)
 */
function bankFace(tin: SurfaceTin, cover: GroundCover, f: number): boolean {
  const si = cover.locate(...centre(tin, f)), t = tin.tris[f], e = 0.06 * M;
  if (si < 0 || cover.shapes[si].kind !== 'water' || tin.cover![f] !== -1) return false;
  return [t.a, t.b, t.c].some((v) => [[0, 0], [e, 0], [-e, 0], [0, e], [0, -e]].some(([dx, dy]) => {
    const sj = cover.locate(tin.vx[v] + dx, tin.vy[v] + dy);
    return sj >= 0 && ['carriageway', 'shoulder', 'path'].includes(cover.shapes[sj].kind);
  }));
}
it('gives each face one cover, the senior shape under its centre (a road’s bank the ground’s), and no face straddles a cover edge', () => {
  const { tin, cover } = coverSurface(townFixture());
  for (let f = 0; f < tin.tris.length; f++) expect(tin.cover![f]).toBe(bankFace(tin, cover, f) ? -1 : cover.locate(...centre(tin, f)));
  expect(straddling(tin, cover)).toBe(0);
});
it('covers each shape’s area less its seniors’, to the outline’s simplification', () => {
  const { tin, cover } = coverSurface(townFixture());
  // within 2 % (the plan's ruling 1: the seniors' areas taken off on rows across the tile)
  for (let s = 0; s < cover.shapes.length; s++) expect(Math.abs(coverArea(tin, s, cover) - ownArea(cover, s))).toBeLessThanOrEqual(0.02 * ownArea(cover, s) + 1e-9);
});
it('drops the parks before the roads when over the budget, and cracks nowhere', () => {   // Review Focus 4
  const { tin, cover } = coverSurface(denseTown(2500));
  expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
  expect(tin.loose?.size ?? 0).toBe(0);
  expect(droppedKinds(tin, cover)).toEqual(['area']);
  expect(cracks(tin)).toBe(0);
});

it('takes a covered road’s shoulder edge for its bed’s: no fixed edge 0.3 m beyond it, the ground across it level', () => {
  const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]); // runs south across a 20 % cross slope
  const net = buildRoadNet([r]), roads = { net, z: solveRoadHeights(net, demOf(net, relief)) };
  const cover = buildGroundCover(TILE, GRID, data([r]), roads);
  const debug = {} as TinDebug;
  const tin = buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), roads, cover, debug });
  expect(tin.loose).toBeUndefined();
  // the fixed edges along the road (lattice x of both ends near one offset), by their offset from its axis, metres
  const edge = classifyLine({ highway: 'primary' })!, outer = edge.width / 2 + edge.shoulder!;
  const offsets = debug.constraints!.flatMap(([u, v]) => {
    const a = (tin.vx[u] - 32) / M, b = (tin.vx[v] - 32) / M;
    return Math.abs(a - b) < 0.01 && Math.abs(tin.vy[u] - tin.vy[v]) > 0.05 ? [Math.abs(a)] : [];
  });
  expect(offsets.some((o) => Math.abs(o - outer) < 0.02)).toBe(true);
  expect(offsets.filter((o) => Math.abs(o - outer - BED_MARGIN_M) < 0.1)).toEqual([]);
  for (const y of [400, 800, 1200]) { const h = at(tin, SIZE / 2, y); for (const off of [-9, -4, 4, 9]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(h, 1); }
});
it('paints a face with a dropped area only when the face lies in it, centre and corners: a small pool goes', () => {
  const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
  // a budget below the relief's own vertices: every edge left out
  const surface = (areas: OsmArea[]) => {
    const cover = buildGroundCover(TILE, GRID, data([], areas), undefined);
    return { cover, tin: buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), cover, maxSurfaceVerts: 0 }) };
  };
  const bare = surface([areaOf({ natural: 'water' }, polygon(-20, -20, 1, 5))]).tin;
  // a pool round the centre of a big face, much smaller than it; a lake round the whole tile
  const [cx, cy] = centre(bare, 0);
  const pool = areaOf({ natural: 'water' }, polygon(cx, cy, 0.3, 7, 0.4)), lake = areaOf({ natural: 'water' }, polygon(32, 32, 80, 9, 0.1));
  const { tin, cover } = surface([pool]);
  expect(cover.locate(cx, cy)).toBe(0);
  expect(tin.vx.length).toBe(bare.vx.length);
  expect([...tin.cover!].every((c) => c === -1)).toBe(true);
  // over the lake, every face lies in it
  const wet = surface([lake]);
  expect([...wet.tin.cover!].every((c) => c === 0)).toBe(true);
  // the pool in the lake: the lake's
  const both = surface([pool, lake]);
  const ofPool = both.cover.shapes.findIndex((sh) => sh.source === pool), ofLake = both.cover.shapes.findIndex((sh) => sh.source === lake);
  expect(both.cover.locate(cx, cy)).toBe(Math.min(ofPool, ofLake));
  expect([...both.tin.cover!].every((c) => c === ofLake)).toBe(true);
});
it('fills the vertex budget: in one build where the outlines cross little, in two where they cross much', () => {
  const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
  for (const [d, max, builds] of [[denseTown(2500), MAX_SURFACE_VERTS, 1], [denseTown(2500), 12000, 1], [randomTown(10), 6000, 2]] as const) {
    const net = buildRoadNet(d.lines), roads = { net, z: solveRoadHeights(net, demOf(net, relief)) };
    const cover = buildGroundCover(TILE, GRID, d, roads), stats = {} as SurfaceStats;
    const tin = buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), roads, cover, maxSurfaceVerts: max, stats });
    expect(tin.vx.length).toBeLessThanOrEqual(max);
    expect(tin.vx.length).toBeGreaterThan(0.88 * max);
    expect(stats.builds).toBeLessThanOrEqual(builds);
  }
});

/** the surface of a random town, roads only or with its cover, and how many fixed edges the triangulation lost */
const townSurface = (seed: number, withCover: boolean) => {
  const relief = (x: number, y: number) => 500 + 25 * Math.sin(x / 300) + 0.06 * y;
  const d = randomTown(seed), net = buildRoadNet(d.lines), roads = { net, z: solveRoadHeights(net, demOf(net, relief)) };
  const debug = {} as TinDebug;
  const cover = withCover ? buildGroundCover(TILE, GRID, d, roads) : undefined;
  return { tin: buildSurfaceTin(TILE, GRID, lattice(relief), { borders: bordersOf(relief), roads, cover, debug }), missing: debug.missing };
};
for (const seed of [10, 12]) it(`keeps every fixed edge and cracks nowhere under a random town's roads (seed ${seed})`, () => {
  const { tin, missing } = townSurface(seed, false);
  expect(missing).toBe(0);
  expect(cracks(tin)).toBe(0);
});
it('keeps every fixed edge and cracks nowhere under a random town with its covers', () => {
  const { tin, missing } = townSurface(12, true);
  expect(missing).toBe(0);
  expect(cracks(tin)).toBe(0);
});

it('lays a dropped road over the cover under it: the park it crosses, the bare ground elsewhere', () => {
  // a street through a park, and a lane in the network with no cover of its own (a bed alone)
  const street = road({ highway: 'residential' }, [[4.3, 20.2], [60.1, 22.7]]);
  const lane = road({ highway: 'service' }, [[10.3, 40.1], [50.2, 43.3]]);
  const parkArea = areaOf({ leisure: 'park' }, polygon(30.2, 21.4, 8.1, 9, 0.2));
  const relief = (x: number, y: number) => 500 + 0.2 * x + 0.05 * y;
  const net = buildRoadNet([street, lane]), roads = { net, z: solveRoadHeights(net, demOf(net, relief)) };
  const cover = buildGroundCover(TILE, GRID, { lines: [street], areas: [parkArea], points: [] }, roads);
  const park = cover.shapes.findIndex((s) => s.kind === 'area');
  const ofStreet = (s: number) => s >= 0 && cover.shapes[s].source === street;
  // a budget below the relief's own vertices: every edge left out
  const tin = buildSurfaceTin(TILE, GRID, lattice(relief), { roads, cover, maxSurfaceVerts: 0 });
  expect([...tin.loose!].sort((a, b) => a.tags.highway.localeCompare(b.tags.highway))).toEqual([street, lane]);
  const under = new Set<number>();
  /** the dropped park paints a face only where the face lies in it, its corners too */
  const lies = (f: number) => [tin.tris[f].a, tin.tris[f].b, tin.tris[f].c].every((v) => cover.locate(tin.vx[v], tin.vy[v], (s) => s !== park) === park);
  tin.tris.forEach((_, f) => {
    const [x, y] = centre(tin, f);
    expect(ofStreet(tin.cover![f])).toBe(false);
    if (!ofStreet(cover.locate(x, y))) {
      const want = cover.locate(x, y);
      expect(tin.cover![f]).toBe(want === park && !lies(f) ? -1 : want);
      return;
    }
    // on the street: what lies under it
    const inPark = cover.shapes[park].tris.length > 0 && cover.locate(x, y, (s) => s !== park) === park && lies(f);
    expect(tin.cover![f]).toBe(inPark ? park : -1);
    under.add(tin.cover![f]);
  });
  expect([...under].sort((a, b) => a - b)).toEqual([-1, park]);
  // within the budget both keep their edges (nothing loose) and the street its faces
  const kept = buildSurfaceTin(TILE, GRID, lattice(relief), { roads, cover });
  expect(kept.loose).toBeUndefined();
  expect([...kept.cover!].some(ofStreet)).toBe(true);
});

it('lays a road’s bank from its cover’s edge down to the water as one steep strip of ground: no water face at the road’s height', () => {
  // flat ground at 503 m: a residential with a canal (18 m wide, its water 2.5 m down) 10 m off it,
  // and another with a stream (5 m wide, 1 m down) across it, no culvert
  const main = road({ highway: 'residential' }, [[4, 40], [60, 40]]), side = road({ highway: 'residential' }, [[4, 12], [60, 12]]);
  const canal = road({ waterway: 'canal', width: '18' }, [[-4, 40 + 10 * M], [68, 40 + 10 * M]]);
  const stream = road({ waterway: 'stream', width: '5' }, [[20, 2], [20, 24]]);
  const d = data([main, side, canal, stream]), flat = () => 503, net = buildRoadNet(d.lines);
  const roads = roadSurfaceOf(TILE, d, net, demOf(net, flat)), cover = buildGroundCover(TILE, GRID, d, roads);
  const tin = buildSurfaceTin(TILE, GRID, lattice(flat), { borders: bordersOf(flat), roads, cover });
  // the road's bed's edge: its cover's outer edge
  const edge = net.ways[0].half;
  /** metres off the nearer road's axis (round its ends) */
  const off = (v: number) => Math.min(...[40, 12].map((y) => Math.hypot(tin.vx[v] - Math.max(4, Math.min(60, tin.vx[v])), tin.vy[v] - y) / M));
  const levels = new Set<number>(), tilted: string[] = [], banks: number[] = [];
  tin.tris.forEach((t, f) => {
    const own = tin.cover![f], hs = [t.a, t.b, t.c].map((v) => tin.vh[v]);
    if (own < 0) {
      // a road's bank: ground from the road's height on its edge down to the water's, BANK_M (and a
      // hair) wide (the far bank of the canal falls from the relief to its water as ever)
      const offs = [t.a, t.b, t.c].map(off);
      if (Math.max(...hs) - Math.min(...hs) > 1 && Math.min(...offs) < edge + 0.1) banks.push(...offs.map((o) => o - edge));
      return;
    }
    if (cover.shapes[own].kind !== 'water') return;
    for (const h of hs) levels.add(Math.round(h * 10) / 10);
    // no water face tilted, none at the road's height
    if (Math.max(...hs) - Math.min(...hs) > 0.05 || Math.max(...hs) > 502.5) tilted.push(`${centre(tin, f).map((c) => (c / M).toFixed(1))} ${hs.map((h) => h.toFixed(2))}`);
  });
  // the canal's water and the stream's, each at its own level
  expect([...levels].sort()).toEqual([500.5, 502]);
  expect(tilted).toEqual([]);
  expect(banks.length).toBeGreaterThan(0);
  // from the cover's edge (a round end's chords 14 cm inside its circle) to the water row
  expect(Math.min(...banks)).toBeGreaterThanOrEqual(-0.14);
  expect(Math.max(...banks)).toBeLessThanOrEqual(BANK_M + 0.01);
  expect(cracks(tin)).toBe(0);
});

it('shares the border’s points of a road’s bank with the neighbour: where its rows cross, as laid (cut before thinned)', () => {
  // a curving residential across the border to the east tile, a canal (18 m wide, its water 2.5 m
  // down) 10 m off it, a street across both far into the east tile (beyond the west's view)
  const arc = (o: number) => Array.from({ length: 21 }, (_, i): [number, number] => { const x = 30 + i * 5; return [x, 30 + o * M + ((x - 80) ** 2) / 400]; });
  const lines = [
    road({ highway: 'residential' }, arc(0)), road({ waterway: 'canal', width: '18' }, arc(10)),
    road({ highway: 'residential' }, [[112, 4], [112, 60]]),
  ];
  const flat = () => 503;
  const tileOf = (t: typeof TILE) => {
    const d = data(lines), net = buildRoadNet(d.lines), roads = roadSurfaceOf(t, d, net, demOf(net, flat)), cover = buildGroundCover(t, GRID, d, roads);
    return buildSurfaceTin(t, GRID, lattice(flat, t), { borders: bordersOf(flat, t), roads, cover });
  };
  const west = tileOf(TILE), east = tileOf({ ...TILE, x: TILE.x + 1 });
  const on = (tin: SurfaceTin, x: number) => new Map(tin.vx.flatMap((vx, k) => (vx === x ? [[tin.vy[k].toFixed(9), tin.vh[k]] as const] : [])));
  const a = on(west, GRID), b = on(east, 0);
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [y, h] of a) expect(b.get(y)).toBeCloseTo(h, 6);
  expect(cracks(west)).toBe(0);
  expect(cracks(east)).toBe(0);
});

it('lifts a bridge’s deck by its own heights and DEM alone: the low stretches that pull agree across the border', () => {
  // a primary with a 350 m bridge crossing the border to the east tile at 45° over rolling relief
  const relief = (xm: number, ym: number) => 500 + 4 * Math.sin(xm / 60) * Math.cos(ym / 70);
  const lines = [
    road({ highway: 'primary' }, [[40, 10], [60, 30]]), road({ highway: 'primary', bridge: 'yes', layer: '1' }, [[60, 30], [68, 38]]),
    road({ highway: 'primary' }, [[68, 38], [88, 58]]),
  ];
  const tileOf = (t: typeof TILE) => {
    const d = data(lines), net = buildRoadNet(d.lines), roads = roadSurfaceOf(t, d, net, demOf(net, relief)), cover = buildGroundCover(t, GRID, d, roads);
    return buildSurfaceTin(t, GRID, lattice(relief, t), { borders: bordersOf(relief, t), roads, cover });
  };
  const west = tileOf(TILE), east = tileOf({ ...TILE, x: TILE.x + 1 });
  const on = (tin: SurfaceTin, x: number) => new Map(tin.vx.flatMap((vx, k) => (vx === x ? [[tin.vy[k].toFixed(6), tin.vh[k]] as const] : [])));
  const a = on(west, GRID), b = on(east, 0);
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [y, h] of a) expect(Math.abs(b.get(y)! - h)).toBeLessThan(0.05);
});

it('a bridge over a canal at the border with a road along the canal’s bank: the two tiles’ border rows agree', () => {
  // a 20 m tertiary bridge across the border to the east tile over a canal along it, a bank road
  // beside the canal ending near the bridge, over relief sloped along the border
  const relief = (xm: number, ym: number) => 500 + 1.5 * Math.sin(xm / 40) + 0.02 * ym;
  const B = GRID;
  for (const [cx, bank] of [
    [B + M, road({ highway: 'residential' }, [[B - 3 * M, 4], [B - 3 * M, 32 - M]])],
    [B - 2 * M, road({ highway: 'residential' }, [[B + M, 4], [B + 3 * M, 32 - 1.5 * M]])],
    [B, road({ highway: 'residential' }, [[B + 4.5 * M, 60], [B + 3 * M, 32 + 0.5 * M]])],
  ] as const) {
    const lines = [
      road({ highway: 'tertiary' }, [[B - 40 * M, 32], [B - 10 * M, 32]]), road({ highway: 'tertiary', bridge: 'yes', layer: '1' }, [[B - 10 * M, 32], [B + 10 * M, 32]]),
      road({ highway: 'tertiary' }, [[B + 10 * M, 32], [B + 40 * M, 32]]), road({ waterway: 'canal' }, [[cx, 2], [cx, 62]]), bank,
    ];
    const tileOf = (t: typeof TILE) => {
      const d = data(lines), net = buildRoadNet(d.lines), roads = roadSurfaceOf(t, d, net, demOf(net, relief)), cover = buildGroundCover(t, GRID, d, roads);
      return buildSurfaceTin(t, GRID, lattice(relief, t), { borders: bordersOf(relief, t), roads, cover });
    };
    const west = tileOf(TILE), east = tileOf({ ...TILE, x: TILE.x + 1 });
    const on = (tin: SurfaceTin, x: number) => new Map(tin.vx.flatMap((vx, k) => (vx === x ? [[tin.vy[k].toFixed(6), tin.vh[k]] as const] : [])));
    const a = on(west, GRID), b = on(east, 0);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [y, h] of a) expect(Math.abs(b.get(y)! - h)).toBeLessThan(0.05);
    expect(cracks(west)).toBe(0);
    expect(cracks(east)).toBe(0);
  }
});
