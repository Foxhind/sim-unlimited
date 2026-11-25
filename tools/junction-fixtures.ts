/**
 * The junctions regression set (tests/fixtures/junctions.json): for each junction of
 * tests/fixtures/junction-set.json, the roads of its z14 tile within REACH_M of it, as the OSM
 * worker has the tile (the local PMTiles: tiles/build.sh), whole ways, and its traffic lights.
 *
 *   npx vite-node tools/junction-fixtures.ts -- tiles/data/out
 *
 * A junction's `archive` names its PMTiles in that folder (central-fed-district-261118.pmtiles if
 * none).
 */
import fs from 'node:fs';
import { latLonToEnu, tileForLatLon } from '../src/world/geodesy';
import { pmtilesToOverpass } from '../src/world/osm-pmtiles';
import { parseOverpass } from '../src/world/overpass';
import type { OsmLine } from '../src/world/osm-types';
import { Pmtiles } from '../src/world/pmtiles';

/** the ways kept: those with a point within this of the junction, metres */
const REACH_M = 220;

const dir = process.argv.slice(2).filter((a) => a !== '--')[0];
if (!dir) throw new Error('usage: junction-fixtures.ts <folder of the archives>');
const archives = new Map<string, Pmtiles>();
const archiveOf = (name: string): Pmtiles => {
  let a = archives.get(name);
  if (!a) {
    const fd = fs.openSync(`${dir}/${name}`, 'r');
    archives.set(name, a = new Pmtiles(async (offset, length) => {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, length);
    }));
  }
  return a;
};
const set = JSON.parse(fs.readFileSync('tests/fixtures/junction-set.json', 'utf8')) as { name: string; at: [number, number]; span: number; note: string; archive?: string }[];
const out = [];
for (const j of set) {
  const [lat, lon] = j.at, tile = tileForLatLon(lat, lon, 14);
  const archive = archiveOf(j.archive ?? 'central-fed-district-261118.pmtiles');
  const data = parseOverpass(pmtilesToOverpass(await archive.tile(14, tile.x, tile.y), tile, { aerodromes: [], runways: [] }));
  const near = (l: OsmLine) => l.points.some(([plon, plat]) => { const [e, n] = latLonToEnu({ lat, lon }, plat, plon, 0); return Math.hypot(e, n) < REACH_M; });
  const lines = data.lines.filter((l) => (l.tags.highway || l.tags.railway) && near(l));
  const points = data.points.filter((p) => p.tags.highway === 'traffic_signals' && near({ tags: {}, points: [p.at] }));
  out.push({ ...j, tile, lines, points });
  console.log(j.name, lines.length, 'ways', points.length, 'traffic lights');
}
fs.writeFileSync('tests/fixtures/junctions.json', JSON.stringify(out));
