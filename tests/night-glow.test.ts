import { describe, expect, it } from 'vitest';
import { rampGlowLevel } from '../src/engine/palette';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildBuildingMesh } from '../src/world/building-mesher';
import { applyGlowByRuns } from '../src/world/night-glow';
import type { OsmBuilding } from '../src/world/osm-types';

const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function house(cx: number, cy: number, w: number, h: number): OsmBuilding {
  const ring: [number, number][] = [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]];
  return { tags: { building: 'apartments', 'building:levels': '5' }, rings: [ring] } as OsmBuilding;
}

describe('night glow on buildings', () => {
  it('lights a house as one, by the terrain triangle under its footprint', () => {
    const b = tileBounds(TILE);
    const mid = (b.west + b.east) / 2, cy = (b.south + b.north) / 2;
    // two terrain "triangles": west of mid lit (level 3), east dark
    const locate = (lon: number) => ({ tri: lon < mid ? 0 : 1 });
    const levels = Uint8Array.from([3, 0]);
    // A straddles mid, its centroid west of it; B wholly east
    const a = house(mid - 0.0001, cy, 0.0003, 0.0002);
    const bh = house(mid + 0.001, cy, 0.0002, 0.0002);
    const mesh = buildBuildingMesh({ tile: TILE, buildings: [a, bh], sampleHeight: () => 100 });
    applyGlowByRuns(mesh.ramps, mesh.footprints, TILE, locate, levels);
    // the footprint runs: A's core, B's core, A's small parts, B's small parts
    const [aCore, bCore, aSmall, bSmall] = [0, 3, 6, 9].map((i) => mesh.footprints[i]);
    const levelsIn = (from: number, to: number) => new Set(Array.from(mesh.ramps.slice(from, to), rampGlowLevel));
    expect(levelsIn(aCore, bCore)).toEqual(new Set([3]));
    expect(levelsIn(aSmall, bSmall)).toEqual(new Set([3]));
    expect(levelsIn(bCore, mesh.coreVertexCount)).toEqual(new Set([0]));
    expect(levelsIn(bSmall, mesh.vertexCount)).toEqual(new Set([0]));
  });
});
