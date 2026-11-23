import { describe, expect, it } from 'vitest';
import { colour, rampGlowLevel, RAMP, snowy, withGlow } from '../src/engine/palette';
import { enuToLatLon, gridLatLon, latLonToEnu, tileBounds, tileCenter, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildOsmMesh, classifyLine, isTunnel, osmWidthM, RAIL_ZONE_RAMP, SHOULDER_RAMP } from '../src/world/osm-mesher';
import { parseFilter } from '../src/world/osm-api';
import { osmFilter } from '../src/world/overpass';
import type { OsmTileData } from '../src/world/osm-types';
import { buildTerrainTin, tinLocator, tinSampler } from '../src/world/terrain-tin';
import { buildGroundCover, coverRamp, type GroundCover } from '../src/world/ground-cover';
import { buildSurfaceTin, type SurfaceTin } from '../src/world/surface-tin';
import { tinToWorld } from '../src/world/terrain-mesher';
import { DEFAULT_AREA_STYLES } from '../src/world/area-styles';
import { WINDOW_ATTR_FLOATS } from '../src/world/building-mesher';
import { LIT_ROAD_GLOW, UNLIT_ROAD_GLOW } from '../src/world/way-styles';
import {
  areaOf, bordersOf, fnv, GRID as COVER_GRID, lattice, osmMeshOf, polygon, road as coverRoad, TILE as COVER_TILE, townFixture, vertexOfFace,
} from './roads-helpers';

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
    // the outer corner of the bend is south-east of the node (probes off the mitre's seam at -45°,
    // which lies on the edge shared by the two ways' triangles)
    for (let deg = -87.5; deg <= -2.5; deg += 5) {
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

describe('tunnels', () => {
  const b = tileBounds(TILE);
  const center = tileCenter(TILE);
  const lat = (b.north + b.south) / 2;
  const lonA = b.west + (b.east - b.west) * 0.3, lonB = b.west + (b.east - b.west) * 0.7;
  const tags = { highway: 'trunk', tunnel: 'yes', layer: '-1', lit: 'yes', lanes: '2' };
  /** a ridge between the portals: 100 m outside, up to 400 m over the middle */
  const ridge = (lon: number) => 100 + (lon > lonA && lon < lonB ? 300 * Math.sin((Math.PI * (lon - lonA)) / (lonB - lonA)) : 0);
  const DARK = colour(16, 16, 18);
  const data = (lines: OsmTileData['lines']): OsmTileData => ({ areas: [], lines, points: [], buildings: [] });
  const xOf = (lon: number) => {
    const ll = enuToLatLon(center, 0, 0, 0);
    return ((lon - ll.lon) / (b.east - b.west)) * tileSizeMeters(TILE);
  };

  it('tunnel=yes is a tunnel; building_passage and tunnel=no are not', () => {
    expect(isTunnel({ highway: 'primary', tunnel: 'yes' })).toBe(true);
    expect(isTunnel({ railway: 'rail', tunnel: 'yes' })).toBe(true);
    expect(isTunnel({ highway: 'service', tunnel: 'building_passage' })).toBe(false);
    expect(isTunnel({ highway: 'primary', tunnel: 'no' })).toBe(false);
    expect(isTunnel({ waterway: 'stream', tunnel: 'culvert' })).toBe(false);
  });

  it('no ribbon, line or lamps over the hill: only a portal at each end, buried before the crest', () => {
    const m = mesh(data([{ points: [[lonA, lat], [lonB, lat]], tags }]), (lon) => ridge(lon));
    expect(m.roadLines.length).toBe(0);
    expect(m.lamps.length).toBe(0);
    expect(m.roads.vertexCount).toBeGreaterThan(0);
    const xa = xOf(lonA), xb = xOf(lonB);
    let dark = 0;
    for (let i = 0; i < m.roads.vertexCount; i++) {
      const x = m.roads.vertices[i * 6], y = m.roads.vertices[i * 6 + 1];
      // within a short tube of one of the mouths, never up on the ridge
      expect(Math.min(Math.abs(x - xa), Math.abs(x - xb))).toBeLessThan(60);
      expect(y).toBeLessThan(120);
      if (m.roads.ramps[i] === DARK) dark++;
    }
    expect(dark).toBeGreaterThan(0);
  });

  it('the dark opening faces out of the tunnel, back along the road', () => {
    const m = mesh(data([{ points: [[lonA, lat], [lonB, lat]], tags }]), (lon) => ridge(lon));
    const xa = xOf(lonA);
    let facing = 0;
    for (let i = 0; i < m.roads.vertexCount; i++) {
      if (m.roads.ramps[i] !== DARK || Math.abs(m.roads.vertices[i * 6] - xa) > 60) continue;
      // the western mouth looks west (-x); its reveal walls look sideways or down
      if (Math.abs(m.roads.vertices[i * 6 + 3]) > 0.5) { expect(m.roads.vertices[i * 6 + 3]).toBeLessThan(0); facing++; }
    }
    expect(facing).toBeGreaterThan(0);
  });

  it('a tunnel split into two ways keeps two portals, none at the joint', () => {
    const mid = (lonA + lonB) / 2;
    const whole = mesh(data([{ points: [[lonA, lat], [mid, lat], [lonB, lat]], tags }]), (lon) => ridge(lon));
    const split = mesh(data([
      { points: [[lonA, lat], [mid, lat]], tags },
      { points: [[mid, lat], [lonB, lat]], tags },
    ]), (lon) => ridge(lon));
    expect(split.roads.vertexCount).toBe(whole.roads.vertexCount);
  });

  it("a portal outside the tile is the neighbour's", () => {
    const outside = b.east + (b.east - b.west) * 0.1;
    const m = mesh(data([{ points: [[lonB, lat], [outside, lat]], tags }]), () => 100);
    const xb = xOf(lonB);
    for (let i = 0; i < m.roads.vertexCount; i++) expect(Math.abs(m.roads.vertices[i * 6] - xb)).toBeLessThan(130);
  });

  it('under a road the tube stops short of it instead of rising over it', () => {
    const mid = (lonA + lonB) / 2;
    const dLat = (b.north - b.south) * 0.2;
    const short: OsmTileData['lines'] = [{ points: [[mid - 0.0002, lat], [mid + 0.0002, lat]], tags: { highway: 'tertiary', tunnel: 'yes', layer: '-1' } }];
    const road = { points: [[mid, lat - dLat], [mid, lat + dLat]] as [number, number][], tags: { highway: 'trunk', lanes: '2' } };
    const m = mesh(data([...short, road]), flat);
    // the trunk road's own ribbon (1.4 m over the ground) gives its line in the mesh's metres
    let sum = 0, n = 0;
    for (let i = 0; i < m.roads.vertexCount; i++) if (Math.abs(m.roads.vertices[i * 6 + 1] - 101.4) < 0.01 && m.roads.ramps[i] !== DARK) { sum += m.roads.vertices[i * 6]; n++; }
    const xm = sum / n;
    // its 3.5 m half plus the wall stay clear of the portals' geometry
    for (let i = 0; i < m.roads.vertexCount; i++) {
      // (its street lamps are HULL_DARK boxes beside it)
      if (m.roads.vertices[i * 6 + 1] > 101.5 && m.roads.ramps[i] !== RAMP.HULL_DARK) expect(Math.abs(m.roads.vertices[i * 6] - xm)).toBeGreaterThan(3.5 + 1.2 - 0.01);
    }
  });

  it('no portal where the road over the tunnel covers the mouth itself', () => {
    const dLon = (b.east - b.west) * 0.2;
    const tunnel = { points: [[lonA, lat - 0.0002], [lonA, lat + 0.0002]] as [number, number][], tags: { highway: 'tertiary', tunnel: 'yes' } };
    // a 20 m road 3 m off the northern mouth, crossing the tunnel
    const off = 0.0002 - 3 / 111_320;
    const road = { points: [[lonA - dLon, lat + off], [lonA + dLon, lat + off]] as [number, number][], tags: { highway: 'trunk', lit: 'no' } };
    const both = mesh(data([tunnel, road]), flat);
    const alone = mesh(data([tunnel]), flat);
    const darkOf = (m: typeof both) => Array.from(m.roads.ramps).filter((r) => r === DARK).length;
    // one mouth's worth of dark: the southern one; the northern is under the road
    expect(darkOf(alone)).toBeGreaterThan(0);
    expect(darkOf(both)).toBe(darkOf(alone) / 2);
  });

  it('a building passage is still drawn as a road', () => {
    const m = mesh(data([{ points: [[lonA, lat], [lonB, lat]], tags: { highway: 'service', tunnel: 'building_passage' } }]), flat);
    expect(m.roadLines.length).toBeGreaterThan(0);
    for (let i = 0; i < m.roads.vertexCount; i++) expect(m.roads.ramps[i]).not.toBe(DARK);
  });
});

/** a sloping, rolling relief over metres east and south of the tile's north-west corner */
const rolling = (x: number, y: number) => 200 + 30 * Math.sin(x / 60) * Math.cos(y / 80) - y / 30;

/** the town of roads-helpers with a tertiary bridged over its river and a helipad */
function bridgedTown() {
  const d = townFixture();
  d.lines.push(
    coverRoad({ highway: 'tertiary', name: 'west' }, [[4.2, 50.1], [15.9, 50.1]]),
    coverRoad({ highway: 'tertiary', bridge: 'yes', layer: '1', name: 'bridge' }, [[15.9, 50.1], [19.7, 50.1]]),
    coverRoad({ highway: 'tertiary', name: 'east' }, [[19.7, 50.1], [30.3, 50.1]]),
  );
  const ll = gridLatLon(COVER_TILE, 40.3, 9.7, COVER_GRID);
  d.points.push({ at: [ll.lon, ll.lat], tags: { aeroway: 'helipad' } });
  return d;
}

/** digests of every array of an OSM mesh */
function digest(m: ReturnType<typeof buildOsmMesh>): number[] {
  return [
    m.vertexCount, fnv(m.vertices), fnv(m.ramps), m.roads.vertexCount, fnv(m.roads.vertices), fnv(m.roads.ramps), fnv(m.roadAttrs),
    m.water.vertexCount, fnv(m.water.vertices), fnv(m.water.ramps), m.bridges.vertexCount, fnv(m.bridges.vertices), fnv(m.bridges.ramps),
    fnv(m.roadLines), fnv(m.pitchLines), fnv(m.lamps), fnv(m.lampPosts),
  ];
}

/**
 * The largest distance of a mesh's vertices from the TIN vertex each stands on (Infinity when one
 * stands on none): a vertex is the TIN's own, at its height (water and below at 0 m), lifted by nothing
 */
function maxLiftOverTin(m: { vertices: Float32Array; vertexCount: number }, tin: SurfaceTin): number {
  const c = tileCenter(COVER_TILE);
  const at = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  tin.vx.forEach((vx, k) => {
    const ll = gridLatLon(COVER_TILE, vx, tin.vy[k], tin.grid);
    const [e, n] = latLonToEnu(c, ll.lat, ll.lon, 0);
    const kk = key(e, -n);
    at.set(kk, [...(at.get(kk) ?? []), Math.max(0, tin.vh[k])]);
  });
  let worst = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const x = m.vertices[i * 6], y = m.vertices[i * 6 + 1], z = m.vertices[i * 6 + 2];
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const h of at.get(`${Math.round(x * 100) + dx},${Math.round(z * 100) + dz}`) ?? []) best = Math.min(best, Math.abs(y - h));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** the largest distance of a mesh's vertices from the ground under them (`sampleHeight`: the TIN's faces) */
function maxOffTin(m: { vertices: Float32Array; vertexCount: number }, sampleHeight: (lon: number, lat: number) => number): number {
  const c = tileCenter(COVER_TILE);
  let worst = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const ll = enuToLatLon(c, m.vertices[i * 6], -m.vertices[i * 6 + 2], 0);
    worst = Math.max(worst, Math.abs(m.vertices[i * 6 + 1] - sampleHeight(ll.lon, ll.lat)));
  }
  return worst;
}

/** the area of a mesh's triangles in plan, m² */
function planArea(m: { vertices: Float32Array; vertexCount: number }): number {
  let sum = 0;
  for (let i = 0; i + 2 < m.vertexCount; i += 3) {
    const [ax, az, bx, bz, cx, cz] = [m.vertices[i * 6], m.vertices[i * 6 + 2], m.vertices[i * 6 + 6], m.vertices[i * 6 + 8], m.vertices[i * 6 + 12], m.vertices[i * 6 + 14]];
    sum += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return sum;
}

/** a mesh's vertices of one face colour (`but`: of every other) */
function onlyRamp(m: { vertices: Float32Array; ramps: Uint32Array }, ramp: number, but = false): { vertices: Float32Array; vertexCount: number } {
  const vertices: number[] = [];
  m.ramps.forEach((r, i) => { if ((r === ramp) !== but) vertices.push(...m.vertices.subarray(i * 6, i * 6 + 6)); });
  return { vertices: Float32Array.from(vertices), vertexCount: vertices.length / 6 };
}

/** a street with its shoulders, a footway across it and a railway across both, and a park */
function looseTown() {
  return {
    lines: [
      coverRoad({ highway: 'residential', name: 'street' }, [[4.3, 20.2], [60.1, 22.7]]),
      coverRoad({ highway: 'footway', name: 'footway' }, [[30.2, 12.1], [31.4, 30.3]]),
      coverRoad({ railway: 'rail', name: 'railway' }, [[45.3, 10.2], [46.1, 33.8]]),
    ],
    areas: [areaOf({ leisure: 'park' }, polygon(30.2, 21.4, 8.1, 9, 0.2))],
    points: [],
  };
}

/** how many TIN faces have a cover of one of `kinds` */
const facesOf = (tin: SurfaceTin, cover: GroundCover, kinds: string[]) =>
  Array.from(tin.cover!).filter((s) => s >= 0 && kinds.includes(cover.shapes[s].kind)).length;

describe('roads and water as the terrain’s own faces', () => {
  it('draws the road faces on the terrain’s own vertices, lifted by nothing', () => {
    const { opts, tin, cover } = osmMeshOf(townFixture(), rolling);
    expect(tin.loose).toBeUndefined();
    const m = buildOsmMesh({ ...opts, cover });
    // every carriageway, ballast and runway face, nothing else (no bridge here: no lifted stretch)
    expect(m.roads.vertexCount).toBe(3 * facesOf(tin, cover, ['carriageway', 'ballast', 'runway']));
    expect(m.roads.vertexCount).toBeGreaterThan(0);
    expect(maxLiftOverTin(m.roads, tin)).toBeLessThan(1e-4);
    expect(m.roadAttrs.length).toBe(m.roads.vertexCount * WINDOW_ATTR_FLOATS);
  });

  it('colours a road face as coverRamp does: the street-lit glow and the unlit one', () => {
    const { opts, tin, cover } = osmMeshOf(townFixture(), rolling);
    const m = buildOsmMesh({ ...opts, cover });
    const glows = new Set<number>();
    tin.tris.forEach((_, f) => {
      const s = tin.cover![f];
      if (s < 0 || cover.shapes[s].kind !== 'carriageway') return;
      const v = vertexOfFace(m.roads, tin, f);
      expect(v).toBeGreaterThanOrEqual(0);
      for (let k = 0; k < 3; k++) expect(m.roads.ramps[v + k]).toBe(coverRamp(cover.shapes[s], DEFAULT_AREA_STYLES, undefined));
      glows.add(rampGlowLevel(m.roads.ramps[v]));
    });
    expect([...glows].sort()).toEqual([LIT_ROAD_GLOW, UNLIT_ROAD_GLOW].sort());
  });

  it('draws a bridge the levels leave on the ground as faces, no ribbon over them', () => {
    // a taxiway bridge and an aqueduct: road-levels lifts neither (a road bridge it always does)
    const d = { lines: [coverRoad({ aeroway: 'taxiway', bridge: 'yes' }, [[10.3, 20.2], [54.1, 21.7]]), coverRoad({ waterway: 'canal', bridge: 'aqueduct' }, [[10.2, 44.3], [54.4, 43.1]])], areas: [], points: [] };
    const withRoads = osmMeshOf(d, rolling);
    const plainCover = buildGroundCover(COVER_TILE, COVER_GRID, d);
    const plainTin = buildSurfaceTin(COVER_TILE, COVER_GRID, lattice(rolling), { borders: bordersOf(rolling), cover: plainCover });
    const plain = { opts: { ...withRoads.opts, roads: undefined, tin: plainTin, sampleHeight: tinSampler(plainTin, COVER_TILE) }, tin: plainTin, cover: plainCover };
    for (const { opts, tin, cover } of [withRoads, plain]) {
      const m = buildOsmMesh({ ...opts, cover });
      expect(m.vertexCount).toBe(0);
      expect(m.roads.vertexCount).toBe(3 * facesOf(tin, cover, ['runway']));
      expect(m.water.vertexCount).toBe(3 * facesOf(tin, cover, ['water']));
      expect(m.roads.vertexCount).toBeGreaterThan(0);
      expect(m.water.vertexCount).toBeGreaterThan(0);
      expect(maxLiftOverTin(m.roads, tin)).toBeLessThan(1e-4);
      expect(maxLiftOverTin(m.water, tin)).toBeLessThan(1e-4);
      expect(m.bridges.vertexCount).toBe(0);
    }
  });

  it('far (detail large) the cover is not used: the mesh of today', () => {
    const { opts, cover } = osmMeshOf(bridgedTown(), rolling);
    const far = { ...opts, detail: 'large' as const };
    expect(digest(buildOsmMesh({ ...far, cover }))).toEqual(digest(buildOsmMesh(far)));
  });

  it('draws the water faces on the terrain’s own vertices into the water mesh', () => {
    const { opts, tin, cover } = osmMeshOf(townFixture(), rolling);
    const m = buildOsmMesh({ ...opts, cover });
    expect(m.water.vertexCount).toBe(3 * facesOf(tin, cover, ['water']));
    expect(m.water.vertexCount).toBeGreaterThan(0);
    expect(maxLiftOverTin(m.water, tin)).toBeLessThan(1e-4);
    for (let i = 0; i < m.water.vertexCount; i++) expect(m.water.ramps[i]).toBe(RAMP.WATER);
  });

  it('draws no area, helipad or pitch line over the cover: the terrain does', () => {
    const { opts, cover } = osmMeshOf(bridgedTown(), rolling);
    const m = buildOsmMesh({ ...opts, cover });
    expect(m.vertexCount).toBe(0);
    expect(m.pitchLines.length).toBe(0);
    // the pitch's floodlights and the street lamps still stand
    expect(m.lampPosts.length).toBe(buildOsmMesh(opts).lampPosts.length);
  });

  it('still draws a road the budget dropped as a ribbon, lying on the ground’s faces, lifted by nothing', () => {
    const { opts, tin, cover } = osmMeshOf(looseTown(), rolling, 0);
    for (const l of looseTown().lines) expect([...tin.loose!].some((d) => d.tags.name === l.tags.name)).toBe(true);
    const m = buildOsmMesh({ ...opts, cover }), ribbon = buildOsmMesh(opts);
    // the ribbons of today, piece for piece, but on the faces: not LINE_BIAS and more over them (of
    // the drape the railway's right-of-way strip)
    for (const [a, b] of [[m.roads, ribbon.roads], [onlyRamp(m, RAIL_ZONE_RAMP), onlyRamp(ribbon, RAIL_ZONE_RAMP)]] as const) {
      expect(a.vertexCount).toBeGreaterThan(0);
      expect(a.vertexCount).toBe(b.vertexCount);
      for (let i = 0; i < a.vertexCount; i++) {
        expect(a.vertices[i * 6]).toBe(b.vertices[i * 6]);
        expect(a.vertices[i * 6 + 2]).toBe(b.vertices[i * 6 + 2]);
      }
      expect(maxOffTin(b, opts.sampleHeight)).toBeGreaterThan(0.9);
      expect(maxOffTin(a, opts.sampleHeight)).toBeLessThan(1e-4);
    }
    expect(Array.from(m.roadAttrs)).toEqual(Array.from(ribbon.roadAttrs));
    // and the park the budget dropped with them: the rest of the drape, on the faces, the same area as today's
    const park = onlyRamp(m, RAIL_ZONE_RAMP, true);
    expect(maxOffTin(park, opts.sampleHeight)).toBeLessThan(1e-4);
    // what of it the faces wholly in it do not carry already (the terrain's): with them, today's area
    const { wx, wz } = tinToWorld(COVER_TILE, COVER_GRID, tin.vx, tin.vy), si = cover.shapes.findIndex((sh) => sh.kind === 'area');
    const own = tin.tris.reduce((sum, t, f) => sum + (tin.cover![f] === si ? Math.abs((wx[t.b] - wx[t.a]) * (wz[t.c] - wz[t.a]) - (wx[t.c] - wx[t.a]) * (wz[t.b] - wz[t.a])) / 2 : 0), 0);
    expect(tin.looseShapes).toEqual([si]);
    expect(own).toBeGreaterThan(10000);
    expect(planArea(park)).toBeGreaterThan(10000);
    expect(planArea(park) + own).toBeCloseTo(planArea(onlyRamp(ribbon, RAIL_ZONE_RAMP, true)), 0);
  });

  it('orders the dropped ways’ ribbons by depth levels, as their heights did: shoulder under carriageway, junior under senior', () => {
    const { opts, cover } = osmMeshOf(looseTown(), rolling, 0);
    const m = buildOsmMesh({ ...opts, cover });
    expect(m.roadDepthLevels.length).toBe(m.roads.vertexCount);
    expect(m.depthLevels.length).toBe(m.vertexCount);
    const { tin } = osmMeshOf(looseTown(), rolling, 0);
    const locate = tinLocator(tin, COVER_TILE), c = tileCenter(COVER_TILE);
    /** per TIN face, the lowest and the highest level of a mesh's triangles of one colour on it (by their centres) */
    const levelsOf = (mesh: { vertices: Float32Array; ramps: Uint32Array }, levels: Float32Array, ramp: number, but = false): Map<number, [number, number]> => {
      const found = new Map<number, [number, number]>();
      for (let i = 0; i < mesh.ramps.length; i += 3) {
        if ((mesh.ramps[i] === ramp) === but) continue;
        const at = (k: number) => (mesh.vertices[i * 6 + k] + mesh.vertices[i * 6 + 6 + k] + mesh.vertices[i * 6 + 12 + k]) / 3;
        const ll = enuToLatLon(c, at(0), -at(2), 0), f = locate(ll.lon, ll.lat)!.tri, r = found.get(f);
        found.set(f, [Math.min(r?.[0] ?? Infinity, levels[i]), Math.max(r?.[1] ?? 0, levels[i])]);
      }
      expect(found.size).toBeGreaterThan(0);
      return found;
    };
    /** on every face with both, all of `a` is under all of `b` (and some face has both) */
    const under = (a: Map<number, [number, number]>, b: Map<number, [number, number]>): void => {
      const both = [...a.keys()].filter((f) => b.has(f));
      expect(both.length).toBeGreaterThan(0);
      for (const f of both) expect(a.get(f)![1]).toBeLessThan(b.get(f)![0]);
    };
    const park = levelsOf(m, m.depthLevels, RAIL_ZONE_RAMP, true);
    const zone = levelsOf(m, m.depthLevels, RAIL_ZONE_RAMP);
    const shoulder = levelsOf(m.roads, m.roadDepthLevels, withGlow(SHOULDER_RAMP, LIT_ROAD_GLOW));
    const street = levelsOf(m.roads, m.roadDepthLevels, withGlow(classifyLine({ highway: 'residential' })!.ramp, LIT_ROAD_GLOW));
    const footway = levelsOf(m.roads, m.roadDepthLevels, withGlow(classifyLine({ highway: 'footway' })!.ramp, UNLIT_ROAD_GLOW));
    const track = levelsOf(m.roads, m.roadDepthLevels, classifyLine({ railway: 'rail' })!.ramp);
    // every piece is over the ground (level 0)
    expect(Math.min(...m.roadDepthLevels, ...m.depthLevels)).toBeGreaterThanOrEqual(1);
    // the ground's own (the dropped park, the right-of-way strip) lowest, level 1 where alone on a face
    expect([...park.values()].every(([lo, hi]) => lo === 1 && hi === 1)).toBe(true);
    expect([...zone.values()].every(([lo, hi]) => lo === 1 && hi === 1)).toBe(true);
    // the park and the right-of-way strip under the shoulder that crosses them, the shoulder under
    // its carriageway and under the footway, the footway under the street, the street under the
    // railway's track
    under(park, shoulder);
    under(zone, shoulder);
    under(shoulder, footway);
    under(footway, street);
    under(street, track);
    // off the park and the strip the ribbons' own levels: the shoulder's the first
    expect(Math.min(...[...shoulder.values()].map((r) => r[0]))).toBe(1);
    // two ways that cross only beyond the tile: their pieces here do not overlap, one level
    const beyond = osmMeshOf({
      lines: [
        coverRoad({ highway: 'footway', name: 'west' }, [[-10.2, 20.1], [20.3, 20.4]]),
        coverRoad({ highway: 'cycleway', name: 'north' }, [[-3.1, 10.2], [-3.2, 30.1], [10.3, 43.2]]),
      ],
      areas: [], points: [],
    }, rolling, 0);
    const b = buildOsmMesh({ ...beyond.opts, cover: beyond.cover });
    expect(b.roads.vertexCount).toBeGreaterThan(0);
    expect(new Set(b.roadDepthLevels)).toEqual(new Set([1]));
    // without the cover nothing has a level: the ribbons are lifted as ever
    const plain = buildOsmMesh(opts);
    expect(plain.roadDepthLevels.length + plain.depthLevels.length + plain.waterDepthLevels.length).toBe(0);
  });

  it('without the cover the mesh is what it was, byte for byte', () => {
    // the surface under the roads alone: the input owes nothing to the covers
    const { opts: withCover } = osmMeshOf(bridgedTown(), rolling);
    const tin = buildSurfaceTin(COVER_TILE, COVER_GRID, lattice(rolling), { borders: bordersOf(rolling), roads: withCover.roads });
    const opts = { ...withCover, tin, sampleHeight: tinSampler(tin, COVER_TILE) };
    // digests of the output of the code before Task 6 (0d4c7b7) on this input
    expect(digest(buildOsmMesh(opts))).toEqual(GOLDEN_OSM_NO_COVER);
  });
});

const GOLDEN_OSM_NO_COVER = [
  5472, 3144877107, 1878073586, 17646, 2702523443, 2729080567, 1796636789, 2685, 3942426410, 243433191, 546, 3310701280, 1187553749,
  1063991330, 3743679959, 1604464319, 280040517,
];
