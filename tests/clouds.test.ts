import { describe, expect, it } from 'vitest';
import {
  BASE_DEFAULT_AGL, BASE_MAX_AGL, BASE_MIN_AGL, CLOUD_RGB, DECK_COVER, TILE_M,
  cloudBaseAgl, cloudDensity, DECK_DIM, underDecks, cloudLayers, cumulusTile, deckDensity, deckTile, type CloudLayer,
} from '../src/world/clouds';
import { parseWeather } from '../src/world/weather';

const at = { lat: 47.26, lon: 11.34 };

describe('cloud layers from the weather', () => {
  it('the low base from the temperature-dew point spread, 125 m per degree, within limits', () => {
    expect(cloudBaseAgl(10, 7)).toBe(375);
    expect(cloudBaseAgl(10, 10)).toBe(BASE_MIN_AGL);
    expect(cloudBaseAgl(30, -10)).toBe(BASE_MAX_AGL);
    expect(cloudBaseAgl(10, undefined)).toBe(BASE_DEFAULT_AGL);
  });

  it('nothing without weather or with a clear sky', () => {
    expect(cloudLayers(undefined)).toEqual([]);
    expect(cloudLayers({ cloudPct: 3, elevation: 0 })).toEqual([]);
  });

  it('the layers Open-Meteo gives: low cumulus over the ground, a mid deck above it', () => {
    const w = parseWeather({
      elevation: 579,
      current: { time: '2026-11-17T14:15', temperature_2m: 10.1, dew_point_2m: 7, cloud_cover: 94, cloud_cover_low: 40, cloud_cover_mid: 94, cloud_cover_high: 75 },
    }, at)!;
    expect(w).toMatchObject({ cloudLowPct: 40, cloudMidPct: 94, cloudHighPct: 75, dewPointC: 7 });
    const [low, mid, ...rest] = cloudLayers({ ...w, elevation: w.elevation! });
    expect(rest).toEqual([]); // high clouds are not drawn
    expect(low).toMatchObject({ id: 'low', kind: 'cumulus', cover: 0.4 });
    expect(low.base).toBe(Math.round((579 + 125 * 3.1) / 50) * 50);
    expect(low.top).toBeGreaterThan(low.base + 300);
    expect(mid).toMatchObject({ id: 'mid', kind: 'deck', cover: 0.95, base: 3500 });
    expect(mid.base).toBeGreaterThan(low.top);
  });

  it('only the total cover: one low layer; a forced cover and base override the layers', () => {
    expect(cloudLayers({ cloudPct: 60, elevation: 200 }).map((l) => [l.id, l.kind, l.cover, l.base])).toEqual([['low', 'cumulus', 0.6, 1400]]);
    const forced = cloudLayers({ cloudPct: 90, cloudLowPct: 0, cloudMidPct: 80, elevation: 200, baseAgl: 800 });
    expect(forced.map((l) => [l.id, l.kind, l.base])).toEqual([['low', 'deck', 1000]]);
  });

  it('overcast from DECK_COVER; the key changes with the geometry', () => {
    const a = cloudLayers({ cloudPct: DECK_COVER * 100 - 5, elevation: 0 })[0];
    const b = cloudLayers({ cloudPct: DECK_COVER * 100, elevation: 0 })[0];
    expect([a.kind, b.kind]).toEqual(['cumulus', 'deck']);
    expect(a.key).not.toBe(b.key);
    expect(cloudLayers({ cloudPct: 61, elevation: 0 })[0].key).toBe(cloudLayers({ cloudPct: 59, elevation: 0 })[0].key);
  });
});

const cumulus = (cover: number): CloudLayer => cloudLayers({ cloudPct: cover, elevation: 0, baseAgl: 1000 })[0];

function normalsUnit(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i += 6) if (Math.abs(Math.hypot(v[i + 3], v[i + 4], v[i + 5]) - 1) > 1e-4) return false;
  return true;
}

describe('cumulus tiles', () => {
  it('deterministic, flat-bottomed at the base, within the layer, white faces', () => {
    const l = cumulus(50);
    const m = cumulusTile(l, 3, -2);
    expect(cumulusTile(l, 3, -2).verts).toEqual(m.verts);
    expect(m.verts.length % 18).toBe(0);
    expect(m.ramps.length).toBe(m.verts.length / 6);
    expect(m.ramps.every((r) => r === CLOUD_RGB)).toBe(true);
    expect(normalsUnit(m.verts)).toBe(true);
    let minY = Infinity, maxY = -Infinity, down = 0;
    for (let i = 0; i < m.verts.length; i += 6) {
      minY = Math.min(minY, m.verts[i + 1]);
      maxY = Math.max(maxY, m.verts[i + 1]);
      if (m.verts[i + 4] < -0.999) down++;
    }
    expect(minY).toBeCloseTo(l.base, 3);
    expect(maxY).toBeLessThanOrEqual(l.top);
    expect(down).toBeGreaterThan(0); // flat bellies
  });

  it('more cover, more clouds; a different tile, different clouds', () => {
    const few = cumulusTile(cumulus(20), 0, 0).puffs.length, many = cumulusTile(cumulus(75), 0, 0).puffs.length;
    expect(many).toBeGreaterThan(few * 2);
    expect(cumulusTile(cumulus(50), 1, 0).verts).not.toEqual(cumulusTile(cumulus(50), 0, 0).verts);
  });

  it('the veil: whole in a puff, fading at its edge, nothing below the base or outside', () => {
    const { puffs } = cumulusTile(cumulus(60), 0, 0);
    const p = puffs[0];
    expect(cloudDensity(puffs, p.c[0], p.c[1], p.c[2])).toBe(1);
    expect(cloudDensity([p], p.c[0] + p.r[0] * 0.9, p.c[1], p.c[2])).toBeGreaterThan(0);
    expect(cloudDensity([p], p.c[0] + p.r[0] * 0.9, p.c[1], p.c[2])).toBeLessThan(1);
    expect(cloudDensity([p], p.c[0], p.floor - 1, p.c[2])).toBe(0);
    expect(cloudDensity([p], p.c[0] + Math.max(p.r[0], p.r[2]) * 1.01, p.c[1], p.c[2])).toBe(0);
  });
});

describe('deck tiles', () => {
  const deck = cloudLayers({ cloudPct: 100, elevation: 0, baseAgl: 800 })[0];

  it('a top and a bottom surface whose normals face out of the slab', () => {
    const m = deckTile(deck, 0, 0);
    expect(normalsUnit(m.verts)).toBe(true);
    let up = 0, dn = 0;
    for (let i = 0; i < m.verts.length; i += 6) {
      const y = m.verts[i + 1], ny = m.verts[i + 4];
      if (y > (deck.base + deck.top) / 2) { expect(ny).toBeGreaterThan(0); up++; } else { expect(ny).toBeLessThan(0); dn++; }
    }
    expect(up).toBe(dn);
  });

  it('neighbouring tiles meet: the shared edge has the same vertices', () => {
    // tile (1,0) is TILE_M further east: shift tile (0,0) onto its frame and look for common vertices
    const key = (v: Float32Array, i: number, dx: number): string => `${(v[i] + dx).toFixed(1)},${v[i + 1].toFixed(1)},${v[i + 2].toFixed(1)}`;
    const a = deckTile(deck, 0, 0).verts, b = deckTile(deck, 1, 0).verts;
    const west = new Set<string>();
    for (let i = 0; i < b.length; i += 6) west.add(key(b, i, 0));
    const shared = new Set<string>();
    for (let i = 0; i < a.length; i += 6) if (west.has(key(a, i, -TILE_M))) shared.add(key(a, i, -TILE_M));
    // the edge's grid points, on the top and the bottom
    expect(shared.size).toBe(2 * (TILE_M / 1000 + 1));
  });

  it('the veil: none outside the slab or in its bumpy skins, whole in the middle', () => {
    expect(deckDensity(deck, deck.base - 10)).toBe(0);
    expect(deckDensity(deck, deck.top + 10)).toBe(0);
    expect(deckDensity(deck, (deck.base + deck.top) / 2)).toBe(1);
  });
});

describe('the light under overcast decks', () => {
  const deck = (base: number, top: number): CloudLayer => ({ id: 'low', kind: 'deck', cover: 1, base, top, flat: 1, seed: 1, key: '' });
  const layers = [deck(1000, 1400), { ...deck(4000, 4200), id: 'mid' as const }];
  it('each deck overhead takes its share of the light: darker under every one', () => {
    expect(underDecks(5000, layers)).toEqual({ under: 0, light: 1 });
    expect(underDecks(3000, layers).light).toBeCloseTo(1 - DECK_DIM, 6);
    expect(underDecks(500, layers).light).toBeCloseTo((1 - DECK_DIM) ** 2, 6);
    expect(underDecks(500, layers).under).toBe(1);
  });
  it('the light fades through the slab, and broken cloud takes none', () => {
    expect(underDecks(1200, layers).light).toBeCloseTo((1 - DECK_DIM) * (1 - DECK_DIM / 2), 6);
    expect(underDecks(4100, layers).under).toBeCloseTo(0.5, 6);
    expect(underDecks(0, [{ ...deck(1000, 1400), kind: 'cumulus', cover: 0.5 }])).toEqual({ under: 0, light: 1 });
  });
});
