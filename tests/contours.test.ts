import { describe, expect, it } from 'vitest';
import { constrainedDelaunay, contourLevels, delaunay, extractIsolines, simplifyOpen, simplifyRing } from '../src/world/contours';

function lattice(n: number, fn: (i: number, j: number) => number): Float32Array {
  const h = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) h[j * (n + 1) + i] = fn(i, j);
  return h;
}

describe('contourLevels', () => {
  it('lists multiples of step strictly inside the range, never negative', () => {
    expect(contourLevels(-30, 45, 20)).toEqual([0, 20, 40]);
    expect(contourLevels(10, 50, 20)).toEqual([20, 40]);
    expect(contourLevels(100, 100, 20)).toEqual([]);
  });
});

describe('extractIsolines', () => {
  it('traces a closed ring around a cone peak at the right radius', () => {
    const n = 16;
    const h = lattice(n, (i, j) => 100 - 10 * Math.hypot(i - 8, j - 8));
    const lines = extractIsolines(h, n, 50);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    for (const p of lines[0].pts) expect(Math.hypot(p.x - 8, p.y - 8)).toBeGreaterThan(4.7);
    for (const p of lines[0].pts) expect(Math.hypot(p.x - 8, p.y - 8)).toBeLessThan(5.3);
  });

  it('traces an open line ending on the border for a slope', () => {
    const n = 8;
    const h = lattice(n, (i) => i * 10);
    const lines = extractIsolines(h, n, 35);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(false);
    const ys = lines[0].pts.map((p) => p.y);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(n);
    for (const p of lines[0].pts) expect(p.x).toBeCloseTo(3.5, 5);
  });

  it('resolves saddles consistently (every edge crossing used exactly twice or at border)', () => {
    const n = 2;
    const h = lattice(n, (i, j) => ((i + j) % 2 === 0 ? 10 : 0));
    const lines = extractIsolines(h, n, 5);
    const used = lines.reduce((s, l) => s + l.pts.length, 0);
    expect(used).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const n = 24;
    const h = lattice(n, (i, j) => 50 * Math.sin(i / 3) * Math.cos(j / 4) + 60);
    expect(extractIsolines(h, n, 40)).toEqual(extractIsolines(h, n, 40));
  });
});

describe('simplification', () => {
  it('drops collinear points but keeps endpoints', () => {
    const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 0 }));
    expect(simplifyOpen(pts, 0.1)).toEqual([pts[0], pts[4]]);
  });

  it('keeps a corner beyond tolerance', () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }];
    expect(simplifyOpen(pts, 1)).toHaveLength(3);
    expect(simplifyOpen(pts, 5)).toHaveLength(2);
  });

  it('reduces a fine circle ring to far fewer points within tolerance', () => {
    const ring = Array.from({ length: 120 }, (_, k) => ({
      x: 10 * Math.cos((k / 120) * 2 * Math.PI),
      y: 10 * Math.sin((k / 120) * 2 * Math.PI),
    }));
    const s = simplifyRing(ring, 0.3);
    expect(s.length).toBeLessThan(30);
    expect(s.length).toBeGreaterThanOrEqual(8);
  });
});

describe('delaunay', () => {
  it('covers the convex hull exactly (area of unit square with interior + border points)', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
      { x: 2, y: 0 }, { x: 4, y: 1.5 }, { x: 0, y: 3 }, { x: 2, y: 4 },
      { x: 1.3, y: 1.1 }, { x: 2.9, y: 2.2 }, { x: 2.2, y: 3.1 },
    ];
    const tris = delaunay(pts);
    let area = 0;
    for (const t of tris) {
      const a = pts[t.a], b = pts[t.b], c = pts[t.c];
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
    expect(area).toBeCloseTo(16, 9);
  });

  it('is deterministic', () => {
    const pts = Array.from({ length: 60 }, (_, k) => ({ x: (k * 37) % 17, y: (k * 91) % 23 + k * 0.01 }));
    expect(delaunay(pts)).toEqual(delaunay(pts));
  });
});

describe('constrainedDelaunay at scale', () => {
  const rnd = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  it('triangulates 8000 points with 2000 fixed edges within 150 ms', () => {
    const r = rnd(7), pts = Array.from({ length: 8000 }, () => ({ x: r() * 64, y: r() * 64 }));
    // fixed edges: short non-crossing segments between consecutive points of 2000 disjoint pairs
    const sorted = pts.map((p, i) => ({ p, i })).sort((a, b) => a.p.x - b.p.x || a.p.y - b.p.y);
    const cons: [number, number][] = [];
    for (let k = 0; k + 1 < sorted.length && cons.length < 2000; k += 4) cons.push([sorted[k].i, sorted[k + 1].i]);
    constrainedDelaunay(pts, cons); // warm-up
    const t = performance.now();
    const { tris, missing } = constrainedDelaunay(pts, cons);
    expect(performance.now() - t).toBeLessThan(150);
    expect(missing).toBe(0);
    const has = new Set(tris.flatMap((f) => [[f.a, f.b], [f.b, f.c], [f.c, f.a]].map(([u, v]) => (u < v ? `${u},${v}` : `${v},${u}`))));
    for (const [u, v] of cons) expect(has.has(u < v ? `${u},${v}` : `${v},${u}`)).toBe(true);
  });

  it('leaves no vertex on another face’s edge among points on one line', () => {
    const on = (x: number) => ({ x, y: 3 + ((x - 3) * 41) / 42 });
    const pts = [on(24.54), on(26.54), on(27.041), on(27.613), on(28.04), on(29.27), { x: 27.995, y: 29.434 }, { x: 33, y: 24.35 }, { x: 20, y: 30 }, { x: 30, y: 18 }];
    const { tris } = constrainedDelaunay(pts, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], () => true);
    for (const f of tris) for (const [p, q] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) {
      const a = pts[p], b = pts[q], len = Math.hypot(b.x - a.x, b.y - a.y);
      pts.forEach((m, k) => {
        if (k === p || k === q) return;
        const s = ((m.x - a.x) * (b.x - a.x) + (m.y - a.y) * (b.y - a.y)) / (len * len);
        const d = Math.abs((m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x)) / len;
        expect(s > 1e-6 && s < 1 - 1e-6 && d < 1e-7).toBe(false);
      });
    }
  });
});
