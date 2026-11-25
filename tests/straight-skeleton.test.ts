import { describe, expect, it } from 'vitest';
import { straightSkeleton, type XZ } from '../src/world/straight-skeleton';

function area(r: XZ[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p[0] * q[1] - q[0] * p[1]; }
  return s / 2;
}

/** faces tile the footprint, every node sits at its time from each face's edge line */
function check(rings: XZ[][]) {
  const sk = straightSkeleton(rings);
  expect(sk).toBeDefined();
  const { nodes, edges, faces } = sk!;
  let sum = 0;
  faces.forEach((f, e) => {
    const poly = f.map((i) => nodes[i].p);
    const a = area(poly);
    expect(a).toBeGreaterThan(-1e-6);
    sum += a;
    for (const i of f) {
      const { p, t } = nodes[i];
      expect(edges[e].n[0] * p[0] + edges[e].n[1] * p[1] - edges[e].c).toBeCloseTo(t, 3);
    }
  });
  const want = rings.reduce((s, r, i) => s + (i === 0 ? Math.abs(area(r)) : -Math.abs(area(r))), 0);
  expect(sum).toBeCloseTo(want, 3);
  return sk!;
}

describe('straight skeleton', () => {
  it('a rectangle: a ridge along the middle at half the width', () => {
    const sk = check([[[0, 0], [24, 0], [24, 10], [0, 10]]]);
    expect(sk.tMax).toBeCloseTo(5, 6);
    expect(sk.faces.map((f) => f.length).sort()).toEqual([3, 3, 4, 4]);
  });
  it('a square: a pyramid', () => {
    const sk = check([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    expect(sk.tMax).toBeCloseTo(5, 6);
  });
  it('clockwise input, an L, a T, a [ and a plus', () => {
    check([[[0, 10], [10, 10], [10, 0], [0, 0]]]);
    check([[[-12, -5], [12, -5], [12, 15], [2, 15], [2, 5], [-12, 5]]]);
    check([[[0, 0], [30, 0], [30, 8], [19, 8], [19, 25], [11, 25], [11, 8], [0, 8]]]);
    check([[[0, 0], [30, 0], [30, 12], [12, 12], [12, 68], [30, 68], [30, 80], [0, 80]]]);
    check([[[10, 0], [20, 0], [20, 10], [30, 10], [30, 20], [20, 20], [20, 30], [10, 30], [10, 20], [0, 20], [0, 10], [10, 10]]]);
  });
  it('a courtyard (hole)', () => {
    const sk = check([[[0, 0], [40, 0], [40, 30], [0, 30]], [[10, 10], [30, 10], [30, 20], [10, 20]]]);
    expect(sk.tMax).toBeCloseTo(5, 6);
  });
  it('noisy and irregular outlines', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2e-4;
    const fp: XZ[] = [[0, 0], [30, 0], [30, 12], [12, 12], [12, 68], [30, 68], [30, 80], [0, 80]];
    for (let k = 0; k < 50; k++) check([fp.map(([x, z]) => [x + rnd(), z + rnd()] as XZ)]);
    const star: XZ[] = [];
    for (let i = 0; i < 14; i++) { const r = i % 2 ? 6 : 15, a = (i / 14) * 2 * Math.PI; star.push([r * Math.cos(a), r * Math.sin(a)]); }
    check([star]);
  });
});
