import { describe, expect, it } from 'vitest';
import { FACADE_PROFILE_M, rgbOf } from '../src/engine/palette';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh, buildingTags, wallRamp, WINDOW_ATTR_FLOATS } from '../src/world/building-mesher';
import { ARCH_GLSL, ARCH_INFERRED_TAG, ARCH_PROFILES, archProfile, archRegion, BELT, inferArchitecture } from '../src/world/arch-styles';
import { shareStyleInParts } from '../src/world/overpass';
import type { OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function rect(w = 0.0002, h = 0.00015): [number, number][] {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
  return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
}

const build = (tags: Record<string, string>) => buildBuildingMesh({ tile: TILE, buildings: [{ rings: [rect()], tags }], sampleHeight: () => 100 });

/** the wall heights the facade vertices carry (WINDOW_ATTR_FLOATS index 3), windowed ones only */
function wallHeights(m: ReturnType<typeof build>): number[] {
  const out: number[] = [];
  for (let i = 3; i < m.windows.length; i += WINDOW_ATTR_FLOATS) if (m.windows[i] > 0) out.push(m.windows[i]);
  return out;
}

/** vertex heights above the base (100) of the small parts, rounded to cm */
function smallYs(m: ReturnType<typeof build>): Set<number> {
  const out = new Set<number>();
  for (let i = m.coreVertexCount; i < m.vertexCount; i++) out.add(Math.round((m.vertices[i * 6 + 1] - 100) * 100) / 100);
  return out;
}

describe('architectural styles', () => {
  it('reads building:architecture: the OSM wiki values, aliases, case and separators; unknown: none', () => {
    expect(archProfile({ 'building:architecture': 'stalinist_neoclassicism' })?.tags[0]).toBe('stalinist_neoclassicism');
    expect(archProfile({ 'building:architecture': 'russian_gothic' })).toBe(archProfile({ 'building:architecture': 'pseudo-gothic' }));
    expect(archProfile({ 'building:architecture': 'historicism' })).toBe(archProfile({ 'building:architecture': 'neo-renaissance' }));
    expect(archProfile({ 'building:architecture': 'Art Nouveau' })?.tags[0]).toBe('art_nouveau');
    expect(archProfile({ 'building:architecture': 'neo_gothic' })?.tags[0]).toBe('neo-gothic');
    expect(archProfile({ 'building:architecture': 'empire;eclectic' })?.tags[0]).toBe('empire');
    expect(archProfile({ 'building:architecture': 'no_such_style' })).toBeUndefined();
    expect(archProfile({})).toBeUndefined();
  });

  it('covers every style of the wiki table, ids 1.. within the wall-height packing', () => {
    const wiki = [
      'neoclassicism', 'empire', 'moorish_revival', 'pseudo-russian', 'eclectic', 'georgian', 'victorian', 'historicism',
      'neo-romanesque', 'neo-gothic', 'pseudo-gothic', 'russian_gothic', 'neo-byzantine', 'neo-renaissance', 'neo-baroque',
      'art_nouveau', 'nothern_modern', 'functionalism', 'cubism', 'new_objectivity', 'art_deco', 'modern', 'amsterdam_school',
      'international_style', 'constructivism', 'postconstructivism', 'stalinist_neoclassicism', 'brutalist', 'postmodern', 'contemporary',
    ];
    for (const v of wiki) expect(archProfile({ 'building:architecture': v }), v).toBeDefined();
    ARCH_PROFILES.forEach((p, i) => expect(p.id).toBe(i + 1));
    // a wall of 900 m under the last profile stays exact to the centimetre in a float
    const packed = Math.fround(900.37 + ARCH_PROFILES.length * FACADE_PROFILE_M);
    expect(packed - ARCH_PROFILES.length * FACADE_PROFILE_M).toBeCloseTo(900.37, 2);
    expect(ARCH_GLSL).toContain(`const uint ARCH_HEAD[${ARCH_PROFILES.length + 1}] = uint[${ARCH_PROFILES.length + 1}](0u, `);
  });

  it('carries the profile above the wall height of a styled facade; an unstyled one as before', () => {
    const plain = wallHeights(build({ building: 'apartments', 'building:levels': '5' }));
    const styled = wallHeights(build({ building: 'apartments', 'building:levels': '5', 'building:architecture': 'stalinist_neoclassicism' }));
    const id = archProfile({ 'building:architecture': 'stalinist_neoclassicism' })!.id;
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((h) => h < FACADE_PROFILE_M)).toBe(true);
    expect(styled).toHaveLength(plain.length);
    styled.forEach((h, i) => expect(h - id * FACADE_PROFILE_M).toBeCloseTo(plain[i], 3));
  });

  it('a cornice under the wall top and belt courses at the floor lines, as small parts', () => {
    const tags = { building: 'apartments', 'building:levels': '5', 'roof:shape': 'flat' };
    const plain = build(tags);
    const neo = build({ ...tags, 'building:architecture': 'neo-renaissance' });
    const ys = smallYs(neo);
    // 5 levels × 3 m over the 1 m plinth, under the 1.5 m technical floor: a 17.5 m wall
    // the cornice: its top 0.9 m, its cove ending 0.45 of the way up
    expect(ys.has(17.5)).toBe(true);
    expect(ys.has(16.6)).toBe(true);
    expect([...ys].some((y) => Math.abs(y - (16.6 + 0.45 * 0.9)) < 0.011)).toBe(true);
    // belts at every floor line of the 5 floors (the windows from the plinth, 1 m, up)
    const floorH = 3;
    for (let k = 1; k < 5; k++) expect(ys.has(Math.round((1 + k * floorH - BELT.BELOW) * 100) / 100), `belt ${k}`).toBe(true);
    expect(neo.vertexCount - neo.coreVertexCount).toBeGreaterThan(plain.vertexCount - plain.coreVertexCount);
    // the core (what the far LOD draws) is the same mesh
    expect(neo.coreVertexCount).toBe(plain.coreVertexCount);
  });

  it('a style without mouldings adds none; one belt only over the ground floor', () => {
    const tags = { building: 'apartments', 'building:levels': '5', 'roof:shape': 'flat' };
    const plain = build(tags);
    expect(build({ ...tags, 'building:architecture': 'functionalism' }).vertexCount).toBe(plain.vertexCount);
    const classic = smallYs(build({ ...tags, 'building:architecture': 'neoclassicism' }));
    const floorH = 3;
    expect(classic.has(Math.round((1 + floorH - BELT.BELOW) * 100) / 100)).toBe(true);
    expect(classic.has(Math.round((1 + 2 * floorH - BELT.BELOW) * 100) / 100)).toBe(false);
  });

  it('no balconies on a pre-1900 style; balconies kept on a Stalinist block', () => {
    const tags = { building: 'apartments', 'building:levels': '9' };
    const style = (m: ReturnType<typeof build>) => {
      const s = new Set<number>();
      for (let i = 4; i < m.windows.length; i += WINDOW_ATTR_FLOATS) if (m.windows[i] > 0) s.add((m.windows[i] >> 16) & 3);
      return s;
    };
    expect([...style(build({ ...tags, 'building:architecture': 'eclectic' }))]).toEqual([0]);
    const all = new Set<number>();
    // over many seeds (the footprint's position) some edges of a Stalinist block carry balconies
    for (let k = 0; k < 12; k++) {
      const ring = rect(0.0002 + k * 0.00001, 0.00015);
      const m = buildBuildingMesh({ tile: TILE, buildings: [{ rings: [ring], tags: { ...tags, 'building:architecture': 'stalinist_neoclassicism' } }], sampleHeight: () => 100 });
      for (const s of style(m)) all.add(s);
    }
    expect(all.size).toBeGreaterThan(1);
  });

  it('untagged walls take the style colours; a tagged colour still wins', () => {
    const russian = archProfile({ 'building:architecture': 'pseudo-russian' })!;
    for (const seed of [0.1, 0.5, 0.9]) {
      const c = rgbOf(wallRamp({ building: 'church', 'building:architecture': 'pseudo-russian' }, seed));
      expect(russian.walls.map(([w]) => w.join())).toContain(c.join());
    }
    expect(rgbOf(wallRamp({ building: 'yes', 'building:architecture': 'pseudo-russian', 'building:colour': '#ffffff' }))).toEqual([255, 255, 255]);
  });

  it('parts take the style of their building outline', () => {
    const outline: OsmBuilding = { rings: [rect()], tags: { building: 'yes', 'building:architecture': 'neo-gothic' } };
    const part: OsmBuilding = { rings: [rect(0.0001, 0.0001)], tags: { 'building:part': 'yes' } };
    const own: OsmBuilding = { rings: [rect(0.00005, 0.00005)], tags: { 'building:part': 'yes', 'building:architecture': 'modern' } };
    const out = shareStyleInParts([outline, part, own]);
    expect(out.find((b) => b.rings === part.rings)!.tags['building:architecture']).toBe('neo-gothic');
    expect(out.find((b) => b.rings === own.rings)!.tags['building:architecture']).toBe('modern');
  });
});

describe('styles inferred from start_date', () => {
  const MOSCOW: [number, number] = [37.6, 55.76];
  const BERLIN: [number, number] = [13.4, 52.52];
  const infer = (tags: Record<string, string>, [lon, lat]: [number, number], seed = 0.3) => inferArchitecture(tags, lon, lat, seed);

  it('tells the former USSR, Britain and the rest apart', () => {
    for (const [lon, lat] of [[37.6, 55.76], [30.32, 59.93], [24.1, 56.95], [20.5, 54.7], [24.03, 49.84], [28.86, 47.0], [69.24, 41.3], [44.8, 41.7], [131.9, 43.1], [60.6, 56.84]]) {
      expect(archRegion(lon, lat), `${lon},${lat}`).toBe('soviet');
    }
    for (const [lon, lat] of [[13.4, 52.52], [21.0, 52.23], [24.94, 60.17], [26.1, 44.43], [28.97, 41.01], [51.4, 35.7], [116.4, 39.9], [106.9, 47.9], [2.35, 48.86], [-74, 40.7]]) {
      expect(archRegion(lon, lat), `${lon},${lat}`).toBe('west');
    }
    expect(archRegion(-0.13, 51.5)).toBe('british');
    expect(archRegion(-6.26, 53.35)).toBe('british');
  });

  it('a Moscow block by its year: eclectic or art nouveau, constructivism, Stalinist; none after 1956', () => {
    const block = (y: string) => infer({ building: 'apartments', 'building:levels': '6', start_date: y }, MOSCOW);
    expect(block('1928')).toBe('constructivism');
    expect(block('1935')).toBe('postconstructivism');
    expect(block('1952-05-01')).toBe('stalinist_neoclassicism');
    expect(block('~1950')).toBe('stalinist_neoclassicism');
    expect(block('1970')).toBeUndefined();
    expect(['eclectic', 'neo-renaissance', 'pseudo-russian']).toContain(block('1885'));
    expect(['art_nouveau', 'eclectic']).toContain(block('1905'));
    expect(infer({ building: 'university', start_date: '1975' }, MOSCOW)).toBe('brutalist');
    expect(infer({ building: 'church', start_date: '1890' }, MOSCOW)).toMatch(/^(pseudo-russian|neo-byzantine)$/);
  });

  it('the same years elsewhere: functionalism or art deco, Victorian in Britain', () => {
    expect(['functionalism', 'art_deco', 'new_objectivity']).toContain(infer({ building: 'apartments', 'building:levels': '4', start_date: '1928' }, BERLIN));
    expect(['modern', 'international_style', 'brutalist']).toContain(infer({ building: 'office', 'building:levels': '8', start_date: '1952' }, BERLIN));
    expect(['victorian', 'neo-gothic']).toContain(infer({ building: 'terrace', 'building:levels': '3', start_date: '1880' }, [-0.13, 51.5]));
  });

  it('within an era a style by the seed, all of them drawn', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 200; k++) seen.add(infer({ building: 'apartments', 'building:levels': '5', start_date: '1885' }, MOSCOW, k / 200)!);
    expect([...seen].sort()).toEqual(['eclectic', 'neo-renaissance', 'pseudo-russian']);
  });

  it('none for houses, sheds, industry, small yes buildings, no or a vague date, or a tagged style', () => {
    expect(infer({ building: 'house', start_date: '1950' }, MOSCOW)).toBeUndefined();
    expect(infer({ building: 'industrial', 'building:levels': '4', start_date: '1950' }, MOSCOW)).toBeUndefined();
    expect(infer({ building: 'yes', start_date: '1950' }, MOSCOW)).toBeUndefined();
    expect(infer({ building: 'apartments', 'building:levels': '1', start_date: '1950' }, MOSCOW)).toBeUndefined();
    expect(infer({ building: 'yes', 'building:levels': '5', start_date: '1950' }, MOSCOW)).toBe('stalinist_neoclassicism');
    expect(infer({ building: 'apartments', 'building:levels': '5' }, MOSCOW)).toBeUndefined();
    expect(infer({ building: 'apartments', 'building:levels': '5', start_date: 'C19' }, MOSCOW)).toBeUndefined();
    expect(infer({ building: 'apartments', 'building:levels': '5', start_date: '1950', 'building:architecture': 'modern' }, MOSCOW)).toBeUndefined();
  });

  it('a building takes the inferred style as a default tag, its mesh and colours drawn with it', () => {
    const b = tileBounds(TILE);
    // the test tile is in central Europe: a block of 1930 is modern of its time, styled; one of 2010 is not
    expect(archRegion((b.west + b.east) / 2, (b.south + b.north) / 2)).toBe('west');
    const old: OsmBuilding = { rings: [rect()], tags: { building: 'apartments', 'building:levels': '5', start_date: '1930' } };
    const style = buildingTags(old)[ARCH_INFERRED_TAG];
    expect(['functionalism', 'art_deco', 'new_objectivity']).toContain(style);
    expect(archProfile(buildingTags(old))?.tags).toContain(style);
    const id = archProfile(buildingTags(old))!.id;
    const heights = wallHeights(buildBuildingMesh({ tile: TILE, buildings: [old], sampleHeight: () => 100 }));
    expect(heights.every((h) => Math.floor(h / FACADE_PROFILE_M) === id)).toBe(true);
    const late: OsmBuilding = { rings: [rect()], tags: { building: 'apartments', 'building:levels': '5', start_date: '2010' } };
    expect(buildingTags(late)[ARCH_INFERRED_TAG]).toBeUndefined();
    // the parts of one building share its start_date, so its style
    const part: OsmBuilding = { rings: [rect(0.0001, 0.0001)], tags: { 'building:part': 'yes', 'building:levels': '5' } };
    const shared = shareStyleInParts([old, part]).find((x) => x.rings === part.rings)!;
    expect(shared.tags.start_date).toBe('1930');
  });
});
