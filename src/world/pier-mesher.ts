import earcut from 'earcut';
import { colourOf, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmArea, OsmLine } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Piers, pontoons, breakwaters and groynes (man_made=pier | breakwater | groyne), mapped as lines
 * (a width across them) or as areas: solid bodies over the water, drawn with the buildings.
 * A pier is a flat deck DECK_M over the sea (a hair over the ground where it runs ashore) on sides
 * down into the water; a breakwater or a groyne a mound of rock, its crest CREST_M over the sea,
 * its flanks sloping out to the full width under the water.
 */
export const PIER = {
  /** a pier's deck over the sea, and over the ground where it runs ashore */
  DECK_M: 1.2,
  ASHORE_M: 0.3,
  /** a pier's sides and a mound's flanks go this far under the water (and the ground) */
  SINK_M: 1.5,
  /** width without a `width` tag: a pontoon's */
  WIDTH_M: 2.5,
  CONCRETE: [196, 192, 184] as RGB,
  WOOD: [150, 118, 86] as RGB,
} as const;

export const MOUND = {
  /** a breakwater's and a groyne's crest over the sea */
  CREST_M: { breakwater: 2.5, groyne: 1.2 } as Record<string, number>,
  WIDTH_M: { breakwater: 10, groyne: 5 } as Record<string, number>,
  /** the crest's share of the full width */
  CREST_SHARE: 0.4,
  ROCK: [138, 134, 126] as RGB,
} as const;

export type PierKind = 'pier' | 'breakwater' | 'groyne';

export function pierKind(tags: Record<string, string>): PierKind | undefined {
  const m = tags.man_made;
  return m === 'pier' || m === 'breakwater' || m === 'groyne' ? m : undefined;
}

/** the width of a pier or a mound mapped as a line, metres */
export function pierWidth(tags: Record<string, string>): number {
  const kind = pierKind(tags);
  const w = parseLength(tags.width);
  if (w !== undefined && w > 0.5 && w < 200) return w;
  return kind === 'pier' || !kind ? PIER.WIDTH_M : MOUND.WIDTH_M[kind];
}

function pierColour(tags: Record<string, string>): number {
  if (pierKind(tags) !== 'pier') return colourOf(MOUND.ROCK);
  return colourOf(tags.surface === 'wood' ? PIER.WOOD : PIER.CONCRETE);
}

export interface PierMeshData {
  /** interleaved pos + normal (stride 6), as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
}

type V3 = [number, number, number];

/** the piers and mounds among a tile's lines and areas (clipped to the tile), in its ENU frame (x east, z south) */
export function buildPiers(tile: Tile, lines: ReadonlyArray<OsmLine>, areas: ReadonlyArray<OsmArea>, sampleHeight: HeightSampler): PierMeshData {
  const center = tileCenter(tile);
  const verts: number[] = [];
  const ramps: number[] = [];
  const toXZ = ([lon, lat]: LonLat): [number, number] => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const tri = (a: V3, b: V3, c: V3, ramp: number): void => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) return;
    n = n.map((v) => v / len);
    for (const p of [a, b, c]) verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    ramps.push(ramp, ramp, ramp);
  };
  /** a quad, its normal turned to face `out` (a direction in x, z; y up when omitted) */
  const quad = (a: V3, b: V3, c: V3, d: V3, ramp: number, out?: [number, number]): void => {
    const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    const nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const flip = out ? nx * out[0] + nz * out[1] < 0 : ny < 0;
    if (flip) { tri(a, c, b, ramp); tri(a, d, c, ramp); } else { tri(a, b, c, ramp); tri(a, c, d, ramp); }
  };
  const ground = (lon: number, lat: number): number => sampleHeight(lon, lat);
  /** the top of a pier's deck or a mound's crest over a point */
  const topAt = (kind: PierKind, h: number): number => {
    const over = kind === 'pier' ? PIER.DECK_M : MOUND.CREST_M[kind];
    return h > PIER.ASHORE_M ? h + (kind === 'pier' ? PIER.ASHORE_M : over) : Math.max(h, 0) + over;
  };

  for (const l of lines) {
    const kind = pierKind(l.tags);
    if (!kind || l.points.length < 2) continue;
    const ramp = pierColour(l.tags);
    const w = pierWidth(l.tags);
    const crest = kind === 'pier' ? w / 2 : (w * MOUND.CREST_SHARE) / 2;
    for (let i = 0; i + 1 < l.points.length; i++) {
      const pa = l.points[i], pb = l.points[i + 1];
      const [ax, az] = toXZ(pa), [bx, bz] = toXZ(pb);
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      // across: the segment's left (x, z frame) and right, crest and foot
      const sx = -(bz - az) / len, sz = (bx - ax) / len;
      const ha = ground(pa[0], pa[1]), hb = ground(pb[0], pb[1]);
      const ta = topAt(kind, ha), tb = topAt(kind, hb);
      const fa = Math.min(ha, 0) - PIER.SINK_M, fb = Math.min(hb, 0) - PIER.SINK_M;
      const foot = kind === 'pier' ? crest : w / 2;
      const P = (x: number, z: number, s: number, y: number): V3 => [x + sx * s, y, z + sz * s];
      // the deck or the crest
      quad(P(ax, az, crest, ta), P(bx, bz, crest, tb), P(bx, bz, -crest, tb), P(ax, az, -crest, ta), ramp);
      // the sides (a pier's straight down, a mound's flanks out to its foot)
      for (const side of [1, -1]) {
        quad(P(ax, az, side * crest, ta), P(bx, bz, side * crest, tb), P(bx, bz, side * foot, fb), P(ax, az, side * foot, fa), ramp, [sx * side, sz * side]);
      }
      // the ends of the line: closed
      for (const [x, z, t, f, dir] of [[ax, az, ta, fa, -1], [bx, bz, tb, fb, 1]] as const) {
        if ((dir === -1 && i !== 0) || (dir === 1 && i !== l.points.length - 2)) continue;
        const ox = ((bx - ax) / len) * dir, oz = ((bz - az) / len) * dir;
        quad(P(x, z, crest, t), P(x, z, -crest, t), P(x, z, -foot, f), P(x, z, foot, f), ramp, [ox, oz]);
      }
    }
  }

  for (const a of areas) {
    const kind = pierKind(a.tags);
    if (!kind) continue;
    const ramp = pierColour(a.tags);
    const rings = a.rings.map((r) => {
      const pts = r.slice();
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      return pts;
    }).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    // one deck level over the whole area: its highest point's
    let h = -Infinity;
    for (const [lon, lat] of rings[0]) h = Math.max(h, ground(lon, lat));
    const top = topAt(kind, h), foot = Math.min(h, 0) - PIER.SINK_M;
    const xz = rings.map((r) => r.map(toXZ));
    const flat: number[] = [], holes: number[] = [];
    const all: [number, number][] = [];
    xz.forEach((r, ri) => {
      if (ri > 0) holes.push(all.length);
      for (const p of r) { flat.push(p[0], p[1]); all.push(p); }
    });
    const idx = earcut(flat, holes.length ? holes : undefined, 2);
    for (let i = 0; i < idx.length; i += 3) {
      const p = all[idx[i]], q = all[idx[i + 1]], r = all[idx[i + 2]];
      quadOrTri([p[0], top, p[1]], [q[0], top, q[1]], [r[0], top, r[1]], ramp);
    }
    // walls round every ring, facing away from the area's inside (the centroid for the outer ring)
    let cx = 0, cz = 0;
    for (const p of xz[0]) { cx += p[0]; cz += p[1]; }
    cx /= xz[0].length; cz /= xz[0].length;
    xz.forEach((r, ri) => {
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        let ox = q[1] - p[1], oz = -(q[0] - p[0]);
        const away = ox * ((p[0] + q[0]) / 2 - cx) + oz * ((p[1] + q[1]) / 2 - cz);
        if ((away < 0) !== (ri > 0)) { ox = -ox; oz = -oz; }
        quad([p[0], top, p[1]], [q[0], top, q[1]], [q[0], foot, q[1]], [p[0], foot, p[1]], ramp, [ox, oz]);
      }
    });
  }

  /** a flat face facing up */
  function quadOrTri(a: V3, b: V3, c: V3, ramp: number): void {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny < 0) tri(a, c, b, ramp);
    else tri(a, b, c, ramp);
  }

  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps) };
}
