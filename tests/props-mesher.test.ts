import { describe, expect, it } from 'vitest';
import { LIGHT, RAMP, rampIndex, snowy } from '../src/engine/palette';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildProps, CONE_VERTICES } from '../src/world/props-mesher';
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

describe('CONE_VERTICES', () => {
  it('is 18 vertices of pos+normal with upward-facing normals', () => {
    expect(CONE_VERTICES.length).toBe(18 * 6);
    for (let i = 0; i < 18; i++) {
      const nx = CONE_VERTICES[i * 6 + 3], ny = CONE_VERTICES[i * 6 + 4], nz = CONE_VERTICES[i * 6 + 5];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      expect(ny).toBeGreaterThanOrEqual(0);
      expect(CONE_VERTICES[i * 6 + 1]).toBeGreaterThanOrEqual(0);
      expect(CONE_VERTICES[i * 6 + 1]).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildProps trees (Q36)', () => {
  it('scatters deterministic trees inside forest areas', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { landuse: 'forest' } }] };
    const a = props(data);
    const b = props(data);
    expect(a.trees.length).toBeGreaterThan(0);
    expect(a.trees.length % 5).toBe(0);
    expect(Array.from(a.trees)).toEqual(Array.from(b.trees));
    const count = a.trees.length / 5;
    for (let i = 0; i < count; i++) {
      expect(a.trees[i * 5 + 1]).toBe(100);
      expect(a.trees[i * 5 + 3]).toBeGreaterThanOrEqual(8);
      expect(a.trees[i * 5 + 3]).toBeLessThanOrEqual(16);
      expect(a.trees[i * 5 + 4]).toBe(snowy(RAMP.FOREST));
    }
  });

  it('caps tree count and skips water-level samples', () => {
    const data: OsmTileData = { ...empty, areas: [{ rings: [squareRing()], tags: { natural: 'wood' } }] };
    const big = props(data);
    expect(big.trees.length / 5).toBeLessThanOrEqual(2500);
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
    for (let i = 4; i < p.trees.length; i += 5) expect(p.trees[i]).toBe(snowy(77));
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