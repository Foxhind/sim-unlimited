import { describe, expect, it } from 'vitest';
import { LIGHT, RAMP, rampIndex, snowy } from '../src/engine/palette';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildProps, climateLatitude, TREE, TREE_GEOMETRY, TREE_MESHES, TREE_STRIDE, TREE_TYPES, TREE_VERTEX_FLOATS, treeWeights } from '../src/world/props-mesher';
import type { OsmTileData } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function squareRing(): [number, number][] {
  const b = tileBounds(TILE);
  const dx = (b.east - b.west) * 0.2;
  const dy = (b.north - b.south) * 0.2;
  const w = b.west + dx, e = b.east - dx, s = b.south + dy, n = b.north - dy;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

function runwayLine(): [number, number][] {
  const c = tileCenter(TILE);
  const b = tileBounds(TILE);
  return [
    [b.west + (b.east - b.west) * 0.2, c.lat],
    [b.west + (b.east - b.west) * 0.8, c.lat],
  ];
}

const flat = () => 100;
const empty: OsmTileData = { areas: [], lines: [], points: [], buildings: [] };

function props(data: OsmTileData, detail: 'full' | 'large' = 'full', sample = flat) {
  return buildProps({ tile: TILE, detail, data, sampleHeight: sample });
}

describe('tree geometry', () => {
  it('packs one unit-height silhouette per type, with unit normals', () => {
    expect(TREE_MESHES.length).toBe(TREE_TYPES);
    let next = 0;
    for (const m of TREE_MESHES) {
      expect(m.first).toBe(next);
      expect(m.count % 3).toBe(0);
      expect(m.count).toBeGreaterThan(0);
      next += m.count;
    }
    expect(TREE_GEOMETRY.length).toBe(next * TREE_VERTEX_FLOATS);
    for (let i = 0; i < next; i++) {
      const v = TREE_GEOMETRY.subarray(i * TREE_VERTEX_FLOATS, (i + 1) * TREE_VERTEX_FLOATS);
      expect(Math.hypot(v[3], v[4], v[5])).toBeCloseTo(1, 5);
      expect(v[1]).toBeGreaterThanOrEqual(0);
      expect(v[1]).toBeLessThanOrEqual(1);
      expect([0, 1]).toContain(v[6]);
    }
  });

  it('gives broadleaves, pines and palms a trunk and spruces and cypresses none', () => {
    const hasTrunk = (type: number) => {
      const { first, count } = TREE_MESHES[type];
      for (let i = first; i < first + count; i++) if (TREE_GEOMETRY[i * TREE_VERTEX_FLOATS + 6] === 1) return true;
      return false;
    };
    expect([TREE.BROADLEAF, TREE.PINE, TREE.PALM].every(hasTrunk)).toBe(true);
    expect([TREE.SPRUCE, TREE.CYPRESS].some(hasTrunk)).toBe(false);
  });
});

describe('tree types by climate', () => {
  const top = (w: number[]) => w.indexOf(Math.max(...w));

  it('runs from palms in the tropics through stone pines to spruce in the north', () => {
    expect(treeWeights(10)[TREE.PALM]).toBeGreaterThan(0.3);
    expect(top(treeWeights(36.6))).toBe(TREE.PINE); // Fethiye
    expect(treeWeights(36.6)[TREE.SPRUCE]).toBeLessThan(0.1);
    expect(treeWeights(36.6)[TREE.PALM]).toBe(0);
    expect(top(treeWeights(45))).toBe(TREE.BROADLEAF);
    expect(top(treeWeights(65))).toBe(TREE.SPRUCE);
    for (const lat of [0, 20, 30, 40, 50, 60, 80]) {
      expect(treeWeights(lat).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
  });

  it('climbs toward spruce with elevation, both hemispheres alike', () => {
    expect(climateLatitude(-36.6, 0)).toBe(36.6);
    expect(climateLatitude(47.3, 1500)).toBeCloseTo(57.3, 5); // Innsbruck mountainside
    expect(climateLatitude(10, -20)).toBe(10);
    expect(top(treeWeights(climateLatitude(47.3, 1500)))).toBe(TREE.SPRUCE);
  });

  it('follows the leaf type of the wood', () => {
    const needle = treeWeights(36.6, { leaf_type: 'needleleaved' });
    expect(needle[TREE.BROADLEAF] + needle[TREE.PALM]).toBe(0);
    const broad = treeWeights(60, { leaf_type: 'broadleaved' });
    expect(broad[TREE.SPRUCE] + broad[TREE.PINE] + broad[TREE.CYPRESS]).toBe(0);
    expect(treeWeights(36.6, { wood: 'deciduous' })[TREE.PINE]).toBe(0);
    // no needle tree in the band: a pine in the south, a spruce in the north
    expect(top(treeWeights(10, { leaf_type: 'needleleaved' }))).toBe(TREE.PINE);
    expect(treeWeights(36.6, { leaf_type: 'mixed' })).toEqual(treeWeights(36.6));
  });
});

describe('buildProps trees (Q36)', () => {
  it('scatters deterministic trees inside forest areas', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'forest' } }] };
    const a = props(data);
    const b = props(data);
    expect(a.trees.length).toBeGreaterThan(0);
    expect(a.trees.length % TREE_STRIDE).toBe(0);
    expect(Array.from(a.trees)).toEqual(Array.from(b.trees));
    const count = a.trees.length / TREE_STRIDE;
    let prevType = -1;
    for (let i = 0; i < count; i++) {
      const t = a.trees.subarray(i * TREE_STRIDE, (i + 1) * TREE_STRIDE);
      expect(t[1]).toBe(100);
      expect(t[3]).toBeGreaterThanOrEqual(8);
      expect(t[3]).toBeLessThanOrEqual(20);
      expect(t[4]).toBe(snowy(RAMP.FOREST));
      expect(Number.isInteger(t[5]) && t[5] >= 0 && t[5] < TREE_TYPES).toBe(true);
      expect(t[5]).toBeGreaterThanOrEqual(prevType); // sorted by type: one draw per type
      prevType = t[5];
    }
  });

  it('mixes types in a forest and keeps them to the climate', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'forest' } }] };
    const types = (sample: () => number, tags: Record<string, string> = { landuse: 'forest' }) => {
      const p = buildProps({ tile: TILE, detail: 'full', data: { ...data, areas: [{ ...data.areas[0], tags }] }, sampleHeight: sample });
      const n = new Array(TREE_TYPES).fill(0);
      for (let i = 5; i < p.trees.length; i += TREE_STRIDE) n[p.trees[i]]++;
      return n;
    };
    const lowland = types(flat);
    expect(lowland.filter((v) => v > 0).length).toBeGreaterThan(1);
    expect(lowland[TREE.PALM]).toBe(0); // this tile is at ~42 deg N
    const alpine = types(() => 2500);
    expect(alpine[TREE.SPRUCE]).toBeGreaterThan(alpine.reduce((a, b) => a + b, 0) * 0.6);
    const needle = types(flat, { landuse: 'forest', leaf_type: 'needleleaved' });
    expect(needle[TREE.BROADLEAF] + needle[TREE.PALM]).toBe(0);
  });

  it('caps tree count and skips water-level samples', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { natural: 'wood' } }] };
    const big = props(data);
    expect(big.trees.length / TREE_STRIDE).toBeLessThanOrEqual(2500);
    const wet = props(data, 'full', () => -5);
    expect(wet.trees.length).toBe(0);
  });

  it('plants trees in forest whose fill the drape no longer draws', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'forest' } }] };
    expect(props(data).trees.length).toBeGreaterThan(0);
    expect(buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: flat }).vertexCount).toBe(0);
  });

  it('foliage takes the ramp given for the ground under each tree', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'forest' } }] };
    const p = buildProps({ tile: TILE, detail: 'full', data, sampleHeight: flat, treeRamp: () => 77 });
    expect(p.trees.length).toBeGreaterThan(0);
    for (let i = 4; i < p.trees.length; i += TREE_STRIDE) expect(p.trees[i]).toBe(snowy(77));
  });

  it('ignores non-forest areas and the large detail layer', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'residential' } }] };
    expect(props(data).trees.length).toBe(0);
    const forest: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'forest' } }] };
    expect(props(forest, 'large').trees.length).toBe(0);
    expect(props(forest, 'large').lights.length).toBe(0);
  });
});

describe('buildProps lights (Q7)', () => {
  it('emits edge, centerline and threshold lights along a runway', () => {
    const data: OsmTileData = { ...empty, lines: [{ points: runwayLine(), tags: { aeroway: 'runway' } }] };
    const p = props(data);
    expect(p.lights.length).toBeGreaterThan(0);
    expect(p.lights.length % 4).toBe(0);
    const indices = new Set<number>();
    for (let i = 0; i < p.lights.length / 4; i++) {
      expect(p.lights[i * 4 + 1]).toBeCloseTo(101.8, 3);
      indices.add(p.lights[i * 4 + 3]);
    }
    expect(indices.has(rampIndex(RAMP.EMISSIVE, 13))).toBe(true); // edge
    expect(indices.has(rampIndex(RAMP.EMISSIVE, 10))).toBe(true); // centerline
    expect(indices.has(rampIndex(RAMP.HUD_GREEN, 13))).toBe(true); // threshold
    // edge lights straddle the centerline in z (east-west runway at constant lat)
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.lights.length / 4; i++) {
      if (p.lights[i * 4 + 3] !== rampIndex(RAMP.EMISSIVE, 13)) continue;
      minZ = Math.min(minZ, p.lights[i * 4 + 2]);
      maxZ = Math.max(maxZ, p.lights[i * 4 + 2]);
    }
    expect(maxZ - minZ).toBeGreaterThan(40); // default 45 m runway width
  });

  it('emits blue taxiway edge lights only', () => {
    const data: OsmTileData = { ...empty, lines: [{ points: runwayLine(), tags: { aeroway: 'taxiway', width: '20' } }] };
    const p = props(data);
    expect(p.lights.length).toBeGreaterThan(0);
    for (let i = 0; i < p.lights.length / 4; i++) {
      expect(p.lights[i * 4 + 3]).toBe(LIGHT.TAXI_BLUE);
    }
  });

  it('ignores non-aeroway lines', () => {
    const data: OsmTileData = { ...empty, lines: [{ points: runwayLine(), tags: { highway: 'primary' } }] };
    expect(props(data).lights.length).toBe(0);
  });
});