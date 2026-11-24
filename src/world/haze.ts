/**
 * The air's haze from the weather (renderer.hazeDensity, shaders.ts AIR_HAZE): its extinction per
 * metre at sea level, falling off with height over AIR_HAZE.SCALE_H.
 *
 * The aerosol optical depth of the column (CAMS, weather.ts aod) is that extinction integrated up
 * the air, so at sea level it is aod / SCALE_H. Checked against an aerial panorama (Fethiye,
 * 1 Jul 2023, 14:49 UTC, CAMS aod 0.21): the haze matched by eye there was 1/6 km at sea level,
 * a column of 0.20. Without data the haze is that of DEFAULT_AOD, the same.
 *
 * The reported visibility adds to it only below VISIBILITY_CAP_M (models report their cap, ~24 km,
 * in any clear air) and when nothing falls (under rain or snow the fog draws in by it already,
 * precipitation.ts fogRange): mist and haze, by Koschmieder's law, extinction = 3.912 / visibility.
 */
import { AIR_HAZE } from '../engine/shaders';
import type { Weather } from './weather';

export const HAZE = {
  /** the column without data: a clear summer day's (and the panorama's) */
  DEFAULT_AOD: 0.2,
  /** the clearest and the dustiest columns taken: polar air, a Saharan dust storm */
  AOD_MIN: 0.02,
  AOD_MAX: 3,
  /** the visibility informs the haze only below this, m */
  VISIBILITY_CAP_M: 20000,
  KOSCHMIEDER: 3.912,
} as const;

/** haze extinction at sea level, per metre, for the weather in force (undefined: no data) */
export function hazeDensity(w: Pick<Weather, 'aod' | 'visibilityM' | 'precipKind'> | undefined): number {
  const aod = Math.max(HAZE.AOD_MIN, Math.min(HAZE.AOD_MAX, w?.aod ?? HAZE.DEFAULT_AOD));
  let k = aod / AIR_HAZE.SCALE_H;
  const vis = w?.visibilityM;
  const dry = (w?.precipKind ?? 'none') === 'none';
  if (dry && vis !== undefined && vis > 0 && vis < HAZE.VISIBILITY_CAP_M) k = Math.max(k, HAZE.KOSCHMIEDER / vis);
  return k;
}
