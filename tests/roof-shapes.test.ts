import { describe, expect, it } from 'vitest';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh, computeHeights } from '../src/world/building-mesher';
import { roofDirection, roofFrame, roofModel, roofShape, roofSkeleton, skeletonRoof, type XZ } from '../src/world/roof-shapes';
import type { OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };
const GROUND = 100;

/** a footprint around the tile centre, given in metres (x east, y north) */
function ring(m: [number, number][]): [number, number][] {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  const k = 111320, c = Math.cos((cy * Math.PI) / 180);
  const r = m.map(([x, y]) => [cx + x / (k * c), cy + y / k] as [number, number]);
  return [...r, r[0]];
}
const RECT = ring([[-12, -5], [12, -5], [12, 5], [-12, 5]]);
const ELL = ring([[-12, -5], [12, -5], [12, 15], [2, 15], [2, 5], [-12, 5]]);

function mesh(b: OsmBuilding[]) {
  return buildBuildingMesh({ tile: TILE, buildings: b, sampleHeight: () => GROUND });
}

/** edges above the foundation used by an odd number of triangles: holes in the shell (vertices matched within 1 mm) */
function openEdges(m: { vertices: Float32Array; vertexCount: number }): number {
  const ids: [number, number, number][] = [];
  const id = (i: number) => {
    const x = m.vertices[i * 6], y = m.vertices[i * 6 + 1], z = m.vertices[i * 6 + 2];
    let k = ids.findIndex((p) => Math.abs(p[0] - x) < 1e-3 && Math.abs(p[1] - y) < 1e-3 && Math.abs(p[2] - z) < 1e-3);
    if (k < 0) k = ids.push([x, y, z]) - 1;
    return k;
  };
  const uses = new Map<string, number>();
  for (let t = 0; t < m.vertexCount; t += 3) {
    const v = [id(t), id(t + 1), id(t + 2)];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      if (ids[a][1] < GROUND + 0.01 && ids[b][1] < GROUND + 0.01) continue; // open bottom
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((n) => n % 2 === 1).length;
}

function maxY(m: { vertices: Float32Array; vertexCount: number }): number {
  let y = -Infinity;
  for (let i = 0; i < m.vertexCount; i++) y = Math.max(y, m.vertices[i * 6 + 1]);
  return y;
}

const PLANAR = ['gabled', 'hipped', 'half-hipped', 'side_hipped', 'side_half-hipped', 'gambrel', 'mansard', 'round',
  'saltbox', 'bellcast_gable', 'crosspitched', 'butterfly', 'sawtooth', 'skillion'];

describe('roof shapes (S3DB)', () => {
  it.each([...PLANAR, 'flat', 'pyramidal', 'cone', 'dome', 'onion'])('%s closes the building shell and tops out at height', (shape) => {
    for (const fp of [RECT, ELL]) {
      const m = mesh([{ rings: [fp], tags: { building: 'yes', height: '14', 'roof:shape': shape, 'roof:height': '4' } }]);
      for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i])).toBe(true);
      expect(openEdges(m)).toBe(0);
      if (shape !== 'butterfly' && shape !== 'flat') expect(maxY(m)).toBeCloseTo(GROUND + 14, 1);
      // nothing rises above height but an onion's bulge never does either
      expect(maxY(m)).toBeLessThanOrEqual(GROUND + 14.01);
    }
  });

  it('resolves aliases and draws unknown shapes and roof:shape=many flat', () => {
    expect(roofShape({ 'roof:shape': 'Pitched' })).toBe('gabled');
    expect(roofShape({ 'roof:shape': 'hipped-and-gabled' })).toBe('half-hipped');
    expect(roofShape({ 'roof:shape': 'many' })).toBe('flat');
    expect(roofShape({ 'roof:shape': 'spaceship' })).toBe('flat');
    expect(roofShape({})).toBe('flat');
  });

  it('reads roof:direction as degrees or a 16-point compass', () => {
    const near = (a: XZ | undefined, b: XZ) => {
      expect(a![0]).toBeCloseTo(b[0], 6);
      expect(a![1]).toBeCloseTo(b[1], 6);
    };
    near(roofDirection({ 'roof:direction': '90' }), [1, 0]); // east (x east, z south)
    near(roofDirection({ 'roof:direction': 'S' }), [0, 1]);
    near(roofDirection({ 'roof:direction': 'NNE' }), [Math.sin(Math.PI / 8), -Math.cos(Math.PI / 8)]);
    expect(roofDirection({ 'roof:direction': 'up' })).toBeUndefined();
  });

  it('runs the ridge along the long side of the minimum bounding rectangle, even rotated', () => {
    const a = (30 * Math.PI) / 180;
    const rot = (x: number, z: number): XZ => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
    const fp = [rot(-12, -5), rot(12, -5), rot(12, 5), rot(-12, 5)];
    const f = roofFrame(fp, {});
    expect(Math.abs(f.u[0] * Math.cos(a) + f.u[1] * Math.sin(a))).toBeCloseTo(1, 6);
    expect(f.halfU).toBeCloseTo(12, 6);
    expect(f.halfV).toBeCloseTo(5, 6);
    const across = roofFrame(fp, { 'roof:orientation': 'across' });
    expect(across.halfU).toBeCloseTo(5, 6);
  });

  it('gabled: ridge along the long axis, gable walls up to the ridge', () => {
    const f = roofFrame([[-12, -5], [12, -5], [12, 5], [-12, 5]], {});
    const roof = roofModel('gabled', f, 4, [[-12, -5], [12, -5], [12, 5], [-12, 5]], {});
    if (roof.kind !== 'planar') throw new Error('planar');
    expect(roof.field([0, 0])).toBeCloseTo(4, 6);
    expect(roof.field([11, 0])).toBeCloseTo(4, 6); // along the ridge
    expect(roof.field([0, 5])).toBeCloseTo(0, 6);
    expect(roof.field([0, 2.5])).toBeCloseTo(2, 6);
  });

  it('skillion slopes down toward roof:direction, else toward the first edge of the way', () => {
    const fp: XZ[] = [[-12, -5], [12, -5], [12, 5], [-12, 5]];
    const south = roofModel('skillion', roofFrame(fp, { 'roof:direction': 'S' }), 3, fp, { 'roof:direction': 'S' });
    if (south.kind !== 'planar') throw new Error('planar');
    expect(south.field([0, 5])).toBeCloseTo(0, 6); // z south: the south eave is low
    expect(south.field([0, -5])).toBeCloseTo(3, 6);
    const byEdge = roofModel('skillion', roofFrame(fp, {}), 3, fp, {}, [0, -1]);
    if (byEdge.kind !== 'planar') throw new Error('planar');
    expect(byEdge.field([0, -5])).toBeCloseTo(0, 6);
  });

  it('hipped ends slope like the sides; mansard breaks at 0.6 of the roof height', () => {
    const fp: XZ[] = [[-12, -5], [12, -5], [12, 5], [-12, 5]];
    const f = roofFrame(fp, {});
    const hip = roofModel('hipped', f, 5, fp, {});
    if (hip.kind !== 'planar') throw new Error('planar');
    expect(hip.field([12, 0])).toBeCloseTo(0, 6);
    expect(hip.field([7, 0])).toBeCloseTo(5, 6); // the ridge ends a half-width in from the hip
    const man = roofModel('mansard', f, 5, fp, {});
    if (man.kind !== 'planar') throw new Error('planar');
    expect(man.field([0, 3.75])).toBeCloseTo(3, 6);
    expect(man.field([10.75, 0])).toBeCloseTo(3, 6);
  });

  it('derives the roof height from roof:angle, roof:levels or a 30° default; levels add up', () => {
    expect(computeHeights({ height: '20', 'roof:shape': 'gabled', 'roof:angle': '45' }, 5).roof).toBeCloseTo(5, 6);
    expect(computeHeights({ height: '20', 'roof:shape': 'gabled', 'roof:levels': '2' }, 5).roof).toBe(6);
    expect(computeHeights({ height: '20', 'roof:shape': 'gabled' }, 5).roof).toBeCloseTo(5 * Math.tan(Math.PI / 6), 6);
    expect(computeHeights({ height: '20', 'roof:shape': 'dome' }, 6).roof).toBe(6);
    // facade levels plus the roof (S3DB: building:levels=3, roof:levels=1 → 12 m, 9 m of it facade), plus the 1 m plinth
    expect(computeHeights({ 'building:levels': '3', 'roof:levels': '1', 'roof:shape': 'gabled' }, 5)).toEqual({ min: 0, wall: 10, roof: 3 });
    expect(computeHeights({ 'building:levels': '2', 'roof:height': '2.5', 'roof:shape': 'hipped' })).toEqual({ min: 0, wall: 7, roof: 2.5 });
    expect(computeHeights({ height: '10', 'building:min_level': '2' }).min).toBe(6);
  });

  it('a canopy has no walls and no ground-level ceiling', () => {
    const m = mesh([{ rings: [RECT], tags: { building: 'roof', height: '5', 'roof:shape': 'gabled', 'roof:height': '1' } }]);
    let minY = Infinity;
    for (let i = 0; i < m.vertexCount; i++) minY = Math.min(minY, m.vertices[i * 6 + 1]);
    expect(minY).toBeCloseTo(GROUND + 4, 3);
  });

  it('every roof face is planar and faces up (no twisted quads across a crease)', () => {
    for (const shape of PLANAR) {
      const m = mesh([{ rings: [ELL], tags: { building: 'yes', height: '14', 'roof:shape': shape, 'roof:height': '4' } }]);
      for (let t = 0; t < m.vertexCount; t += 3) {
        const ny = m.vertices[t * 6 + 4];
        if (Math.abs(ny) < 1e-6) continue; // wall
        expect(ny).toBeGreaterThan(0);
      }
    }
  });

  describe('on the straight skeleton', () => {
    const BRACKET = ring([[0, 0], [30, 0], [30, 12], [12, 12], [12, 68], [30, 68], [30, 80], [0, 80]]);
    const YARD = ring([[-20, -15], [20, -15], [20, 15], [-20, 15]]);
    const YARD_IN = ring([[-10, -5], [10, -5], [10, 5], [-10, 5]]).reverse();

    it('a rectangle keeps its planes; an L, a [ and a courtyard follow the skeleton', () => {
      const rect: XZ[] = [[-12, -5], [12, -5], [12, 5], [-12, 5]];
      expect(roofSkeleton('hipped', roofFrame(rect, {}), rect, [])).toBeUndefined();
      const ell: XZ[] = [[-12, -5], [12, -5], [12, 15], [2, 15], [2, 5], [-12, 5]];
      const sk = roofSkeleton('hipped', roofFrame(ell, {}), ell, []);
      // the ridges run down the middle of the 10 m wide arms, not of the bounding box
      expect(sk?.tMax).toBeCloseTo(5, 6);
      expect(roofSkeleton('gambrel', roofFrame(ell, {}), ell, [])).toBeUndefined();
    });

    it.each(['hipped', 'gabled'])('%s closes the shell and tops out at height', (shape) => {
      for (const rings of [[ELL], [BRACKET], [YARD, YARD_IN]]) {
        const m = mesh([{ rings, tags: { building: 'yes', height: '14', 'roof:shape': shape, 'roof:height': '4' } }]);
        for (let i = 0; i < m.vertices.length; i++) expect(Number.isFinite(m.vertices[i])).toBe(true);
        expect(openEdges(m)).toBe(0);
        expect(maxY(m)).toBeCloseTo(GROUND + 14, 1);
      }
    });

    it('a gabled L gets a gable at the end of each arm, the corner stays hipped', () => {
      const ell: XZ[] = [[-12, -5], [12, -5], [12, 15], [2, 15], [2, 5], [-12, 5]];
      const roof = skeletonRoof(roofSkeleton('gabled', roofFrame(ell, {}), ell, [])!, 'gabled', 4)!;
      const tops = roof.breaks.map(([x, z]) => [Math.round(x * 1e3) / 1e3, Math.round(z * 1e3) / 1e3]).sort((a, b) => a[0] - b[0]);
      expect(tops).toEqual([[-12, 0], [7, 15]]);
      expect(roof.field([-12, 0])).toBeCloseTo(4, 6);
      expect(roof.field([12, -5])).toBeCloseTo(0, 6);
      const hip = skeletonRoof(roofSkeleton('hipped', roofFrame(ell, {}), ell, [])!, 'hipped', 4)!;
      expect(hip.breaks).toEqual([]);
      expect(hip.field([-12, 0])).toBeCloseTo(0, 6);
    });
  });
});
