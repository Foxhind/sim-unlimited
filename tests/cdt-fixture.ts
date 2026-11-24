/** 8000 random points in 64 x 64 and 2000 fixed edges: short non-crossing segments between disjoint pairs */
export function scatterWithEdges(): { pts: { x: number; y: number }[]; cons: [number, number][] } {
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pts = Array.from({ length: 8000 }, () => ({ x: r() * 64, y: r() * 64 }));
  const sorted = pts.map((p, i) => ({ p, i })).sort((a, b) => a.p.x - b.p.x || a.p.y - b.p.y);
  const cons: [number, number][] = [];
  for (let k = 0; k + 1 < sorted.length && cons.length < 2000; k += 4) cons.push([sorted[k].i, sorted[k + 1].i]);
  return { pts, cons };
}
