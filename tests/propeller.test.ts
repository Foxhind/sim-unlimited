import { describe, expect, it } from 'vitest';
import { C150, aircraftMesh } from '../src/flight/aircraft';
import { BLADES_RPM, DISC_RPM, GHOSTS, blurOf, ghostOpacity, glintAt, pistonRpm, propVertices } from '../src/flight/propeller';

const prop = C150.prop!;

describe('propeller', () => {
  it('finds the two blades of the C150 and nothing else', () => {
    const mesh = aircraftMesh('c150');
    const sel = propVertices(mesh.vertices, prop);
    const idx = [...sel.keys()].filter((v) => sel[v]);
    // 2 blades x (root, tip) x 2 sides x 2 triangles
    expect(idx.length).toBe(16 * 3);
    const colours = new Set(idx.map((v) => mesh.ramps[v] & 0xffffff));
    expect([...colours].sort()).toEqual([0x17191c, 0xf2c400].sort());
    // the blades reach the tip radius, around the hub
    const far = Math.max(...idx.map((v) => Math.hypot(mesh.vertices[v * 6] - prop.hub[0], mesh.vertices[v * 6 + 1] - prop.hub[1])));
    expect(far).toBeCloseTo(prop.radius, 1);
  });

  it('draws blades slowly, a disc fast, and fades between them without a jump', () => {
    expect(pistonRpm(0, 0)).toBe(700);
    expect(pistonRpm(1, 0)).toBe(2450);
    expect(blurOf(0)).toBe(0);
    expect(blurOf(BLADES_RPM)).toBe(0);
    expect(blurOf(DISC_RPM)).toBe(1);
    expect(blurOf(pistonRpm(1, 0))).toBe(1);
    // idle: half way, ghosts over a faint disc
    const idle = blurOf(700);
    expect(idle).toBeGreaterThan(0.3);
    expect(idle).toBeLessThan(0.8);
    // the ghosts, all overlapping, cover 1 - blur
    for (const b of [0.01, 0.3, 0.7, 0.99]) {
      expect(1 - Math.pow(1 - ghostOpacity(b), GHOSTS)).toBeCloseTo(1 - b, 6);
    }
    expect(ghostOpacity(1e-9)).toBeGreaterThan(0.99);
  });

  it('glints on arcs where the blade faces mirror the sun to the eye', () => {
    const N = 360;
    const ring = (sun: number[], eye: number[], r: number): number[] =>
      Array.from({ length: N }, (_, i) => glintAt(prop, r, (i / N) * 2 * Math.PI, sun, eye));
    const fwd = [0, 0, -1];
    // sun behind the eye, both straight ahead: the tips (least blade angle) glint all round, the roots not
    const tip = ring(fwd, fwd, 0.85);
    const root = ring(fwd, fwd, 0.2);
    expect(Math.min(...tip)).toBeGreaterThan(0.01);
    expect(Math.min(...tip)).toBeGreaterThan(1000 * Math.max(...root));
    // the sun off to one side: only an arc of the disc glints, at one radius more than the others
    const s = Math.SQRT1_2;
    const side = [s * Math.sin(0.5), 0, -s];
    const len = Math.hypot(side[0], side[1], side[2]);
    const sun = side.map((v) => v / len);
    let best = 0;
    for (const r of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const g = ring(sun, fwd, r);
      const peak = Math.max(...g);
      if (peak < 0.2) continue;
      const lit = g.filter((v) => v > 0.5 * peak).length;
      expect(lit / N).toBeLessThan(0.35);
      best = Math.max(best, peak);
    }
    expect(best).toBeGreaterThan(0.5);
    // the sun and the eye on opposite sides of the disc: no mirror glint
    expect(Math.max(...ring([0, 0, 1], fwd, 0.85))).toBe(0);
  });
});
