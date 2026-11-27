import { describe, expect, it } from 'vitest';
import { colourOf } from '../src/engine/palette';
import { tileCenter, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh, buildingTags, computeHeights, styleSeed, wallRamp } from '../src/world/building-mesher';
import { ARCH_INFERRED_TAG } from '../src/world/arch-styles';
import { minaretSites } from '../src/world/minaret-mesher';
import { parseOverpass, type OverpassJson } from '../src/world/overpass';
import { FINIAL, FINIAL_TAG, faithOf, finialTris, FOOTING_TAG, orthodoxLand, qiblaAxis, TEMPLE } from '../src/world/temples';
import type { OsmBuilding } from '../src/world/osm-types';

const MOSCOW: [number, number] = [37.62, 55.75];
const PARIS: [number, number] = [2.35, 48.85];
const FETHIYE: [number, number] = [29.12, 36.62];

type Tags = Record<string, string>;
let nextId = 1;
/** a rectangle `w` × `h` metres about [lon, lat], its long side east–west */
function rectNodes(at: [number, number], w: number, h: number, du = 0, dv = 0): { lon: number; lat: number }[] {
  const k = 111320, c = Math.cos((at[1] * Math.PI) / 180);
  const p = (x: number, y: number) => ({ lon: at[0] + (x + du) / (k * c), lat: at[1] + (y + dv) / k });
  return [p(-w / 2, -h / 2), p(w / 2, -h / 2), p(w / 2, h / 2), p(-w / 2, h / 2)];
}
/** the Overpass elements of closed ways */
function osm(...ways: { nodes: { lon: number; lat: number }[]; tags: Tags }[]): OverpassJson {
  const elements: OverpassJson['elements'] = [];
  for (const w of ways) {
    const ids = w.nodes.map((n) => { const id = nextId++; elements.push({ type: 'node', id, lat: n.lat, lon: n.lon }); return id; });
    elements.push({ type: 'way', id: nextId++, nodes: [...ids, ids[0]], tags: w.tags });
  }
  return { elements };
}
const parse = (...ways: { nodes: { lon: number; lat: number }[]; tags: Tags }[]) => parseOverpass(osm(...ways)).buildings;
const partsOf = (bs: OsmBuilding[]) => bs.filter((b) => b.tags['building:part'] !== undefined);
const topOf = (b: OsmBuilding) => { const h = computeHeights(buildingTags(b)); return h.min + h.wall + h.roof; };

describe('the faith a place of worship is built in', () => {
  it('a church by its denomination, else by where it stands; a mosque, a synagogue by their type', () => {
    expect(faithOf({ building: 'church' }, ...MOSCOW)).toBe('orthodox');
    expect(faithOf({ building: 'church' }, ...PARIS)).toBe('western');
    expect(faithOf({ building: 'church', denomination: 'catholic' }, ...MOSCOW)).toBe('western');
    expect(faithOf({ building: 'yes', amenity: 'place_of_worship', religion: 'christian', denomination: 'russian_orthodox' }, ...PARIS)).toBe('orthodox');
    // no denomination (our tiles keep none): the name, the style
    expect(faithOf({ building: 'cathedral', 'name:en': 'Catholic Cathedral of the Immaculate Conception' }, ...MOSCOW)).toBe('western');
    expect(faithOf({ building: 'church', name: 'Евангелическо-лютеранская церковь' }, ...MOSCOW)).toBe('western');
    expect(faithOf({ building: 'church', 'building:architecture': 'neo-gothic' }, ...MOSCOW)).toBe('western');
    expect(faithOf({ building: 'church', name: 'Православный храм' }, ...PARIS)).toBe('orthodox');
    expect(faithOf({ building: 'mosque' }, ...FETHIYE)).toBe('muslim');
    expect(faithOf({ building: 'synagogue' }, ...PARIS)).toBe('jewish');
    expect(faithOf({ building: 'temple', religion: 'buddhist' }, ...PARIS)).toBe('buddhist');
    // a temple of no told religion: no tradition to build in
    expect(faithOf({ building: 'temple' }, ...MOSCOW)).toBeUndefined();
  });
  it('Orthodox lands: Russia, Greece, Georgia; not the Baltic states, not Italy', () => {
    expect(orthodoxLand(30.3, 59.9)).toBe(true);
    expect(orthodoxLand(23.7, 37.98)).toBe(true);
    expect(orthodoxLand(44.8, 41.7)).toBe(true);
    expect(orthodoxLand(24.1, 56.95)).toBe(false);
    expect(orthodoxLand(25.3, 54.7)).toBe(false);
    expect(orthodoxLand(12.5, 41.9)).toBe(false);
  });
});

describe('a place of worship mapped as a bare outline is built in its tradition', () => {
  it('an Orthodox church: the outline under a gable, an onion dome on a drum over the nave, a bell tower under a tent at the west end, crosses on both', () => {
    const bs = parse({ nodes: rectNodes(MOSCOW, 30, 14), tags: { building: 'church' } });
    const body = bs.find((b) => b.tags.building === 'church')!;
    expect(body.tags['roof:shape']).toBe('gabled');
    const parts = partsOf(bs);
    const dome = parts.find((p) => p.tags['roof:shape'] === 'onion')!;
    const tower = parts.find((p) => p.tags['building:part'] === 'bell_tower')!;
    expect(dome.tags[FINIAL_TAG]).toBe('orthodox');
    expect(tower.tags['roof:shape']).toBe('pyramidal');
    expect(tower.tags[FINIAL_TAG]).toBe('orthodox');
    // the tower at the west end, the dome east of it, both over the body's ridge
    const west = (b: OsmBuilding) => Math.min(...b.rings[0].map(([lon]) => lon));
    expect(west(tower)).toBeCloseTo(west(body), 6);
    expect(west(dome)).toBeGreaterThan(west(tower));
    expect(topOf(dome)).toBeGreaterThan(topOf(body) + 3);
    expect(topOf(tower)).toBeGreaterThan(topOf(body) + 5);
    // they stand on the whole temple's ground and share its colours
    expect(dome.tags[FOOTING_TAG].split(' ')).toHaveLength(5);
    expect(dome.tags['sim:style_at']).toBe(body.tags['sim:style_at']);
    // the body is still drawn: its parts are generated, not mapped
    expect(bs).toContain(body);
  });
  it('its parts are walled as the body: the style its start_date suggests is the whole temple’s', () => {
    for (const start_date of ['1890', '1785', '2005']) {
      const bs = parse({ nodes: rectNodes(MOSCOW, 30, 14), tags: { building: 'church', start_date } });
      const body = bs.find((b) => b.tags.building === 'church')!;
      expect(partsOf(bs).length).toBeGreaterThan(1);
      for (const p of partsOf(bs)) {
        expect(buildingTags(p)[ARCH_INFERRED_TAG], start_date).toBe(buildingTags(body)[ARCH_INFERRED_TAG]);
        expect(wallRamp(buildingTags(p), styleSeed(p)), start_date).toBe(wallRamp(buildingTags(body), styleSeed(body)));
      }
    }
  });
  it('a large one gets five domes; a chapel one small dome and no tower', () => {
    const large = partsOf(parse({ nodes: rectNodes(MOSCOW, 40, 24), tags: { building: 'cathedral' } }));
    expect(large.filter((p) => p.tags['roof:shape'] === 'onion')).toHaveLength(5);
    const chapel = partsOf(parse({ nodes: rectNodes(MOSCOW, 6, 5), tags: { building: 'chapel' } }));
    expect(chapel.map((p) => p.tags['roof:shape'])).toEqual(['onion']);
  });
  it('a Western church: a steep gable and a west tower with a spire and a cross; a chapel only a cross on its west gable', () => {
    const bs = parse({ nodes: rectNodes(PARIS, 32, 14), tags: { building: 'church' } });
    const body = bs.find((b) => b.tags.building === 'church')!;
    const h = computeHeights(buildingTags(body));
    expect(h.roof).toBeCloseTo(7, 1);
    const [tower] = partsOf(bs);
    expect(tower.tags['roof:shape']).toBe('pyramidal');
    expect(tower.tags[FINIAL_TAG]).toBe('cross');
    expect(topOf(tower)).toBeGreaterThan(topOf(body) * 2);
    const chapel = parse({ nodes: rectNodes(PARIS, 8, 6), tags: { building: 'chapel' } });
    expect(chapel).toHaveLength(1);
    expect(chapel[0].tags[FINIAL_TAG]).toBe('cross');
  });
  it('a cross-shaped one: its tower fits the narrow west front, not the transept’s width', () => {
    const k = 111320, c = Math.cos((PARIS[1] * Math.PI) / 180);
    const p = (x: number, y: number) => ({ lon: PARIS[0] + x / (k * c), lat: PARIS[1] + y / k });
    // a nave 44 m by 12 east–west, a transept 12 m by 28 near its east end
    const nodes = [p(-22, -6), p(8, -6), p(8, -14), p(20, -14), p(20, -6), p(22, -6), p(22, 6), p(20, 6), p(20, 14), p(8, 14), p(8, 6), p(-22, 6)];
    const bs = parse({ nodes, tags: { building: 'church' } });
    const towers = partsOf(bs).filter((b) => b.tags['building:part'] === 'bell_tower');
    expect(towers).toHaveLength(1);
    const lats = towers[0].rings[0].map(([, lat]) => (lat - PARIS[1]) * k);
    expect(Math.max(...lats)).toBeLessThanOrEqual(6.01);
    expect(Math.min(...lats)).toBeGreaterThanOrEqual(-6.01);
  });
  it('a mosque: a flat body and a dome with a crescent; it is still the mosque its minaret is guessed by', () => {
    const bs = parse({ nodes: rectNodes(FETHIYE, 20, 16), tags: { building: 'mosque' } });
    const body = bs.find((b) => b.tags.building === 'mosque')!;
    expect(body.tags['roof:shape']).toBe('flat');
    const [dome] = partsOf(bs);
    expect(dome.tags['roof:shape']).toBe('dome');
    expect(dome.tags[FINIAL_TAG]).toBe('crescent');
    expect(minaretSites([], bs)).toHaveLength(1);
  });
  it('a told height is the body’s top', () => {
    const body = parse({ nodes: rectNodes(PARIS, 32, 14), tags: { building: 'church', height: '20' } }).find((b) => b.tags.building === 'church')!;
    expect(topOf(body)).toBeCloseTo(20, 1);
  });
  it('one with fewer than TEMPLE.DETAILED_PARTS parts and no roof shape is built anew, its parts left out', () => {
    const bs = parse(
      { nodes: rectNodes(MOSCOW, 30, 14), tags: { building: 'church' } },
      { nodes: rectNodes(MOSCOW, 4, 4, -12), tags: { 'building:part': 'yes', height: '25' } },
    );
    expect(TEMPLE.DETAILED_PARTS).toBe(3);
    expect(bs.some((b) => b.tags.height === '25')).toBe(false);
    expect(partsOf(bs).some((p) => p.tags['roof:shape'] === 'onion')).toBe(true);
  });
});

describe('a place of worship mapped in detail is drawn as mapped, its symbols added', () => {
  it('its parts are walled alike unless OSM colours one: a plain building tagged a place of worship too', () => {
    const bs = parse(
      { nodes: rectNodes(MOSCOW, 30, 14), tags: { building: 'yes', amenity: 'place_of_worship', religion: 'christian', start_date: '1890' } },
      { nodes: rectNodes(MOSCOW, 20, 12, 4), tags: { 'building:part': 'yes', height: '10' } },
      { nodes: rectNodes(MOSCOW, 6, 6, -11), tags: { 'building:part': 'tower', height: '30' } },
      { nodes: rectNodes(MOSCOW, 5, 5, 4), tags: { 'building:part': 'dome', min_height: '10', height: '16' } },
      { nodes: rectNodes(MOSCOW, 3, 3, 12), tags: { 'building:part': 'apse', height: '8', 'building:colour': 'white' } },
    );
    const parts = partsOf(bs);
    expect(parts).toHaveLength(4);
    const walls = parts.map((p) => wallRamp(buildingTags(p), styleSeed(p)));
    expect(buildingTags(parts[0])[ARCH_INFERRED_TAG]).toMatch(/^(pseudo-russian|neo-byzantine)$/);
    const coloured = parts.findIndex((p) => p.tags['building:colour'] === 'white');
    expect(new Set(walls.filter((_, i) => i !== coloured)).size).toBe(1);
    expect(walls[coloured]).not.toBe(walls[(coloured + 1) % 4]);
  });
  it('three parts or more: the parts as they are, a cross on the domes and the spire, none on the rest', () => {
    const bs = parse(
      { nodes: rectNodes(MOSCOW, 30, 14), tags: { building: 'church' } },
      { nodes: rectNodes(MOSCOW, 20, 14, 5), tags: { 'building:part': 'yes', height: '10' } },
      { nodes: rectNodes(MOSCOW, 6, 6, 5), tags: { 'building:part': 'yes', min_height: '10', height: '18', 'roof:shape': 'onion' } },
      { nodes: rectNodes(MOSCOW, 6, 6, -12), tags: { 'building:part': 'yes', height: '30', 'roof:shape': 'pyramidal' } },
    );
    expect(bs).toHaveLength(3);
    expect(bs.every((b) => b.tags[FINIAL_TAG] === 'orthodox')).toBe(true);
    expect(bs.some((b) => b.tags.building === 'church')).toBe(false);
  });
  it('a roof:shape on the outline: as mapped, with its finial', () => {
    const [b] = parse({ nodes: rectNodes(PARIS, 20, 10), tags: { building: 'church', 'roof:shape': 'gabled', height: '12' } });
    expect(b.tags.height).toBe('12');
    expect(b.tags[FINIAL_TAG]).toBe('cross');
  });
  it('other buildings are left alone', () => {
    const [b] = parse({ nodes: rectNodes(PARIS, 20, 10), tags: { building: 'house' } });
    expect(b.tags[FINIAL_TAG]).toBeUndefined();
  });
});

describe('finials', () => {
  it('a cross stands `size` over its apex, in its plane; an Orthodox one has its foot bar; a crescent rises on its stem', () => {
    const top = (tris: ReturnType<typeof finialTris>) => Math.max(...tris.flatMap((t) => [t[0][1], t[1][1], t[2][1]]));
    const cross = finialTris('cross', [10, 100, 20], 2, [1, 0]);
    expect(top(cross)).toBeCloseTo(102, 5);
    // in the x-y plane, `size` × 0.1 thick across it
    const zs = cross.flatMap((t) => [t[0][2], t[1][2], t[2][2]]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.2, 5);
    expect(finialTris('orthodox', [0, 0, 0], 2, [1, 0]).length).toBeGreaterThan(cross.length);
    const crescent = finialTris('crescent', [0, 0, 0], 2, [0, 1]);
    expect(top(crescent)).toBeGreaterThan(1);
    expect(top(crescent)).toBeLessThan(2);
    // the normals are unit length
    for (const t of [...cross, ...crescent]) expect(Math.hypot(...t[3])).toBeCloseTo(1, 5);
  });
  it('the crescent faces Mecca: its plane square to the qibla', () => {
    // from Fethiye Mecca lies south-east: the plane runs south-west to north-east
    const [x, z] = qiblaAxis(...FETHIYE);
    expect(Math.hypot(x, z)).toBeCloseTo(1, 6);
    expect(x * z).toBeLessThan(0);
  });
  it('the mesh: a gilded cross over the onion dome of a generated church', () => {
    const tile: Tile = { z: 14, x: 9903, y: 5121 };
    const c = tileCenter(tile);
    const bs = parse({ nodes: rectNodes([c.lon, c.lat], 30, 14), tags: { building: 'church' } });
    const m = buildBuildingMesh({ tile, buildings: bs, sampleHeight: () => 100 });
    const gold = colourOf(FINIAL.RGB);
    let goldTop = -Infinity, goldCount = 0, otherTop = -Infinity;
    for (let i = 0; i < m.vertexCount; i++) {
      const y = m.vertices[i * 6 + 1];
      if ((m.ramps[i] & 0xffffff) === (gold & 0xffffff)) { goldCount++; goldTop = Math.max(goldTop, y); } else otherTop = Math.max(otherTop, y);
    }
    expect(goldCount).toBeGreaterThan(0);
    expect(goldTop).toBeGreaterThan(otherTop + FINIAL.MIN_M - 0.01);
  });
});
