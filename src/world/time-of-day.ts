import type { LatLon } from './geodesy';
import { sunPosition } from './sun';

export type TimeOfDay = 'real' | 'morning' | 'day' | 'evening' | 'night';
export const TIMES_OF_DAY: readonly TimeOfDay[] = ['real', 'morning', 'day', 'evening', 'night'];

const MIN = 60000;
const HOUR = 3600000;
/** sun elevation that reads as "morning" / "evening" (palette: dusk at 0°, full day at 12°) */
const MORNING_ELEV = 10;
const EVENING_ELEV = 4;

/**
 * Concrete instant for a time-of-day choice at `loc`, on the local solar day containing `now`.
 * - real: `now` itself
 * - morning: the sun rising through +10°; evening: setting through +4°
 * - day: solar noon; night: solar midnight (the end of that solar day)
 * Where the sun never crosses the threshold (polar day/night) it falls back to solar noon -4 h / +6 h.
 */
export function timeForPreset(tod: TimeOfDay, loc: LatLon, now: Date): Date {
  if (tod === 'real') return now;
  const offset = (loc.lon / 15) * HOUR; // local mean solar time offset
  const dayStart = Math.floor((now.getTime() + offset) / (24 * HOUR)) * 24 * HOUR - offset;
  const elev = (t: number): number => sunPosition(new Date(t), loc).elevationDeg;
  const step = 2 * MIN;

  const extremum = (from: number, to: number, sign: 1 | -1): number => {
    let best = from;
    let bestV = -Infinity;
    for (let t = from; t <= to; t += step) {
      const v = sign * elev(t);
      if (v > bestV) { bestV = v; best = t; }
    }
    return best;
  };
  const noon = extremum(dayStart + 6 * HOUR, dayStart + 18 * HOUR, 1);
  if (tod === 'day') return new Date(noon);
  if (tod === 'night') return new Date(extremum(dayStart + 18 * HOUR, dayStart + 30 * HOUR, -1));

  if (tod === 'morning') {
    for (let t = noon; t >= dayStart; t -= step) {
      if (elev(t) < MORNING_ELEV) return new Date(t);
    }
    return new Date(noon - 4 * HOUR);
  }
  for (let t = noon; t <= noon + 12 * HOUR; t += step) {
    if (elev(t) < EVENING_ELEV) return new Date(t);
  }
  return new Date(noon + 6 * HOUR);
}
