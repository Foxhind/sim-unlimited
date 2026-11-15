import { describe, expect, it } from 'vitest';
import { RAMP, snowy, withGlow } from '../src/engine/palette';
import { enuToLatLon, tileBounds, tileCenter, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildOsmMesh, osmWidthM } from '../src/world/osm-mesher';
import { parseFilter } from '../src/world/osm-api';
import { osmFilter } from '../src/world/overpass';
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
    const all = mesh(data, () => 42, 40);
    expect(all.vertexCount).toBe(0); // water is a mesh of its own (drawn after the drape, no depth writes)
    const m = all.water;
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.ramps[i]).toBe(RAMP.WATER);
      expect(m.vertices[i * 6 + 1]).toBeCloseTo(42.3, 3);
    }
  });

  it('river and canal ribbons go to the water mesh, roads over them to the road mesh', () => {
    const c = tileCenter(TILE);
    const b = tileBounds(TILE);
    const across = (tags: Record<string, string>) => ({
      points: [[b.west + (b.east - b.west) * 0.2, c.lat], [b.west + (b.east - b.west) * 0.8, c.lat]] as [number, number][], tags,
    });
    const data: OsmTileData = { areas: [], lines: [across({ waterway: 'river' }), across({ highway: 'primary' })], points: [], buildings: [] };
    const m = mesh(data, flat, 40);
    expect(m.vertexCount).toBe(0);
    expect(m.water.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.water.vertexCount; i++) expect(m.water.ramps[i]).toBe(RAMP.WATER);
    expect(m.roads.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.roads.vertexCount; i++) expect(m.roads.ramps[i]).not.toBe(RAMP.WATER);
  });

  it('builds a draped road ribbon wider than its centerline', () => {
    const c = tileCenter(TILE);
    const b = tileBounds(TILE);
    const data: OsmTileData = {
      areas: [],
      lines: [{ points: [[b.west + (b.east - b.west) * 0.2, c.lat], [b.west + (b.east - b.west) * 0.8, c.lat]], tags: { highway: 'primary' } }],
      points: [], buildings: [],
    };
    const all = mesh(data, flat, 40);
    expect(all.vertexCount).toBe(0); // roads are a mesh of their own (drawn near only)
    const m = all.roads;
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(all.roadLines.length).toBeGreaterThan(0);
    // the ribbon (a primary road is street-lit: its ramps carry a glow level, its lamp poles share the mesh)
    const ribbon = [...Array(m.vertexCount).keys()].filter((i) => withGlow(m.ramps[i], 0) === RAMP.ASPHALT);
    expect(ribbon.length).toBeGreaterThan(0);
    for (const i of ribbon) expect(m.vertices[i * 6 + 1]).toBeCloseTo(101.4, 3);
    let minZ = Infinity, maxZ = -Infinity;
    for (const i of ribbon) {
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
  const offSurface = (m: { vertices: Float32Array; vertexCount: number }, bias = 0.6): number => {
    let worst = 0;
    for (let v = 0; v < m.vertexCount; v += 3) {
      const p = [0, 1, 2].map((k) => [m.vertices[(v + k) * 6], m.vertices[(v + k) * 6 + 1], m.vertices[(v + k) * 6 + 2]]);
      const probes = [...p, [0, 1, 2].map((c) => (p[0][c] + p[1][c] + p[2][c]) / 3)];
      for (const [x, y, z] of probes) {
        const ll = enuToLatLon(center, x, -z, 0);
        worst = Math.max(worst, Math.abs(y - bias - surface(ll.lon, ll.lat)));
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

  it('a water area lies on the terrain faces, not on a plane at its highest shore point', () => {
    const lake: OsmTileData = { areas: [{ rings: [squareRing()], tags: { natural: 'water', water: 'canal' } }], lines: [], points: [], buildings: [] };
    const cut = buildOsmMesh({ tile: TILE, detail: 'full', data: lake, sampleHeight: surface, tin });
    expect(cut.vertexCount).toBe(0);
    expect(cut.water.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < cut.water.vertexCount; i++) expect(cut.water.ramps[i]).toBe(RAMP.WATER);
    expect(offSurface(cut.water, 0.3)).toBeLessThan(0.5);
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

  const b = tileBounds(TILE);
  const road: OsmTileData = {
    areas: [],
    lines: [{
      points: [[b.west + (b.east - b.west) * 0.1, b.south + (b.north - b.south) * 0.3], [b.west + (b.east - b.west) * 0.9, b.south + (b.north - b.south) * 0.7]],
      tags: { highway: 'tertiary' }, // unlit: no lamp poles in the mesh
    }],
    points: [], buildings: [],
  };

  it('road ribbon cut by the faces lies on the terrain; draped, the terrain crosses it', () => {
    const cut = buildOsmMesh({ tile: TILE, detail: 'full', data: road, sampleHeight: surface, tin });
    expect(cut.roads.vertexCount).toBeGreaterThan(0);
    expect(offSurface(cut.roads, 1.4)).toBeLessThan(0.5);
    const draped = buildOsmMesh({ tile: TILE, detail: 'full', data: road, sampleHeight: surface });
    expect(offSurface(draped.roads, 1.4)).toBeGreaterThan(5);
  });

  it('far road lines lie on the terrain and follow the whole road', () => {
    const cut = buildOsmMesh({ tile: TILE, detail: 'full', data: road, sampleHeight: surface, tin });
    const l = cut.roadLines;
    expect(l.length % 8).toBe(0);
    expect(l.length / 8).toBeGreaterThan(10); // split at every face edge it crosses
    let worst = 0, length = 0;
    for (let k = 0; k < l.length; k += 8) {
      length += Math.hypot(l[k + 4] - l[k], l[k + 6] - l[k + 2]);
      for (const o of [0, 4]) {
        const p = [l[k + o], l[k + o + 1], l[k + o + 2]];
        const mid = [0, 1, 2].map((c) => (l[k + c] + l[k + 4 + c]) / 2);
        for (const [x, y, z] of [p, mid]) {
          const ll = enuToLatLon(center, x, -z, 0);
          worst = Math.max(worst, Math.abs(y - 1.4 - surface(ll.lon, ll.lat)));
        }
      }
    }
    expect(worst).toBeLessThan(0.5);
    const flatLines = buildOsmMesh({ tile: TILE, detail: 'full', data: road, sampleHeight: flat }).roadLines;
    let want = 0;
    for (let k = 0; k < flatLines.length; k += 8) want += Math.hypot(flatLines[k + 4] - flatLines[k], flatLines[k + 6] - flatLines[k + 2]);
    expect(length / want).toBeGreaterThan(0.999);
    expect(length / want).toBeLessThan(1.001);
  });
});

describe('road ribbons where ways meet and across tile borders', () => {
  const GRID = 16;
  const flatLattice = new Float32Array((GRID + 1) * (GRID + 1)).fill(100);
  const EAST: Tile = { z: TILE.z, x: TILE.x + 1, y: TILE.y };
  const tiles = [TILE, EAST].map((t) => {
    const tin = buildTerrainTin(t, GRID, flatLattice);
    return { tile: t, tin, surface: tinSampler(tin, t), center: tileCenter(t) };
  });
  /** the road meshes' triangles in lon/lat (both tiles), for point-in-triangle probes */
  const coverage = (data: OsmTileData, which = tiles) => {
    const tris: Array<[number, number][]> = [];
    for (const t of which) {
      const m = buildOsmMesh({ tile: t.tile, detail: 'full', data, sampleHeight: t.surface, tin: t.tin }).roads;
      for (let v = 0; v + 2 < m.vertexCount; v += 3) {
        tris.push([0, 1, 2].map((k) => {
          const ll = enuToLatLon(t.center, m.vertices[(v + k) * 6], -m.vertices[(v + k) * 6 + 2], 0);
          return [ll.lon, ll.lat] as [number, number];
        }));
      }
    }
    return (lon: number, lat: number) => tris.some(([a, b, c]) => {
      const s = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (lat - p[1]) - (q[1] - p[1]) * (lon - p[0]);
      const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    });
  };
  const b = tileBounds(TILE);
  const lonPerM = (b.east - b.west) / tileSizeMeters(TILE);
  const latPerM = lonPerM * Math.cos((tileCenter(TILE).lat * Math.PI) / 180);
  const HALF = 4.5; // tertiary: 9 m wide

  it('a road across a tile border is covered right up to the border from both sides', () => {
    // slanting across the east border, so square ends cut at the border would leave notches
    const mid = tileCenter(TILE).lat;
    const a: [number, number] = [b.east - 300 * lonPerM, mid - 150 * latPerM];
    const z: [number, number] = [b.east + 300 * lonPerM, mid + 150 * latPerM];
    const data: OsmTileData = { areas: [], lines: [{ points: [a, z], tags: { highway: 'tertiary' } }], points: [], buildings: [] };
    const covered = coverage(data);
    const len = Math.hypot(600, 300);
    const ux = 600 / len, uy = 300 / len;
    let missed = 0, n = 0;
    for (let along = -20; along <= 20; along += 1) {
      for (let across = -0.9 * HALF; across <= 0.9 * HALF; across += 0.9) {
        // metres from where the road crosses the border
        const x = ux * along - uy * across, y = uy * along + ux * across;
        n++;
        if (!covered(b.east + x * lonPerM, mid + y * latPerM)) missed++;
      }
    }
    expect(missed).toBe(0);
    expect(n).toBeGreaterThan(300);
  });

  it('two ways meeting at a right angle leave no wedge open outside the bend', () => {
    const c = tileCenter(TILE);
    const node: [number, number] = [c.lon, c.lat];
    const data: OsmTileData = {
      areas: [],
      lines: [
        { points: [[c.lon - 200 * lonPerM, c.lat], node], tags: { highway: 'tertiary' } },
        { points: [node, [c.lon, c.lat + 200 * latPerM]], tags: { highway: 'tertiary' } },
      ],
      points: [], buildings: [],
    };
    const covered = coverage(data, [tiles[0]]);
    // the outer corner of the bend is south-east of the node
    for (let deg = -90; deg <= 0; deg += 5) {
      const r = 0.9 * HALF;
      const x = Math.cos((deg * Math.PI) / 180) * r, y = Math.sin((deg * Math.PI) / 180) * r;
      expect(covered(c.lon + x * lonPerM, c.lat + y * latPerM)).toBe(true);
    }
  });
});

describe('line widths from OSM', () => {
  it('reads width in metres, feet and with units; ignores junk', () => {
    expect(osmWidthM('5')).toBe(5);
    expect(osmWidthM('5.5 m')).toBe(5.5);
    expect(osmWidthM('3,5')).toBe(3.5);
    expect(osmWidthM("12'")).toBeCloseTo(3.658, 3);
    expect(osmWidthM('12 ft')).toBeCloseTo(3.658, 3);
    expect(osmWidthM('4\'6"')).toBeCloseTo(1.372, 3);
    for (const junk of [undefined, '', 'wide', '0', '1000', '-3']) expect(osmWidthM(junk)).toBeUndefined();
  });

  /** ribbon width of a single west→east line on flat ground: the spread of its vertices north–south */
  const ribbonWidth = (tags: Record<string, string>) => {
    const c = tileCenter(TILE);
    const b = tileBounds(TILE);
    const data: OsmTileData = {
      areas: [], points: [], buildings: [],
      lines: [{ points: [[b.west + (b.east - b.west) * 0.2, c.lat], [b.west + (b.east - b.west) * 0.8, c.lat]], tags }],
    };
    const m = mesh(data, flat, 40);
    const out = tags.highway ? m.roads : m.water;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < out.vertexCount; i++) {
      lo = Math.min(lo, out.vertices[i * 6 + 2]);
      hi = Math.max(hi, out.vertices[i * 6 + 2]);
    }
    return out.vertexCount ? hi - lo : 0;
  };

  it('streams, brooks, ditches and drains are drawn as water, narrower than rivers', () => {
    const river = ribbonWidth({ waterway: 'river' });
    for (const ww of ['stream', 'brook', 'ditch', 'drain']) {
      const w = ribbonWidth({ waterway: ww });
      expect(w).toBeGreaterThan(1);
      expect(w).toBeLessThan(river / 4);
    }
    expect(ribbonWidth({ waterway: 'stream', tunnel: 'culvert' })).toBe(0);
  });

  it('a width tag sets the ribbon width of waterways and roads; lanes when a road has none', () => {
    expect(ribbonWidth({ waterway: 'stream', width: '6' })).toBeCloseTo(6, 1);
    expect(ribbonWidth({ waterway: 'river', width: '40 m' })).toBeCloseTo(40, 1);
    // unlit classes: a lit road's lamp poles stand beyond its edges in the same mesh
    expect(ribbonWidth({ highway: 'tertiary', width: '4' })).toBeCloseTo(4, 1);
    expect(ribbonWidth({ highway: 'tertiary', lanes: '4' })).toBeCloseTo(14, 1);
    expect(ribbonWidth({ highway: 'tertiary' })).toBeCloseTo(9, 1);
    expect(ribbonWidth({ highway: 'unclassified' })).toBeCloseTo(7, 1);
  });

  it('the full-detail query fetches the small waterways', () => {
    const sel = parseFilter(osmFilter('full'));
    const fetched = (v: string) => sel.some((s) => s.type === 'way' && s.clauses.some((c) => c.key === 'waterway' && c.re?.test(v)));
    for (const ww of ['river', 'riverbank', 'canal', 'stream', 'brook', 'ditch', 'drain']) expect(fetched(ww)).toBe(true);
    expect(fetched('dam')).toBe(false);
  });
});
