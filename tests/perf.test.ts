import { describe, expect, it } from 'vitest';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildProps } from '../src/world/props-mesher';
import type { OsmTileData } from '../src/world/osm-types';

// §10: tile generation in a worker < 200 ms for a dense city centre (mesher part only, no network/PNG decode).
const TILE: Tile = { z: 14, x: 8800, y: 5500 };

function denseCity(): OsmTileData {
  const b = tileBounds(TILE);
  const buildings: OsmTileData['buildings'] = [];
  const roads: OsmTileData['lines'] = [];
  const cols = 60;
  const rows = 60; // 3600 buildings ~ dense European centre
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const w = b.west + ((i + 0.15) / cols) * (b.east - b.west);
      const e = b.west + ((i + 0.8) / cols) * (b.east - b.west);
      const s = b.south + ((j + 0.15) / rows) * (b.north - b.south);
      const n = b.south + ((j + 0.8) / rows) * (b.north - b.south);
      buildings.push({
        rings: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
        tags: { building: 'apartments', 'building:levels': String(3 + ((i * 7 + j * 3) % 8)), ...((i + j) % 3 === 0 ? { 'roof:shape': 'gabled' } : {}) },
      } as OsmTileData['buildings'][number]);
    }
    roads.push({
      points: [[b.west, b.south + ((j + 0.9) / rows) * (b.north - b.south)], [b.east, b.south + ((j + 0.9) / rows) * (b.north - b.south)]],
      tags: { highway: 'residential' },
    });
  }
  return { areas: [], lines: roads, points: [], buildings };
}

describe('§10 tile generation budget', () => {
  it('dense city tile meshes in < 200 ms (median of 5, after warm-up)', () => {
    const data = denseCity();
    const sample = () => 100;
    const run = (): number => {
      const t0 = performance.now();
      buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: sample });
      buildProps({ tile: TILE, detail: 'full', data, sampleHeight: sample });
      return performance.now() - t0;
    };
    run();
    const times = Array.from({ length: 5 }, run).sort((a, b) => a - b);
    console.log('dense tile ms', times.map((t) => t.toFixed(0)).join(' '));
    expect(times[2]).toBeLessThan(200);
  });
});
