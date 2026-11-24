import { describe, expect, it } from 'vitest';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import { buildProps } from '../src/world/props-mesher';
import type { OsmTileData } from '../src/world/osm-types';
import { buildGroundCover } from '../src/world/ground-cover';
import { solveRoadHeights } from '../src/world/road-heights';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin } from '../src/world/surface-tin';
import { constrainedDelaunay } from '../src/world/contours';
import { scatterWithEdges } from './cdt-fixture';
import { bordersOf, demOf, GRID, lattice, randomTown, TILE as Z14_TILE, townFixture } from './roads-helpers';

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

// One-layer ground: the z14 surface with its covers (road net and heights are built outside the timed part, as the
// workers get them from the DEM beforehand).
const relief = (x: number, y: number) => 500 + 25 * Math.sin(x / 300) + 0.06 * y;
function surfaceMedian(label: string, town: ReturnType<typeof townFixture>): number {
  const net = buildRoadNet(town.lines), roads = { net, z: solveRoadHeights(net, demOf(net, relief)) };
  const h = lattice(relief), borders = bordersOf(relief);
  const run = (): number => {
    const t0 = performance.now();
    const cover = buildGroundCover(Z14_TILE, GRID, town, roads);
    buildSurfaceTin(Z14_TILE, GRID, h, { borders, roads, cover });
    return performance.now() - t0;
  };
  run();
  const times = Array.from({ length: 5 }, run).sort((a, b) => a - b);
  console.log(label, 'ms', times.map((t) => t.toFixed(0)).join(' '));
  return times[2];
}

describe('one-layer ground budgets', () => {
  // randomTown: 40 ways of every class sharing 30 nodes plus 25 overlapping areas of every kind, spilling past the tile:
  // the closest fixture to a city centre (many junctions and overlapping covers), unlike denseTown's artificial park grid.
  it('the surface with the covers of a dense town in < 250 ms', () => {
    expect(surfaceMedian('dense town surface', randomTown(10))).toBeLessThan(250);
  });

  it('the surface with the covers of an ordinary tile in < 120 ms', () => {
    expect(surfaceMedian('ordinary tile surface', townFixture())).toBeLessThan(120);
  });
});

describe('constrainedDelaunay budget', () => {
  it('triangulates 8000 points with 2000 fixed edges within 150 ms', () => {
    const { pts, cons } = scatterWithEdges();
    constrainedDelaunay(pts, cons); // warm-up
    const t = performance.now();
    constrainedDelaunay(pts, cons);
    expect(performance.now() - t).toBeLessThan(150);
  });
});
