/**
 * Simple 3D Buildings roof shapes (https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings).
 *
 * A roof is a height field over the footprint, in the building's frame: u along the ridge (the long
 * side of the minimum-area bounding rectangle, unless roof:direction / roof:orientation say
 * otherwise), v across it. Every shape but the radial ones (dome, onion) is piecewise planar: a min/max
 * combination of a few planes. The mesher cuts the footprint along the lines where two of those planes
 * meet and are both on the surface (the creases), so each face comes out exactly flat, and raises the
 * walls up to the same field, so gable ends close by themselves.
 */

export type XZ = [number, number];
/** a world plane y = a·x + b·z + c (height above the eaves) */
export type Plane = [number, number, number];

export interface RoofFrame {
  /** centre of the frame's bounding rectangle */
  origin: XZ;
  /** unit vector along the ridge, and across it */
  u: XZ;
  v: XZ;
  /** half extents of the footprint along u and v */
  halfU: number;
  halfV: number;
}

export interface PlanarRoof {
  kind: 'planar';
  planes: Plane[];
  /** height above the eaves at a point; every value is one of `planes` (or 0) */
  field: (p: XZ) => number;
}

export interface RadialRoof {
  kind: 'radial';
  /** [ring scale about the centre, height fraction] from the eaves (1, 0) to the apex (0, 1) */
  profile: [number, number][];
}

export interface FanRoof {
  kind: 'fan';
}

export type RoofModel = PlanarRoof | RadialRoof | FanRoof | { kind: 'flat' };

/** roof:shape values drawn with a ridge (frame along the long side) */
const RIDGED = new Set([
  'gabled', 'half-hipped', 'hipped', 'side_hipped', 'side_half-hipped', 'gambrel', 'mansard', 'round',
  'saltbox', 'gabled_height_moved', 'double_saltbox', 'quadruple_saltbox', 'hipped-and-gabled',
  'bellcast_gable', 'crosspitched', 'sawtooth', 'butterfly',
]);
const RADIAL = new Set(['dome', 'onion']);
const FAN = new Set(['pyramidal', 'cone']);
const ALIASES: Record<string, string> = {
  pitched: 'gabled', gable: 'gabled', hip: 'hipped', 'half_hipped': 'half-hipped', 'side-hipped': 'side_hipped',
  pyramid: 'pyramidal', domed: 'dome', 'gabled-height-moved': 'gabled_height_moved', 'cross_gabled': 'crosspitched',
  // vertical gables inside the footprint cannot be a height field: the closest shape
  'hipped-and-gabled': 'half-hipped', 'double_saltbox': 'saltbox', 'quadruple_saltbox': 'hipped',
};

/** the roof:shape the mesher draws: aliases resolved, unknown values and `many` flat (S3DB) */
export function roofShape(tags: Record<string, string>): string {
  const raw = (tags['roof:shape'] ?? 'flat').trim().toLowerCase();
  const s = ALIASES[raw] ?? raw;
  if (s === 'skillion' || RIDGED.has(s) || RADIAL.has(s) || FAN.has(s)) return s;
  return 'flat';
}

/** 16-point compass and degrees (0 = north, clockwise) → a unit vector in the mesh frame (x east, z south) */
const COMPASS = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse', 's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];
export function roofDirection(tags: Record<string, string>): XZ | undefined {
  const d = tags['roof:direction']?.trim().toLowerCase();
  if (!d) return undefined;
  let deg = Number(d);
  if (!Number.isFinite(deg)) {
    const k = COMPASS.indexOf(d.replace(/[^a-z]/g, '').replace(/^north$/, 'n').replace(/^south$/, 's').replace(/^east$/, 'e').replace(/^west$/, 'w'));
    if (k < 0) return undefined;
    deg = k * 22.5;
  }
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

function convexHull(pts: XZ[]): XZ[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XZ[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** the footprint's extents in an axis frame: origin at the centre of the bounding rectangle */
function frameFor(outer: XZ[], u: XZ): RoofFrame {
  const v: XZ = [-u[1], u[0]];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of outer) {
    const a = p[0] * u[0] + p[1] * u[1], b = p[0] * v[0] + p[1] * v[1];
    u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { origin: [cu * u[0] + cv * v[0], cu * u[1] + cv * v[1]], u, v, halfU: (u1 - u0) / 2 || 0.5, halfV: (v1 - v0) / 2 || 0.5 };
}

/**
 * The ridge frame of a footprint: along the long side of its minimum-area bounding rectangle;
 * roof:orientation=across turns it; roof:direction (the way the main slope faces) sets v to it.
 */
export function roofFrame(outer: XZ[], tags: Record<string, string>): RoofFrame {
  const dir = roofDirection(tags);
  if (dir) return frameFor(outer, [dir[1], -dir[0]]);
  const hull = convexHull(outer);
  let best: RoofFrame | undefined;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    let f = frameFor(outer, [(b[0] - a[0]) / len, (b[1] - a[1]) / len]);
    if (f.halfV > f.halfU) f = frameFor(outer, [-f.v[0], -f.v[1]]);
    if (!best || f.halfU * f.halfV < best.halfU * best.halfV - 1e-9) best = f;
  }
  best ??= frameFor(outer, [1, 0]);
  if (tags['roof:orientation']?.trim().toLowerCase() === 'across') best = frameFor(outer, best.v);
  return best;
}

/** horizontal run a roof:angle rises over: across the whole footprint for a skillion, half of it otherwise */
export function roofRun(shape: string, frame: RoofFrame): number {
  return shape === 'skillion' ? frame.halfV * 2 : frame.halfV;
}

/** plane in the frame: y = pu·u + pv·v + p0, as a world plane */
function local(f: RoofFrame, pu: number, pv: number, p0: number): Plane {
  const a = pu * f.u[0] + pv * f.v[0];
  const b = pu * f.u[1] + pv * f.v[1];
  return [a, b, p0 - a * f.origin[0] - b * f.origin[1]];
}

export const evalPlane = (pl: Plane, p: XZ): number => pl[0] * p[0] + pl[1] * p[1] + pl[2];

const min = (ps: Plane[]) => (p: XZ) => Math.min(...ps.map((pl) => evalPlane(pl, p)));
const max = (ps: Plane[]) => (p: XZ) => Math.max(...ps.map((pl) => evalPlane(pl, p)));

/**
 * The roof of `shape` and height `H` over the footprint. `outer` is the outer ring (for the skillion
 * extent); `firstEdgeOut` is the outward normal of the first edge of the OSM way, the low side of a
 * skillion without roof:direction (OSM-4D roof table).
 */
export function roofModel(shape: string, frame: RoofFrame, H: number, outer: XZ[], tags: Record<string, string>, firstEdgeOut?: XZ): RoofModel {
  if (shape === 'flat' || H < 0.01) return { kind: 'flat' };
  if (FAN.has(shape)) return { kind: 'fan' };
  if (shape === 'dome') {
    const n = 6;
    const profile: [number, number][] = [];
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * (Math.PI / 2);
      profile.push([Math.cos(t), Math.sin(t)]);
    }
    profile[n] = [0, 1];
    return { kind: 'radial', profile };
  }
  if (shape === 'onion') {
    return { kind: 'radial', profile: [[1, 0], [1.18, 0.12], [1.22, 0.26], [1.05, 0.42], [0.7, 0.57], [0.36, 0.71], [0.14, 0.84], [0.04, 0.94], [0, 1]] };
  }

  const W = frame.halfV, L = frame.halfU, s = H / W;
  const z = local(frame, 0, 0, 0);
  const done = (planes: Plane[], field: (p: XZ) => number): PlanarRoof => ({
    kind: 'planar',
    planes: [...planes, z],
    field: (p) => Math.max(0, field(p)),
  });

  if (shape === 'skillion') {
    const d = roofDirection(tags) ?? firstEdgeOut ?? frame.v;
    let lo = Infinity, hi = -Infinity;
    for (const p of outer) {
      const t = p[0] * d[0] + p[1] * d[1];
      lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    const k = H / Math.max(hi - lo, 1e-6);
    // low (0) on the side the roof faces, H at the back
    const pl: Plane = [-k * d[0], -k * d[1], k * hi];
    return done([pl], (p) => evalPlane(pl, p));
  }

  const sides = [local(frame, 0, -s, H), local(frame, 0, s, H)];
  // an end plane rising inward from height k·H at u = ±L with the slope of the sides
  const end = (sign: 1 | -1, k: number) => local(frame, -sign * s, 0, k * H + s * L);
  switch (shape) {
    case 'gabled': return done(sides, min(sides));
    case 'hipped': { const ps = [...sides, end(1, 0), end(-1, 0)]; return done(ps, min(ps)); }
    case 'half-hipped': { const ps = [...sides, end(1, 0.5), end(-1, 0.5)]; return done(ps, min(ps)); }
    case 'side_hipped': { const ps = [...sides, end(1, 0)]; return done(ps, min(ps)); }
    case 'side_half-hipped': { const ps = [...sides, end(1, 0.5)]; return done(ps, min(ps)); }
    case 'saltbox':
    case 'gabled_height_moved': {
      // ridge moved toward +v; the long slope faces roof:direction (v = direction)
      const vr = roofDirection(tags) ? -0.4 * W : 0.4 * W;
      const ps = [local(frame, 0, -H / (W - vr), (H * W) / (W - vr)), local(frame, 0, H / (vr + W), (H * W) / (vr + W))];
      return done(ps, min(ps));
    }
    case 'gambrel':
    case 'mansard': {
      // steep lower slope over the outer quarter up to 0.6 H, shallow upper slope to the ridge
      const lo = (0.6 * H) / (0.25 * W), up = (0.4 * H) / (0.75 * W);
      const ps = [
        local(frame, 0, -lo, lo * W), local(frame, 0, lo, lo * W),
        local(frame, 0, -up, 0.6 * H + up * 0.75 * W), local(frame, 0, up, 0.6 * H + up * 0.75 * W),
      ];
      if (shape === 'mansard') {
        ps.push(
          local(frame, -lo, 0, lo * L), local(frame, lo, 0, lo * L),
          local(frame, -up, 0, 0.6 * H + up * (L - 0.25 * W)), local(frame, up, 0, 0.6 * H + up * (L - 0.25 * W)),
        );
      }
      return done(ps, min(ps));
    }
    case 'round': {
      // a barrel vault: chords of the half ellipse across the building
      const n = 8, ps: Plane[] = [];
      const y = (v: number) => H * Math.sqrt(Math.max(0, 1 - (v / W) ** 2));
      for (let k = 0; k < n; k++) {
        const v0 = -W + (2 * W * k) / n, v1 = -W + (2 * W * (k + 1)) / n;
        const slope = (y(v1) - y(v0)) / (v1 - v0);
        ps.push(local(frame, 0, slope, y(v0) - slope * v0));
      }
      return done(ps, min(ps));
    }
    case 'bellcast_gable': {
      // main slopes reach the eaves line at 0.85 W; flatter flares carry them out to the walls
      const m = H / (0.85 * W), f = (0.5 * H) / W;
      const mainP = local(frame, 0, -m, H), mainN = local(frame, 0, m, H);
      const flareP = local(frame, 0, -f, f * W), flareN = local(frame, 0, f, f * W);
      return done([mainP, mainN, flareP, flareN], (p) =>
        Math.min(Math.max(evalPlane(mainP, p), evalPlane(flareP, p)), Math.max(evalPlane(mainN, p), evalPlane(flareN, p))));
    }
    case 'crosspitched': {
      const su = H / L;
      const across = sides, along = [local(frame, -su, 0, H), local(frame, su, 0, H)];
      return done([...across, ...along], (p) => Math.max(min(across)(p), min(along)(p)));
    }
    case 'butterfly': {
      const ps = [local(frame, 0, s, 0), local(frame, 0, -s, 0)];
      return done(ps, max(ps));
    }
    case 'sawtooth': {
      // teeth across the ridge, about 8 m each: a long glazed rise and a short steep drop
      const n = Math.max(2, Math.round((2 * W) / 8));
      const w = (2 * W) / n, rise = 0.85 * w;
      const teeth: Plane[][] = [];
      for (let k = 0; k < n; k++) {
        const v0 = -W + k * w;
        teeth.push([
          local(frame, 0, H / rise, -(H / rise) * v0),
          local(frame, 0, -H / (w - rise), (H / (w - rise)) * (v0 + w)),
        ]);
      }
      return done(teeth.flat(), (p) => Math.max(...teeth.map(min).map((f) => f(p))));
    }
  }
  return { kind: 'flat' };
}

/** the creases of a planar roof inside a box: lines a·x + b·z + c = 0 where two of its planes meet on the surface */
export function roofCreases(roof: PlanarRoof, box: { minX: number; maxX: number; minZ: number; maxZ: number }): Plane[] {
  const out: Plane[] = [];
  const { planes, field } = roof;
  const eps = 1e-6 * Math.max(1, Math.abs(field([(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2])));
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const a = planes[i][0] - planes[j][0], b = planes[i][1] - planes[j][1], c = planes[i][2] - planes[j][2];
      const n = Math.hypot(a, b);
      if (n < 1e-12) continue;
      const line: Plane = [a / n, b / n, c / n];
      const seg = clipLineToBox(line, box);
      if (!seg) continue;
      let on = false;
      for (let k = 0; k <= 32 && !on; k++) {
        const t = k / 32;
        const p: XZ = [seg[0][0] + (seg[1][0] - seg[0][0]) * t, seg[0][1] + (seg[1][1] - seg[0][1]) * t];
        const f = field(p);
        on = Math.abs(f - Math.max(0, evalPlane(planes[i], p))) < eps + 1e-6 && Math.abs(f - Math.max(0, evalPlane(planes[j], p))) < eps + 1e-6;
      }
      if (on) out.push(line);
    }
  }
  return out;
}

function clipLineToBox(line: Plane, box: { minX: number; maxX: number; minZ: number; maxZ: number }): [XZ, XZ] | undefined {
  const [a, b, c] = line;
  const pts: XZ[] = [];
  if (Math.abs(b) > 1e-12) {
    for (const x of [box.minX, box.maxX]) {
      const zz = -(a * x + c) / b;
      if (zz >= box.minZ - 1e-9 && zz <= box.maxZ + 1e-9) pts.push([x, zz]);
    }
  }
  if (Math.abs(a) > 1e-12) {
    for (const zz of [box.minZ, box.maxZ]) {
      const x = -(b * zz + c) / a;
      if (x >= box.minX - 1e-9 && x <= box.maxX + 1e-9) pts.push([x, zz]);
    }
  }
  if (pts.length < 2) return undefined;
  let best: [XZ, XZ] = [pts[0], pts[1]], bestD = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d > bestD) { bestD = d; best = [pts[i], pts[j]]; }
    }
  }
  return best;
}

/** distances (m) below which a point is on a crease and two points are one (lat/lon → metres leaves ~0.1 mm of noise) */
const ON_LINE = 5e-4;
const SAME_POINT = 1e-3;

/** a convex polygon cut by a line into the parts on either side (slivers and repeated points dropped) */
export function splitConvex(poly: XZ[], line: Plane): XZ[][] {
  const side = (p: XZ) => line[0] * p[0] + line[1] * p[1] + line[2];
  const ds = poly.map(side);
  if (ds.every((d) => d >= -ON_LINE) || ds.every((d) => d <= ON_LINE)) return [poly];
  const pos: XZ[] = [], neg: XZ[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = ds[i], sq = ds[(i + 1) % poly.length];
    if (sp >= -ON_LINE) pos.push(p);
    if (sp <= ON_LINE) neg.push(p);
    if ((sp > ON_LINE && sq < -ON_LINE) || (sp < -ON_LINE && sq > ON_LINE)) {
      const t = sp / (sp - sq);
      const x: XZ = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      pos.push(x);
      neg.push(x);
    }
  }
  return [pos, neg].map(clean).filter((r) => r.length >= 3 && polyArea(r) > 1e-6);
}

function clean(r: XZ[]): XZ[] {
  const out: XZ[] = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > SAME_POINT) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= SAME_POINT) out.pop();
  return out;
}

function polyArea(r: XZ[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s / 2);
}

/** where a segment p→q crosses the creases, as sorted parameters strictly inside (0, 1) */
export function crossings(p: XZ, q: XZ, lines: Plane[]): number[] {
  const ts: number[] = [];
  for (const l of lines) {
    const sp = l[0] * p[0] + l[1] * p[1] + l[2], sq = l[0] * q[0] + l[1] * q[1] + l[2];
    if ((sp > ON_LINE && sq < -ON_LINE) || (sp < -ON_LINE && sq > ON_LINE)) ts.push(sp / (sp - sq));
  }
  // creases through one point (a hip meeting the ridge) give one break, not two
  ts.sort((a, b) => a - b);
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  return ts.filter((t, i) => t * len > SAME_POINT && (1 - t) * len > SAME_POINT && (i === 0 || (t - ts[i - 1]) * len > SAME_POINT));
}
