import { afterEach, describe, expect, it } from 'vitest';
import { DETAIL_Z, selectLeaves } from '../src/world/chunks';
import { farOsmTiles } from '../src/world/far-osm';
import { detail, detailFor, FULL_DETAIL, PHONE_DETAIL, setDetail } from '../src/world/detail';

const MOSCOW = { lat: 55.752, lon: 37.6175 };

describe('detail profiles', () => {
  afterEach(() => setDetail(FULL_DETAIL));

  it('auto: the phone profile only where a finger is the only pointer', () => {
    expect(detailFor('auto', true)).toBe(PHONE_DETAIL);
    expect(detailFor('auto', false)).toBe(FULL_DETAIL);
    expect(detailFor('full', true)).toBe(FULL_DETAIL);
    expect(detailFor('phone', false)).toBe(PHONE_DETAIL);
  });

  it('each profile draws its buildings only where the tiles are detailed, and its far ring beyond them', () => {
    for (const p of [FULL_DETAIL, PHONE_DETAIL]) {
      expect(p.houseRadiusM).toBeLessThanOrEqual(p.detailRadiusM);
      expect(p.drapeRadiusM).toBeLessThanOrEqual(p.detailRadiusM);
      expect(p.buildingDetailM).toBeLessThan(p.houseRadiusM);
      expect(p.farOsmRadiusM).toBeGreaterThan(p.detailRadiusM);
    }
  });

  it('a phone over Moscow builds half the detailed tiles or fewer and far tiles', () => {
    const count = (): { near: number; far: number } => {
      const leaves = selectLeaves(MOSCOW, 600);
      const near = leaves.filter((t) => t.z === DETAIL_Z);
      const keys = new Set(near.map((t) => `${t.z}/${t.x}/${t.y}`));
      return { near: near.length, far: farOsmTiles(MOSCOW, 600, keys).length };
    };
    const full = count();
    setDetail(PHONE_DETAIL);
    expect(detail.detailRadiusM).toBe(PHONE_DETAIL.detailRadiusM);
    const phone = count();
    expect(phone.near).toBeLessThanOrEqual(full.near * 0.5);
    expect(phone.far).toBeLessThan(full.far * 0.6);
    expect(phone.near).toBeGreaterThan(0);
  });
});
