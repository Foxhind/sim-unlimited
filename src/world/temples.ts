/**
 * Places of worship. A church, mosque or temple mapped in detail (TEMPLE.DETAILED_PARTS building:part
 * areas or more, or a roof:shape on the outline or a part) is drawn as mapped, with only its symbols
 * added: a cross or a crescent on its domes and spires (FINIAL_TAG). One mapped as a bare outline is
 * built here as S3DB parts in its tradition's shape (templeParts): an Orthodox church with a drum and
 * onion dome (five on a large one) and a bell tower under a tent roof at the west end, a Western one
 * under a steep gable with a west tower and spire, a mosque under a dome on a drum (the minaret is
 * minaret-mesher's), a synagogue under a hipped roof, a Buddhist temple under two tiers of hipped roofs,
 * a Hindu one with its tower (shikhara) over the east end, a gurdwara with a dome.
 */

import earcut from 'earcut';
import { archRegion } from './arch-styles';
import { roofFrame, type XZ } from './roof-shapes';
import { STYLE_AT_TAG, STYLE_TYPE_TAG, type LonLat, type OsmBuilding } from './osm-types';

export type Faith = 'orthodox' | 'western' | 'muslim' | 'jewish' | 'buddhist' | 'hindu' | 'sikh';
export type FinialKind = 'cross' | 'orthodox' | 'crescent';

/** the symbol on top of a dome, a spire or a gable (building-mesher finial) */
export const FINIAL_TAG = 'sim:finial';
/** a generated part stands on the ground of the whole temple: its outline, "lon,lat lon,lat ..." (building-mesher) */
export const FOOTING_TAG = 'sim:footing';

export const TEMPLE = {
  /** this many building:part areas in an outline: mapped in detail, drawn as it is */
  DETAILED_PARTS: 3,
  /** a chapel: no tower, one small dome */
  CHAPEL_MAX_M2: 80,
  /** five domes (Orthodox), two west towers (Western, and wide enough), corner domes (mosque) */
  LARGE_MIN_M2: 700,
  /** the walls of the main body: BASE_M + PER_M × √area, kept to MIN_M..MAX_M */
  WALL: { BASE_M: 3, PER_M: 0.25, MIN_M: 4, MAX_M: 16 },
  /** an Orthodox drum: its radius a share of the body's width, its walls this many radii above the roof's ridge */
  DRUM: { R_SHARE: 0.22, MIN_R: 1.2, MAX_R: 6, CHAPEL_R_SHARE: 0.3, CHAPEL_MAX_R: 2, RISE: 1.3, CORNER_R: 0.55 },
  /** a west tower: its side a share of the body's width; its walls this many sides above the ridge; its spire or tent */
  TOWER: { SIDE_SHARE: 0.45, MIN_M: 3, MAX_M: 9, RISE: 1.4, SPIRE: 2.6, TENT: 1.8, MIN_RISE_M: 4 },
  /** a Western body's roof pitch, degrees */
  WESTERN_PITCH_DEG: 45,
  /** a mosque's dome: radius a share of its narrow side; the drum this share of the radius high */
  DOME: { R_SHARE: 0.42, MIN_R: 1.5, MAX_R: 16, DRUM: 0.25, CORNER_R: 0.3 },
  /** a Buddhist temple's upper tier: this share of the body across, above the body's roof this share of its wall */
  TIER: { SHARE: 0.6, RISE: 0.45, MIN_M2: 80 },
  /** a Hindu temple's shikhara: its side a share of the width, its tower roof this many sides high */
  SHIKHARA: { SIDE_SHARE: 0.5, MIN_M: 3, MAX_M: 12, ROOF: 2.2 },
  /** a polygon this many sides is round enough for a dome */
  ROUND_SIDES: 12,
} as const;

/** roof colours of the generated temples, by faith (one drawn by the building's seed) */
const ORTHODOX_DOMES = ['#c9a13b', '#c9a13b', '#2f4f8f', '#3f6e4e', '#8a9096', '#8a9096', '#2b2f36'];
const ORTHODOX_ROOFS = ['#4a6b4f', '#5a5f66', '#3f5f45', '#6b4a3a'];
const WESTERN_SPIRES = ['#4a4d52', '#4a4d52', '#5d9b84', '#3a3c40'];
const WESTERN_ROOFS = ['#8a4a35', '#4d5056', '#7a3f2c', '#585c63'];
const MOSQUE_DOMES = ['#8c9298', '#8c9298', '#8c9298', '#2e7d5b', '#c9a13b', '#3a8fa0'];
const BUDDHIST_ROOFS = ['#8b3a2b', '#c46a2a', '#3d4a5c', '#2f5a3a'];

const SACRED_TYPES: Record<string, string> = {
  church: 'christian', cathedral: 'christian', chapel: 'christian', basilica: 'christian',
  mosque: 'muslim', synagogue: 'jewish',
};
const TEMPLE_TYPES = new Set(['church', 'cathedral', 'chapel', 'basilica', 'mosque', 'synagogue', 'temple', 'shrine', 'religious']);

/**
 * Lands whose churches are Orthodox where no denomination says otherwise: the former USSR but the
 * Baltic states, the Balkans' Orthodox countries, Romania and Moldova, Greece and Cyprus, Georgia and Armenia.
 */
export function orthodoxLand(lon: number, lat: number): boolean {
  if (archRegion(lon, lat) === 'soviet') {
    // Estonia and Latvia (Lutheran), Lithuania (Catholic)
    if (lon < 28.2 && lat > 55.7) return false;
    if (lon < 26.8 && lat > 53.9) return false;
    return true;
  }
  const box = (w: number, s: number, e: number, n: number) => lon >= w && lon <= e && lat >= s && lat <= n;
  return box(19.3, 34.8, 28.3, 41.8) // Greece
    || box(22.3, 41.2, 28.6, 44.2) // Bulgaria
    || box(18.8, 40.8, 23.0, 46.2) // Serbia, Montenegro, North Macedonia
    || box(20.2, 43.6, 30.2, 48.3) // Romania, Moldova
    || box(32.2, 34.5, 34.6, 35.7) // Cyprus
    || box(40.0, 38.8, 46.7, 43.6); // Georgia, Armenia
}

/** names of Western (Catholic, Protestant) and of Orthodox churches */
const WESTERN_NAME = /католи|catholic|костё?е?л|kirche|кирх|лютеран|lutheran|евангел|evangel|протестант|protestant|баптист|baptist|адвентист|adventist|методист|methodist|пресвитериан|presbyterian|англикан|anglican|пятидесятн|pentecost/i;
const ORTHODOX_NAME = /православ|orthodox/i;

/**
 * The tradition a place of worship is built in: its religion (else the one its type implies: a church
 * is Christian), a Christian one by its denomination, else its name or style, else by where it stands (orthodoxLand). Undefined
 * for anything else (no religion, or one without a shape here).
 */
export function faithOf(tags: Record<string, string>, lon: number, lat: number): Faith | undefined {
  const type = tags[STYLE_TYPE_TAG] || tags['building:part'] || tags.building || '';
  const religion = tags.religion ?? SACRED_TYPES[type] ?? (tags.building && SACRED_TYPES[tags.building]);
  switch (religion) {
    case 'christian': {
      const d = (tags.denomination ?? '').toLowerCase();
      if (/orthodox|old_believers|armenian|apostolic|coptic|ethiopian/.test(d)) return 'orthodox';
      if (d) return 'western';
      // our tiles keep no denomination: the name and the style tell a Catholic or a Lutheran church in Moscow
      const name = `${tags.name ?? ''} ${tags['name:en'] ?? ''}`;
      if (WESTERN_NAME.test(name)) return 'western';
      if (ORTHODOX_NAME.test(name)) return 'orthodox';
      const style = tags['building:architecture'] ?? '';
      if (/gothic|romanesque/.test(style)) return 'western';
      if (/russian|byzantine/.test(style)) return 'orthodox';
      return orthodoxLand(lon, lat) ? 'orthodox' : 'western';
    }
    case 'muslim': return 'muslim';
    case 'jewish': return 'jewish';
    case 'buddhist': return 'buddhist';
    case 'hindu': return 'hindu';
    case 'sikh': return 'sikh';
    default: return undefined;
  }
}

/** the symbol a faith puts on top of its domes and spires */
export function finialOf(faith: Faith | undefined): FinialKind | undefined {
  return faith === 'orthodox' ? 'orthodox' : faith === 'western' ? 'cross' : faith === 'muslim' ? 'crescent' : undefined;
}

/** a building (not a part) that is a place of worship */
function isTemple(tags: Record<string, string>): boolean {
  if (tags.building === undefined || tags.building === 'no') return false;
  return TEMPLE_TYPES.has(tags.building) || tags.amenity === 'place_of_worship';
}

const isPart = (b: OsmBuilding) => b.tags['building:part'] !== undefined && b.tags['building:part'] !== 'no';

/** a vertex of the ring a part stands on (the same anchor overpass shareStyleInParts takes) */
function leastVertex(ring: LonLat[]): LonLat {
  let at = ring[0];
  for (const v of ring) if (v[0] < at[0] || (v[0] === at[0] && v[1] < at[1])) at = v;
  return at;
}

/**
 * The places of worship among `buildings` (after shareStyleInParts, before the outlines with parts are
 * hidden): one with TEMPLE.DETAILED_PARTS parts or more, or a roof:shape on it or one of its parts, keeps
 * them, each part and the outline marked with its faith's finial; one with fewer parts and no roof
 * shape anywhere loses them and is built by templeParts. `owners` are the outlines each part lies in.
 */
export function expandTemples(buildings: OsmBuilding[], owners: ReadonlyMap<OsmBuilding, OsmBuilding[]>): OsmBuilding[] {
  const partsOf = new Map<OsmBuilding, OsmBuilding[]>();
  for (const [part, outs] of owners) for (const o of outs) {
    const list = partsOf.get(o);
    if (list) list.push(part); else partsOf.set(o, [part]);
  }
  const dropped = new Set<OsmBuilding>();
  const replaced = new Map<OsmBuilding, OsmBuilding[]>();
  const marked = new Map<OsmBuilding, OsmBuilding>();
  const mark = (b: OsmBuilding, kind: FinialKind | undefined) => {
    if (kind && !marked.has(b)) marked.set(b, { rings: b.rings, tags: { ...b.tags, [FINIAL_TAG]: kind } });
  };
  for (const b of buildings) {
    if (isPart(b) || !b.rings[0]?.length || !isTemple(b.tags)) continue;
    const [lon, lat] = b.rings[0][0];
    const faith = faithOf(b.tags, lon, lat);
    if (!faith) continue;
    const parts = partsOf.get(b) ?? [];
    const shaped = (t: Record<string, string>) => t['roof:shape'] !== undefined && t['roof:shape'] !== 'flat';
    if (parts.length >= TEMPLE.DETAILED_PARTS || shaped(b.tags) || parts.some((p) => shaped(p.tags))) {
      mark(b, finialOf(faith));
      continue;
    }
    for (const p of parts) dropped.add(p);
    replaced.set(b, templeParts(b, faith));
  }
  // the parts of a temple mapped in detail (also of a type=building relation, which has no outline here)
  for (const b of buildings) {
    if (!isPart(b) || dropped.has(b) || !b.rings[0]?.length) continue;
    const [lon, lat] = b.rings[0][0];
    const type = b.tags[STYLE_TYPE_TAG] || '';
    const owned = owners.get(b)?.some((o) => isTemple(o.tags)) || TEMPLE_TYPES.has(type) || b.tags.religion !== undefined;
    if (owned) mark(b, finialOf(faithOf(b.tags, lon, lat)));
  }
  if (!dropped.size && !replaced.size && !marked.size) return buildings;
  return buildings.flatMap((b) => dropped.has(b) ? [] : replaced.get(b) ?? [marked.get(b) ?? b]);
}

/** a ring in metres about `o` (x east, z south) and back */
function projector(o: LonLat) {
  const k = 111320, c = Math.cos((o[1] * Math.PI) / 180);
  return {
    toXZ: ([lon, lat]: LonLat): XZ => [(lon - o[0]) * k * c, -(lat - o[1]) * k],
    toLL: ([x, z]: XZ): LonLat => [o[0] + x / (k * c), o[1] - z / k],
  };
}

function areaOf(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

function insideXZ(p: XZ, ring: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pick = <T>(list: readonly T[], t: number): T => list[Math.floor((((t % 1) + 1) % 1) * list.length) % list.length];
const num = (v: string | undefined) => { const x = parseFloat(v ?? ''); return Number.isFinite(x) ? x : undefined; };
const fmt = (x: number) => String(Math.round(x * 100) / 100);

/**
 * A place of worship mapped as a bare outline, built as S3DB parts: the outline itself as the body
 * (its roof and wall height set; a told height is the body's top, told levels its walls), and the
 * parts of its tradition inside it (a part that does not fit in the outline is left out). The parts
 * share the body's colours (STYLE_AT_TAG, STYLE_TYPE_TAG) and its footing (FOOTING_TAG).
 */
export function templeParts(b: OsmBuilding, faith: Faith): OsmBuilding[] {
  const ring = b.rings[0];
  const origin = ring[0];
  const { toXZ, toLL } = projector(origin);
  const outer = ring.map(toXZ);
  const closed = outer.length > 1 && outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1];
  const poly = closed ? outer.slice(0, -1) : outer;
  if (poly.length < 3) return [b];
  const area = areaOf(poly);
  const f = roofFrame(poly, {});
  // u along the long side, pointing east: the west end at −halfU (the entrance, the tower), the east at +halfU (the altar)
  const flip = f.u[0] < 0 || (f.u[0] === 0 && f.u[1] > 0);
  const u: XZ = flip ? [-f.u[0], -f.u[1]] : f.u;
  const v: XZ = [-u[1], u[0]];
  const at = (su: number, sv: number): XZ => [f.origin[0] + u[0] * su + v[0] * sv, f.origin[1] + u[1] * su + v[1] * sv];
  const L = f.halfU, W = f.halfV;
  const seed = (Math.abs(Math.sin(origin[0] * 12.9898 + origin[1] * 78.233)) * 43758.5453) % 1;
  const chapel = b.tags.building === 'chapel' || area < TEMPLE.CHAPEL_MAX_M2;
  const large = !chapel && (b.tags.building === 'cathedral' || area >= TEMPLE.LARGE_MIN_M2);

  const anchor = leastVertex(ring);
  const shared: Record<string, string> = {
    [STYLE_AT_TAG]: `${anchor[0]},${anchor[1]}`,
    [STYLE_TYPE_TAG]: b.tags.building && b.tags.building !== 'yes' ? b.tags.building : 'religious',
  };
  for (const k of ['building:colour', 'building:color', 'colour', 'building:material', 'religion', 'denomination', 'building:architecture', 'start_date']) {
    if (b.tags[k] !== undefined) shared[k] = b.tags[k];
  }
  const footing = ring.map(([lo, la]) => `${lo},${la}`).join(' ');

  // the body's walls: told levels, else from the footprint; a told height is the body's top
  const levels = num(b.tags['building:levels']);
  let wall = levels !== undefined ? levels * 3 : clamp(TEMPLE.WALL.BASE_M + TEMPLE.WALL.PER_M * Math.sqrt(area), TEMPLE.WALL.MIN_M, TEMPLE.WALL.MAX_M);
  const body: Record<string, string> = { ...b.tags, ...shared };
  delete body['building:levels'];
  delete body.height;
  delete body.min_height;
  let roofH = 0;
  switch (faith) {
    case 'orthodox': roofH = clamp(Math.tan(Math.PI / 6) * W, 1.2, 8); body['roof:shape'] = 'gabled'; break;
    case 'western': roofH = Math.tan((TEMPLE.WESTERN_PITCH_DEG * Math.PI) / 180) * W; body['roof:shape'] = 'gabled'; break;
    case 'jewish': roofH = clamp(0.5 * W, 1.2, 8); body['roof:shape'] = 'hipped'; break;
    case 'buddhist': roofH = clamp(0.55 * W, 1.2, 8); body['roof:shape'] = 'hipped'; break;
    default: body['roof:shape'] = 'flat';
  }
  const told = num(b.tags.height);
  if (told !== undefined && told > roofH + 2) wall = told - roofH;
  if (faith === 'muslim' || faith === 'sikh' || faith === 'hindu') wall = levels !== undefined || told !== undefined ? wall : clamp(3 + 0.2 * Math.sqrt(area), 4, 14);
  body.height = fmt(wall + roofH);
  if (roofH > 0) body['roof:height'] = fmt(roofH);
  const ridge = wall + roofH;

  const out: OsmBuilding[] = [];
  const part = (pts: XZ[], tags: Record<string, string>): boolean => {
    if (!pts.every((p) => insideXZ(p, poly))) return false;
    const r = pts.map(toLL);
    r.push(r[0]);
    out.push({ rings: [r], tags: { ...shared, [FOOTING_TAG]: footing, ...tags } });
    return true;
  };
  const round = (c: XZ, r: number, n: number = TEMPLE.ROUND_SIDES): XZ[] =>
    Array.from({ length: n }, (_, i) => { const a = (2 * Math.PI * (i + 0.5)) / n; return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as XZ; });
  const square = (cu: number, cv: number, hu: number, hv: number): XZ[] => [at(cu - hu, cv - hv), at(cu + hu, cv - hv), at(cu + hu, cv + hv), at(cu - hu, cv + hv)];
  /** a dome on a drum: the drum's walls from `from` to `top`, the dome `shape` over them */
  const domed = (c: XZ, r: number, from: number, top: number, shape: 'onion' | 'dome', colour: string, finial?: FinialKind): boolean =>
    part(round(c, r), {
      'building:part': 'dome', min_height: fmt(from), height: fmt(top + (shape === 'onion' ? 2.4 : 1) * r * Math.cos(Math.PI / TEMPLE.ROUND_SIDES)),
      'roof:shape': shape, 'roof:colour': colour, ...(finial ? { [FINIAL_TAG]: finial } : {}),
    });
  /** the footprint across the axis at `su` along it: the stretch of v about the axis (the widest where none holds it) */
  const spanAt = (su: number): [number, number] | undefined => {
    const p0 = at(su, 0);
    const ts: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], c = poly[i];
      const da = (a[0] - p0[0]) * u[0] + (a[1] - p0[1]) * u[1], dc = (c[0] - p0[0]) * u[0] + (c[1] - p0[1]) * u[1];
      if ((da > 0) === (dc > 0)) continue;
      const k = da / (da - dc);
      ts.push(((a[0] + (c[0] - a[0]) * k) - p0[0]) * v[0] + ((a[1] + (c[1] - a[1]) * k) - p0[1]) * v[1]);
    }
    ts.sort((x, y) => x - y);
    let best: [number, number] | undefined;
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const sp: [number, number] = [ts[i], ts[i + 1]];
      if (sp[0] <= 0 && sp[1] >= 0) return sp;
      if (!best || sp[1] - sp[0] > best[1] - best[0]) best = sp;
    }
    return best;
  };
  /**
   * A square tower at the west end (the east one): in the middle across the axis, or at its `left` or
   * `right` side, its walls to `top`, its pyramidal roof `roof` high; where the end is too narrow, a
   * little further in or smaller (both heights less with it). Returns how far in from the end it reaches.
   */
  const tower = (side: number, where: 'middle' | 'left' | 'right', top: number, roof: number, colour: string, finial?: FinialKind, east = false): number | undefined => {
    for (let s = side; s >= TEMPLE.TOWER.MIN_M * 0.8; s *= 0.8) {
      for (let inset = 0; inset <= L * 0.4; inset += 0.5) {
        const u0 = east ? L - s / 2 - inset : -L + s / 2 + inset;
        const a = spanAt(u0 - s / 2 + 0.01), b = spanAt(u0 + s / 2 - 0.01);
        if (!a || !b) continue;
        const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
        if (hi - lo < s) continue;
        const cv = where === 'left' ? lo + s / 2 : where === 'right' ? hi - s / 2 : clamp(0, lo + s / 2, hi - s / 2);
        const k = s / side;
        if (part(square(u0, cv, s / 2, s / 2), {
          'building:part': 'bell_tower', height: fmt(top * (0.5 + 0.5 * k) + roof * k), 'roof:shape': 'pyramidal', 'roof:height': fmt(roof * k),
          'roof:colour': colour, ...(finial ? { [FINIAL_TAG]: finial } : {}),
        })) return inset + s;
      }
    }
    return undefined;
  };
  /** the width the west end leaves for two towers side by side */
  const westWidth = (s: number): number => {
    const a = spanAt(-L + 0.01), b = spanAt(-L + s - 0.01);
    return a && b ? Math.min(a[1], b[1]) - Math.max(a[0], b[0]) : 0;
  };

  switch (faith) {
    case 'orthodox': {
      body['roof:colour'] ??= pick(ORTHODOX_ROOFS, seed * 7);
      const domeColour = pick(ORTHODOX_DOMES, seed * 13);
      let east = -L;
      if (!chapel) {
        const side = clamp(TEMPLE.TOWER.SIDE_SHARE * 2 * W, TEMPLE.TOWER.MIN_M, TEMPLE.TOWER.MAX_M);
        const top = ridge + Math.max(TEMPLE.TOWER.MIN_RISE_M, TEMPLE.TOWER.RISE * side);
        const reach = L > side * 1.5 ? tower(side, 'middle', top, TEMPLE.TOWER.TENT * side, body['roof:colour'], 'orthodox') : undefined;
        if (reach !== undefined) east = -L + reach;
      }
      const cu = (east + L) / 2;
      const r = chapel
        ? clamp(TEMPLE.DRUM.CHAPEL_R_SHARE * 2 * W, 0.6, TEMPLE.DRUM.CHAPEL_MAX_R)
        : clamp(TEMPLE.DRUM.R_SHARE * 2 * W, TEMPLE.DRUM.MIN_R, TEMPLE.DRUM.MAX_R);
      domed(at(cu, 0), r, wall, ridge + TEMPLE.DRUM.RISE * r, 'onion', domeColour, 'orthodox');
      if (large) {
        const rc = r * TEMPLE.DRUM.CORNER_R, du = Math.min((L - east) / 2 * 0.55, W * 0.55), dv = W * 0.55;
        for (const [su, sv] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          domed(at(cu + su * du, sv * dv), rc, wall, ridge + TEMPLE.DRUM.RISE * rc * 0.6, 'onion', domeColour, 'orthodox');
        }
      }
      break;
    }
    case 'western': {
      body['roof:colour'] ??= pick(WESTERN_ROOFS, seed * 7);
      if (chapel) { body[FINIAL_TAG] = 'cross'; break; }
      const spire = pick(WESTERN_SPIRES, seed * 13);
      const side = clamp(TEMPLE.TOWER.SIDE_SHARE * 2 * W, TEMPLE.TOWER.MIN_M, TEMPLE.TOWER.MAX_M);
      const top = ridge + Math.max(TEMPLE.TOWER.MIN_RISE_M, TEMPLE.TOWER.RISE * side);
      // a large one with a wide west front: two towers at its corners
      const twin = large && westWidth(side) >= 2.5 * side;
      const placed = twin
        ? (['left', 'right'] as const).map((w) => tower(side, w, top, TEMPLE.TOWER.SPIRE * side, spire, 'cross')).some((r) => r !== undefined)
        : L > side * 1.5 && tower(side, 'middle', top, TEMPLE.TOWER.SPIRE * side, spire, 'cross') !== undefined;
      if (!placed) body[FINIAL_TAG] = 'cross';
      break;
    }
    case 'muslim':
    case 'sikh': {
      const colour = faith === 'sikh' ? '#d9b44a' : pick(MOSQUE_DOMES, seed * 13);
      const finial = faith === 'muslim' ? 'crescent' : undefined;
      if (faith === 'sikh') shared['building:colour'] ??= '#f2efe6';
      const r = clamp(TEMPLE.DOME.R_SHARE * 2 * Math.min(W, L), TEMPLE.DOME.MIN_R, TEMPLE.DOME.MAX_R);
      for (let rr = r; rr >= TEMPLE.DOME.MIN_R * 0.7; rr *= 0.8) {
        if (domed(f.origin, rr, wall, wall + Math.max(0.8, TEMPLE.DOME.DRUM * rr), 'dome', colour, finial)) break;
      }
      if (large) {
        const rc = r * TEMPLE.DOME.CORNER_R;
        for (const [su, sv] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          domed(at(su * (L - rc - 1), sv * (W - rc - 1)), rc, wall, wall + 0.5, 'dome', colour, finial);
        }
      }
      break;
    }
    case 'buddhist': {
      body['roof:colour'] ??= pick(BUDDHIST_ROOFS, seed * 7);
      if (area < TEMPLE.TIER.MIN_M2) break;
      const s = TEMPLE.TIER.SHARE;
      const from = wall + roofH * (1 - s);
      const tierWall = TEMPLE.TIER.RISE * wall;
      part(square(0, 0, L * s, W * s), {
        'building:part': 'yes', min_height: fmt(from), height: fmt(from + tierWall + roofH * s),
        'roof:shape': 'hipped', 'roof:height': fmt(roofH * s), 'roof:colour': body['roof:colour'],
      });
      break;
    }
    case 'hindu': {
      const side = clamp(TEMPLE.SHIKHARA.SIDE_SHARE * 2 * W, TEMPLE.SHIKHARA.MIN_M, TEMPLE.SHIKHARA.MAX_M);
      if (L * 2 > side) tower(side, 'middle', wall + 0.4 * side, TEMPLE.SHIKHARA.ROOF * side, '#c8b89a', undefined, true);
      break;
    }
    case 'jewish':
      break;
  }
  return [{ rings: b.rings, tags: body }, ...out];
}

/** a triangle with its normal: [a, b, c, n] */
export type V3 = [number, number, number];
export type FinialTri = [V3, V3, V3, V3];

/**
 * A finial standing at `apex`, `size` metres high, in the vertical plane along `axis` (a unit vector
 * in x, z): a Latin cross, an Orthodox one (a top bar, the cross bar, the slanted foot bar) or a
 * crescent opening upward on a short stem. Solid: each figure extruded `size`·0.1 thick.
 */
export function finialTris(kind: FinialKind, apex: V3, size: number, axis: XZ): FinialTri[] {
  const w = Math.max(0.12, size * 0.1);
  const polys: [number, number][][] = [];
  const rect = (s0: number, t0: number, s1: number, t1: number): [number, number][] => [[s0, t0], [s1, t0], [s1, t1], [s0, t1]];
  if (kind === 'cross' || kind === 'orthodox') {
    polys.push(rect(-w / 2, 0, w / 2, size));
    polys.push(rect(-size * 0.3, size * 0.62, size * 0.3, size * 0.62 + w));
    if (kind === 'orthodox') {
      polys.push(rect(-size * 0.16, size * 0.84, size * 0.16, size * 0.84 + w));
      // the foot bar, slanting down to the right
      const a = size * 0.2, y = size * 0.3, d = size * 0.07;
      polys.push([[-a, y + d], [a, y - d], [a, y - d + w], [-a, y + d + w]]);
    }
  } else {
    const stem = size * 0.25;
    polys.push(rect(-w / 2, 0, w / 2, stem + w));
    // a crescent: the outer circle's arc above, the inner (shifted up) cut out of it, horns up
    const R = size * 0.38, r = R * 0.8, cy = stem + R, off = R * 0.35, n = 12;
    // the outer lower arc from the left horn (−R, cy) round the bottom to the right horn (R, cy)
    const outer: [number, number][] = [];
    for (let i = 0; i <= n; i++) { const a = Math.PI + (Math.PI * i) / n; outer.push([R * Math.cos(a), cy + R * Math.sin(a)]); }
    // back along the inner arc (centre raised by `off`) from the right horn to the left
    const inner: [number, number][] = [];
    const hornA = Math.asin(Math.min(1, off / r));
    for (let i = n; i >= 0; i--) {
      const a = Math.PI + hornA + ((Math.PI - 2 * hornA) * i) / n;
      inner.push([r * Math.cos(a), cy + off + r * Math.sin(a)]);
    }
    polys.push([...outer, ...inner]);
  }
  const ax = axis[0], az = axis[1];
  const m: V3 = [-az, 0, ax];
  const P = ([s, t]: [number, number], side: number): V3 => [apex[0] + ax * s + m[0] * side * w / 2, apex[1] + t, apex[2] + az * s + m[2] * side * w / 2];
  const tris: FinialTri[] = [];
  for (const poly of polys) {
    const idx = earcut(poly.flat());
    for (const side of [1, -1]) {
      const n: V3 = [m[0] * side, 0, m[2] * side];
      for (let i = 0; i < idx.length; i += 3) tris.push([P(poly[idx[i]], side), P(poly[idx[i + 1]], side), P(poly[idx[i + 2]], side), n]);
    }
    // the sides: each edge's outward normal in the figure's plane (the polygon is ccw or cw: the sign by its area)
    let a2 = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a2 += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    const sgn = a2 >= 0 ? 1 : -1;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ds = q[0] - p[0], dt = q[1] - p[1], len = Math.hypot(ds, dt);
      if (len < 1e-6) continue;
      const ns = (sgn * dt) / len, nt = (-sgn * ds) / len;
      const n: V3 = [ax * ns, nt, az * ns];
      const p0 = P(p, 1), p1 = P(q, 1), q1 = P(q, -1), q0 = P(p, -1);
      tris.push([p0, p1, q1, n], [p0, q1, q0, n]);
    }
  }
  return tris;
}

/** the Kaaba, Mecca (as minaret-mesher's) */
const KAABA: LonLat = [39.8262, 21.4225];

/** a crescent's plane at (lon, lat): across the qibla (its face turned to Mecca), a unit vector in x east, z south */
export function qiblaAxis(lon: number, lat: number): XZ {
  const r = Math.PI / 180;
  const [l1, p1] = [lon * r, lat * r], [l2, p2] = [KAABA[0] * r, KAABA[1] * r];
  const q = Math.atan2(Math.sin(l2 - l1) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1));
  // the qibla is (sin q, −cos q) in x, z: the plane runs square to it
  return [Math.cos(q), Math.sin(q)];
}

/** a finial's size: FINIAL.SIZE of the radius under it, MIN_M..MAX_M; on a pyramid or cone only when it is a spire or a tent (SPIRE_RISE radii high) */
export const FINIAL = { SIZE: 0.8, MIN_M: 1, MAX_M: 5, SPIRE_RISE: 1.2, GABLE: 0.35, GABLE_MAX_M: 3, INSET_M: 0.3, RGB: [212, 175, 55] as [number, number, number] } as const;
