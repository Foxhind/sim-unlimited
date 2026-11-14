import { describe, expect, it } from 'vitest';
import { RAMP, snowy } from '../src/engine/palette';
import { enuToLatLon, tileBounds, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { OsmTileData } from '../src/world/osm-types';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';

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

describe('areas on the terrain faces', () => {
  // creased relief: belts of 250 m cross the area, so the terrain bends inside every draped triangle
  const GRID = 32;
  const side = GRID + 1;
  const heights = Float32Array.from({ length: side * side }, (_, k) => {
    const i = k % side, j = Math.floor(k / side);
    return 600 + 500 * Math.sin(i / 5) * Math.cos(j / 4);
  });
  const tin = buildTerrainTin(TILE, GRID, heights);
  const surface = tinSampler(tin, TILE);
  const data: OsmTileData = { areas: [{ rings: [squareRing()], tags: { landuse: 'farmland' } }], lines: [], points: [], buildings: [] };
  const center = tileCenter(TILE);
  /** largest distance from a mesh to the terrain surface plus the bias, over vertices and face centres */
  const offSurface = (m: ReturnType<typeof buildOsmMesh>): number => {
    let worst = 0;
    for (let v = 0; v < m.vertexCount; v += 3) {
      const p = [0, 1, 2].map((k) => [m.vertices[(v + k) * 6], m.vertices[(v + k) * 6 + 1], m.vertices[(v + k) * 6 + 2]]);
      const probes = [...p, [0, 1, 2].map((c) => (p[0][c] + p[1][c] + p[2][c]) / 3)];
      for (const [x, y, z] of probes) {
        const ll = enuToLatLon(center, x, -z, 0);
        worst = Math.max(worst, Math.abs(y - 0.6 - surface(ll.lon, ll.lat)));
      }
    }
    return worst;
  };

  it('cut by the faces, every piece lies on the terrain; draped, the terrain crosses it', () => {
    const cut = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: surface, tin });
    expect(cut.vertexCount).toBeGreaterThan(0);
    // the probe goes back through lat/lon, which costs decimetres on these slopes
    expect(offSurface(cut)).toBeLessThan(0.5);
    const draped = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: surface });
    expect(offSurface(draped)).toBeGreaterThan(5);
  });

  it('covers the same ground as the area', () => {
    const cut = buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: surface, tin });
    let area = 0;
    for (let v = 0; v < cut.vertexCount; v += 3) {
      const [ax, az, bx, bz, cx, cz] = [0, 1, 2].flatMap((k) => [cut.vertices[(v + k) * 6], cut.vertices[(v + k) * 6 + 2]]);
      area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    }
    const flatMesh = mesh(data, flat);
    let want = 0;
    for (let v = 0; v < flatMesh.vertexCount; v += 3) {
      const [ax, az, bx, bz, cx, cz] = [0, 1, 2].flatMap((k) => [flatMesh.vertices[(v + k) * 6], flatMesh.vertices[(v + k) * 6 + 2]]);
      want += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    }
    expect(area / want).toBeGreaterThan(0.999);
    expect(area / want).toBeLessThan(1.001);
  });
});
