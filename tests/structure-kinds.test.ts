import { describe, expect, it } from 'vitest';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh } from '../src/world/building-mesher';
import type { OsmBuilding } from '../src/world/osm-types';
import { ALL_STRUCTURES, KindRuns, shownRanges, STRUCTURE, structureKind } from '../src/world/structure-kinds';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function rect(dx: number, w = 0.0002, h = 0.00015): [number, number][] {
  const b = tileBounds(TILE);
  const cx = (b.west + b.east) / 2 + dx, cy = (b.south + b.north) / 2;
  return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
}

describe('structureKind', () => {
  it('classifies by building and man_made tags', () => {
    expect(structureKind({ building: 'yes' })).toBe(STRUCTURE.BUILDING);
    expect(structureKind({ building: 'roof' })).toBe(STRUCTURE.CANOPY);
    expect(structureKind({ man_made: 'chimney' })).toBe(STRUCTURE.CHIMNEY);
    expect(structureKind({ 'building:part': 'chimney' })).toBe(STRUCTURE.CHIMNEY);
    expect(structureKind({ building: 'yes', man_made: 'water_tower' })).toBe(STRUCTURE.TOWER);
    expect(structureKind({ man_made: 'storage_tank' })).toBe(STRUCTURE.TANK);
    expect(structureKind({ building: 'industrial', man_made: 'works' })).toBe(STRUCTURE.MAN_MADE);
  });
});

describe('KindRuns', () => {
  it('merges same kinds and replaces empty runs', () => {
    const r = new KindRuns();
    r.mark(0, 1);
    r.mark(0, 2); // nothing of kind 1 came: replaced
    r.mark(6, 2); // same kind: merged
    r.mark(9, 3);
    expect(r.pairs).toEqual([0, 2, 9, 3]);
  });
});

describe('shownRanges', () => {
  const runs = [0, STRUCTURE.BUILDING, 30, STRUCTURE.BRIDGE, 60, STRUCTURE.BUILDING, 90, STRUCTURE.MAST];
  it('all kinds: the whole mesh in one range', () => {
    expect(shownRanges(runs, 120, ALL_STRUCTURES)).toEqual([[0, 120]]);
  });
  it('leaves out the hidden kinds and stops at the vertex count', () => {
    expect(shownRanges(runs, 120, 1 << STRUCTURE.BUILDING)).toEqual([[0, 30], [60, 30]]);
    expect(shownRanges(runs, 45, ALL_STRUCTURES & ~(1 << STRUCTURE.BUILDING))).toEqual([[30, 15]]);
    expect(shownRanges(runs, 120, 0)).toEqual([]);
  });
  it('no runs: all of it is buildings', () => {
    expect(shownRanges([], 12, 1 << STRUCTURE.BUILDING)).toEqual([[0, 12]]);
    expect(shownRanges([], 12, 1 << STRUCTURE.MAST)).toEqual([]);
  });
});

describe('building mesh kinds', () => {
  it('marks each building’s vertices, core and small parts, with its kind on whole triangles', () => {
    const buildings: OsmBuilding[] = [
      { rings: [rect(-0.0006)], tags: { building: 'apartments', 'building:levels': '9', 'roof:shape': 'flat' } },
      { rings: [rect(0, 0.00005, 0.00005)], tags: { man_made: 'chimney', height: '60' } },
      { rings: [rect(0.0006)], tags: { building: 'roof' } },
    ];
    const m = buildBuildingMesh({ tile: TILE, buildings, sampleHeight: () => 100 });
    const pairs = [...m.kinds];
    for (let i = 0; i < pairs.length; i += 2) {
      expect(pairs[i] % 3).toBe(0);
      if (i) expect(pairs[i]).toBeGreaterThan(pairs[i - 2]);
    }
    const kinds = new Set(pairs.filter((_, i) => i % 2 === 1));
    expect(kinds).toEqual(new Set([STRUCTURE.BUILDING, STRUCTURE.CHIMNEY, STRUCTURE.CANOPY]));
    // every vertex in one shown range of all kinds, and the kinds' ranges add up to the mesh
    let total = 0;
    for (const k of kinds) for (const [, n] of shownRanges(m.kinds, m.vertexCount, 1 << k)) total += n;
    expect(total).toBe(m.vertexCount);
  });
});
