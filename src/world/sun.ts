import type { LatLon } from './geodesy';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface SunState {
  /** unit vector toward the sun in world axes [east, up, -north] */
  dir: [number, number, number];
  elevationDeg: number;
}

/** Low-precision NOAA solar position (±0.5° — plenty for palette keyframing). */
export function sunPosition(date: Date, loc: LatLon): SunState {
  const n = date.getTime() / 86400000 - 10957.5; // days since J2000
  const L = ((280.46 + 0.9856474 * n) % 360 + 360) % 360;
  const g = (((357.528 + 0.9856003 * n) % 360 + 360) % 360) * D2R;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const epsilon = (23.439 - 0.0000004 * n) * D2R;
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) * R2D;
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24 * 15;
  const lmst = gmst + loc.lon;
  const H = (((lmst - ra) % 360 + 540) % 360 - 180) * D2R;
  const lat = loc.lat * D2R;
  const elevation = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
  const ce = Math.cos(elevation);
  return {
    dir: [ce * Math.sin(azimuth), Math.sin(elevation), -ce * Math.cos(azimuth)],
    elevationDeg: elevation * R2D,
  };
}