import { colourOf, LIGHT, type RGB } from '../engine/palette';
import { parseLength } from './building-mesher';
import { latLonToEnu, tileBounds, tileCenter, type Tile } from './geodesy';
import type { LonLat, OsmPoint } from './osm-types';
import type { HeightSampler } from './terrain-source';

/**
 * Lighthouses and the sea's lights (man_made=lighthouse | beacon, seamark:type=light_major |
 * light_minor | beacon_*): a tower, a harbour light's post or a cardinal beacon's banded pole, and
 * its light flashing at night as the chart gives it (seamark:light:character, period, group,
 * sequence; the first of a sectored light's). A lighthouse and its light are often two nodes a few
 * metres apart: the nodes within MERGE_M are one site. The light stands at its seamark height over
 * the sea where that is over the ground (the tower reaches up to it), else on a tower of its kind.
 */
export const LIGHTHOUSE = {
  MERGE_M: 40,
  /** a tower's height without the light's: a lighthouse's, a harbour light's post */
  TOWER_M: { lighthouse: 14, post: 6, cardinal: 5 } as Record<SiteKind, number>,
  /** the tower reaches its light's height within these */
  MIN_M: 3,
  MAX_M: 40,
  /** a lighthouse: its tower's radius at the foot and the top, its gallery, lantern and roof */
  FOOT_R: 2.2,
  TOP_R: 1.6,
  GALLERY: { R: 2.5, H: 0.4 },
  LANTERN: { R: 1.2, H: 2 },
  ROOF: { R: 1.5, H: 1.2 },
  /** a post's and a pole's radius */
  POST_R: 0.5,
  POLE_R: 0.35,
  SIDES: 8,
  WHITE: [232, 230, 222] as RGB,
  RED: [190, 44, 40] as RGB,
  GLASS: [40, 52, 60] as RGB,
  /** the light's colours on the chart: the fixed light colours (palette LIGHT.SEA_*), shining at night as a beacon does */
  COLOURS: {
    white: LIGHT.SEA_WHITE, red: LIGHT.SEA_RED, green: LIGHT.SEA_GREEN, yellow: LIGHT.SEA_YELLOW, blue: LIGHT.SEA_BLUE, orange: LIGHT.SEA_ORANGE,
  } as Record<string, number>,
  /** a flash, a long flash; a quick and a very quick light's period, its flash */
  FLASH_S: 0.5,
  LONG_S: 2,
  QUICK: [1, 0.3] as [number, number],
  VERY_QUICK: [0.5, 0.2] as [number, number],
  /** a flashing light's period without one on the chart */
  PERIOD_S: 5,
  /** at most this many flashes in a period, and sectors of one light */
  MAX_FLASHES: 6,
  MAX_SECTORS: 6,
} as const;

export type SiteKind = 'lighthouse' | 'post' | 'cardinal';

/**
 * per light: x, y, z, colour (LIGHT.SEA_*), period s, flash count, then MAX_FLASHES × (start, end) s,
 * then its sector count and MAX_SECTORS × (start°, end°, colour)
 */
export const FLASH_STRIDE = 6 + 2 * LIGHTHOUSE.MAX_FLASHES + 1 + 3 * LIGHTHOUSE.MAX_SECTORS;
const SECTOR_AT = 6 + 2 * LIGHTHOUSE.MAX_FLASHES;

export interface SeamarkLight {
  /** its LUT light colour (LIGHT.SEA_*) */
  colour: number;
  /** its height over the sea, metres, when charted */
  height?: number;
  period: number;
  /** when it is lit within its period, seconds from the period's start */
  on: [number, number][];
  /**
   * a sectored light's sectors: its colour seen from bearings start…end (degrees true, clockwise,
   * from seaward towards the light, as the chart gives them); dark from any other
   */
  sectors?: { start: number; end: number; colour: number }[];
}

const num = (v: string | undefined): number | undefined => {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * When a light is lit within its period: by its sequence (on times, darkness in brackets:
 * "0.3+(2.7)"), else by its character and group: F fixed; Fl n flashes (LFl long ones); Q, VQ
 * quick ones (a group of n, then dark to the period); Iso half lit; Oc lit but a second's darkness
 */
export function flashTimes(character: string | undefined, period: number | undefined, group: string | undefined, sequence: string | undefined): { period: number; on: [number, number][] } {
  const ch = (character ?? 'F').replace(/\s/g, '');
  if (sequence) {
    const on: [number, number][] = [];
    let t = 0;
    for (const part of sequence.split('+')) {
      const dark = /^\((.*)\)$/.exec(part.trim());
      const d = num(dark ? dark[1] : part);
      if (d === undefined) continue;
      if (!dark) on.push([t, t + d]);
      t += d;
    }
    if (on.length && t > 0) return { period: period ?? t, on: on.slice(0, LIGHTHOUSE.MAX_FLASHES) };
  }
  const n = Math.max(1, Math.min(LIGHTHOUSE.MAX_FLASHES, Math.round(num(group?.split(/[+(]/)[0]) ?? 1)));
  if (ch === 'F' || ch === '') return { period: 1, on: [[0, 1]] };
  if (/^V?Q/.test(ch) || /^I?V?Q/.test(ch)) {
    const [p, f] = ch.includes('VQ') ? LIGHTHOUSE.VERY_QUICK : LIGHTHOUSE.QUICK;
    // continuous quick: one flash per its period; grouped: n then dark to the charted period
    if (!period || n === 1 && !group) return { period: p, on: [[0, f]] };
    return { period, on: Array.from({ length: n }, (_, k): [number, number] => [k * p, k * p + f]) };
  }
  const P = period ?? LIGHTHOUSE.PERIOD_S;
  if (ch.startsWith('Iso')) return { period: P, on: [[0, P / 2]] };
  if (ch.startsWith('Oc')) return { period: P, on: [[0, Math.max(P - 1, P / 2)]] };
  const f = ch.startsWith('LFl') ? LIGHTHOUSE.LONG_S : LIGHTHOUSE.FLASH_S;
  const gap = Math.min(1, (P - n * f) / Math.max(1, n));
  return { period: P, on: Array.from({ length: n }, (_, k): [number, number] => [k * (f + gap), k * (f + gap) + f]) };
}

const colourOfName = (v: string | undefined): number => LIGHTHOUSE.COLOURS[(v ?? 'white').split(';')[0].trim()] ?? LIGHTHOUSE.COLOURS.white;

/**
 * A point's charted light, or none: its rhythm the first light's; a sectored one (seamark:light:N:*
 * with sector_start and sector_end) with its sectors, each its own colour
 */
export function seamarkLight(tags: Record<string, string>): SeamarkLight | undefined {
  const key = tags['seamark:light:colour'] !== undefined || tags['seamark:light:character'] !== undefined ? 'seamark:light:' : tags['seamark:light:1:colour'] !== undefined ? 'seamark:light:1:' : undefined;
  if (!key) return undefined;
  const colour = colourOfName(tags[key + 'colour']);
  const { period, on } = flashTimes(tags[key + 'character'], num(tags[key + 'period']), tags[key + 'group'], tags[key + 'sequence']);
  const sectors: { start: number; end: number; colour: number }[] = [];
  for (let k = 1; k <= 9 && sectors.length < LIGHTHOUSE.MAX_SECTORS; k++) {
    const p = `seamark:light:${k}:`, start = num(tags[p + 'sector_start']), end = num(tags[p + 'sector_end']);
    if (start === undefined || end === undefined) continue;
    sectors.push({ start: ((start % 360) + 360) % 360, end: ((end % 360) + 360) % 360, colour: colourOfName(tags[p + 'colour']) });
  }
  return { colour, height: num(tags[key + 'height']), period, on, ...(sectors.length ? { sectors } : {}) };
}

/** whether bearing `b` lies in the sector clockwise from `start` to `end` (degrees) */
export function inSector(b: number, start: number, end: number): boolean {
  const x = ((b % 360) + 360) % 360;
  return start <= end ? x >= start && x < end : x >= start || x < end;
}

function isSite(tags: Record<string, string>): boolean {
  const st = tags['seamark:type'] ?? '';
  return tags.man_made === 'lighthouse' || tags.man_made === 'beacon' || st === 'light_major' || st === 'light_minor' || st.startsWith('beacon_') || seamarkLight(tags) !== undefined;
}

function siteKind(tags: Record<string, string>): SiteKind {
  const st = tags['seamark:type'] ?? '';
  if (tags.man_made === 'lighthouse' || st === 'light_major') return 'lighthouse';
  if (st === 'beacon_cardinal') return 'cardinal';
  return 'post';
}

/** the light sites among `points`: the nodes within MERGE_M of each other as one, a lighthouse's kind first */
export function lightSites(points: ReadonlyArray<OsmPoint>): { at: LonLat; tags: Record<string, string> }[] {
  const sites: { at: LonLat; tags: Record<string, string> }[] = [];
  const near = (a: LonLat, b: LonLat) => {
    const k = 111320 * Math.cos((a[1] * Math.PI) / 180);
    return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 111320) <= LIGHTHOUSE.MERGE_M;
  };
  // the lighthouses first, so a site's structure is theirs and its place the tower's
  const list = points.filter((p) => isSite(p.tags)).sort((a, b) => (siteKind(a.tags) === 'lighthouse' ? 0 : 1) - (siteKind(b.tags) === 'lighthouse' ? 0 : 1) || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  for (const p of list) {
    const s = sites.find((x) => near(x.at, p.at));
    if (s) {
      // the light from whichever node charts it; the tower's own tags kept
      for (const [k, v] of Object.entries(p.tags)) if (s.tags[k] === undefined) s.tags[k] = v;
    } else {
      sites.push({ at: p.at, tags: { ...p.tags } });
    }
  }
  return sites;
}

export interface LighthouseData {
  /** pos + normal (stride 6) with face colours, as the building mesh */
  vertices: Float32Array;
  ramps: Uint32Array;
  /** the lights: FLASH_STRIDE floats each */
  flashes: Float32Array;
}

type V3 = [number, number, number];

/** the light sites among `points` standing in `tile` */
export function buildLighthouses(tile: Tile, points: ReadonlyArray<OsmPoint>, sampleHeight: HeightSampler): LighthouseData {
  const center = tileCenter(tile);
  const b = tileBounds(tile);
  const owns = ([lon, lat]: LonLat) => lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;
  const verts: number[] = [];
  const ramps: number[] = [];
  const flashes: number[] = [];
  const tri = (a: V3, c: V3, d: V3, n: V3, ramp: number) => {
    for (const p of [a, c, d]) verts.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    ramps.push(ramp, ramp, ramp);
  };
  /** a SIDES-sided frustum from y0 (radius r0) to y1 (r1), closed at both ends; a cone when r1 is 0 */
  const frustum = (x: number, z: number, y0: number, y1: number, r0: number, r1: number, ramp: number) => {
    const S = LIGHTHOUSE.SIDES;
    const at = (k: number, y: number, r: number): V3 => [x + Math.cos((2 * Math.PI * k) / S) * r, y, z + Math.sin((2 * Math.PI * k) / S) * r];
    const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
    for (let k = 0; k < S; k++) {
      const m = (2 * Math.PI * (k + 0.5)) / S;
      const n: V3 = [Math.cos(m), slope, Math.sin(m)];
      const l = Math.hypot(n[0], n[1], n[2]);
      const nn: V3 = [n[0] / l, n[1] / l, n[2] / l];
      // counter-clockwise from outside: round the axis the other way from x towards z
      const a0 = at(k, y0, r0), a1 = at(k + 1, y0, r0), b0 = at(k, y1, r1), b1 = at(k + 1, y1, r1);
      tri(a0, b0, a1, nn, ramp);
      if (r1 > 0) tri(a1, b0, b1, nn, ramp);
      if (r1 > 0) tri([x, y1, z], b1, b0, [0, 1, 0], ramp);
      tri([x, y0, z], a0, a1, [0, -1, 0], ramp);
    }
  };

  for (const site of lightSites(points)) {
    if (!owns(site.at)) continue;
    const [e, nn] = latLonToEnu(center, site.at[1], site.at[0], 0);
    const x = e, z = -nn;
    const g = Math.max(0, sampleHeight(site.at[0], site.at[1]));
    const kind = siteKind(site.tags);
    const light = seamarkLight(site.tags);
    const tagged = parseLength(site.tags.height) ?? num(site.tags['seamark:beacon_cardinal:height']);
    const L = LIGHTHOUSE;
    // the tower up to the charted light where that stands over the ground, else its own height
    const top = kind === 'lighthouse' ? L.GALLERY.H + L.LANTERN.H / 2 : 0.6;
    let H = tagged ?? L.TOWER_M[kind];
    if (light?.height !== undefined && tagged === undefined && light.height - g - top > L.MIN_M) H = Math.min(L.MAX_M, light.height - g - top);
    H = Math.max(L.MIN_M, Math.min(L.MAX_M, H));
    const white = colourOf(L.WHITE), red = colourOf(L.RED);
    let lightY: number;
    if (kind === 'lighthouse') {
      // a white tower, a red band under its gallery, the lantern's dark glass, a red roof
      frustum(x, z, g - 1, g + H * 0.85, L.FOOT_R, L.TOP_R + (L.FOOT_R - L.TOP_R) * 0.15, white);
      frustum(x, z, g + H * 0.85, g + H, L.TOP_R + (L.FOOT_R - L.TOP_R) * 0.15, L.TOP_R, red);
      frustum(x, z, g + H, g + H + L.GALLERY.H, L.GALLERY.R, L.GALLERY.R, white);
      frustum(x, z, g + H + L.GALLERY.H, g + H + L.GALLERY.H + L.LANTERN.H, L.LANTERN.R, L.LANTERN.R, colourOf(L.GLASS));
      frustum(x, z, g + H + L.GALLERY.H + L.LANTERN.H, g + H + L.GALLERY.H + L.LANTERN.H + L.ROOF.H, L.ROOF.R, 0, red);
      lightY = g + H + L.GALLERY.H + L.LANTERN.H / 2;
    } else if (kind === 'cardinal') {
      // a pole in its bands (seamark:beacon_cardinal:colour, top first), a cone on it
      const bands = (site.tags['seamark:beacon_cardinal:colour'] ?? 'black;yellow').split(';').map((c) => c.trim());
      const rgb = (c: string): RGB => (c === 'black' ? [30, 30, 32] : c === 'yellow' ? [226, 188, 40] : c === 'red' ? L.RED : c === 'green' ? [40, 150, 70] : L.WHITE);
      bands.forEach((c, i) => {
        const y1 = g + H * (1 - i / bands.length), y0 = i === bands.length - 1 ? g - 1 : g + H * (1 - (i + 1) / bands.length);
        frustum(x, z, y0, y1, L.POLE_R, L.POLE_R, colourOf(rgb(c)));
      });
      frustum(x, z, g + H, g + H + 0.8, 0.5, 0, colourOf([30, 30, 32]));
      lightY = g + H + 1;
    } else {
      // a post in its light's colour (a white one for a white or yellow light), its lamp on top
      const c = light?.colour === L.COLOURS.red ? red : light?.colour === L.COLOURS.green ? colourOf([40, 150, 70]) : white;
      frustum(x, z, g - 1, g + H, L.POST_R * 1.3, L.POST_R, c);
      lightY = g + H + 0.4;
    }
    if (!light) continue;
    const row = new Array<number>(FLASH_STRIDE).fill(0);
    row[0] = x; row[1] = lightY; row[2] = z;
    row[3] = light.colour;
    row[4] = light.period;
    row[5] = light.on.length;
    light.on.forEach(([s, t], k) => { row[6 + 2 * k] = s; row[7 + 2 * k] = t; });
    row[SECTOR_AT] = light.sectors?.length ?? 0;
    light.sectors?.forEach((s, k) => { row[SECTOR_AT + 1 + 3 * k] = s.start; row[SECTOR_AT + 2 + 3 * k] = s.end; row[SECTOR_AT + 3 + 3 * k] = s.colour; });
    flashes.push(...row);
  }
  return { vertices: new Float32Array(verts), ramps: new Uint32Array(ramps), flashes: new Float32Array(flashes) };
}

/**
 * The lights of `flashes` lit at `seconds` as seen from `eye` (x, z in the tile's frame: x east,
 * z south): x, y, z, colour each (the points drawLights draws). A sectored light in the colour of
 * the sector the eye's bearing to it falls in, unseen from outside them; without `eye`, its first.
 */
export function litFlashes(flashes: Float32Array, seconds: number, out: Float32Array, eye?: [number, number]): number {
  let n = 0;
  for (let i = 0; i + FLASH_STRIDE <= flashes.length; i += FLASH_STRIDE) {
    const period = flashes[i + 4] || 1, t = ((seconds % period) + period) % period;
    let lit = false;
    for (let k = 0; k < flashes[i + 5]; k++) if (t >= flashes[i + 6 + 2 * k] && t < flashes[i + 7 + 2 * k]) lit = true;
    if (!lit) continue;
    let colour = flashes[i + 3];
    const sectors = flashes[i + SECTOR_AT];
    if (sectors > 0 && eye) {
      // the bearing from the eye to the light, degrees true (north is −z)
      const b = (Math.atan2(flashes[i] - eye[0], -(flashes[i + 2] - eye[1])) * 180) / Math.PI;
      let found = -1;
      for (let k = 0; k < sectors && found < 0; k++) {
        const at = i + SECTOR_AT + 1 + 3 * k;
        if (inSector(b, flashes[at], flashes[at + 1])) found = flashes[at + 2];
      }
      if (found < 0) continue;
      colour = found;
    } else if (sectors > 0) {
      colour = flashes[i + SECTOR_AT + 3];
    }
    out.set([flashes[i], flashes[i + 1], flashes[i + 2], colour], n * 4);
    n++;
  }
  return n;
}
