import { describe, expect, it } from 'vitest';
import { CLIMATE, climateTemperature, seasonOf } from '../src/engine/palette';
import normals from './fixtures/climate-normals.json';
import { climateFaceRgb, climateRgb, seaLevelTemperature, temperatureAt } from '../src/world/climate-colour';

describe('height × temperature colouring', () => {
  it('cools with latitude and height', () => {
    expect(seaLevelTemperature(0)).toBeCloseTo(29, 0);
    expect(seaLevelTemperature(60)).toBeCloseTo(2.5, 0);
    expect(temperatureAt(45, 2000)).toBeCloseTo(seaLevelTemperature(45) - 12, 5);
  });
  it('hits the table nodes and blends between them', () => {
    expect(climateRgb(0, -20)).toEqual([226, 232, 238]);
    expect(climateRgb(0, 3)).toEqual([50, 70, 42]);
    const mid = climateRgb(250, 3);
    expect(mid[0]).toBeCloseTo(53, 5);
  });
  it('turns steep faces to rock but keeps ice white', () => {
    expect(climateFaceRgb(100, 45, 0.4)).toEqual([118, 112, 104]);
    expect(climateFaceRgb(100, 45, 0.8)).toEqual(climateFaceRgb(100, 45, 1));
    expect(climateFaceRgb(100, 85, 0.4)[0]).toBeGreaterThan(200);
  });
});

describe('seasons (climate formula against observed daily means)', () => {
  const day = (d: number) => Math.cos((2 * Math.PI * (d - CLIMATE.COLDEST_DAY)) / 365.2425);
  const rmse = (season: (d: number) => number) => {
    let se = 0, n = 0;
    for (const p of normals.points) {
      p.t.forEach((t, d) => {
        se += (climateTemperature(p.lat, p.elev, season(d)) - t) ** 2;
        n++;
      });
    }
    return Math.sqrt(se / n);
  };

  it('fits 55 points worldwide to an RMSE of 5.5 °C, far better than without seasons', () => {
    expect(normals.points).toHaveLength(55);
    expect(rmse(day)).toBeLessThan(5.5);
    expect(rmse(() => 0)).toBeGreaterThan(8.5);
  });

  it('winter is cold in the north in January and in the south in July', () => {
    expect(seasonOf(new Date(Date.UTC(2026, 0, 18)))).toBeCloseTo(1, 3);
    expect(seasonOf(new Date(Date.UTC(2026, 6, 19)))).toBeCloseTo(-1, 2);
    const jan = seasonOf(new Date(Date.UTC(2026, 0, 18)));
    // Moscow: a snowy January, a warm July
    expect(climateTemperature(55.75, 150, jan)).toBeLessThan(CLIMATE.ICE_C);
    expect(climateTemperature(55.75, 150, -jan)).toBeGreaterThan(15);
    // Ushuaia: milder seasons, coldest in July
    expect(climateTemperature(-54.8, 50, -jan)).toBeLessThan(climateTemperature(-54.8, 50, jan));
    // the equator has no seasons
    expect(climateTemperature(0, 0, jan)).toBeCloseTo(climateTemperature(0, 0, -jan), 6);
  });
});
