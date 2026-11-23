import { describe, expect, it } from 'vitest';
import { colourOf } from '../src/engine/palette';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildPower, POWER, supportHeight } from '../src/world/power-mesher';
import { overpassQuery, parseOverpass } from '../src/world/overpass';
import type { LonLat } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 9517, y: 6397 };
const c = tileCenter(TILE);
const KX = 111320 * Math.cos((c.lat * Math.PI) / 180), KY = 111320;
const at = (x: number, y: number): LonLat => [c.lon + x / KX, c.lat + y / KY];
const ground = () => 50;

/** wire vertices as [x, y, z] */
function wirePts(w: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < w.length; i += 4) out.push([w[i], w[i + 1], w[i + 2]]);
  return out;
}

describe('supportHeight', () => {
  it('height, else by the highest voltage; a pole on a minor line', () => {
    expect(supportHeight({ power: 'line', height: '50' })).toBe(50);
    expect(supportHeight({ power: 'line', voltage: '380000;154000' })).toBe(45);
    expect(supportHeight({ power: 'line', voltage: '154000' })).toBe(36);
    expect(supportHeight({ power: 'line', voltage: '66000' })).toBe(28);
    expect(supportHeight({ power: 'line' })).toBe(22);
    expect(supportHeight({ power: 'minor_line' })).toBe(POWER.POLE_M);
  });
});

describe('buildPower', () => {
  const line = { points: [at(-150, 0), at(150, 0)], tags: { power: 'line', voltage: '154000' } };

  it('a steel lattice pylon at every vertex, from the ground to its height, insulators on its arms', () => {
    const p = buildPower(TILE, [line], ground);
    expect(p.vertices.length).toBe(p.ramps.length * 6);
    const colours = new Set(p.ramps);
    expect(colours).toEqual(new Set([colourOf(POWER.STEEL), colourOf(POWER.INSULATOR_RGB)]));
    let top = -Infinity, low = Infinity, wide = 0;
    for (let i = 0; i < p.vertices.length; i += 6) {
      top = Math.max(top, p.vertices[i + 1]); low = Math.min(low, p.vertices[i + 1]);
      // the pylon at x = −150: its reach across the line (z)
      if (Math.abs(p.vertices[i] + 150) < 10) wide = Math.max(wide, Math.abs(p.vertices[i + 2]));
    }
    expect(top).toBeGreaterThan(50 + 36 - 0.5);
    expect(top).toBeLessThan(50 + 36 + 0.5);
    expect(low).toBeLessThan(50);
    // the middle tier's arms are the longest
    const longest = Math.max(...POWER.TIERS.map(([, a]) => a)) * 36;
    expect(wide).toBeGreaterThan(longest - 0.5);
    expect(wide).toBeLessThan(longest + 0.5);
  });

  it('six conductors and an earth wire a span: three tiers each side, sagging, square to the line', () => {
    const w = wirePts(buildPower(TILE, [line], ground).wires);
    expect(w.length).toBe(7 * POWER.PIECES * 2);
    // the arms run north–south (across an east–west line): conductors at z = ± each tier's arm, the earth wire on the axis
    const round = (v: number) => Math.round(v * 10) / 10;
    const zs = [...new Set(w.map(([, , z]) => round(z)))].sort((a, b) => a - b);
    const arms = [...new Set(POWER.TIERS.map(([, a]) => a * 36))];
    expect(zs).toEqual([...arms.map((a) => -a), 0, ...arms].map(round).sort((a, b) => a - b));
    // the earth wire is the highest, hung from the peak
    expect(Math.max(...w.map(([, y]) => y))).toBeCloseTo(50 + 36, 3);
    // a conductor (the outermost on one side): mid-span lower than the ends by SAG of the span
    const one = w.filter(([, , z]) => round(z) === round(Math.max(...arms)));
    const ends = Math.max(...one.map(([, y]) => y));
    const mid = Math.min(...one.map(([, y]) => y));
    expect(ends - mid).toBeCloseTo(300 * POWER.SAG, 1);
    // it hangs an insulator string under its arm's tip
    const [hy] = POWER.TIERS[1];
    expect(ends).toBeCloseTo(50 + (hy - POWER.INSULATOR) * 36, 3);
  });

  it('a minor line: concrete poles, its conductors near the top', () => {
    const p = buildPower(TILE, [{ points: [at(-30, 0), at(30, 0)], tags: { power: 'minor_line' } }], ground);
    for (const r of p.ramps) expect(r).toBe(colourOf(POWER.CONCRETE));
    for (const [, y] of wirePts(p.wires)) expect(y).toBeGreaterThan(50 + POWER.POLE_M - 2);
  });

  it('a span is drawn by the tile holding its middle, a support by the tile it stands in', () => {
    const b = tileBounds(TILE);
    const east = (b.east - c.lon) * KX;
    // one support in this tile, one in the next, the middle in the next
    const across = { points: [at(east - 10, 0), at(east + 200, 0)], tags: { power: 'line' } };
    const here = buildPower(TILE, [across], ground);
    const next = buildPower({ ...TILE, x: TILE.x + 1 }, [across], ground);
    expect(here.wires.length).toBe(0);
    expect(next.wires.length).toBeGreaterThan(0);
    expect(here.ramps.length).toBeGreaterThan(0);
    expect(next.ramps.length).toBe(here.ramps.length);
  });

  it('from OSM: a power line is a line, fetched near', () => {
    const n = (id: number, x: number) => ({ type: 'node' as const, id, lon: at(x, 0)[0], lat: at(x, 0)[1] });
    const d = parseOverpass({ elements: [n(1, 0), n(2, 100), { type: 'way', id: 5, nodes: [1, 2], tags: { power: 'line', voltage: '154000' } }] });
    expect(d.lines.length).toBe(1);
    expect(overpassQuery(TILE, 'full')).toContain('way["power"~"^(line|minor_line)$"];');
  });
});
