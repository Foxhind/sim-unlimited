/**
 * The order of the ribbons that lie on the ground's own faces (with the cover, the ways the TIN's
 * budget dropped: SurfaceTin.loose). They are not lifted over the ground nor over each other: each
 * is coplanar with the face under it, and a depth level per vertex (WORLD_VS aDepthLevel) pulls it
 * toward the eye at draw time, a level a step more. The ground is level 0; a ribbon is level 1, or
 * one over the highest level of a ribbon it overlaps with a lower key (the height that ordered them
 * before: a way's shoulder under its carriageway, the right-of-way strip under the ballast, the
 * higher priority, then layer, then tie over the lower). Ribbons that do not overlap share a level,
 * so the levels stay few (each costs a step of pull).
 */
import type { P2 } from './ribbon-shapes';

/** a ribbon: its key (what lies higher), its centre line and how far from it the ribbon reaches (lattice units) */
export interface LevelItem {
  key: number;
  c: P2[];
  reach: number;
}

/** distance between segments ab and cd */
function segDistance(a: P2, b: P2, c: P2, d: P2): number {
  const cross = (o: P2, p: P2, q: P2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const toSeg = (p: P2, s: P2, e: P2): number => {
    const dx = e[0] - s[0], dy = e[1] - s[1], l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - s[0] - dx * t, p[1] - s[1] - dy * t);
  };
  return Math.min(toSeg(a, c, d), toSeg(b, c, d), toSeg(c, a, b), toSeg(d, a, b));
}

/**
 * Each item's depth level (1 and up): items taken by key, each one over the highest level among the
 * items of a lower key it overlaps (a centre line within both reaches of its own). `cell`: the size
 * of the grid the candidates are found in, lattice units.
 */
export function depthLevels(items: readonly LevelItem[], cell = 1): number[] {
  // the centre lines in pieces no longer than a cell, each in the cells its reach touches
  const pieces: { item: number; a: P2; b: P2 }[] = [];
  const grid = new Map<string, number[]>();
  items.forEach((it, i) => {
    const c = it.c.length === 1 ? [it.c[0], it.c[0]] : it.c;
    for (let k = 0; k + 1 < c.length; k++) {
      const a = c[k], b = c[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / cell));
      for (let s = 0; s < n; s++) {
        const p: P2 = [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n];
        const q: P2 = [a[0] + ((b[0] - a[0]) * (s + 1)) / n, a[1] + ((b[1] - a[1]) * (s + 1)) / n];
        const pi = pieces.push({ item: i, a: p, b: q }) - 1;
        const x0 = Math.floor((Math.min(p[0], q[0]) - it.reach) / cell), x1 = Math.floor((Math.max(p[0], q[0]) + it.reach) / cell);
        const y0 = Math.floor((Math.min(p[1], q[1]) - it.reach) / cell), y1 = Math.floor((Math.max(p[1], q[1]) + it.reach) / cell);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const key = `${x},${y}`;
            const list = grid.get(key);
            if (list) list.push(pi);
            else grid.set(key, [pi]);
          }
        }
      }
    }
  });
  // the pairs of items that overlap: a piece of each within both reaches of the other
  const near: number[][] = items.map(() => []);
  const found = new Set<number>();
  for (const list of grid.values()) {
    for (let u = 0; u < list.length; u++) {
      for (let v = u + 1; v < list.length; v++) {
        const p = pieces[list[u]], q = pieces[list[v]];
        if (p.item === q.item) continue;
        const lo = Math.min(p.item, q.item), hi = Math.max(p.item, q.item), pair = lo * items.length + hi;
        if (found.has(pair)) continue;
        if (segDistance(p.a, p.b, q.a, q.b) >= items[lo].reach + items[hi].reach) continue;
        found.add(pair);
        near[lo].push(hi);
        near[hi].push(lo);
      }
    }
  }
  const order = items.map((_, i) => i).sort((a, b) => items[a].key - items[b].key || a - b);
  const level = new Array<number>(items.length).fill(0);
  for (const i of order) {
    let l = 1;
    for (const j of near[i]) if (items[j].key < items[i].key) l = Math.max(l, level[j] + 1);
    level[i] = l;
  }
  return level;
}
