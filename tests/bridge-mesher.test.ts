import { describe, expect, it } from 'vitest';
import { RAMP } from '../src/engine/palette';
import { buildDecks, insertAt, PARAPET_M, PIER_MIN_CLEAR_M, SLAB_THICK_M, type DeckRun, type DeckStation } from '../src/world/bridge-mesher';

const GROUND = 100;
const EARTH = 12345;

/** a straight run west to east, 90 m, stations every 10 m; left of the direction is north (-z) */
function run(y: number, bridge: boolean, blocked: (x: number, z: number) => boolean = () => false): DeckRun {
  const stations: DeckStation[] = [];
  for (let x = 0; x <= 90; x += 10) stations.push({ d: x, x, z: 0, y, ground: GROUND, groundL: GROUND, groundR: GROUND, nx: 0, nz: -1, half: 5 });
  return { stations, bridge, earth: EARTH, blocked };
}

function points(m: { vertices: Float32Array; ramps: Uint32Array }) {
  const out: { x: number; y: number; z: number; ramp: number }[] = [];
  for (let i = 0; i < m.ramps.length; i++) out.push({ x: m.vertices[i * 6], y: m.vertices[i * 6 + 1], z: m.vertices[i * 6 + 2], ramp: m.ramps[i] });
  return out;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe('bridge bodies and embankments', () => {
  it('a bridge run has slab sides, a parapet and piers', () => {
    const m = buildDecks([run(106, true)]);
    const p = points(m);
    expect(m.vertices.length).toBe(m.ramps.length * 6);
    expect(p.some((v) => near(v.y, 106 - SLAB_THICK_M))).toBe(true);
    expect(p.some((v) => near(v.y, 106 + PARAPET_M))).toBe(true);
    expect(p.every((v) => v.ramp === RAMP.CONCRETE)).toBe(true);
    // the slab is as wide as the deck
    expect(Math.max(...p.map((v) => Math.abs(v.z)))).toBeCloseTo(5, 2);
    // piers reach under the ground, one every 30 m of the way
    const feet = new Set(p.filter((v) => v.y < GROUND).map((v) => Math.round(v.x / 10) * 10));
    expect([...feet].sort((a, b) => a - b)).toEqual([0, 30, 60, 90]);
    for (const v of m.vertices) expect(Number.isFinite(v)).toBe(true);
  });

  it('no pier where blocked', () => {
    const p = points(buildDecks([run(106, true, (x) => Math.abs(x - 30) < 10)]));
    expect(p.filter((v) => v.y < 104 && Math.abs(v.x - 30) < 10)).toEqual([]);
    expect(p.some((v) => v.y < GROUND && Math.abs(v.x - 60) < 2)).toBe(true);
  });

  it('no pier whose corner is blocked', () => {
    // the pier at x = 30 is 6 m wide across the deck (z from -3 to 3): something along its northern side
    const p = points(buildDecks([run(106, true, (x, z) => Math.abs(x - 30) < 2 && z < -2)]));
    expect(p.filter((v) => v.y < 104 && Math.abs(v.x - 30) < 10)).toEqual([]);
  });

  it('insertAt puts one array into another', () => {
    expect(Array.from(insertAt(new Float32Array([1, 2, 3, 4]), new Float32Array([9, 9]), 2))).toEqual([1, 2, 9, 9, 3, 4]);
    expect(Array.from(insertAt(new Uint32Array([1, 2]), new Uint32Array([7]), 0))).toEqual([7, 1, 2]);
    expect(Array.from(insertAt(new Uint32Array([1, 2]), new Uint32Array([]), 2))).toEqual([1, 2]);
    expect(insertAt(new Uint32Array([1]), new Uint32Array([7]), 1)).toBeInstanceOf(Uint32Array);
  });

  it('no piers under a low deck', () => {
    const y = GROUND + SLAB_THICK_M + PIER_MIN_CLEAR_M - 0.5;
    expect(points(buildDecks([run(y, true)])).filter((v) => v.y < GROUND)).toEqual([]);
  });

  it('an approach run has embankment slopes down to the ground', () => {
    const all = points(buildDecks([run(104, false)]));
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((v) => v.ramp === EARTH)).toBe(true);
    // the run's cut ends reach into the ground: the slopes are what lies between them
    expect(Math.min(...all.map((v) => v.y))).toBeLessThan(GROUND);
    const p = all.filter((v) => v.x > 5 && v.x < 85);
    const far = Math.max(...p.map((v) => Math.abs(v.z)));
    expect(far).toBeCloseTo(5 + 1.5 * 4, 2);
    expect(p.filter((v) => near(Math.abs(v.z), far)).every((v) => near(v.y, GROUND))).toBe(true);
    expect(Math.max(...p.map((v) => v.y))).toBeCloseTo(104, 2);
  });

  it('sloping ground: each side from its own edge height to its own ground', () => {
    const r = run(104, false);
    for (const s of r.stations) { s.groundL = 102; s.groundR = 98; }
    const p = points(buildDecks([r])).filter((v) => v.x > 5 && v.x < 85);
    // left is north (-z): the deck's edge there is 2 m over the centre's, its toe on 102
    expect(Math.max(...p.filter((v) => v.z < 0).map((v) => v.y))).toBeCloseTo(106, 2);
    expect(Math.min(...p.filter((v) => v.z < -5.5).map((v) => v.y))).toBeCloseTo(102, 2);
    expect(Math.min(...p.filter((v) => v.z > 5.5).map((v) => v.y))).toBeCloseTo(98, 2);
  });

  it('empty and degenerate input', () => {
    expect(buildDecks([]).ramps.length).toBe(0);
    const one = run(106, true);
    one.stations.length = 1;
    expect(buildDecks([one]).ramps.length).toBe(0);
  });
});
