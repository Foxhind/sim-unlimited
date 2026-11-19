import { latLonToEnu, type LatLon } from '../world/geodesy';

/**
 * Radio navigation: VOR/DME, NDB and ILS stations and what a receiver on board reads from them.
 *
 * There is no worldwide navaid database in the sim, so stations are generated from what it knows:
 * an ICAO airport gets a VOR/DME on its reference point, a smaller airfield an NDB, and every long
 * paved runway an ILS on each end (localizer down the centreline, 3 deg glide slope). Frequencies
 * and idents are made up but stable (hashed from the station), in the real bands. Courses are true.
 */

export type NavKind = 'VOR' | 'NDB' | 'ILS';

export interface Navaid {
  /** unique key (also what deduplicates repeated adds) */
  id: string;
  kind: NavKind;
  /** Morse ident, 2–4 letters */
  ident: string;
  /** airfield code or name it belongs to */
  name: string;
  /** MHz for VOR and ILS, kHz for NDB */
  freq: number;
  /** station position; for an ILS the landing threshold */
  lat: number;
  lon: number;
  dme: boolean;
  /** nominal service range, m */
  rangeM: number;
  /** ILS: the true course flown on final, deg */
  course?: number;
  /** ILS: runway designator, e.g. "26" */
  rwy?: string;
  lenM?: number;
  widthM?: number;
  /** ILS: threshold elevation, m (filled from the terrain when known) */
  elev?: number;
}

export const GLIDE_DEG = 3;
/** glide-slope antenna (and the autoland aim point) this far past the threshold, m */
export const GS_ANTENNA_M = 300;
const VOR_DEG_PER_DOT = 2;
const LOC_DEG_PER_DOT = 1.25;
const GS_DEG_PER_DOT = 0.35;
const VOR_RANGE_M = 200000;
const NDB_RANGE_M = 90000;
const ILS_RANGE_M = 46000;
const GS_RANGE_M = 18500;
/** the localizer is usable within this angle either side of the course */
const LOC_SECTOR_DEG = 35;

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/** signed difference a - b wrapped to (-180, 180] */
export function angDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}
const norm360 = (a: number): number => ((a % 360) + 360) % 360;

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** VOR band above the ILS one: 112.00–117.95 MHz in 50 kHz steps */
export function vorFreq(key: string): number {
  return Math.round((112 + (hash(key) % 120) * 0.05) * 100) / 100;
}
/** ILS localizer channels: 108.10–111.95 MHz, odd tenths (x.10, x.15, x.30, x.35 ...) */
export function ilsFreq(key: string): number {
  const ch = hash(key) % 40; // 4 MHz x 5 odd tenths x 2
  const mhz = 108 + Math.floor(ch / 10);
  const tenth = [1, 3, 5, 7, 9][Math.floor((ch % 10) / 2)];
  return Math.round((mhz + tenth / 10 + (ch % 2) * 0.05) * 100) / 100;
}
/** NDB: 200–495 kHz in 5 kHz steps */
export function ndbFreq(key: string): number {
  return 200 + (hash(key) % 60) * 5;
}

function letters(s: string, n: number, salt: string): string {
  const clean = s.toUpperCase().replace(/[^A-Z]/g, '');
  if (clean.length >= n) return clean.slice(0, n);
  let h = hash(s + salt);
  let out = clean;
  while (out.length < n) {
    out += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + 7;
  }
  return out;
}

/** true heading from a to b over the ground, deg */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const [e, n] = latLonToEnu(a, b.lat, b.lon, 0);
  return norm360(Math.atan2(e, n) * R2D);
}

/** a point `dist` m from `p` along true heading `hdg` */
export function offsetLatLon(p: LatLon, hdg: number, dist: number): LatLon {
  const dn = Math.cos(hdg * D2R) * dist;
  const de = Math.sin(hdg * D2R) * dist;
  return {
    lat: p.lat + dn / 111320,
    lon: p.lon + de / (111320 * Math.max(0.2, Math.cos(p.lat * D2R))),
  };
}

export interface Reception {
  nav: Navaid;
  inRange: boolean;
  /** ground distance to the station (ILS: to the threshold), m */
  distM: number;
  /** DME slant range, m */
  slantM: number;
  /** true bearing from the aircraft to the station */
  bearing: number;
  /** true bearing from the station to the aircraft */
  radial: number;
}

/** radio horizon of a receiver at altM over a station near the ground, m */
export function radioHorizonM(altM: number): number {
  return 4120 * (Math.sqrt(Math.max(0, altM)) + Math.sqrt(10));
}

export function receive(nav: Navaid, own: LatLon, altM: number): Reception {
  const [e, n] = latLonToEnu(own, nav.lat, nav.lon, 0);
  const distM = Math.hypot(e, n);
  const bearing = norm360(Math.atan2(e, n) * R2D);
  const radial = norm360(bearing + 180);
  const slantM = Math.hypot(distM, altM - (nav.elev ?? 0));
  let inRange = distM <= Math.min(nav.rangeM, radioHorizonM(altM - (nav.elev ?? 0)));
  if (nav.kind === 'ILS' && inRange) {
    // the localizer radiates down the approach: only inside its sector ahead of the threshold
    inRange = Math.abs(angDiff(radial, nav.course! + 180)) < LOC_SECTOR_DEG || distM < 2000;
  }
  return { nav, inRange, distM, slantM, bearing, radial };
}

export interface Cdi {
  /** course the needle is referenced to, deg true */
  course: number;
  /** needle deflection in dots: + means the course is to the right (fly right); clamped to the scale */
  dots: number;
  /** deflection limit of this scale, dots */
  fullScale: number;
  toFrom: 'TO' | 'FROM' | '';
  /** cross-track distance, m: + means the aircraft is right of the course line */
  xtkM: number;
  /** ILS: glide-slope deflection, dots, + means the glide path is above (fly up); undefined without a GS signal */
  gsDots?: number;
  /** ILS: distance along the course to the threshold, m (negative past it) */
  thrDistM?: number;
}

/**
 * Course deviation: a VOR with its selected course (OBS), or an ILS on its own course.
 * The ILS localizer is referenced to its antenna past the far end of the runway and the glide
 * slope to its antenna GS_ANTENNA_M past the threshold, as on the real thing.
 */
export function cdi(rx: Reception, obs: number, own: LatLon, altM: number): Cdi {
  const nav = rx.nav;
  if (nav.kind === 'ILS') {
    const course = nav.course!;
    const thr: LatLon = { lat: nav.lat, lon: nav.lon };
    const loc = offsetLatLon(thr, course, (nav.lenM ?? 2500) + 300);
    const [le, ln] = latLonToEnu(own, loc.lat, loc.lon, 0);
    const toLoc = Math.atan2(le, ln) * R2D;
    // the aircraft is on the course when the localizer is dead ahead along it
    const devDeg = angDiff(toLoc, course);
    const locDist = Math.hypot(le, ln);
    const xtkM = -Math.sin(devDeg * D2R) * locDist;
    const [te, tn] = latLonToEnu(own, thr.lat, thr.lon, 0);
    const thrDistM = te * Math.sin(course * D2R) + tn * Math.cos(course * D2R);
    const gsDist = thrDistM + GS_ANTENNA_M;
    let gsDots: number | undefined;
    if (rx.inRange && gsDist > 0 && gsDist < GS_RANGE_M && Math.abs(devDeg) < 8) {
      const ang = Math.atan2(altM - (nav.elev ?? 0), gsDist) * R2D;
      gsDots = Math.max(-2.5, Math.min(2.5, (GLIDE_DEG - ang) / GS_DEG_PER_DOT));
    }
    const dots = Math.max(-2.5, Math.min(2.5, devDeg / LOC_DEG_PER_DOT));
    return { course, dots, fullScale: 2, toFrom: '', xtkM, gsDots, thrDistM };
  }
  if (nav.kind === 'NDB') {
    return { course: obs, dots: 0, fullScale: 5, toFrom: '', xtkM: 0 };
  }
  const off = angDiff(rx.radial, obs);
  const to = Math.abs(off) > 90;
  // FROM: the radial must equal the course; TO: the reciprocal of it
  const devDeg = to ? angDiff(rx.radial, obs + 180) : -off;
  const xtkM = -Math.sin(devDeg * D2R) * rx.distM;
  const dots = Math.max(-5.5, Math.min(5.5, devDeg / VOR_DEG_PER_DOT));
  // right over the station the flag drops
  const toFrom = rx.distM < 300 ? '' : to ? 'TO' : 'FROM';
  return { course: obs, dots, fullScale: 5, toFrom, xtkM };
}

/** the shape of a map feature the db makes stations for (minimap/map-features.ts) */
export interface AirfieldLike {
  kind: string;
  lat: number;
  lon: number;
  code?: string;
  name?: string;
}

export const PAVED_MIN_ILS_M = 1200;
const UNPAVED = /^(grass|dirt|earth|ground|gravel|sand|unpaved|compacted|fine_gravel|mud|snow|ice)$/;

export class NavDb {
  private readonly items = new Map<string, Navaid>();
  /** bumped on every new station, so views can cache */
  version = 0;

  all(): Navaid[] {
    return [...this.items.values()];
  }

  get(id: string): Navaid | undefined {
    return this.items.get(id);
  }

  add(n: Navaid): boolean {
    if (this.items.has(n.id)) return false;
    this.items.set(n.id, n);
    this.version++;
    return true;
  }

  /** VOR/DME for an airport with an ICAO code, NDB for a smaller airfield; heliports get nothing */
  addAirfield(f: AirfieldLike): void {
    if (f.kind === 'airport' && f.code) {
      const id = `VOR|${f.code}`;
      this.add({
        id, kind: 'VOR', ident: letters(f.code.length === 4 ? f.code.slice(1) : f.code, 3, id), name: f.code,
        freq: vorFreq(id), lat: f.lat, lon: f.lon, dme: true, rangeM: VOR_RANGE_M,
      });
    } else if (f.kind === 'airfield' && (f.code || f.name)) {
      const label = f.code ?? f.name!;
      const id = `NDB|${label}|${f.lat.toFixed(3)}|${f.lon.toFixed(3)}`;
      this.add({
        id, kind: 'NDB', ident: letters(label.length === 4 && f.code ? label.slice(2) : label, 2, id), name: label.toUpperCase(),
        freq: ndbFreq(id), lat: f.lat, lon: f.lon, dme: false, rangeM: NDB_RANGE_M,
      });
    }
  }

  /** an ILS onto a runway threshold, unless one already serves (nearly) the same threshold and course */
  addIls(o: { name: string; lat: number; lon: number; course: number; lenM: number; widthM?: number; rwy?: string }): Navaid | null {
    for (const n of this.items.values()) {
      if (n.kind !== 'ILS') continue;
      const [e, nn] = latLonToEnu(o, n.lat, n.lon, 0);
      if (Math.hypot(e, nn) < 500 && Math.abs(angDiff(n.course!, o.course)) < 12) return null;
    }
    const rwy = o.rwy ?? String(Math.round(norm360(o.course) / 10) || 36).padStart(2, '0');
    const id = `ILS|${o.name}|${rwy}|${o.lat.toFixed(4)}|${o.lon.toFixed(4)}`;
    const n: Navaid = {
      id, kind: 'ILS', ident: `I${letters(o.name.length === 4 ? o.name.slice(1) : o.name, 3, id)}`, name: o.name,
      freq: ilsFreq(id), lat: o.lat, lon: o.lon, dme: true, rangeM: ILS_RANGE_M,
      course: norm360(o.course), rwy, lenM: o.lenM, widthM: o.widthM ?? 45,
    };
    return this.add(n) ? n : null;
  }

  /**
   * An ILS on each end of an OSM runway centreline long and paved enough for one. `name` is the
   * airfield it belongs to (nearest known one), or a made-up name from the runway itself.
   */
  addRunway(points: [number, number][], tags: Record<string, string>, name?: string): void {
    if (points.length < 2 || UNPAVED.test(tags.surface ?? '')) return;
    const a: LatLon = { lat: points[0][1], lon: points[0][0] };
    const b: LatLon = { lat: points[points.length - 1][1], lon: points[points.length - 1][0] };
    const [e, n] = latLonToEnu(a, b.lat, b.lon, 0);
    const len = Math.hypot(e, n);
    if (len < PAVED_MIN_ILS_M) return;
    const hdgAB = norm360(Math.atan2(e, n) * R2D);
    const width = parseFloat(tags.width ?? '') || 45;
    const refs = (tags.ref ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    const label = name ?? `RW${refs[0] ?? Math.round(hdgAB / 10)}`;
    const desig = (course: number): string | undefined => {
      const want = Math.round(course / 10) || 36;
      // OSM "08/26": pick the one closest to the course (they are magnetic, ours are true)
      let best: string | undefined;
      let bestD = 4;
      for (const r of refs) {
        const num = parseInt(r, 10);
        if (Number.isNaN(num)) continue;
        const d = Math.abs(angDiff(num * 10, want * 10)) / 10;
        if (d < bestD) { bestD = d; best = r; }
      }
      return best;
    };
    this.addIls({ name: label, lat: a.lat, lon: a.lon, course: hdgAB, lenM: len, widthM: width, rwy: desig(hdgAB) });
    const back = norm360(hdgAB + 180);
    this.addIls({ name: label, lat: b.lat, lon: b.lon, course: back, lenM: len, widthM: width, rwy: desig(back) });
  }

  /** stations of the given kinds in range of the aircraft, nearest first */
  inRange(own: LatLon, altM: number, kinds: NavKind[]): Reception[] {
    const out: Reception[] = [];
    for (const n of this.items.values()) {
      if (!kinds.includes(n.kind)) continue;
      const rx = receive(n, own, altM);
      if (rx.inRange) out.push(rx);
    }
    return out.sort((p, q) => p.distM - q.distM);
  }
}

/** frequency as the radio shows it */
export function freqText(n: Navaid): string {
  return n.kind === 'NDB' ? String(Math.round(n.freq)) : n.freq.toFixed(2);
}

/** "08", "26L": the runway end's designator, or the course rounded */
export function rwyText(n: Navaid): string {
  return n.rwy ?? String(Math.round((n.course ?? 0) / 10) || 36).padStart(2, '0');
}
