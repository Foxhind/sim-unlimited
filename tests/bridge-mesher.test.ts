import { describe, expect, it } from 'vitest';
import { RAMP } from '../src/engine/palette';
import { buildDecks, deckJoint, insertAt, MITRE_LIMIT, PARAPET_M, PARAPET_THICK_M, PIER_MIN_CLEAR_M, SLAB_THICK_M, type DeckRun, type DeckStation } from '../src/world/bridge-mesher';

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

  it('closes the parapets at the slab\'s cut ends', () => {
    const p = points(buildDecks([run(106, true)]));
    // at each end (x 0 and 90) a face across each parapet's thickness, from the deck to its top
    for (const x of [0, 90]) {
      for (const z of [-5, 5]) {
        const cap = p.filter((v) => near(v.x, x) && Math.abs(v.z) >= 4.69 && Math.sign(v.z) === Math.sign(z));
        expect(cap.some((v) => near(v.y, 106 + PARAPET_M) && near(Math.abs(v.z), 4.7))).toBe(true);
        expect(cap.some((v) => near(v.y, 106) && near(Math.abs(v.z), 4.7))).toBe(true);
      }
    }
  });

  it('a solid deck (a footbridge\'s ramp): walls straight down into the ground under its edges, no slab underside, no piers', () => {
    const p = points(buildDecks([{ ...run(106, true), solid: true }]));
    // no wider than the deck; nothing at the slab's underside; its walls and cut ends under the ground
    expect(Math.max(...p.map((v) => Math.abs(v.z)))).toBeCloseTo(5, 2);
    expect(p.filter((v) => near(v.y, 106 - SLAB_THICK_M))).toEqual([]);
    const feet = p.filter((v) => v.y < GROUND);
    expect(feet.every((v) => near(v.y, GROUND - 1) && near(Math.abs(v.z), 5))).toBe(true);
    expect(new Set(feet.map((v) => v.x)).size).toBe(10);
    // the walls' feet follow the ground under each edge
    const low = points(buildDecks([{ ...run(106, true), solid: true, groundAt: (_x, z) => (z > 0 ? GROUND - 2 : GROUND) }]));
    expect(Math.min(...low.filter((v) => v.z > 0).map((v) => v.y))).toBeCloseTo(GROUND - 3, 2);
    expect(Math.min(...low.filter((v) => v.z < 0).map((v) => v.y))).toBeCloseTo(GROUND - 1, 2);
  });

  it('a top of its own just under the deck (cap), edge to edge', () => {
    const p = points(buildDecks([{ ...run(106, true), cap: true }]));
    const top = p.filter((v) => near(v.y, 106 - 0.03));
    expect(top.length).toBe(9 * 6);
    expect(Math.max(...top.map((v) => Math.abs(v.z)))).toBeCloseTo(5, 2);
  });

  it('deckJoint: two decks at a right angle meet in a mitre, each corner shared; straight on or alone, square', () => {
    // one leg east, one south (z grows south), both 2 m half wide
    const [e, s] = deckJoint([10, 20], [{ dir: [1, 0], half: 2 }, { dir: [0, 1], half: 2 }]);
    // east leg: its left is north; the corner outside the bend (north-west) and inside it (south-east)
    expect(e.l).toEqual([8, 18]);
    expect(e.r).toEqual([12, 22]);
    // the south leg's left is east: the same two corners, the other way round
    expect(s.l).toEqual(e.r);
    expect(s.r).toEqual(e.l);
    // the parapets' inner edges: the same mitre, a parapet's thickness in
    const [ei] = deckJoint([10, 20], [{ dir: [1, 0], half: 2 }, { dir: [0, 1], half: 2 }], PARAPET_THICK_M);
    expect(ei.l[0]).toBeCloseTo(8 + PARAPET_THICK_M, 9);
    expect(ei.l[1]).toBeCloseTo(18 + PARAPET_THICK_M, 9);
    // straight on, and a leg alone: square
    expect(deckJoint([0, 0], [{ dir: [1, 0], half: 2 }, { dir: [-1, 0], half: 3 }])[0]).toEqual({ l: [0, -2], r: [0, 2] });
    expect(deckJoint([0, 0], [{ dir: [1, 0], half: 2 }])[0]).toEqual({ l: [0, -2], r: [0, 2] });
  });

  it('deckJoint: three decks: each corner the two neighbours\'; a sharp turn\'s mitre cut short', () => {
    // a T: west and east legs straight through, one north
    const legs = [{ dir: [-1, 0] as [number, number], half: 2 }, { dir: [1, 0] as [number, number], half: 2 }, { dir: [0, -1] as [number, number], half: 1 }];
    const [w, e, n] = deckJoint([0, 0], legs);
    // south of the through way: straight, square
    expect(w.l).toEqual([0, 2]);
    expect(e.r).toEqual([0, 2]);
    // north: each through leg's corner with the branch
    expect(w.r).toEqual([-1, -2]);
    expect(n.l).toEqual(w.r);
    expect(e.l).toEqual([1, -2]);
    expect(n.r).toEqual(e.l);
    // a hairpin (10° between the legs): no further from the node than MITRE_LIMIT half widths
    const a = (10 * Math.PI) / 180;
    const [h] = deckJoint([0, 0], [{ dir: [1, 0], half: 2 }, { dir: [Math.cos(a), Math.sin(a)], half: 2 }]);
    expect(Math.hypot(...h.l)).toBeCloseTo(MITRE_LIMIT * 2, 6);
    expect(Math.hypot(...h.r)).toBeLessThanOrEqual(MITRE_LIMIT * 2 + 1e-9);
  });

  it('a deck with its edges given (a joint) runs to them, parapets and all; joined, it is closed to the node, not cut', () => {
    // a ramp west to east whose start meets another deck at 45°: its edges there skewed
    const r: DeckRun = { ...run(106, true), solid: true, cap: true, joined: [true, false] };
    r.stations[0] = { ...r.stations[0], l: [-5, -5], r: [5, 5], li: [-4.7, -4.7], ri: [4.7, 4.7] };
    const p = points(buildDecks([r]));
    // the wall and the parapet from the given corners, top to foot
    for (const [x, z] of [[-5, -5], [5, 5]]) {
      const at = p.filter((v) => near(v.x, x) && near(v.z, z));
      expect(at.some((v) => near(v.y, 106 + PARAPET_M))).toBe(true);
      expect(at.some((v) => near(v.y, GROUND - 1))).toBe(true);
    }
    expect(p.some((v) => near(v.x, -4.7) && near(v.z, -4.7) && near(v.y, 106 + PARAPET_M))).toBe(true);
    // closed to the node: the cap's triangle and the walls under it from each corner to the node
    const node = p.filter((v) => near(v.x, 0) && near(v.z, 0));
    expect(node.some((v) => near(v.y, 106 - 0.03))).toBe(true);
    expect(node.some((v) => near(v.y, GROUND - 1))).toBe(true);
    // no parapet end across the deck there (the deck it meets carries the parapet on)
    expect(p.filter((v) => near(v.x, 0) && near(Math.abs(v.z), 5))).toEqual([]);
    // the far end, not joined: cut square, its parapets closed
    expect(p.some((v) => near(v.x, 90) && near(Math.abs(v.z), 4.7) && near(v.y, 106))).toBe(true);
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
    // the slope runs on FOOT_M (1 m) into the ground
    expect(far).toBeCloseTo(5 + 1.5 * 5, 2);
    expect(p.filter((v) => near(Math.abs(v.z), far)).every((v) => near(v.y, GROUND - 1))).toBe(true);
    expect(Math.max(...p.map((v) => v.y))).toBeCloseTo(104, 2);
  });

  it('sloping ground: each side from its own edge height to its own ground', () => {
    const r = run(104, false);
    for (const s of r.stations) { s.groundL = 102; s.groundR = 98; }
    const p = points(buildDecks([r])).filter((v) => v.x > 5 && v.x < 85);
    // left is north (-z): the deck's edge there is 2 m over the centre's, its toe on 102
    expect(Math.max(...p.filter((v) => v.z < 0).map((v) => v.y))).toBeCloseTo(106, 2);
    expect(Math.min(...p.filter((v) => v.z < -5.5).map((v) => v.y))).toBeCloseTo(101, 2);
    expect(Math.min(...p.filter((v) => v.z > 5.5).map((v) => v.y))).toBeCloseTo(97, 2);
  });

  it('a level deck askew over a bank: its slab and parapets level across, as its ribbon, whatever the ground under each edge', () => {
    // a footbridge over a canal's mouth (Fethiye, 36.6379 N 29.1210 E): one edge over the bank (3.4 m),
    // the other over the water (0 m); its ribbon is level at the centre line's height
    const r = run(106, true);
    for (const s of r.stations) { s.groundL = 103.4; s.groundR = 100; }
    r.level = true;
    const p = points(buildDecks([r]));
    for (const side of [-1, 1]) {
      // the parapet's top and the slab's underside at the same height on both edges
      const edge = p.filter((v) => near(Math.abs(v.z), 5) && Math.sign(v.z) === side);
      expect(Math.max(...edge.map((v) => v.y))).toBeCloseTo(106 + PARAPET_M, 2);
      expect(Math.min(...edge.filter((v) => v.y > GROUND + 1).map((v) => v.y))).toBeCloseTo(106 - SLAB_THICK_M, 2);
    }
    // not level, each edge follows its own ground (an embankment's road on a cross slope)
    r.level = false;
    const q = points(buildDecks([r])).filter((v) => near(Math.abs(v.z), 5));
    expect(Math.max(...q.filter((v) => v.z < 0).map((v) => v.y))).toBeCloseTo(106 + 3.4 + PARAPET_M, 2);
  });

  it('an embankment of its own slope: steeper, or walls straight down', () => {
    const ramp = points(buildDecks([{ ...run(106, false), slope: 0.5 }]));
    expect(Math.max(...ramp.map((v) => Math.abs(v.z)))).toBeCloseTo(5 + 0.5 * 7, 2);
    const walls = points(buildDecks([{ ...run(106, false), slope: 0 }]));
    // no wider than the deck, and its walls reach under the ground
    expect(Math.max(...walls.map((v) => Math.abs(v.z)))).toBeCloseTo(5, 2);
    expect(Math.min(...walls.map((v) => v.y))).toBeLessThan(GROUND);
  });

  it('a switchback: every slope within its reach of the deck, none crossing over it', () => {
    // up north 20 m, back south-east 15 m, on east: two hairpins (the stations' own normals point anywhere there)
    const pts: [number, number][] = [[0, 0], [0, -10], [0, -20], [3, -6], [6, 8], [16, 8]];
    const stations: DeckStation[] = pts.map(([x, z], i) => ({ d: i * 10, x, z, y: 104, ground: GROUND, groundL: GROUND, groundR: GROUND, nx: 0, nz: -1, half: 1.5 }));
    const p = points(buildDecks([{ stations, bridge: false, earth: EARTH, slope: 0.5 }]));
    const reach = 1.5 + 0.5 * 5 + 1e-6;
    const dist = (x: number, z: number) => Math.min(...pts.slice(1).map(([bx, bz], i) => {
      const [ax, az] = pts[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      return Math.hypot(x - ax - dx * t, z - az - dz * t);
    }));
    expect(p.length).toBeGreaterThan(0);
    expect(p.filter((v) => dist(v.x, v.z) > reach)).toEqual([]);
    // nothing over the deck
    expect(Math.max(...p.map((v) => v.y))).toBeCloseTo(104, 2);
  });

  it('the slope meets the ground where it lies (groundAt), not the ground under the deck edge', () => {
    // the ground falls away from the deck: 2 m lower 3 m out
    const r = { ...run(104, false), slope: 0.5, groundAt: (_x: number, z: number) => (Math.abs(z) > 5.5 ? GROUND - 2 : GROUND) };
    const p = points(buildDecks([r])).filter((v) => v.x > 5 && v.x < 85);
    expect(Math.min(...p.map((v) => v.y))).toBeCloseTo(GROUND - 3, 2);
  });

  it('empty and degenerate input', () => {
    expect(buildDecks([]).ramps.length).toBe(0);
    const one = run(106, true);
    one.stations.length = 1;
    expect(buildDecks([one]).ramps.length).toBe(0);
  });
});
