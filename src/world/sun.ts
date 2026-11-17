import type { LatLon } from './geodesy';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const AU_KM = 149597870.7;
const EARTH_RADIUS_KM = 6378.14;

const norm360 = (x: number): number => ((x % 360) + 360) % 360;

export interface SunState {
  /** unit vector toward the sun in world axes [east, up, -north] */
  dir: [number, number, number];
  elevationDeg: number;
}

export interface MoonState {
  /** unit vector toward the moon in world axes [east, up, -north] (topocentric) */
  dir: [number, number, number];
  elevationDeg: number;
  /** illuminated fraction of the disc, 0 (new) .. 1 (full) */
  illumination: number;
  /** position in the synodic month, 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter */
  phase: number;
}

/** Days since J2000.0 (UT; ΔT ≈ 70 s is far below the accuracy of these models). */
export function daysSinceJ2000(date: Date): number {
  return date.getTime() / 86400000 - 10957.5;
}

function obliquity(n: number): number {
  return (23.439 - 0.0000004 * n) * D2R;
}

/** Sun ecliptic longitude (rad) and distance (AU); NOAA low-precision series, ~0.01° for 1950–2100. */
function sunEcliptic(n: number): { lambda: number; distAU: number } {
  const L = norm360(280.46 + 0.9856474 * n);
  const g = norm360(357.528 + 0.9856003 * n) * D2R;
  return {
    lambda: (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R,
    distAU: 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g),
  };
}

/** Equatorial (RA deg, Dec rad) → local horizontal at `loc`, optional parallax lowering of the altitude (rad). */
/** Greenwich mean sidereal time, degrees 0..360, `n` days since J2000 */
export function gmstDeg(n: number): number {
  return ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24 * 15;
}

function toHorizontal(
  raDeg: number, decRad: number, n: number, loc: LatLon, parallaxRad = 0,
): { dir: [number, number, number]; elevationDeg: number } {
  const gmst = gmstDeg(n);
  const H = (((gmst + loc.lon - raDeg) % 360 + 540) % 360 - 180) * D2R;
  const lat = loc.lat * D2R;
  let elevation = Math.asin(Math.sin(lat) * Math.sin(decRad) + Math.cos(lat) * Math.cos(decRad) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(decRad) * Math.cos(lat)) + Math.PI;
  elevation -= parallaxRad * Math.cos(elevation);
  const ce = Math.cos(elevation);
  return {
    dir: [ce * Math.sin(azimuth), Math.sin(elevation), -ce * Math.cos(azimuth)],
    elevationDeg: elevation * R2D,
  };
}

/** Low-precision NOAA solar position (±0.5° — plenty for palette keyframing). */
export function sunPosition(date: Date, loc: LatLon): SunState {
  const n = daysSinceJ2000(date);
  const { lambda } = sunEcliptic(n);
  const eps = obliquity(n);
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D;
  return toHorizontal(ra, decl, n, loc);
}

// Meeus, "Astronomical Algorithms" ch. 47, largest periodic terms.
// Rows: [D, M, M', F, Σl (1e-6 deg, sin), Σr (1e-3 km, cos)]
const MOON_LR: readonly (readonly number[])[] = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
];
// Rows: [D, M, M', F, Σb (1e-6 deg, sin)]
const MOON_B: readonly (readonly number[])[] = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
];

/** Geocentric ecliptic longitude/latitude (deg) and distance (km) of the Moon, mean equinox of date. */
export function moonEcliptic(n: number): { lon: number; lat: number; distKm: number } {
  const T = n / 36525;
  const Lp = norm360(218.3164477 + 481267.88123421 * T);
  const D = norm360(297.8501921 + 445267.1114034 * T) * D2R;
  const M = norm360(357.5291092 + 35999.0502909 * T) * D2R;
  const Mp = norm360(134.9633964 + 477198.8675055 * T) * D2R;
  const F = norm360(93.272095 + 483202.0175233 * T) * D2R;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sl += l * e * Math.sin(arg);
    sr += r * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sb += b * e * Math.sin(arg);
  }
  // additive terms (Venus, Jupiter, Earth flattening)
  const A1 = norm360(119.75 + 131.849 * T) * D2R;
  const A2 = norm360(53.09 + 479264.29 * T) * D2R;
  const A3 = norm360(313.45 + 481266.484 * T) * D2R;
  const Lr = Lp * D2R;
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(Lr - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(Lr) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F)
    + 127 * Math.sin(Lr - Mp) - 115 * Math.sin(Lr + Mp);

  return { lon: norm360(Lp + sl / 1e6), lat: sb / 1e6, distKm: 385000.56 + sr / 1000 };
}

/** Moon position and phase (~0.05° / 0.3 % illumination, good for centuries around J2000). */
export function moonPosition(date: Date, loc: LatLon): MoonState {
  const n = daysSinceJ2000(date);
  const m = moonEcliptic(n);
  const lam = m.lon * D2R;
  const beta = m.lat * D2R;
  const eps = obliquity(n);
  const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps), Math.cos(lam)) * R2D;
  const dec = Math.asin(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lam));
  const parallax = Math.asin(EARTH_RADIUS_KM / m.distKm);
  const h = toHorizontal(ra, dec, n, loc, parallax);

  const sun = sunEcliptic(n);
  const elong = norm360(m.lon - sun.lambda * R2D); // 0 new, 180 full
  const psi = Math.acos(Math.cos(beta) * Math.cos(elong * D2R)); // geocentric elongation
  const R = sun.distAU * AU_KM;
  const phaseAngle = Math.atan2(R * Math.sin(psi), m.distKm - R * Math.cos(psi));
  return {
    dir: h.dir,
    elevationDeg: h.elevationDeg,
    illumination: (1 + Math.cos(phaseAngle)) / 2,
    phase: elong / 360,
  };
}
