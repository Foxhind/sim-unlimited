import type { RGB } from '../engine/palette';
import { STYLE_TYPE_TAG } from './osm-types';

/**
 * Architectural styles (OSM building:architecture) as the facade elements the generator draws:
 * geometry in building-mesher (a crowning cornice, belt courses at the floor lines) and paint in
 * WORLD_FS windowAt (rustication, quoins, pilaster strips, the windows' head, surround and glazing).
 * docs/arch-style-elements.md describes each style; this is the part of it drawn so far.
 *
 * A profile's index (1..) rides on a facade vertex with its wall height (palette.ts FACADE_PROFILE_M);
 * 0 is no style: the facade as it was before styles.
 */

/** the top of a window opening (WORLD_FS paneIn) */
export const HEAD = { FLAT: 0, SEGMENTAL: 1, ROUND: 2, POINTED: 3, HORSESHOE: 4, BAND: 5 } as const;
/**
 * what frames an opening: nothing, a surround (наличник), a surround under a cornice bar (сандрик),
 * a surround with a keystone, a dark reveal of a deep opening
 */
export const FRAME = { NONE: 0, SURROUND: 1, SANDRIK: 2, KEYSTONE: 3, REVEAL: 4 } as const;
/**
 * the bars across a pane: the edge's own (random), a T (a mullion, a transom at two thirds), a grid of
 * small panes (6/6), a single mullion under a fine grid in the upper third, horizontal strips
 */
export const GLAZING = { OWN: 0, CROSS: 1, GRID: 2, TRANSOM: 3, STRIPS: 4 } as const;

type Head = (typeof HEAD)[keyof typeof HEAD];
type Frame = (typeof FRAME)[keyof typeof FRAME];
type Glazing = (typeof GLAZING)[keyof typeof GLAZING];

export interface ArchProfile {
  /** index in ARCH_PROFILES, carried to the shader (> 0) */
  id: number;
  /** the building:architecture values drawn with it */
  tags: string[];
  /** a crowning cornice round the wall top: height and how far it stands out (m) */
  cornice?: { h: number; out: number };
  /** belt courses at the floor lines: none, over the ground floor only, at every floor line */
  belts: 0 | 1 | 2;
  /** floors of rusticated wall from the ground (grooved courses), 0: none */
  rust: number;
  /** stone blocks at the corners of each wall edge */
  quoins: boolean;
  /** flat pilaster strips between the window columns */
  piers: boolean;
  /** the window: head, max half-width and half-height (m), surround, glazing */
  window: { head: Head; w: number; h: number; frame: Frame; glazing: Glazing };
  /** head and width vary by window column (modern, northern modern) */
  varyHeads: boolean;
  /** the surround changes from floor to floor (eclectic) */
  varyFrames: boolean;
  /** the detail colour (surrounds, cornices, belts, quoins); none: the wall's, a little lighter */
  trim?: RGB;
  /** wall colours of a building OSM gives none, [colour, weight] */
  walls: [RGB, number][];
  /** balconies on a residential building (not on a pre-1900 facade) */
  balconies: boolean;
  /** panoramic windows (FACADE_PANORAMIC) */
  panoramic: boolean;
}

type Def = Omit<ArchProfile, 'id' | 'belts' | 'rust' | 'quoins' | 'piers' | 'varyHeads' | 'varyFrames' | 'balconies' | 'panoramic'> & Partial<ArchProfile>;

const WHITE: RGB = [240, 238, 230];
const w = (head: Head, hw: number, hh: number, frame: Frame = FRAME.NONE, glazing: Glazing = GLAZING.OWN) => ({ head, w: hw, h: hh, frame, glazing });

const DEFS: Def[] = [
  {
    tags: ['neoclassicism', 'classicism'],
    cornice: { h: 0.6, out: 0.45 }, belts: 1, rust: 1,
    window: w(HEAD.FLAT, 0.6, 1.0, FRAME.SANDRIK, GLAZING.CROSS), trim: WHITE,
    walls: [[[226, 196, 120], 3], [[226, 190, 176], 2], [[200, 200, 196], 1], [[190, 206, 176], 1], [[184, 200, 214], 1]],
  },
  {
    tags: ['empire'],
    cornice: { h: 0.7, out: 0.5 }, belts: 1, rust: 1,
    window: w(HEAD.FLAT, 0.6, 1.0, FRAME.NONE, GLAZING.CROSS), trim: WHITE,
    walls: [[[232, 200, 110], 3], [[205, 203, 198], 1]],
  },
  {
    tags: ['moorish_revival', 'neo-moorish', 'moorish'],
    cornice: { h: 0.3, out: 0.2 }, belts: 2,
    window: w(HEAD.HORSESHOE, 0.5, 1.0, FRAME.SURROUND), trim: [238, 232, 215],
    walls: [[[196, 130, 96], 2], [[214, 178, 120], 2], [[228, 208, 170], 1]],
  },
  {
    tags: ['pseudo-russian', 'russian_revival', 'russian-byzantine'],
    cornice: { h: 0.45, out: 0.3 }, belts: 1, piers: true,
    window: w(HEAD.ROUND, 0.5, 0.95, FRAME.SURROUND, GLAZING.CROSS), trim: [236, 232, 222],
    walls: [[[158, 72, 56], 3], [[140, 64, 52], 1]],
  },
  {
    tags: ['eclectic'],
    cornice: { h: 0.7, out: 0.5 }, belts: 2, rust: 1, quoins: true, varyFrames: true,
    window: w(HEAD.FLAT, 0.6, 1.0, FRAME.SANDRIK, GLAZING.CROSS), trim: [236, 230, 214],
    walls: [[[220, 196, 150], 2], [[180, 190, 170], 1], [[222, 186, 170], 1], [[226, 210, 180], 2], [[160, 84, 62], 1]],
  },
  {
    tags: ['georgian'],
    cornice: { h: 0.35, out: 0.3 }, belts: 1, quoins: true,
    window: w(HEAD.FLAT, 0.5, 0.95, FRAME.NONE, GLAZING.GRID), trim: WHITE,
    walls: [[[150, 76, 58], 3], [[178, 140, 96], 2]],
  },
  {
    tags: ['victorian'],
    cornice: { h: 0.3, out: 0.25 }, belts: 2,
    window: w(HEAD.SEGMENTAL, 0.5, 1.0, FRAME.SURROUND, GLAZING.CROSS), trim: [226, 214, 190],
    walls: [[[150, 72, 54], 3], [[196, 162, 104], 1], [[110, 70, 60], 1]],
  },
  {
    tags: ['neo-romanesque', 'romanesque_revival'],
    cornice: { h: 0.4, out: 0.3 }, belts: 1, piers: true,
    window: w(HEAD.ROUND, 0.45, 0.95),
    walls: [[[156, 80, 60], 2], [[200, 170, 130], 2], [[160, 156, 150], 1]],
  },
  {
    tags: ['neo-gothic', 'gothic_revival'],
    cornice: { h: 0.25, out: 0.2 }, piers: true,
    window: w(HEAD.POINTED, 0.45, 1.1, FRAME.SURROUND), trim: [200, 192, 176],
    walls: [[[146, 70, 54], 2], [[150, 148, 144], 2]],
  },
  {
    tags: ['pseudo-gothic', 'russian_gothic'],
    cornice: { h: 0.3, out: 0.2 }, belts: 1,
    window: w(HEAD.POINTED, 0.5, 1.0, FRAME.SURROUND, GLAZING.CROSS), trim: WHITE,
    walls: [[[160, 70, 56], 3]],
  },
  {
    tags: ['neo-byzantine', 'byzantine_revival'],
    cornice: { h: 0.35, out: 0.3 }, belts: 2,
    window: w(HEAD.ROUND, 0.5, 0.95, FRAME.SURROUND), trim: [232, 224, 204],
    walls: [[[214, 176, 120], 2], [[170, 90, 64], 2]],
  },
  {
    // historicism: no one neo-style named, drawn as the commonest
    tags: ['neo-renaissance', 'renaissance_revival', 'historicism'],
    cornice: { h: 0.9, out: 0.65 }, belts: 2, rust: 1, quoins: true,
    window: w(HEAD.FLAT, 0.6, 1.0, FRAME.SANDRIK, GLAZING.CROSS), trim: [232, 224, 206],
    walls: [[[214, 196, 160], 2], [[210, 170, 120], 1], [[190, 130, 100], 1], [[176, 172, 164], 2]],
  },
  {
    tags: ['neo-baroque', 'baroque_revival'],
    cornice: { h: 0.8, out: 0.6 }, belts: 2, rust: 1, quoins: true, piers: true,
    window: w(HEAD.SEGMENTAL, 0.6, 1.0, FRAME.SANDRIK, GLAZING.CROSS), trim: WHITE,
    walls: [[[168, 198, 212], 2], [[150, 196, 186], 1], [[232, 206, 130], 2], [[228, 184, 176], 1]],
  },
  {
    tags: ['art_nouveau', 'jugendstil', 'secession', 'modernisme'],
    cornice: { h: 0.4, out: 0.55 }, varyHeads: true,
    window: w(HEAD.FLAT, 0.65, 1.0, FRAME.SURROUND, GLAZING.TRANSOM), trim: [236, 228, 206],
    walls: [[[214, 200, 170], 2], [[170, 170, 130], 1], [[170, 184, 192], 1], [[206, 170, 110], 1], [[140, 110, 86], 1]],
  },
  {
    tags: ['nothern_modern', 'northern_modern', 'national_romanticism'],
    rust: 1, varyHeads: true,
    window: w(HEAD.FLAT, 0.5, 0.85, FRAME.NONE, GLAZING.TRANSOM),
    walls: [[[150, 150, 146], 2], [[140, 118, 96], 1], [[176, 150, 100], 1], [[140, 150, 140], 1]],
  },
  {
    tags: ['functionalism', 'bauhaus'],
    window: w(HEAD.BAND, 0, 0.6), balconies: true,
    walls: [[[236, 236, 232], 3], [[206, 206, 204], 2]],
  },
  {
    tags: ['cubism'],
    cornice: { h: 0.35, out: 0.35 }, belts: 1,
    window: w(HEAD.FLAT, 0.55, 0.9, FRAME.SURROUND),
    walls: [[[176, 176, 172], 2], [[206, 180, 130], 1], [[230, 228, 222], 1]],
  },
  {
    tags: ['new_objectivity'],
    window: w(HEAD.FLAT, 0.9, 0.65, FRAME.NONE, GLAZING.STRIPS), balconies: true,
    walls: [[[236, 234, 228], 3], [[176, 84, 70], 1], [[110, 136, 170], 1], [[224, 196, 110], 1], [[140, 170, 130], 1]],
  },
  {
    tags: ['art_deco'],
    cornice: { h: 0.3, out: 0.15 }, rust: 1, piers: true,
    window: w(HEAD.FLAT, 0.55, 1.0), trim: [236, 226, 200],
    walls: [[[216, 204, 178], 3], [[176, 174, 170], 2], [[196, 140, 110], 1]],
  },
  {
    tags: ['modern', 'modernism'],
    window: w(HEAD.FLAT, 0.9, 0.7), balconies: true,
    walls: [[[220, 220, 216], 2], [[180, 180, 178], 2], [[150, 152, 154], 1]],
  },
  {
    tags: ['amsterdam_school'],
    cornice: { h: 0.3, out: 0.3 },
    window: w(HEAD.FLAT, 0.6, 0.85, FRAME.NONE, GLAZING.STRIPS), trim: WHITE,
    walls: [[[128, 60, 48], 2], [[120, 80, 60], 1], [[190, 150, 96], 1]],
  },
  {
    tags: ['international_style'],
    window: w(HEAD.BAND, 0, 0.9),
    walls: [[[232, 232, 228], 2], [[184, 186, 188], 2], [[140, 144, 150], 1]],
  },
  {
    tags: ['constructivism'],
    window: w(HEAD.BAND, 0, 0.65), balconies: true,
    walls: [[[186, 186, 182], 2], [[230, 230, 226], 2], [[160, 84, 64], 1]],
  },
  {
    tags: ['postconstructivism'],
    cornice: { h: 0.45, out: 0.3 }, belts: 1, piers: true,
    window: w(HEAD.FLAT, 0.6, 0.65, FRAME.SURROUND, GLAZING.CROSS), balconies: true,
    walls: [[[184, 182, 176], 2], [[210, 180, 130], 1], [[220, 204, 176], 2]],
  },
  {
    tags: ['stalinist_neoclassicism', 'stalinist_empire', 'socialist_classicism'],
    cornice: { h: 1.0, out: 0.75 }, belts: 1, rust: 2, piers: true,
    window: w(HEAD.FLAT, 0.55, 0.95, FRAME.SANDRIK, GLAZING.CROSS), trim: [236, 228, 210], balconies: true,
    walls: [[[222, 206, 176], 3], [[214, 180, 128], 1], [[214, 180, 160], 1], [[200, 196, 186], 1]],
  },
  {
    tags: ['brutalist', 'brutalism'],
    cornice: { h: 1.0, out: 0.3 },
    window: w(HEAD.FLAT, 0.7, 0.7, FRAME.REVEAL),
    walls: [[[150, 150, 146], 2], [[128, 128, 126], 2], [[168, 166, 160], 1]],
  },
  {
    tags: ['postmodern', 'postmodernism'],
    cornice: { h: 0.5, out: 0.4 }, belts: 1,
    window: w(HEAD.FLAT, 0.55, 0.55, FRAME.SURROUND, GLAZING.CROSS), trim: [240, 232, 214], balconies: true,
    walls: [[[222, 170, 160], 2], [[196, 130, 100], 1], [[234, 222, 196], 2], [[150, 190, 190], 1]],
  },
  {
    tags: ['contemporary'],
    window: w(HEAD.FLAT, 0.7, 0.75), balconies: true, panoramic: true,
    walls: [[[234, 234, 232], 2], [[170, 172, 174], 2], [[80, 82, 86], 1], [[170, 130, 90], 1]],
  },
];

/** index 0: no style */
export const ARCH_PROFILES: ArchProfile[] = DEFS.map((d, i) => ({
  belts: 0, rust: 0, quoins: false, piers: false, varyHeads: false, varyFrames: false, balconies: false, panoramic: false,
  ...d, id: i + 1,
}));

const BY_TAG = new Map<string, ArchProfile>();
for (const p of ARCH_PROFILES) for (const t of p.tags) BY_TAG.set(t, p);

/** the style a building is drawn in without building:architecture, inferred from its start_date (inferArchitecture) */
export const ARCH_INFERRED_TAG = 'sim:architecture';

/**
 * The style a building:architecture value names (first of a `;` list, case and `_`/`-`/space alike),
 * else the inferred one (ARCH_INFERRED_TAG); undefined if none drawn
 */
export function archProfile(tags: Record<string, string>): ArchProfile | undefined {
  const raw = (tags['building:architecture'] ?? tags[ARCH_INFERRED_TAG])?.split(';')[0].trim().toLowerCase();
  if (!raw) return undefined;
  return BY_TAG.get(raw) ?? BY_TAG.get(raw.replace(/[\s-]+/g, '_')) ?? BY_TAG.get(raw.replace(/[\s_]+/g, '-'));
}

/** a pane's max half-height on a floor `fh` high (WORLD_FS windowAt, the same formula) */
export function paneHalfHeight(p: ArchProfile, fh: number): number {
  return Math.min(p.window.h, 0.38 * fh);
}

/** belt courses: their height, how far they stand out, how far below the floor line they start (m) */
export const BELT = { H: 0.22, OUT: 0.08, BELOW: 0.06 } as const;

const f = (v: number) => v.toFixed(3);
const list = <T>(type: string, xs: T[], fmt: (x: T) => string) => `const ${type}[${xs.length}] = ${type.split(' ')[0]}[${xs.length}](${xs.map(fmt).join(', ')})`;
const all = [undefined, ...ARCH_PROFILES];
/** the profiles as GLSL constant arrays, indexed by profile (WORLD_FS windowAt; 0: no style) */
export const ARCH_GLSL = [
  list('uint ARCH_HEAD', all, (p) => `${p?.window.head ?? 0}u`),
  list('float ARCH_W', all, (p) => f(p?.window.w ?? 0)),
  list('float ARCH_H', all, (p) => f(p?.window.h ?? 0)),
  list('uint ARCH_FRAME', all, (p) => `${p?.window.frame ?? 0}u`),
  list('uint ARCH_GLAZE', all, (p) => `${p?.window.glazing ?? 0}u`),
  list('float ARCH_RUST', all, (p) => f(p?.rust ?? 0)),
  // bits: 1 quoins, 2 piers, 4 vary heads, 8 vary frames
  list('uint ARCH_BITS', all, (p) => `${p ? (p.quoins ? 1 : 0) | (p.piers ? 2 : 0) | (p.varyHeads ? 4 : 0) | (p.varyFrames ? 8 : 0) : 0}u`),
  // the trim colour 0..1, x < 0: the wall's, lighter
  list('vec3 ARCH_TRIM', all, (p) => (p?.trim ? `vec3(${p.trim.map((c) => f(c / 255)).join(', ')})` : 'vec3(-1.0)')),
].join(';\n') + ';';

/**
 * The former USSR, coarsely (lon, lat): where 1925–1955 means constructivism and Stalinist classicism
 * rather than functionalism and art deco. Its western border as of 1945–1991 (the Baltic states, Kaliningrad,
 * western Ukraine and Moldova in, Finland, Poland and Romania out), its southern one along Turkey, Iran,
 * Afghanistan, China and Mongolia; the open sea round it is in, Chukotka beyond 180° out.
 */
const SOVIET_BORDER: [number, number][] = [
  [20.0, 54.4], [22.8, 54.4], [23.5, 53.9], [23.9, 52.7], [23.6, 51.5], [24.0, 50.4], [22.6, 49.1], [22.1, 48.4],
  [22.9, 47.9], [24.9, 47.7], [26.6, 48.3], [28.2, 45.5], [29.7, 45.2], [31.0, 43.0], [41.5, 41.5], [43.5, 41.1],
  [44.8, 39.7], [46.5, 38.9], [48.0, 38.4], [53.9, 37.3], [57.0, 38.2], [61.1, 36.6], [62.5, 35.3], [64.5, 37.2],
  [67.8, 37.2], [70.0, 37.5], [71.5, 36.7], [74.9, 37.2], [75.0, 39.5], [80.2, 42.0], [80.0, 45.0], [82.5, 45.2],
  [87.3, 49.1], [98.0, 50.0], [106.0, 50.3], [116.7, 49.8], [119.5, 53.3], [127.5, 49.8], [134.7, 48.3], [131.0, 44.8],
  [130.6, 42.4], [141.0, 45.5], [145.0, 43.5], [180.0, 60.0], [180.0, 82.0], [33.0, 82.0], [31.1, 69.8], [28.9, 69.0],
  [29.4, 66.9], [30.0, 63.0], [31.6, 62.9], [27.8, 60.5], [23.0, 59.6], [21.0, 57.5],
];

function inRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** where a building stands, as far as its style goes */
export type ArchRegion = 'soviet' | 'british' | 'west';
export function archRegion(lon: number, lat: number): ArchRegion {
  if (inRing(lon, lat, SOVIET_BORDER)) return 'soviet';
  // Great Britain and Ireland
  if (lon > -10.6 && lon < 1.8 && lat > 49.8 && lat < 60.9) return 'british';
  return 'west';
}

/** styles of a period, [style, weight]; a building draws one by its seed */
type Era = { from: number; to: number; styles: [string, number][] };
const any = (...s: [string, number][]) => s;
/** multi-storey town buildings (apartments, offices, shops, public buildings) by the year they were built */
const TOWN_ERAS: Record<ArchRegion, Era[]> = {
  soviet: [
    { from: 1760, to: 1800, styles: any(['neoclassicism', 1]) },
    { from: 1800, to: 1835, styles: any(['empire', 1], ['neoclassicism', 1]) },
    { from: 1835, to: 1898, styles: any(['eclectic', 3], ['neo-renaissance', 1], ['pseudo-russian', 1]) },
    { from: 1898, to: 1910, styles: any(['art_nouveau', 3], ['eclectic', 2]) },
    { from: 1910, to: 1918, styles: any(['art_nouveau', 2], ['neoclassicism', 2], ['eclectic', 1]) },
    { from: 1918, to: 1933, styles: any(['constructivism', 1]) },
    { from: 1933, to: 1937, styles: any(['postconstructivism', 1]) },
    { from: 1937, to: 1956, styles: any(['stalinist_neoclassicism', 1]) },
  ],
  british: [
    { from: 1714, to: 1837, styles: any(['georgian', 1]) },
    { from: 1837, to: 1901, styles: any(['victorian', 4], ['neo-gothic', 1]) },
    { from: 1901, to: 1918, styles: any(['eclectic', 2], ['art_nouveau', 1]) },
    { from: 1918, to: 1940, styles: any(['art_deco', 1], ['functionalism', 1]) },
    { from: 1945, to: 1980, styles: any(['modern', 3], ['brutalist', 1]) },
    { from: 1980, to: 2000, styles: any(['postmodern', 1], ['modern', 1]) },
  ],
  west: [
    { from: 1760, to: 1840, styles: any(['neoclassicism', 1]) },
    { from: 1840, to: 1895, styles: any(['eclectic', 2], ['neo-renaissance', 2], ['neo-baroque', 1]) },
    { from: 1895, to: 1915, styles: any(['art_nouveau', 3], ['eclectic', 2]) },
    { from: 1915, to: 1940, styles: any(['functionalism', 2], ['art_deco', 2], ['new_objectivity', 1]) },
    { from: 1945, to: 1980, styles: any(['modern', 3], ['international_style', 1], ['brutalist', 1]) },
    { from: 1980, to: 2000, styles: any(['postmodern', 1], ['modern', 1]) },
  ],
};
/** churches and other places of worship */
const SACRED_ERAS: Record<ArchRegion, Era[]> = {
  soviet: [
    { from: 1760, to: 1835, styles: any(['neoclassicism', 1]) },
    { from: 1835, to: 1918, styles: any(['pseudo-russian', 3], ['neo-byzantine', 2]) },
  ],
  british: [{ from: 1820, to: 1914, styles: any(['neo-gothic', 3], ['neo-romanesque', 1]) }],
  west: [{ from: 1830, to: 1914, styles: any(['neo-gothic', 2], ['neo-romanesque', 1], ['neo-byzantine', 1]) }],
};
/** Soviet public buildings of the late years: concrete */
const SOVIET_PUBLIC_LATE: Era = { from: 1965, to: 1991, styles: any(['brutalist', 1]) };

const TOWN_TYPES = new Set([
  'apartments', 'residential', 'dormitory', 'terrace', 'commercial', 'office', 'retail', 'hotel', 'yes', 'civic',
  'public', 'government', 'townhall', 'school', 'university', 'college', 'hospital', 'train_station', 'museum', 'theatre',
]);
const PUBLIC_TYPES = new Set(['civic', 'public', 'government', 'townhall', 'university', 'college', 'hospital', 'museum', 'theatre']);
const SACRED_TYPES = new Set(['church', 'cathedral', 'chapel', 'temple', 'synagogue', 'religious', 'monastery']);
/** town buildings this many levels and up (or this many metres high) get a style: not a cottage or a shed */
export const INFER_MIN = { LEVELS: 2, HEIGHT_M: 6 } as const;

/**
 * The style a building without building:architecture is drawn in, from the year of its start_date
 * (the first four digits; "C19" has none) and where it stands (archRegion): for multi-storey town
 * buildings (TOWN_TYPES, INFER_MIN) by TOWN_ERAS, the late Soviet public ones brutalist, for places of
 * worship by SACRED_ERAS; within an era one of its styles by `seed` (0..1). Undefined: no style
 * (houses, sheds, industry, buildings after 2000 or of a period without a style here).
 */
export function inferArchitecture(tags: Record<string, string>, lon: number, lat: number, seed: number): string | undefined {
  if (tags['building:architecture']) return undefined;
  const year = Number(tags.start_date?.match(/\d{4}/)?.[0]);
  if (!Number.isFinite(year)) return undefined;
  // a part of a building: the building's type (STYLE_TYPE_TAG), so its parts are drawn in its style
  const type = tags[STYLE_TYPE_TAG] || (tags['building:part'] && tags['building:part'] !== 'yes' ? tags['building:part'] : tags.building);
  const region = archRegion(lon, lat);
  let eras: Era[];
  // a place of worship tagged on a plain building, or a part of one (its religion is its outline's: overpass SHARED_STYLE_KEYS)
  const worship = tags.amenity === 'place_of_worship' || (tags['building:part'] !== undefined && tags.religion !== undefined);
  if (SACRED_TYPES.has(type) || (worship && (type === 'yes' || !TOWN_TYPES.has(type)))) eras = SACRED_ERAS[region];
  else if (TOWN_TYPES.has(type)) {
    const levels = Number(tags['building:levels']), height = parseFloat(tags.height);
    // a building=yes or residential of unknown size may be a shed: only with its levels or height told
    const untold = !Number.isFinite(levels) && !Number.isFinite(height) && type !== 'yes' && type !== 'residential';
    const tall = levels >= INFER_MIN.LEVELS || height >= INFER_MIN.HEIGHT_M || untold;
    if (!tall) return undefined;
    eras = region === 'soviet' && PUBLIC_TYPES.has(type) ? [...TOWN_ERAS.soviet, SOVIET_PUBLIC_LATE] : TOWN_ERAS[region];
  } else return undefined;
  const era = eras.find((e) => year >= e.from && year < e.to);
  if (!era) return undefined;
  const total = era.styles.reduce((s, [, w]) => s + w, 0);
  let x = (((seed * 48271) % 1) + 1) % 1 * total; // a draw decorrelated from the colours'
  for (const [style, w] of era.styles) {
    if (x < w) return style;
    x -= w;
  }
  return era.styles[era.styles.length - 1][0];
}
