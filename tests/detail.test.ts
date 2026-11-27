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

describe('simple props', () => {
  it('a lamp post is its pole and its raised arm, a traffic light its post', async () => {
    const { propLines } = await import('../src/world/osm-manager');
    const { INSTANCE, LAMP_SHAPE, SIGNAL_SHAPE, TREE_STRIDE } = await import('../src/world/props-mesher');
    const inst = new Float32Array(3 * TREE_STRIDE);
    // a tree, a lamp at (10, 2, 20) facing +x, a signal at (0, 0, 5)
    inst.set([1, 0, 1, 10, 0, 0, 0, 0], 0);
    inst.set([10, 2, 20, 1, 0, INSTANCE.LAMP, 0, 0], TREE_STRIDE);
    inst.set([0, 0, 5, 1, 0, INSTANCE.SIGNAL, 0, 1], 2 * TREE_STRIDE);
    const l = new Float32Array(propLines(inst));
    expect(l.length).toBe(3 * 2 * 4);
    expect([...l.slice(0, 3)]).toEqual([10, 2, 20]);
    expect(l[5]).toBeCloseTo(2 + LAMP_SHAPE.HEIGHT, 5);
    // the arm reaches out along +x and up
    expect(l[12]).toBeGreaterThan(10 + 1);
    expect(l[13]).toBeGreaterThan(2 + LAMP_SHAPE.HEIGHT);
    expect(l[14]).toBeCloseTo(20, 5);
    expect(l[21]).toBeCloseTo(SIGNAL_SHAPE.HEAD_TOP, 5);
  });

  it('the phone draws half the trees, as lines what the desktop draws solid', () => {
    expect(PHONE_DETAIL.treeShare).toBeLessThan(FULL_DETAIL.treeShare);
    expect(PHONE_DETAIL.simpleProps).toBe(true);
    expect(FULL_DETAIL.simpleProps).toBe(false);
  });
});
