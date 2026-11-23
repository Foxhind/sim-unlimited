/**
 * Sports pitches (leisure=pitch): the playing surface by sport and surface, the oriented rectangle a
 * pitch outline fits in, and the white markings of the big-field sports as 1 px line segments.
 *
 * Markings are in the rectangle's own frame: s along its long side (-L/2..L/2), t across (-W/2..W/2),
 * metres. Courts of a fixed size (basketball, tennis, volleyball) are drawn at their real size in the
 * middle, shrunk only when the plot is smaller; field sports stretch to the plot.
 */

import { colour, RAMP, snowy } from '../engine/palette';

/** a pitch at least this big (m²) has floodlights on its corners and is lit at night */
export const PITCH_LIT_MIN_M2 = 300;

/**
 * Whether a pitch is floodlit: its whole outline (lon/lat ring, not a tile's share of it) is at
 * least PITCH_LIT_MIN_M2. Measured on a plane local to the ring (about its first point), so every
 * tile a pitch spans, and the mesh and the ground cover, reach the same verdict.
 */
export function isLitPitch(ring: [number, number][]): boolean {
  const pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return false;
  const [lon0, lat0] = pts[0], mPerDeg = (Math.PI / 180) * 6378137, k = Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const x0 = (pts[i][0] - lon0) * k * mPerDeg, y0 = (pts[i][1] - lat0) * mPerDeg;
    const x1 = (pts[(i + 1) % pts.length][0] - lon0) * k * mPerDeg, y1 = (pts[(i + 1) % pts.length][1] - lat0) * mPerDeg;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2 >= PITCH_LIT_MIN_M2;
}

/** a marking segment: s0, t0, s1, t1 (pitch frame, metres) */
export type Seg = [number, number, number, number];

export type PitchSport = 'soccer' | 'ice_hockey' | 'field_hockey' | 'basketball' | 'tennis' | 'volleyball' | 'baseball';

const SPORT_ALIASES: Record<string, PitchSport> = {
  soccer: 'soccer',
  football: 'soccer',
  futsal: 'soccer',
  ice_hockey: 'ice_hockey',
  hockey: 'field_hockey',
  field_hockey: 'field_hockey',
  basketball: 'basketball',
  tennis: 'tennis',
  volleyball: 'volleyball',
  beachvolleyball: 'volleyball',
  baseball: 'baseball',
  softball: 'baseball',
};

/** the marked sport of a pitch: the first of `sport=a;b` that has markings */
export function pitchSport(tags: Record<string, string>): PitchSport | undefined {
  for (const s of (tags.sport ?? '').split(';')) {
    const sport = SPORT_ALIASES[s.trim()];
    if (sport) return sport;
  }
  return undefined;
}

/** pitch surfaces: natural grass keeps the imagery (a filter); the rest are solid colours */
const SURFACE_RAMP: Record<string, number> = {
  artificial_turf: snowy(colour(70, 138, 78)),
  clay: snowy(colour(176, 98, 66)),
  tartan: snowy(colour(164, 76, 64)),
  rubber: snowy(colour(150, 72, 62)),
  sand: snowy(RAMP.SAND),
  asphalt: snowy(RAMP.ASPHALT),
  concrete: snowy(RAMP.CONCRETE),
  paved: snowy(RAMP.ASPHALT),
  acrylic: snowy(colour(74, 112, 140)),
  hard: snowy(colour(86, 116, 104)),
  dirt: snowy(colour(132, 112, 86)),
  ground: snowy(colour(132, 112, 86)),
  gravel: snowy(colour(150, 138, 114)),
};
/** a surface by sport where none is tagged (undefined: grass) */
const SPORT_SURFACE: Partial<Record<PitchSport, string>> = {
  basketball: 'asphalt',
  ice_hockey: 'asphalt',
  tennis: 'hard',
};

/** the face colour of a pitch's surface; undefined: natural grass (drawn with the grass filter) */
export function pitchSurface(tags: Record<string, string>): number | undefined {
  const sport = pitchSport(tags);
  const surface = tags.surface ?? (sport ? SPORT_SURFACE[sport] : undefined) ?? (tags.sport === 'beachvolleyball' ? 'sand' : undefined);
  if (!surface || surface === 'grass') return undefined;
  return SURFACE_RAMP[surface];
}

export interface PitchRect {
  /** centre, ENU x, z */
  cx: number;
  cz: number;
  /** unit vector along the long side (x, z) */
  ux: number;
  uz: number;
  /** long and short side, metres */
  length: number;
  width: number;
}

/** the smallest-area rectangle around a ring (x, z), with a side on one of its edges */
export function orientedRect(ring: [number, number][]): PitchRect | undefined {
  if (ring.length < 3) return undefined;
  let best: PitchRect | undefined;
  let bestArea = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const [x, z] of ring) {
      const s = x * ux + z * uz, t = -x * uz + z * ux;
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area >= bestArea) continue;
    bestArea = area;
    const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2;
    const cx = sm * ux - tm * uz, cz = sm * uz + tm * ux;
    best = s1 - s0 >= t1 - t0
      ? { cx, cz, ux, uz, length: s1 - s0, width: t1 - t0 }
      : { cx, cz, ux: -uz, uz: ux, length: t1 - t0, width: s1 - s0 };
  }
  return best;
}

/** a pitch's markings and the frames they are drawn in (pitchFrame) */
export interface PitchFrame {
  /** the oriented rectangle round the outline */
  rect: PitchRect;
  /** the rectangle's frame (s along its long side, t across, metres) to ENU x, z */
  toXZ(s: number, t: number): [number, number];
  /** the markings for its sport, in `frame`; undefined for no sport marked or a plot too small */
  segs?: Seg[];
  /** the markings' frame to ENU x, z: the rectangle's, or for baseball one from home plate towards second base */
  frame(s: number, t: number): [number, number];
}

/**
 * A pitch's markings and their frame from its outer ring (ENU x, z, without the closing point) and
 * tags; undefined when the ring has no rectangle. The OSM mesh draws the lines and the ground covers
 * lay their paint from this one derivation, so the two lie on each other.
 */
export function pitchFrame(ring: [number, number][], tags: Record<string, string>): PitchFrame | undefined {
  const r = orientedRect(ring);
  if (!r) return undefined;
  const vx = -r.uz, vz = r.ux;
  const toXZ = (s: number, t: number): [number, number] => [r.cx + r.ux * s + vx * t, r.cz + r.uz * s + vz * t];
  const sport = pitchSport(tags);
  let segs: Seg[] | undefined;
  let frame = toXZ;
  if (sport === 'baseball') {
    // home plate: the corner of the fan nearest a right angle; second base towards the middle
    let home = ring[0], bestDev = Infinity;
    const mx = ring.reduce((s, p) => s + p[0], 0) / ring.length, mz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
      const ax = a[0] - p[0], az = a[1] - p[1], bx = b[0] - p[0], bz = b[1] - p[1];
      const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
      const dev = Math.abs(cos);
      if (dev < bestDev) { bestDev = dev; home = p; }
    }
    const dl = Math.hypot(mx - home[0], mz - home[1]) || 1;
    const dx = (mx - home[0]) / dl, dz = (mz - home[1]) / dl;
    const reach = Math.max(...ring.map((p) => Math.hypot(p[0] - home[0], p[1] - home[1])));
    segs = baseballMarkings(reach * 0.95);
    frame = (s, t) => [home[0] + dx * s - dz * t, home[1] + dz * s + dx * t];
  } else if (sport) {
    segs = pitchMarkings(sport, r.length, r.width);
  }
  return { rect: r, toXZ, segs, frame };
}

const ARC_STEP_RAD = Math.PI / 16;

/** an arc round (cs, ct) from angle a0 to a1 (radians; 0 is +s, π/2 is +t) */
function arc(out: Seg[], cs: number, ct: number, r: number, a0: number, a1: number): void {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / ARC_STEP_RAD));
  for (let i = 0; i < n; i++) {
    const p = a0 + ((a1 - a0) * i) / n, q = a0 + ((a1 - a0) * (i + 1)) / n;
    out.push([cs + r * Math.cos(p), ct + r * Math.sin(p), cs + r * Math.cos(q), ct + r * Math.sin(q)]);
  }
}

function rect(out: Seg[], s0: number, t0: number, s1: number, t1: number): void {
  out.push([s0, t0, s1, t0], [s1, t0, s1, t1], [s1, t1, s0, t1], [s0, t1, s0, t0]);
}

/** a rectangle with rounded corners of radius r */
function roundedRect(out: Seg[], hl: number, hw: number, r: number): void {
  out.push([-hl + r, -hw, hl - r, -hw], [hl, -hw + r, hl, hw - r], [hl - r, hw, -hl + r, hw], [-hl, hw - r, -hl, -hw + r]);
  arc(out, hl - r, -hw + r, r, -Math.PI / 2, 0);
  arc(out, hl - r, hw - r, r, 0, Math.PI / 2);
  arc(out, -hl + r, hw - r, r, Math.PI / 2, Math.PI);
  arc(out, -hl + r, -hw + r, r, Math.PI, 1.5 * Math.PI);
}

/**
 * The markings of a rectangular pitch L × W (metres) for its sport, in the pitch frame; baseball,
 * whose field is a fan from home plate, is baseballMarkings. Undefined for a plot too small to mark.
 */
export function pitchMarkings(sport: PitchSport, length: number, width: number): Seg[] | undefined {
  if (length < 6 || width < 4) return undefined;
  const out: Seg[] = [];
  const hl = length / 2, hw = width / 2;
  switch (sport) {
    case 'soccer': {
      // the boxes and circle at their real size on a full pitch, shrunk on a small one
      const k = Math.min(1, width / 64, length / 100);
      rect(out, -hl, -hw, hl, hw);
      out.push([0, -hw, 0, hw]);
      arc(out, 0, 0, 9.15 * k, 0, 2 * Math.PI);
      for (const e of [-1, 1]) {
        const end = e * hl;
        const box = Math.min(20.16 * k, hw - 0.5), goal = Math.min(9.16 * k, box - 0.5);
        out.push([end, -box, end - e * 16.5 * k, -box], [end - e * 16.5 * k, -box, end - e * 16.5 * k, box], [end - e * 16.5 * k, box, end, box]);
        out.push([end, -goal, end - e * 5.5 * k, -goal], [end - e * 5.5 * k, -goal, end - e * 5.5 * k, goal], [end - e * 5.5 * k, goal, end, goal]);
        // the penalty arc: the part of the 9.15 m circle round the penalty spot outside the box
        const a = Math.acos(5.5 / 9.15);
        const spot = end - e * 11 * k;
        if (e > 0) arc(out, spot, 0, 9.15 * k, Math.PI - a, Math.PI + a);
        else arc(out, spot, 0, 9.15 * k, -a, a);
      }
      return out;
    }
    case 'ice_hockey': {
      // the rink is the plot: a 60 × 30 m rink stretched to it, corners rounded
      const ks = length / 60, kt = width / 30;
      roundedRect(out, hl, hw, Math.min(8.5 * Math.min(ks, kt), hw * 0.6));
      out.push([0, -hw, 0, hw]);
      for (const e of [-1, 1]) {
        const blue = e * (hl - 22.86 * ks), goal = e * (hl - 4 * ks);
        out.push([blue, -hw, blue, hw]);
        // the goal line between the curves of the corners
        const r = Math.min(8.5 * Math.min(ks, kt), hw * 0.6);
        const inset = Math.max(0, r - Math.sqrt(Math.max(0, r * r - (r - 4 * ks) ** 2)));
        out.push([goal, -hw + inset, goal, hw - inset]);
      }
      arc(out, 0, 0, 4.5 * Math.min(ks, kt), 0, 2 * Math.PI);
      return out;
    }
    case 'field_hockey': {
      const ks = length / 91.4, kt = width / 55;
      rect(out, -hl, -hw, hl, hw);
      out.push([0, -hw, 0, hw]);
      for (const e of [-1, 1]) {
        const q = e * (hl - 22.9 * ks);
        out.push([q, -hw, q, hw]);
        // the shooting circle: quarter circles of 14.63 m round the posts, joined by a straight
        const r = 14.63 * Math.min(ks, kt), post = 1.83 * kt;
        const sign = e > 0 ? Math.PI : 0;
        arc(out, e * hl, post, r, sign + (e > 0 ? -Math.PI / 2 : 0), sign + (e > 0 ? 0 : Math.PI / 2));
        arc(out, e * hl, -post, r, sign + (e > 0 ? 0 : -Math.PI / 2), sign + (e > 0 ? Math.PI / 2 : 0));
        out.push([e * (hl - r), -post, e * (hl - r), post]);
      }
      return out;
    }
    case 'basketball': {
      const k = Math.min(1, length / 28, width / 15);
      const cl = 14 * k, cw = 7.5 * k;
      rect(out, -cl, -cw, cl, cw);
      out.push([0, -cw, 0, cw]);
      arc(out, 0, 0, 1.8 * k, 0, 2 * Math.PI);
      for (const e of [-1, 1]) {
        const end = e * cl;
        const ft = end - e * 5.8 * k;
        // the key and its free-throw circle
        out.push([end, -2.45 * k, ft, -2.45 * k], [ft, -2.45 * k, ft, 2.45 * k], [ft, 2.45 * k, end, 2.45 * k]);
        arc(out, ft, 0, 1.8 * k, 0, 2 * Math.PI);
        // the three-point line: straight from the end line, then an arc of 6.75 m round the basket
        const basket = end - e * 1.575 * k, r = 6.75 * k, side = 6.6 * k;
        const a = Math.asin(side / r);
        const sJoin = basket - e * r * Math.cos(a);
        out.push([end, -side, sJoin, -side], [end, side, sJoin, side]);
        if (e > 0) arc(out, basket, 0, r, Math.PI - a, Math.PI + a);
        else arc(out, basket, 0, r, -a, a);
      }
      return out;
    }
    case 'tennis': {
      const k = Math.min(1, length / 23.77, width / 10.97);
      const cl = 11.885 * k, cw = 5.485 * k, single = 4.115 * k, service = 6.4 * k;
      rect(out, -cl, -cw, cl, cw);
      out.push([-cl, -single, cl, -single], [-cl, single, cl, single]);
      out.push([0, -cw, 0, cw]);
      out.push([-service, -single, -service, single], [service, -single, service, single], [-service, 0, service, 0]);
      return out;
    }
    case 'volleyball': {
      const k = Math.min(1, length / 18, width / 9);
      const cl = 9 * k, cw = 4.5 * k;
      rect(out, -cl, -cw, cl, cw);
      out.push([0, -cw, 0, cw], [-3 * k, -cw, -3 * k, cw], [3 * k, -cw, 3 * k, cw]);
      return out;
    }
    case 'baseball':
      return undefined;
  }
}

/**
 * Baseball: the diamond from home plate and the foul lines, in a frame with home at the origin and
 * +s towards second base; `reach` is how far the field runs from home (the foul lines' length).
 */
export function baseballMarkings(reach: number): Seg[] {
  const base = Math.min(27.43, reach / 3);
  const d = base / Math.SQRT2;
  const first: [number, number] = [d, -d], second: [number, number] = [2 * d, 0], third: [number, number] = [d, d];
  const out: Seg[] = [
    [0, 0, ...first], [...first, ...second], [...second, ...third], [...third, 0, 0],
  ];
  const f = reach / Math.SQRT2;
  out.push([0, 0, f, -f], [0, 0, f, f]);
  // the edge of the infield grass: an arc of 29 m round the pitcher's mound
  const mound = Math.min(18.44, base * 0.67);
  arc(out, mound, 0, Math.min(29, base * 1.06), -Math.PI / 4, Math.PI / 4);
  return out;
}
