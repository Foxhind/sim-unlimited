import type { LatLon } from './geodesy';
import { STAR_CATALOG } from './star-catalog';
import { daysSinceJ2000, gmstDeg } from './sun';

/**
 * The night sky: the catalogue stars (star-catalog.ts, J2000) and the five naked-eye planets, as
 * J2000 equatorial unit vectors, and the matrix that turns those into world directions
 * [east, up, -north] for a place and time (precession to the date, then the local horizon).
 */

const D2R = Math.PI / 180;
const ARCSEC = D2R / 3600;
/** obliquity of the ecliptic at J2000 */
const EPS_J2000 = 23.43928 * D2R;

/** floats per sky point in the vertex buffer: J2000 direction xyz, V magnitude, colour rgb 0..1 */
export const SKY_POINT_FLOATS = 7;

type M3 = [number, number, number, number, number, number, number, number, number];
const mul = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
};
/** active rotation about z by `a` rad (row-major) */
const rotZ = (a: number): M3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** IAU 1976 precession, J2000 mean equator → mean equator of date (Meeus 21.2–21.4), row-major */
export function precessionMatrix(n: number): M3 {
  const T = n / 36525;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * ARCSEC;
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * ARCSEC;
  const ry: M3 = [Math.cos(th), 0, -Math.sin(th), 0, 1, 0, Math.sin(th), 0, Math.cos(th)];
  return mul(rotZ(z), mul(ry, rotZ(zeta)));
}

/**
 * J2000 equatorial unit vector → world direction [east, up, -north] at `loc`, `date`; row-major.
 * Equator of date turned by the local sidereal time so x points at the meridian and y east, then
 * tilted by the latitude.
 */
export function skyMatrix(date: Date, loc: LatLon): M3 {
  const n = daysSinceJ2000(date);
  const lst = (gmstDeg(n) + loc.lon) * D2R;
  const lat = loc.lat * D2R;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const horizon: M3 = [0, 1, 0, cl, 0, sl, sl, 0, -cl];
  return mul(horizon, mul(rotZ(-lst), precessionMatrix(n)));
}

/** row-major M3 → column-major Float32Array for a GLSL mat3 */
export function toGlMat3(m: M3, out = new Float32Array(9)): Float32Array {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[j * 3 + i] = m[i * 3 + j];
  return out;
}

export const applyM3 = (m: M3, v: readonly number[]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** unit vector of RA / Dec in degrees */
export function radec(raDeg: number, decDeg: number): [number, number, number] {
  const a = raDeg * D2R, d = decDeg * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** star colour from B-V (Ballesteros temperature, then a blackbody fit), softened toward white */
export function bvToRgb(bv: number): [number, number, number] {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62)) / 100;
  const c = (x: number): number => Math.max(0, Math.min(1, x / 255));
  const r = t <= 66 ? 1 : c(329.698727446 * (t - 60) ** -0.1332047592);
  const g = t <= 66 ? c(99.4708025861 * Math.log(t) - 161.1195681661) : c(288.1221695283 * (t - 60) ** -0.0755148492);
  const bl = t >= 66 ? 1 : t <= 19 ? 0 : c(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  const soft = 0.45;
  return [r + (1 - r) * soft, g + (1 - g) * soft, bl + (1 - bl) * soft];
}

export interface Planet {
  name: 'Mercury' | 'Venus' | 'Mars' | 'Jupiter' | 'Saturn';
  /** geocentric J2000 equatorial unit vector */
  dir: [number, number, number];
  /** apparent V magnitude */
  mag: number;
  /** distance from the Earth, AU */
  distAU: number;
}

// JPL "Keplerian Elements for Approximate Positions of the Major Planets" (Standish), table 1, 1800–2050:
// a AU, e, I deg, L deg, long. perihelion deg, long. node deg; each [value at J2000, rate per century]
type Elements = readonly [number, number][];
const ORBITS: Record<Planet['name'] | 'Earth', Elements> = {
  Mercury: [[0.38709927, 0.00000037], [0.20563593, 0.00001906], [7.00497902, -0.00594749], [252.2503235, 149472.67411175], [77.45779628, 0.16047689], [48.33076593, -0.12534081]],
  Venus: [[0.72333566, 0.0000039], [0.00677672, -0.00004107], [3.39467605, -0.0007889], [181.9790995, 58517.81538729], [131.60246718, 0.00268329], [76.67984255, -0.27769418]],
  Earth: [[1.00000261, 0.00000562], [0.01671123, -0.00004392], [-0.00001531, -0.01294668], [100.46457166, 35999.37244981], [102.93768193, 0.32327364], [0, 0]],
  Mars: [[1.52371034, 0.00001847], [0.0933941, 0.00007882], [1.84969142, -0.00813131], [-4.55343205, 19140.30268499], [-23.94362959, 0.44441088], [49.55953891, -0.29257343]],
  Jupiter: [[5.202887, -0.00011607], [0.04838624, -0.00013253], [1.30439695, -0.00183714], [34.39644051, 3034.74612775], [14.72847983, 0.21252668], [100.47390909, 0.20469106]],
  Saturn: [[9.53667594, -0.0012506], [0.05386179, -0.00050991], [2.48599187, 0.00193609], [49.95424423, 1222.49362201], [92.59887831, -0.41897216], [113.66242448, -0.28867794]],
};

/** heliocentric J2000 ecliptic position, AU */
function heliocentric(el: Elements, T: number): [number, number, number] {
  const [a, e, I, L, wbar, node] = el.map(([v, r]) => v + r * T);
  const w = (wbar - node) * D2R;
  const O = node * D2R;
  const i = I * D2R;
  const M = ((((L - wbar) % 360) + 540) % 360 - 180) * D2R;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i);
  return [
    (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp,
    (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

/** apparent magnitude from the distances (AU) and the phase angle (deg); Mallama & Hilton 2018, simplified */
function magnitude(name: Planet['name'], r: number, d: number, a: number, ringTilt: number): number {
  const base = 5 * Math.log10(r * d);
  switch (name) {
    case 'Mercury': return -0.613 + base + 0.06328 * a - 0.0016336 * a ** 2 + 0.000033644 * a ** 3 - 3.4565e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6;
    case 'Venus': return a < 163.7
      ? -4.384 + base - 0.001044 * a + 0.0003687 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4
      : 236.05828 + base - 2.81914 * a + 0.00839034 * a ** 2;
    case 'Mars': return -1.601 + base + 0.02267 * a - 0.0001302 * a ** 2;
    case 'Jupiter': return -9.395 + base - 0.00037 * a + 0.000616 * a ** 2;
    case 'Saturn': {
      const sb = Math.abs(Math.sin(ringTilt));
      return -8.914 + base - 1.825 * sb + 0.026 * a - 0.378 * sb * Math.exp(-2.25 * a);
    }
  }
}

export const PLANET_NAMES: readonly Planet['name'][] = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
/** how each planet looks to the eye */
export const PLANET_RGB: Record<Planet['name'], [number, number, number]> = {
  Mercury: [0.95, 0.9, 0.85],
  Venus: [1, 0.98, 0.9],
  Mars: [1, 0.62, 0.42],
  Jupiter: [1, 0.95, 0.85],
  Saturn: [1, 0.92, 0.72],
};

/** Saturn's north pole (IAU, J2000 equatorial) */
const SATURN_POLE = radec(40.589, 83.537);

/** geocentric planets for `date` (no light time, aberration or nutation: ~1′, far below a pixel) */
export function planetPositions(date: Date): Planet[] {
  const T = daysSinceJ2000(date) / 36525;
  const earth = heliocentric(ORBITS.Earth, T);
  const R = Math.hypot(...earth);
  return PLANET_NAMES.map((name) => {
    const h = heliocentric(ORBITS[name], T);
    const g = [h[0] - earth[0], h[1] - earth[1], h[2] - earth[2]];
    const d = Math.hypot(g[0], g[1], g[2]);
    const r = Math.hypot(...h);
    const phase = Math.acos(Math.max(-1, Math.min(1, (r * r + d * d - R * R) / (2 * r * d)))) / D2R;
    // ecliptic → equatorial, J2000
    const c = Math.cos(EPS_J2000), s = Math.sin(EPS_J2000);
    const dir: [number, number, number] = [g[0] / d, (g[1] * c - g[2] * s) / d, (g[1] * s + g[2] * c) / d];
    // the rings' tilt toward the eye: Saturn's pole against the line of sight
    const tilt = Math.asin(Math.abs(dir[0] * SATURN_POLE[0] + dir[1] * SATURN_POLE[1] + dir[2] * SATURN_POLE[2]));
    return { name, dir, mag: magnitude(name, r, d, phase, tilt), distAU: d };
  });
}

/**
 * The vertex data of the sky points: every catalogue star, then PLANET_NAMES.length planet slots
 * (fill them with writePlanets). SKY_POINT_FLOATS per point.
 */
export function buildSkyPoints(): Float32Array {
  const stars = STAR_CATALOG.length / 4;
  const out = new Float32Array((stars + PLANET_NAMES.length) * SKY_POINT_FLOATS);
  for (let i = 0; i < stars; i++) {
    const [ra, dec, mag, bv] = STAR_CATALOG.slice(i * 4, i * 4 + 4);
    out.set([...radec(ra, dec), mag, ...bvToRgb(bv)], i * SKY_POINT_FLOATS);
  }
  return out;
}

/** first float of the planet slots in buildSkyPoints' data */
export const PLANETS_OFFSET = (STAR_CATALOG.length / 4) * SKY_POINT_FLOATS;

/** the planets' points (dir, mag, rgb) for `date`, laid out like buildSkyPoints */
export function planetPoints(date: Date, out: Float32Array<ArrayBuffer> = new Float32Array(PLANET_NAMES.length * SKY_POINT_FLOATS)): Float32Array<ArrayBuffer> {
  planetPositions(date).forEach((p, i) => out.set([...p.dir, p.mag, ...PLANET_RGB[p.name]], i * SKY_POINT_FLOATS));
  return out;
}

/**
 * Faintest magnitude the eye picks out against the sky: by the sun's elevation (none by day but
 * Venus at her brightest, ~2 at civil dusk, 5.5 in full darkness), less under a bright moon.
 */
export function limitingMagnitude(sunElevDeg: number, moonElevDeg: number, moonIllum: number): number {
  const keys: [number, number][] = [[6, -5], [0, -3.5], [-6, 2], [-12, 4.6], [-18, 5.5]];
  let lim = keys[keys.length - 1][1];
  if (sunElevDeg >= keys[0][0]) lim = keys[0][1];
  else {
    for (let i = 1; i < keys.length; i++) {
      const [e0, m0] = keys[i - 1], [e1, m1] = keys[i];
      if (sunElevDeg >= e1) { lim = m0 + (m1 - m0) * (sunElevDeg - e0) / (e1 - e0); break; }
    }
  }
  const moonUp = Math.max(0, Math.min(1, (moonElevDeg + 1) / 6));
  return lim - 1.2 * moonIllum * moonUp;
}
