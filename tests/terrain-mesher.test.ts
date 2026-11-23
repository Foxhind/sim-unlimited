import { describe, expect, it } from 'vitest';
import { colourOf, LUT_SIZE, RAMP, rampGlowLevel, rampIndex, snowy, withGlow } from '../src/engine/palette';
import { DEFAULT_AREA_STYLES } from '../src/world/area-styles';
import { buildGroundCover, coverRamp } from '../src/world/ground-cover';
import { buildOsmMesh, LIT_PITCH_LINE_INDEX, PITCH_LINE_INDEX } from '../src/world/osm-mesher';
import { buildTerrainTin } from '../src/world/terrain-tin';
import { PITCH_GLOW } from '../src/world/way-styles';
import { LIT_ROAD_GLOW, SHOULDER_RAMP } from '../src/world/way-styles';
import { areaOf, data as osmData, GRID as GRID_TOWN, kindsInRange, lattice, M, rail, road, TILE as TOWN_TILE, townFixture, townMesh, vertexOfFace } from './roads-helpers';
import { isSeaFace } from '../src/world/terrain-tin';
import { tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildTerrainMesh } from '../src/world/terrain-mesher';

const TILE: Tile = { z: 12, x: 2140, y: 1420 };
const GRID = 16;

function heights(fn: (i: number, j: number) => number): Float32Array {
  const side = GRID + 1;
  const h = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) h[j * side + i] = fn(i, j);
  return h;
}

function tris(m: { vertices: Float32Array; ramps: Uint32Array; vertexCount: number }) {
  const out: Array<{ pos: number[]; normal: number[]; ramp: number }> = [];
  for (let v = 0; v < m.vertexCount; v += 3) {
    const pos: number[] = [];
    const normal: number[] = [];
    for (let k = 0; k < 3; k++) {
      pos.push(m.vertices[(v + k) * 6], m.vertices[(v + k) * 6 + 1], m.vertices[(v + k) * 6 + 2]);
      normal.push(m.vertices[(v + k) * 6 + 3], m.vertices[(v + k) * 6 + 4], m.vertices[(v + k) * 6 + 5]);
    }
    out.push({ pos, normal, ramp: m.ramps[v] });
  }
  return out;
}

function area(t: { pos: number[] }): number {
  const [a, b, c] = [t.pos.slice(0, 3), t.pos.slice(3, 6), t.pos.slice(6, 9)];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  return Math.hypot(...cr) / 2;
}

function planArea1(t: { pos: number[] }): number {
  const [ax, , az, bx, , bz, cx, , cz] = t.pos;
  return Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
}

/** land faces have planar footprint; skirts are vertical (zero footprint) */
function split(ts: ReturnType<typeof tris>) {
  const land = ts.filter((t) => planArea1(t) > 1e-3);
  const skirts = ts.filter((t) => planArea1(t) <= 1e-3);
  return { land, skirts };
}

describe('buildTerrainMesh (isoline belts)', () => {
  it('flat tile collapses to two land triangles plus skirts, no NaN/degenerates', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 100), skirtDepth: 50 });
    const ts = tris(m);
    expect(split(ts).land).toHaveLength(2);
    expect(split(ts).skirts).toHaveLength(4 * 2);
    for (const t of ts) {
      for (const v of [...t.pos, ...t.normal]) expect(Number.isFinite(v)).toBe(true);
      expect(area(t)).toBeGreaterThan(0);
    }
    for (const t of split(ts).land) {
      expect(t.normal[1]).toBeCloseTo(1, 5);
      expect(t.ramp).toBe(snowy(RAMP.GRASS));
    }
    const minY = Math.min(...split(ts).skirts.flatMap((t) => [t.pos[1], t.pos[4], t.pos[7]]));
    expect(minY).toBe(50);
  });

  it('covers the whole tile footprint exactly once', () => {
    const size = tileSizeMeters(TILE);
    const h = heights((i, j) => 300 + 200 * Math.sin(i / 2.5) * Math.cos(j / 3));
    const { land } = split(tris(buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, skirtDepth: 10 })));
    const total = land.reduce((s, t) => s + planArea1(t), 0);
    expect(total / (size * size)).toBeGreaterThan(0.995);
    expect(total / (size * size)).toBeLessThan(1.005);
  });

  it('is far lighter than the old dense grid on smooth terrain and honors the belt step', () => {
    const h = heights((i, j) => 500 + 12 * i + 6 * j); // gentle plane
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, step: 20 });
    expect(m.vertexCount / 3).toBeLessThan(GRID * GRID * 2);
  });

  it('is deterministic', () => {
    const h = heights((i, j) => 400 + 150 * Math.sin(i / 2) + 90 * Math.cos(j / 1.7));
    const a = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h });
    const b = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h });
    expect(Array.from(a.vertices)).toEqual(Array.from(b.vertices));
    expect(Array.from(a.ramps)).toEqual(Array.from(b.ramps));
  });

  it('floods h<=0 to a flat sea surface at 0 m (Q13), with no snow on it', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => -50) });
    const { land } = split(tris(m));
    expect(land).toHaveLength(2);
    for (const t of land) {
      expect(t.ramp).toBe(RAMP.SEA);
      for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBe(0);
    }
  });

  it('places a coastline on the sea-level isoline and keeps both classes', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => (i < GRID / 2 ? -10 : 10)) });
    const ts = split(tris(m)).land;
    const rampSet = new Set(ts.map((t) => t.ramp));
    expect(rampSet.has(RAMP.SEA)).toBe(true);
    expect(rampSet.has(snowy(RAMP.GRASS))).toBe(true);
    for (const t of ts) for (let k = 1; k < 9; k += 3) expect(t.pos[k]).toBeGreaterThanOrEqual(0);
  });

  it('colors by height and slope', () => {
    const snow = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 3000) });
    expect(split(tris(snow)).land[0].ramp).toBe(snowy(RAMP.SNOW));
    const forest = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 800) });
    expect(split(tris(forest)).land[0].ramp).toBe(snowy(RAMP.FOREST));
    const cell = tileSizeMeters(TILE) / GRID;
    const steep = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights((i) => 500 + i * cell) });
    expect(split(tris(steep)).land[0].ramp).toBe(snowy(RAMP.ROCK));
  });

  it('skirts inherit the adjacent land face ramp and normal, and hang by skirtDepth', () => {
    const h = heights((i) => 500 + i * 30);
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, skirtDepth: 50, step: 20 });
    const { land, skirts } = split(tris(m));
    expect(skirts.length).toBeGreaterThanOrEqual(8);
    for (const sk of skirts) {
      expect(sk.normal[1]).toBeGreaterThan(0);
      const match = land.some((t) => t.ramp === sk.ramp && t.normal.every((v, k) => Math.abs(v - sk.normal[k]) < 1e-9));
      expect(match).toBe(true);
    }
  });

  it('skirt triangles end on a top-edge vertex (flat shading takes fog from it)', () => {
    const h = heights((i) => 500 + i * 30);
    const { skirts } = split(tris(buildTerrainMesh({ tile: TILE, grid: GRID, heights: h, skirtDepth: 50, step: 20 })));
    for (const sk of skirts) {
      const ys = [sk.pos[1], sk.pos[4], sk.pos[7]];
      expect(ys[2] - Math.min(...ys)).toBeGreaterThan(25); // not on the bottom edge (skirtDepth 50)
    }
  });

  it('caps default skirt depth at 2000 m on coarse tiles', () => {
    const coarse: Tile = { z: 8, x: 133, y: 88 };
    const m = buildTerrainMesh({ tile: coarse, grid: GRID, heights: heights(() => 100) });
    const { skirts } = split(tris(m));
    const minY = Math.min(...skirts.flatMap((t) => [t.pos[1], t.pos[4], t.pos[7]]));
    expect(minY).toBe(-1900);
  });

  it('rejects mismatched height grids', () => {
    expect(() => buildTerrainMesh({ tile: TILE, grid: GRID, heights: new Float32Array(10) })).toThrow();
  });
});

describe('buildTerrainMesh (faces by their cover)', () => {
  const relief = () => 100;
  const town = townMesh(townFixture(), relief);
  const faceWhere = (pick: (kind: string, tags: Record<string, string>) => boolean): number =>
    town.tin.tris.findIndex((_, f) => {
      const c = town.tin.cover![f];
      return c >= 0 && pick(town.cover.shapes[c].kind, town.cover.shapes[c].source.tags);
    });

  it('colours a park face by its filter and a shoulder face by the shoulder', () => {
    const m = buildTerrainMesh({ ...town.opts, areaStyles: DEFAULT_AREA_STYLES });
    const park = faceWhere((k, t) => k === 'area' && t.leisure === 'park');
    const shoulder = faceWhere((k) => k === 'shoulder');
    expect(park).toBeGreaterThanOrEqual(0);
    expect(shoulder).toBeGreaterThanOrEqual(0);
    const parkShape = town.cover.shapes[town.tin.cover![park]];
    expect(m.ramps[vertexOfFace(m, town.tin, park)]).toBe(coverRamp(parkShape, DEFAULT_AREA_STYLES, town.imagery));
    // the primary road is street-lit: its shoulder glows as its ribbon does
    expect(m.ramps[vertexOfFace(m, town.tin, shoulder)]).toBe(withGlow(SHOULDER_RAMP, LIT_ROAD_GLOW));
  });

  it('puts the road, rail and runway faces after the ground and skirts, the water last', () => {
    const m = buildTerrainMesh({ ...town.opts });
    expect(kindsInRange(m, town.tin, town.cover, 0, m.nearCount!)).not.toContain('carriageway');
    expect(kindsInRange(m, town.tin, town.cover, m.nearCount!, m.farCount!)).toEqual(new Set(['carriageway', 'ballast']));
    expect(kindsInRange(m, town.tin, town.cover, m.farCount!, m.vertexCount)).toEqual(new Set(['water']));
  });

  it('keeps the morph rows with their vertices through the reordering', () => {
    const side = GRID_TOWN + 1;
    const coarse = { n: new Float32Array(side).fill(5), e: new Float32Array(side).fill(-3) };
    const m = buildTerrainMesh({ ...town.opts, borders: { ...town.opts.borders!, coarse } });
    expect(m.morph).toHaveLength(m.vertexCount * 2);
    // a point has one morph however many faces and skirts share it
    const seen = new Map<string, string>();
    let moving = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      if (m.vertices[v * 6 + 1] < 0) continue; // a skirt's bottom
      const key = `${m.vertices[v * 6]},${m.vertices[v * 6 + 2]}`, row = `${m.morph![v * 2]},${m.morph![v * 2 + 1]}`;
      expect(seen.get(key) ?? row).toBe(row);
      seen.set(key, row);
      if (m.morph![v * 2 + 1] !== 0) moving++;
    }
    expect(moving).toBeGreaterThan(0);
  });

  it('is drawn whole without a cover', () => {
    const m = buildTerrainMesh({ tile: TILE, grid: GRID, heights: heights(() => 100), skirtDepth: 50 });
    expect(m.nearCount).toBe(m.vertexCount);
    expect(m.farCount).toBe(m.vertexCount);
  });
});

describe('coverRamp: the colours the ribbons and areas have today', () => {
  const imagery: [number, number, number] = [90, 140, 60];
  const flat = () => 100;
  const tin = buildTerrainTin(TOWN_TILE, GRID_TOWN, lattice(flat));
  const big = (cx: number, cy: number, tags: Record<string, string>) => areaOf(tags, [[cx - 12, cy - 8], [cx + 12, cy - 8], [cx + 12, cy + 8], [cx - 12, cy + 8]]);
  // a pitch's rectangle: 105 x 68 m is lit, 20 x 12 m is not
  const pitch = (w: number, h: number, tags: Record<string, string>) => areaOf({ leisure: 'pitch', ...tags }, [[30 - w * M / 2, 30 - h * M / 2], [30 + w * M / 2, 30 - h * M / 2], [30 + w * M / 2, 30 + h * M / 2], [30 - w * M / 2, 30 + h * M / 2]]);
  const cases: Array<[string, ReturnType<typeof osmData>, string[]]> = [
    ['lit road (residential)', osmData([road({ highway: 'residential' }, [[5, 30], [60, 30]])]), ['carriageway', 'shoulder']],
    ['unlit road (service)', osmData([road({ highway: 'service' }, [[5, 30], [60, 30]])]), ['carriageway', 'shoulder']],
    ['footway', osmData([road({ highway: 'footway' }, [[5, 30], [60, 30]])]), ['path']],
    ['railway: ballast and right-of-way', osmData([rail([[5, 30], [60, 30]])]), ['ballast', 'railZone']],
    ['runway line', osmData([road({ aeroway: 'runway' }, [[5, 30], [60, 30]])]), ['runway']],
    ['river line', osmData([road({ waterway: 'river' }, [[5, 30], [60, 30]])]), ['water']],
    ['taxiway area', osmData([], [big(30, 30, { aeroway: 'taxiway' })]), ['aeroArea']],
    ['car park', osmData([], [big(30, 30, { amenity: 'parking' })]), ['carPark']],
    ['lake', osmData([], [big(30, 30, { natural: 'water' })]), ['water']],
    ['park (filter)', osmData([], [big(30, 30, { leisure: 'park' })]), ['area']],
    ['farmland (filter)', osmData([], [big(30, 30, { landuse: 'farmland' })]), ['area']],
    ['lit grass pitch (filter)', osmData([], [pitch(105, 68, { sport: 'soccer' })]), ['pitch', 'pitchPaint']],
    ['unlit grass pitch (filter)', osmData([], [pitch(20, 12, { sport: 'soccer' })]), ['pitch', 'pitchPaint']],
    ['lit tarmac pitch', osmData([], [pitch(105, 68, { sport: 'tennis', surface: 'asphalt' })]), ['pitch', 'pitchPaint']],
    ['unlit tarmac pitch', osmData([], [pitch(20, 12, { sport: 'tennis', surface: 'asphalt' })]), ['pitch', 'pitchPaint']],
  ];
  for (const [name, d, kinds] of cases) {
    it(`${name}: coverRamp is a colour the OSM mesh draws it with`, () => {
      const cover = buildGroundCover(TOWN_TILE, GRID_TOWN, d);
      expect(cover.shapes.map((s) => s.kind).sort()).toEqual([...kinds].sort());
      const m = buildOsmMesh({
        tile: TOWN_TILE, detail: 'full', data: { ...d, buildings: [] }, sampleHeight: flat, tin,
        faceColor: () => colourOf(imagery), areaStyles: DEFAULT_AREA_STYLES,
      });
      const drawn = new Set([...m.ramps.subarray(0, m.vertexCount), ...m.roads?.ramps ?? [], ...m.water.ramps.subarray(0, m.water.vertexCount)]);
      for (const shape of cover.shapes) {
        const ramp = coverRamp(shape, DEFAULT_AREA_STYLES, imagery);
        if (shape.kind === 'pitchPaint') {
          // the paint is lines in the mesh: the snow ramp's brightest entry, street-lit on a floodlit pitch
          const lit = rampGlowLevel(ramp) === PITCH_GLOW;
          expect(withGlow(ramp, 0)).toBe(RAMP.SNOW);
          expect(m.pitchLines.length).toBeGreaterThan(0);
          expect(m.pitchLines[3]).toBe(lit ? LIT_PITCH_LINE_INDEX : PITCH_LINE_INDEX);
          expect(LIT_PITCH_LINE_INDEX).toBe(PITCH_GLOW * LUT_SIZE + rampIndex(RAMP.SNOW, 10));
        } else expect(drawn, shape.kind).toContain(ramp);
      }
    });
  }

  it('a pitch is lit by the same verdict in the mesh and the cover (the whole outline)', () => {
    for (const w of [15, 17, 17.4, 17.5, 18, 20, 40]) {
      const d = osmData([], [pitch(w, 17.2, { sport: 'tennis', surface: 'asphalt' })]);
      const shape = buildGroundCover(TOWN_TILE, GRID_TOWN, d).shapes.find((s) => s.kind === 'pitch')!;
      const m = buildOsmMesh({ tile: TOWN_TILE, detail: 'full', data: { ...d, buildings: [] }, sampleHeight: flat, tin });
      const meshLit = Array.from(m.ramps.subarray(0, m.vertexCount)).some((r) => rampGlowLevel(r) === PITCH_GLOW);
      expect(rampGlowLevel(coverRamp(shape, DEFAULT_AREA_STYLES, undefined)) === PITCH_GLOW, `${w} m`).toBe(meshLit);
    }
  });
});

describe('buildTerrainMesh (sea, bare ground, skirts, no cover)', () => {
  const sea = townMesh(townFixture(), () => -10);
  const seaMesh = buildTerrainMesh({ ...sea.opts });
  const kindOf = (f: number) => (sea.tin.cover![f] < 0 ? 'ground' : sea.cover.shapes[sea.tin.cover![f]].kind);

  it('a sea face with a water cover stays the sea', () => {
    const f = sea.tin.tris.findIndex((_, i) => kindOf(i) === 'water' && isSeaFace(sea.tin, i));
    expect(f).toBeGreaterThanOrEqual(0);
    expect(seaMesh.ramps[vertexOfFace(seaMesh, sea.tin, f)]).toBe(RAMP.SEA);
  });

  it('a causeway road across the sea keeps its cover colour', () => {
    const f = sea.tin.tris.findIndex((_, i) => kindOf(i) === 'carriageway' && isSeaFace(sea.tin, i));
    expect(f).toBeGreaterThanOrEqual(0);
    const shape = sea.cover.shapes[sea.tin.cover![f]];
    expect(seaMesh.ramps[vertexOfFace(seaMesh, sea.tin, f)]).toBe(coverRamp(shape, DEFAULT_AREA_STYLES, undefined));
  });

  it('a face of no cover is the ground colour of the imagery', () => {
    const town = townMesh(townFixture(), () => 100);
    const m = buildTerrainMesh({ ...town.opts });
    const bare = Array.from(town.tin.cover!, (c, f) => (c < 0 ? f : -1)).filter((f) => f >= 0);
    expect(bare.length).toBeGreaterThan(0);
    for (const f of bare) expect(m.ramps[vertexOfFace(m, town.tin, f)]).toBe(snowy(colourOf(town.imagery)));
  });

  it('a skirt takes the ramp of the face on its edge, a road face included', () => {
    const town = townMesh(townFixture(), () => 100);
    // a road across the tile border, so a skirt hangs off a road face
    const d = osmData([road({ highway: 'residential' }, [[0, 20], [40, 20]])]);
    const edge = townMesh(d, () => 100);
    for (const t of [town, edge]) {
      const m = buildTerrainMesh({ ...t.opts });
      const at = (v: number, k: number) => [m.vertices[(v + k) * 6], m.vertices[(v + k) * 6 + 1], m.vertices[(v + k) * 6 + 2]];
      const key = (p: number[]) => `${p[0]},${p[2]}`;
      const faces: Array<{ keys: Set<string>; ramp: number }> = [];
      const skirts: number[] = [];
      for (let v = 0; v + 2 < m.vertexCount; v += 3) {
        const p = [at(v, 0), at(v, 1), at(v, 2)];
        const footprint = Math.abs((p[1][0] - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (p[1][2] - p[0][2]));
        if (footprint > 1e-3) faces.push({ keys: new Set(p.map(key)), ramp: m.ramps[v] });
        else skirts.push(v);
      }
      let checked = 0, onRoad = 0;
      for (const v of skirts) {
        const p = [at(v, 0), at(v, 1), at(v, 2)];
        const top = Math.max(...p.map((q) => q[1]));
        const tops = p.filter((q) => q[1] === top);
        if (tops.length !== 2) continue;
        const face = faces.find((f) => f.keys.has(key(tops[0])) && f.keys.has(key(tops[1])));
        expect(face).toBeDefined();
        expect(m.ramps[v]).toBe(face!.ramp);
        checked++;
        if (face!.ramp !== snowy(colourOf(t.imagery))) onRoad++;
      }
      expect(checked).toBeGreaterThan(0);
      if (t === edge) expect(onRoad).toBeGreaterThan(0);
    }
  });

  it('without a cover the mesh is what it was before covers existed, byte for byte', () => {
    const relief = (x: number, y: number) => 40 + 30 * Math.sin(x / 60) * Math.cos(y / 80) - y / 12;
    const town = townMesh(townFixture(), relief);
    const side = GRID_TOWN + 1;
    const coarse = { n: new Float32Array(side).fill(4), w: new Float32Array(side).fill(-2) };
    const m = buildTerrainMesh({ ...town.opts, cover: undefined, borders: { ...town.opts.borders!, coarse } });
    expect(m.nearCount).toBe(m.vertexCount);
    expect(m.farCount).toBe(m.vertexCount);
    const fnv = (a: ArrayBufferView) => {
      let h = 0x811c9dc5;
      for (const b of new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
      return h;
    };
    // digests of the output of the code before Task 4 on this input
    expect([m.vertexCount, fnv(m.vertices), fnv(m.ramps), fnv(m.morph!)]).toEqual(GOLDEN_NO_COVER);
  });
});

const GOLDEN_NO_COVER = [16479, 809495927, 1521313045, 3738157660];
