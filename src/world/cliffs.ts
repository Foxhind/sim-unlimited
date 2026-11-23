import { parseLength } from './building-mesher';
import type { LonLat, OsmArea, OsmLine } from './osm-types';

/**
 * Cliffs (natural=cliff: a line along the top edge, the low side on its right). The DEM smooths a
 * cliff into a slope a lattice cell or two wide; what gives it away from the air is the bare rock of
 * its face. Each cliff line becomes a band of bare rock on its low side, as wide as the cliff is high
 * (`height`, else BAND_M, kept to MIN_M..MAX_M): an ordinary natural=bare_rock area from there on (the
 * ground covers' fixed edges, the rock filter), its top edge on the mapped line.
 */
export const CLIFF = {
  BAND_M: 15,
  MIN_M: 6,
  MAX_M: 40,
  /** a bend's offset vertex goes no farther out than this many band widths (a sharp turn's mitre) */
  MITER_LIMIT: 2,
} as const;

/** internal tag (not OSM) on the rock band made from a cliff line */
export const CLIFF_TAG = 'sim:cliff';

export function cliffWidth(tags: Record<string, string>): number {
  const h = parseLength(tags.height);
  return Math.max(CLIFF.MIN_M, Math.min(CLIFF.MAX_M, h ?? CLIFF.BAND_M));
}

/** the rock band of each cliff line among `lines` */
export function cliffBands(lines: ReadonlyArray<OsmLine>): OsmArea[] {
  const out: OsmArea[] = [];
  for (const l of lines) {
    if (l.tags.natural !== 'cliff') continue;
    const rings = cliffBand(l.points, cliffWidth(l.tags));
    if (rings) out.push({ rings, tags: { natural: 'bare_rock', [CLIFF_TAG]: 'yes' } });
  }
  return out;
}

/**
 * The band right of a line `width` metres wide, as rings ([outer, ...holes]): the line, then its
 * offset to the right walked back, closed. A vertex of the offset sits on the bisector of its two
 * edges (a mitre, at most MITER_LIMIT widths out). A closed line's band lies between it and its
 * offset: the larger of the two the outer ring, the other the hole.
 */
export function cliffBand(points: ReadonlyArray<LonLat>, width: number): LonLat[][] | undefined {
  const pts: LonLat[] = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
  }
  const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed) pts.pop();
  if (pts.length < 2) return undefined;
  const [lon0, lat0] = pts[0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 111320;
  const xy = pts.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
  const n = xy.length;
  // the right-hand unit normal of edge i (east x, north y: right of (dx, dy) is (dy, −dx))
  const normal = (i: number): [number, number] | undefined => {
    const a = xy[i], b = xy[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    return len > 1e-6 ? [dy / len, -dx / len] : undefined;
  };
  const offset: LonLat[] = [];
  for (let i = 0; i < n; i++) {
    const before = i > 0 || closed ? normal((i - 1 + n) % n) : undefined;
    const after = i < n - 1 || closed ? normal(i) : undefined;
    const na = before ?? after!, nb = after ?? before!;
    let mx = na[0] + nb[0], my = na[1] + nb[1];
    const ml = Math.hypot(mx, my);
    // a hairpin: the two normals cancel; out along the one before
    if (ml < 1e-6) [mx, my] = na;
    else { mx /= ml; my /= ml; }
    const cos = mx * na[0] + my * na[1];
    const reach = Math.min(CLIFF.MITER_LIMIT, 1 / Math.max(cos, 1e-6)) * width;
    offset.push([lon0 + (xy[i][0] + mx * reach) / kx, lat0 + (xy[i][1] + my * reach) / ky]);
  }
  if (closed) {
    // a ring round a plateau or a pit: the band between the line and its offset, the larger the outer
    const area = (r: LonLat[]) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0));
    const line = [...pts, pts[0]], off = [...offset, offset[0]];
    return area(off) > area(line) ? [off, line] : [line, off];
  }
  return [[...pts, ...offset.reverse(), pts[0]]];
}
