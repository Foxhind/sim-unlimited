import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { pmtilesToOverpass, type AerodromeIndex } from '../src/world/osm-pmtiles';
import { parseOverpass } from '../src/world/overpass';
import { parseDirectory, Pmtiles, zxyToTileId } from '../src/world/pmtiles';
import { tileBounds, type Tile } from '../src/world/geodesy';
import { layer, mvt, square, varint } from './mvt-encoder';

const TILE: Tile = { z: 14, x: 8710, y: 5744 };
const NO_AERODROMES: AerodromeIndex = { aerodromes: [], runways: [] };

describe('PMTiles reader', () => {
  it('numbers tiles along the Hilbert curve, zoom by zoom (spec v3)', () => {
    expect(zxyToTileId(0, 0, 0)).toBe(0);
    expect([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y))).toEqual([1, 2, 3, 4]);
    expect(zxyToTileId(2, 0, 0)).toBe(5);
    expect(zxyToTileId(2, 3, 0)).toBe(20);
  });

  it('decodes a directory: delta ids, run lengths, lengths, offsets (0 = right after the previous)', () => {
    const dir = new Uint8Array([...varint(3), ...varint(5), ...varint(1), ...varint(4), 1, 1, 0, 10, 20, 30, ...varint(1), 0, ...varint(101)]);
    expect(parseDirectory(dir)).toEqual([
      { tileId: 5, offset: 0, length: 10, runLength: 1 },
      { tileId: 6, offset: 10, length: 20, runLength: 1 },
      { tileId: 10, offset: 100, length: 30, runLength: 0 },
    ]);
  });

  it('reads a tile through a leaf directory', async () => {
    // archive: header | root dir (one leaf pointer) | leaf dir (one tile) | tile data
    const tileData = gzipSync(Buffer.from('hello'));
    const id = zxyToTileId(14, TILE.x, TILE.y);
    const leaf = gzipSync(Buffer.from([...varint(1), ...varint(id), 1, ...varint(tileData.length), ...varint(1)]));
    const root = gzipSync(Buffer.from([...varint(1), ...varint(id), 0, ...varint(leaf.length), ...varint(1)]));
    const header = new Uint8Array(127);
    const v = new DataView(header.buffer);
    header.set(new TextEncoder().encode('PMTiles'), 0);
    header[7] = 3;
    const put = (at: number, n: number) => v.setUint32(at, n, true);
    put(8, 127); put(16, root.length);
    put(40, 127 + root.length); put(48, leaf.length);
    put(56, 127 + root.length + leaf.length); put(64, tileData.length);
    header[97] = 2; header[98] = 2; header[100] = 14; header[101] = 14;
    const file = new Uint8Array([...header, ...root, ...leaf, ...tileData]);
    const archive = new Pmtiles(async (o, l) => file.subarray(o, o + l));
    expect(new TextDecoder().decode(await archive.tile(14, TILE.x, TILE.y))).toBe('hello');
    expect(await archive.tile(14, TILE.x + 1, TILE.y)).toBeUndefined();
    expect(await archive.tile(13, TILE.x >> 1, TILE.y >> 1)).toBeUndefined();
  });
});

describe('our tiles as Overpass JSON', () => {
  it('areas, lines and points come back through parseOverpass with their tags', () => {
    const data = mvt(
      layer('areas', [
        { type: 3, props: { building: 'house', 'roof:shape': 'gabled', 'building:levels': 2 }, parts: [square(100, 100, 50)] },
        // a courtyard: the exterior and its hole become a multipolygon
        { type: 3, props: { building: 'apartments' }, parts: [square(1000, 1000, 300), [[1100, 1100], [1100, 1200], [1200, 1200], [1200, 1100], [1100, 1100]]] },
        { type: 3, props: { landuse: 'farmland' }, parts: [square(2000, 2000, 500)] },
      ]),
      layer('lines', [
        { type: 2, props: { highway: 'primary', lanes: 2 }, parts: [[[0, 10], [4096, 10]]] },
        { type: 2, props: { natural: 'coastline' }, parts: [[[0, 3000], [500, 3000], [500, 3500], [0, 3000]]] },
      ]),
      layer('points', [{ type: 1, props: { man_made: 'mast', height: 120 }, parts: [[[2048, 2048]]] }]),
    );
    const osm = parseOverpass(pmtilesToOverpass(data, TILE, NO_AERODROMES));
    expect(osm.buildings.map((b) => [b.tags.building, b.rings.length])).toEqual([['apartments', 2], ['house', 1]]);
    expect(osm.buildings.find((b) => b.tags.building === 'house')!.tags).toEqual({ building: 'house', 'roof:shape': 'gabled', 'building:levels': '2' });
    expect(osm.areas.map((a) => a.tags.landuse)).toEqual(['farmland']);
    expect(osm.lines.map((l) => l.tags.highway ?? l.tags.natural)).toEqual(['primary', 'coastline']);
    expect(osm.points).toEqual([{ at: expect.any(Array), tags: { man_made: 'mast', height: '120' } }]);

    const b = tileBounds(TILE);
    const road = osm.lines[0].points;
    expect(road[0][0]).toBeCloseTo(b.west, 6);
    expect(road[1][0]).toBeCloseTo(b.east, 6);
  });

  it('aerodromes within reach of the tile and runways crossing it come whole from the index', () => {
    const b = tileBounds(TILE);
    const near: [number, number][] = [[b.east + 0.01, b.south], [b.east + 0.03, b.south], [b.east + 0.03, b.north], [b.east + 0.01, b.north], [b.east + 0.01, b.south]];
    const far = near.map(([lon, lat]) => [lon + 1, lat] as [number, number]);
    const runway: [number, number][] = [[b.west - 0.02, (b.south + b.north) / 2], [b.east + 0.02, (b.south + b.north) / 2]];
    const index: AerodromeIndex = {
      aerodromes: [{ tags: { aeroway: 'aerodrome', icao: 'NEAR' }, rings: [near] }, { tags: { aeroway: 'aerodrome', icao: 'FAR' }, rings: [far] }],
      runways: [{ tags: { aeroway: 'runway', width: '45' }, points: runway }, { tags: { aeroway: 'runway' }, points: runway.map(([lon, lat]) => [lon, lat + 1]) }],
    };
    const osm = parseOverpass(pmtilesToOverpass(undefined, TILE, index));
    expect(osm.areas.map((a) => a.tags.icao)).toEqual(['NEAR']);
    expect(osm.areas[0].rings[0]).toEqual(near);
    expect(osm.lines.map((l) => l.points)).toEqual([runway]);
  });
});
