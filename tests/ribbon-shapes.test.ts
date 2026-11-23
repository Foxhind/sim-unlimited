import { describe, expect, it } from 'vitest';
import { ribbonGeom, ROUND_ENDS, type P2, type RibbonGeom } from '../src/world/ribbon-shapes';
import { M } from './roads-helpers';

/** the summed area of the ribbon's triangles (overlaps counted twice), lattice cells² */
const triArea = (tris: P2[]): number => {
  let a = 0;
  for (let k = 0; k + 2 < tris.length; k += 3) {
    const [p, q, r] = [tris[k], tris[k + 1], tris[k + 2]];
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
  }
  return a;
};

/** whether p is in the triangle (a, b, c) or on its sides, either winding */
const inside = (p: P2, a: P2, b: P2, c: P2): boolean => {
  const s = (u: P2, v: P2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a), tol = 1e-12;
  return (d1 > -tol && d2 > -tol && d3 > -tol) || (d1 < tol && d2 < tol && d3 < tol);
};
/** distance from p to segment ab */
const toSegment = (p: P2, a: P2, b: P2): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};

/**
 * p lies on the boundary of the ribbon: on a side of one of its triangles, and not inside their
 * union (a point a hair away from it, in some direction, is in no triangle). A point on a side two
 * triangles share, or on a cap's spoke under the ribbon's body, is inside: every probe round it is covered.
 */
const onRibbonBoundary = (g: RibbonGeom, p: P2): boolean => {
  const tris: [P2, P2, P2][] = [];
  for (let k = 0; k + 2 < g.tris.length; k += 3) tris.push([g.tris[k], g.tris[k + 1], g.tris[k + 2]]);
  if (!tris.some(([a, b, c]) => Math.min(toSegment(p, a, b), toSegment(p, b, c), toSegment(p, c, a)) < 1e-9)) return false;
  const PROBES = 256, R = 1e-6;
  for (let k = 0; k < PROBES; k++) {
    const a = (k / PROBES) * 2 * Math.PI, q: P2 = [p[0] + Math.cos(a) * R, p[1] + Math.sin(a) * R];
    if (!tris.some(([u, v, w]) => inside(q, u, v, w))) return true;
  }
  return false;
};

/** every outline vertex and the middle of every outline edge lie on the ribbon's boundary */
const outlineOnBoundary = (g: RibbonGeom): boolean =>
  g.outline.every((line) => line.every((p, i) => onRibbonBoundary(g, p) && (i === 0 || onRibbonBoundary(g, [(p[0] + line[i - 1][0]) / 2, (p[1] + line[i - 1][1]) / 2]))));

/** the outline's polylines close into loops: every end point is the end of exactly two of them */
const closed = (g: RibbonGeom): boolean => {
  const ends = new Map<string, number>();
  const key = (p: P2) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
  for (const line of g.outline) for (const p of [line[0], line[line.length - 1]]) ends.set(key(p), (ends.get(key(p)) ?? 0) + 1);
  return [...ends.values()].every((n) => n % 2 === 0);
};

describe('ribbonGeom', () => {
  it('a straight ribbon is a rectangle with two round caps', () => {
    const g = ribbonGeom([[10, 32], [50, 32]], 4, ROUND_ENDS, M);   // 4 m each side; caps are 12-gons
    expect(triArea(g.tris)).toBeCloseTo(40 * 8 * M + 2 * 12 * 0.5 * (4 * M) ** 2 * Math.sin(Math.PI / 6), 6);
    expect(g.outline.flat().every((p) => onRibbonBoundary(g, p))).toBe(true);
  });
  it('cuts the ribbon across at each inner vertex of its centre line', () => {
    const g = ribbonGeom([[10, 32], [30, 32], [50, 40]], 0.1, { capStart: false, capEnd: false }, 1);
    expect(g.cuts.length).toBe(1);
  });
  it('gives every segment triangle its segment', () => {
    const g = ribbonGeom([[10, 32], [30, 32], [50, 40]], 0.1, { capStart: false, capEnd: false }, 1);
    expect(g.triSeg).toEqual([0, 0, 1, 1]);
  });

  it('outlines a ribbon with square ends: two sides and the two ends, closed', () => {
    const g = ribbonGeom([[10, 32], [30, 32], [50, 40]], 2, { capStart: false, capEnd: false }, 1);
    expect(outlineOnBoundary(g)).toBe(true);
    expect(closed(g)).toBe(true);
    // a mitred bend: one cut, through the vertex and as long as the mitre
    const [a, b] = g.cuts[0];
    expect((a[0] + b[0]) / 2).toBeCloseTo(30, 9);
    expect((a[1] + b[1]) / 2).toBeCloseTo(32, 9);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(4);
  });

  it('outlines round caps and a sharp turn: the disc on the outer side, the sides crossing on the inner', () => {
    const c: P2[] = [[10, 32], [40, 32], [20, 40]];
    const g = ribbonGeom(c, 2, ROUND_ENDS, 1);
    expect(outlineOnBoundary(g)).toBe(true);
    expect(closed(g)).toBe(true);
    // the turn is cut twice, across each segment's own end
    expect(g.cuts.length).toBe(2);
    for (const cut of g.cuts) for (const p of cut) expect(Math.hypot(p[0] - 40, p[1] - 32)).toBeCloseTo(2, 9);
    // their outer ends on the edge, the inner ones under the other segment; the disc's centre inside
    expect(g.cuts.flat().filter((p) => onRibbonBoundary(g, p)).length).toBe(2);
    expect(onRibbonBoundary(g, c[1])).toBe(false);
    // the body's two segments, the caps on the first and last, the joint disc on its own vertex
    expect(g.triSeg).toEqual([0, 0, 1, 1, ...Array(12).fill(0), ...Array(12).fill(1), ...Array(12).fill(1)]);
    expect(g.tris.length).toBe(3 * g.triSeg.length);
  });

  it('takes a half width per vertex', () => {
    const g = ribbonGeom([[10, 32], [30, 32], [50, 32]], [1, 2, 3], { capStart: false, capEnd: false }, 1);
    expect(triArea(g.tris)).toBeCloseTo(20 * (1 + 2) + 20 * (2 + 3), 9);
    expect(outlineOnBoundary(g)).toBe(true);
    expect(closed(g)).toBe(true);
  });
});
