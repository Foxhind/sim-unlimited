import { describe, expect, it } from 'vitest';
import { latLonToEnu } from '../src/world/geodesy';
import { runwayStart } from '../src/world/runway';
import type { OsmLine } from '../src/world/osm-types';

describe('runwayStart', () => {
  // LOWI 08/26 as mapped in OSM (west end first), plus a grass glider strip beside it
  const main: OsmLine = { points: [[11.3316904, 47.2588763], [11.357032, 47.2616144]], tags: { aeroway: 'runway', ref: '08/26', surface: 'asphalt' } };
  const grass: OsmLine = { points: [[11.3405, 47.2575], [11.3480, 47.2583]], tags: { aeroway: 'runway', surface: 'grass' } };

  it('starts in from the nearer end, facing down the runway', () => {
    const east = runwayStart([main], { lat: 47.2617, lon: 11.3575 })!;
    expect(east.hdg).toBeCloseTo(261, 0);
    const [e, n] = latLonToEnu({ lat: 47.2616144, lon: 11.357032 }, east.lat, east.lon, 0);
    expect(Math.hypot(e, n)).toBeCloseTo(60, 0);
    const west = runwayStart([main], { lat: 47.2585, lon: 11.33 })!;
    expect(west.hdg).toBeCloseTo(81, 0);
  });

  it('prefers the paved runway to a nearer grass strip, and gives up far from any runway', () => {
    const s = runwayStart([grass, main], { lat: 47.2580, lon: 11.3440 })!;
    expect(s.hdg % 180).toBeCloseTo(81, 0);
    expect(runwayStart([main], { lat: 47.30, lon: 11.35 })).toBeNull();
  });
});
