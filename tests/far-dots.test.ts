import { describe, expect, it } from 'vitest';
import { pointValue } from '../src/engine/palette';
import { POINTS_VS } from '../src/engine/shaders';
import { buildingDots, roofRamp, buildingSeed, wallRamp } from '../src/world/building-mesher';
import { tileBounds, type Tile } from '../src/world/geodesy';
import type { OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

describe('far building dots', () => {
  it('are a wall-coloured point then a roof-coloured one at the same place', () => {
    const b = tileBounds(TILE);
    const cx = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    const ring: [number, number][] = [[cx, cy], [cx + 1e-4, cy], [cx + 1e-4, cy + 1e-4], [cx, cy + 1e-4], [cx, cy]];
    const house = { rings: [ring], tags: { building: 'house', 'building:colour': '#ffffff', 'roof:colour': '#aa2200' } } as unknown as OsmBuilding;
    const d = Array.from(buildingDots([house], TILE, () => 100));
    expect(d).toHaveLength(8);
    expect(d.slice(0, 3)).toEqual(d.slice(4, 7));
    expect(d[3]).toBe(pointValue(wallRamp(house.tags, buildingSeed(ring))));
    expect(d[7]).toBe(pointValue(roofRamp(house.tags, buildingSeed(ring))));
    expect(d[3]).not.toBe(d[7]);
  });

  it('the point shader lifts the odd (roof) one by its size', () => {
    expect(POINTS_VS).toContain('(gl_VertexID & 1) == 1');
  });
});
