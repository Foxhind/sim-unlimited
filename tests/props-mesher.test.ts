import { describe, expect, it } from 'vitest';
import { LIGHT, RAMP, rampIndex, snowy } from '../src/engine/palette';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildProps, climateLatitude, INSTANCE, MARINA, ORCHARD, TREE, TREE_GEOMETRY, TREE_MESHES, TREE_STRIDE, TREE_TYPES, TREE_VERTEX_FLOATS, treeColour, treeWeights } from '../src/world/props-mesher';
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
  it('packs one unit-height silhouette per tree type (then the props), with unit normals', () => {
    expect(TREE_MESHES.length).toBe(TREE_TYPES + 4);
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
      if (i < TREE_MESHES[TREE_TYPES].first) expect(v[1]).toBeLessThanOrEqual(1);
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
      expect(treeColour(a.trees, i * TREE_STRIDE)).toBe(snowy(RAMP.FOREST));
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
    for (let i = 0; i < p.trees.length; i += TREE_STRIDE) expect(treeColour(p.trees, i)).toBe(snowy(77));
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
      expect(p.lights[i * 4 + 1]).toBeCloseTo(100.5, 3);
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

describe('orchards (landuse=orchard)', () => {
  const center = tileCenter(TILE);
  const M = 111320;
  const cos = Math.cos((center.lat * Math.PI) / 180);
  /** a w × h m rectangle about (dx, dy) m from the tile centre, its long side turned by `turn` radians */
  function plot(w: number, h: number, turn = 0, dx = 0, dy = 0): [number, number][] {
    const c = Math.cos(turn), s = Math.sin(turn);
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]];
    return pts.map(([x, y]) => [center.lon + (dx + x * c - y * s) / (M * cos), center.lat + (dy + x * s + y * c) / M]);
  }
  const orchard = (ring: [number, number][], tags: Record<string, string> = {}): OsmTileData => ({
    ...empty, areas: [{ rings: [ring], tags: { landuse: 'orchard', ...tags } }],
  });
  /** every tree: [x, z, height, type] */
  function trees(t: Float32Array): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < t.length; i += TREE_STRIDE) out.push([t[i], t[i + 2], t[i + 3], t[i + 5]]);
    return out;
  }

  it('plants low broadleaves in rows at the orchard spacing', () => {
    const all = trees(props(orchard(plot(120, 60))).trees);
    const expected = (120 * 60) / (ORCHARD.ROW_M * ORCHARD.TREE_M);
    expect(all.length).toBeGreaterThan(expected * 0.8);
    expect(all.length).toBeLessThan(expected * 1.2);
    for (const [, , h, type] of all) {
      expect(type).toBe(TREE.BROADLEAF);
      expect(h).toBeGreaterThanOrEqual(ORCHARD.HEIGHT_M[0]);
      expect(h).toBeLessThanOrEqual(ORCHARD.HEIGHT_M[1]);
    }
  });

  it('lines the rows up with the long side of the plot', () => {
    for (const turn of [0, 0.5, 1.2]) {
      const all = trees(props(orchard(plot(150, 60, turn))).trees);
      // across the rows (the short side) the trees fall into bands ROW_M apart, jitter aside
      const across = all.map(([x, z]) => -x * Math.sin(turn) - z * Math.cos(turn));
      const phase = across.map((v) => ((v % ORCHARD.ROW_M) + ORCHARD.ROW_M) % ORCHARD.ROW_M);
      const ref = phase[0];
      for (const p of phase) {
        const d = Math.min(Math.abs(p - ref), ORCHARD.ROW_M - Math.abs(p - ref));
        // + a few cm: the orchard's flat frame and the tile's ENU differ that much over 150 m
        expect(d).toBeLessThanOrEqual(2 * ORCHARD.JITTER_M + 0.05);
      }
    }
  });

  it('keeps the same trees on both sides of a tile border', () => {
    const b = tileBounds(TILE);
    const next: Tile = { ...TILE, x: TILE.x + 1 };
    // a plot across the east border
    const dx = (b.east - center.lon) * M * cos;
    const data = orchard(plot(200, 80, 0.3, dx, 0));
    const here = props(data).trees;
    const there = buildProps({ tile: next, detail: 'full', data, sampleHeight: flat }).trees;
    expect(here.length).toBeGreaterThan(0);
    expect(there.length).toBeGreaterThan(0);
    const whole = (200 * 80) / (ORCHARD.ROW_M * ORCHARD.TREE_M);
    expect(here.length / TREE_STRIDE + there.length / TREE_STRIDE).toBeGreaterThan(whole * 0.8);
    expect(here.length / TREE_STRIDE + there.length / TREE_STRIDE).toBeLessThan(whole * 1.2);
  });

  it('thins a huge orchard instead of planting without end', () => {
    expect(props(orchard(plot(900, 900))).trees.length / TREE_STRIDE).toBeLessThanOrEqual(ORCHARD.MAX_TREES);
  });

  it('palms for trees=palm_trees, nothing on vineyards', () => {
    for (const [, , , type] of trees(props(orchard(plot(60, 40), { trees: 'palm_trees' })).trees)) expect(type).toBe(TREE.PALM);
    const vineyard: OsmTileData = { ...empty, areas: [{ rings: [plot(60, 40)], tags: { landuse: 'vineyard' } }] };
    expect(props(vineyard).trees.length).toBe(0);
  });
});

describe('yachts in a marina', () => {
  const center = tileCenter(TILE);
  const M = 111320;
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const at = (x: number, y: number): [number, number] => [center.lon + x / (M * cos), center.lat + y / M];
  // a pontoon 100 m long running east, over the sea
  const pontoon = { points: [at(-50, 0), at(50, 0)], tags: { man_made: 'pier', width: '3' } };
  const marina = { at: at(0, 80), tags: { leisure: 'marina' } };
  const sea = () => -4;
  const yachts = (data: OsmTileData, sample = sea) => buildProps({ tile: TILE, detail: 'full', data, sampleHeight: sample }).yachts;

  it('moors yachts on both sides of a marina pontoon, stern to it, bow out, on the water', () => {
    const y = yachts({ ...empty, lines: [pontoon], points: [marina] });
    const n = y.length / TREE_STRIDE;
    const slots = 2 * Math.floor(100 / MARINA.SLOT_M);
    expect(n).toBeGreaterThan(slots * MARINA.OCCUPANCY * 0.6);
    expect(n).toBeLessThanOrEqual(slots);
    let north = 0, south = 0;
    for (let i = 0; i < y.length; i += TREE_STRIDE) {
      const [x, h, z, len, , type, , yaw] = [y[i], y[i + 1], y[i + 2], y[i + 3], y[i + 4], y[i + 5], y[i + 6], y[i + 7]];
      expect([INSTANCE.SAILBOAT, INSTANCE.MOTORBOAT]).toContain(type);
      expect(h).toBe(0);
      expect(len).toBeGreaterThanOrEqual(MARINA.LENGTH_M[0]);
      expect(len).toBeLessThanOrEqual(MARINA.LENGTH_M[1]);
      expect(Math.abs(x)).toBeLessThan(50);
      // the stern on the pontoon's edge, the bow straight out (north: −z, south: +z)
      expect(Math.abs(Math.abs(z) - (1.5 + MARINA.GAP_M))).toBeLessThan(0.5);
      expect(Math.abs(Math.cos(yaw))).toBeLessThan(1e-6);
      expect(Math.sign(Math.sin(yaw))).toBe(Math.sign(z));
      if (z < 0) north++; else south++;
    }
    expect(north).toBeGreaterThan(0);
    expect(south).toBeGreaterThan(0);
    // sailing yachts first, then motor yachts: the instances stay sorted by type
    const types = [];
    for (let i = 5; i < y.length; i += TREE_STRIDE) types.push(y[i]);
    expect(types).toEqual([...types].sort((a, b) => a - b));
  });

  it('none without a marina near, none on land, none at a wide quay', () => {
    expect(yachts({ ...empty, lines: [pontoon] }).length).toBe(0);
    expect(yachts({ ...empty, lines: [pontoon], points: [{ ...marina, at: at(0, 900) }] }).length).toBe(0);
    expect(yachts({ ...empty, lines: [pontoon], points: [marina] }, () => 2).length).toBe(0);
    expect(yachts({ ...empty, lines: [{ ...pontoon, tags: { man_made: 'pier', width: '20' } }], points: [marina] }).length).toBe(0);
  });

  it('a marina mapped as an area holds its pontoons', () => {
    const ring = [at(-80, -60), at(80, -60), at(80, 60), at(-80, 60), at(-80, -60)];
    const y = yachts({ ...empty, lines: [pontoon], areas: [{ rings: [ring], tags: { leisure: 'marina' } }] });
    expect(y.length).toBeGreaterThan(0);
  });

  it('the yacht shapes: hull at the waterline, a sailing yacht taller than a motor yacht', () => {
    const top = (t: number) => {
      const { first, count } = TREE_MESHES[t];
      let lo = Infinity, hi = -Infinity;
      for (let i = first; i < first + count; i++) {
        lo = Math.min(lo, TREE_GEOMETRY[i * TREE_VERTEX_FLOATS + 1]);
        hi = Math.max(hi, TREE_GEOMETRY[i * TREE_VERTEX_FLOATS + 1]);
      }
      return [lo, hi];
    };
    expect(top(INSTANCE.SAILBOAT)[0]).toBe(0);
    expect(top(INSTANCE.MOTORBOAT)[0]).toBe(0);
    expect(top(INSTANCE.SAILBOAT)[1]).toBeGreaterThan(1);
    expect(top(INSTANCE.MOTORBOAT)[1]).toBeLessThan(0.4);
  });
});