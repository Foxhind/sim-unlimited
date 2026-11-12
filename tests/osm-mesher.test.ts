import { describe, expect, it } from 'vitest';
import { RAMP, snowy } from '../src/engine/palette';
import { tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { OsmTileData } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function squareRing(): [number, number][] {
  const b = tileBounds(TILE);
  const dx = (b.east - b.west) * 0.2;
  const dy = (b.north - b.south) * 0.2;
  const w = b.west + dx, e = b.east - dx, s = b.south + dy, n = b.north - dy;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

function mesh(data: OsmTileData, sample: (lon: number, lat: number) => number, maxEdgeMeters?: number) {
  return buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: sample, maxEdgeMeters });
}

const flat = () => 100;

describe('buildOsmMesh', () => {
  it('emits interleaved pos+normal with one ramp per vertex', () => {
    const data: OsmTileData = { areas: [{ rings: [squareRing()], tags: { natural: 'scrub' } }], lines: [], points: [], buildings: [] };
    const m = mesh(data, flat);
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(m.vertices.length).toBe(m.vertexCount * 6);
    expect(m.ramps.length).toBe(m.vertexCount);
    for (let i = 0; i < m.vertexCount; i++) expect(m.ramps[i]).toBe(snowy(RAMP.FOREST));
    // every face normal points up
    for (let i = 0; i < m.vertexCount; i++) expect(m.vertices[i * 6 + 4]).toBeGreaterThanOrEqual(0);
  });

  it('drapes non-water areas onto the DEM with a bias', () => {
    const data: OsmTileData = { areas: [{ rings: [squareRing()], tags: { landuse: 'farmland' } }], lines: [], points: [], buildings: [] };
    const m = mesh(data, () => 250, 50);
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.vertices[i * 6 + 1]).toBeCloseTo(250.6, 3);
      expect(m.ramps[i]).toBe(snowy(RAMP.FIELD));
    }
  });

  it('subdivides large triangles to follow varying terrain', () => {
    const data: OsmTileData = { areas: [{ rings: [squareRing()], tags: { natural: 'scrub' } }], lines: [], points: [], buildings: [] };
    const sample = (_lon: number, lat: number) => lat * 1000;
    const coarse = mesh(data, sample, 100000);
    const fine = mesh(data, sample, 40);
    expect(fine.vertexCount).toBeGreaterThan(coarse.vertexCount);
    const ys = new Set<number>();
    for (let i = 0; i < fine.vertexCount; i++) ys.add(Math.round(fine.vertices[i * 6 + 1]));
    expect(ys.size).toBeGreaterThan(1);
  });

  it('renders water as a flat plane at the boundary height', () => {
    const data: OsmTileData = { areas: [{ rings: [squareRing()], tags: { natural: 'water' } }], lines: [], points: [], buildings: [] };
    const m = mesh(data, () => 42, 40);
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.ramps[i]).toBe(RAMP.WATER);
      expect(m.vertices[i * 6 + 1]).toBeCloseTo(42.3, 3);
    }
  });

  it('builds a draped road ribbon wider than its centerline', () => {
    const c = tileCenter(TILE);
    const b = tileBounds(TILE);
    const data: OsmTileData = {
      areas: [],
      lines: [{ points: [[b.west + (b.east - b.west) * 0.2, c.lat], [b.west + (b.east - b.west) * 0.8, c.lat]], tags: { highway: 'primary' } }],
      points: [], buildings: [],
    };
    const m = mesh(data, flat, 40);
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.ramps[i]).toBe(RAMP.ASPHALT);
      expect(m.vertices[i * 6 + 1]).toBeCloseTo(101.4, 3);
    }
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < m.vertexCount; i++) {
      const z = m.vertices[i * 6 + 2];
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    expect(maxZ - minZ).toBeGreaterThanOrEqual(13); // primary road ~14 m wide
  });

  it('triangulates areas with holes', () => {
    const outer = squareRing();
    const b = tileBounds(TILE);
    const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    const d = (b.east - b.west) * 0.05;
    const hole: [number, number][] = [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]];
    const data: OsmTileData = { areas: [{ rings: [outer, hole], tags: { natural: 'scrub' } }], lines: [], points: [], buildings: [] };
    const m = mesh(data, flat, 60);
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertexCount; i++) expect(m.ramps[i]).toBe(snowy(RAMP.FOREST));
  });

  it('skips wood/forest and landuse other than farmland (Landsat colours the terrain)', () => {
    for (const tags of [{ natural: 'wood' }, { landuse: 'forest' }, { landuse: 'residential' }, { landuse: 'commercial' }, { landuse: 'meadow' }, { landuse: 'grass' }] as Record<string, string>[]) {
      const data: OsmTileData = { areas: [{ rings: [squareRing()], tags }], lines: [], points: [], buildings: [] };
      expect(buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: flat }).vertexCount, JSON.stringify(tags)).toBe(0);
    }
  });

  it('returns an empty mesh for unclassifiable data', () => {
    const data: OsmTileData = { areas: [{ rings: [squareRing()], tags: { boundary: 'administrative' } }], lines: [], points: [], buildings: [] };
    const m = mesh(data, flat);
    expect(m.vertexCount).toBe(0);
  });
});