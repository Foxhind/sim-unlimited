import { describe, expect, it } from 'vitest';
import { sunPosition } from '../src/world/sun';
import { solarClock, solarInstant } from '../src/world/time-of-day';

describe('local mean solar clock', () => {
  it('12:00 at Greenwich is 12:00 UTC', () => {
    expect(solarInstant({ date: '2026-06-21', minutes: 720 }, 0)!.toISOString()).toBe('2026-06-21T12:00:00.000Z');
  });

  it('east of Greenwich the same clock time comes earlier', () => {
    expect(solarInstant({ date: '2026-06-21', minutes: 720 }, 90)!.toISOString()).toBe('2026-06-21T06:00:00.000Z');
    expect(solarInstant({ date: '2026-06-21', minutes: 60 }, 150)!.toISOString()).toBe('2026-06-20T15:00:00.000Z');
  });

  it('the sun is near its highest at 12:00 anywhere', () => {
    for (const lon of [-120, 8, 37.6, 139]) {
      const loc = { lat: 46, lon };
      const at = (minutes: number) => sunPosition(solarInstant({ date: '2026-03-20', minutes }, lon)!, loc).elevationDeg;
      expect(at(720)).toBeGreaterThan(at(660));
      expect(at(720)).toBeGreaterThan(at(780));
    }
  });

  it('round-trips through solarClock, across the date line', () => {
    for (const lon of [-179, -73.5, 0, 37.6, 179]) {
      for (const clock of [{ date: '2026-12-31', minutes: 1435 }, { date: '2026-01-01', minutes: 0 }, { date: '2024-02-29', minutes: 615 }]) {
        expect(solarClock(solarInstant(clock, lon)!, lon)).toEqual(clock);
      }
    }
  });

  it('rejects an unreadable date', () => {
    expect(solarInstant({ date: '', minutes: 0 }, 0)).toBeNull();
    expect(solarInstant({ date: '21.11.2026', minutes: 0 }, 0)).toBeNull();
  });
});
