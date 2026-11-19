/**
 * M6 prototype check: the same z14 tiles from Overpass and from our PMTiles (tiles/SimProfile.java),
 * both through parseOverpass + clipTileData, compared by what the meshers use.
 *
 *   npx vite-node tools/compare-osm-tiles.ts -- tiles/data/out/austria.pmtiles 47.2616,11.3570 [--ring=1]
 *
 * Overpass replies are cached in tiles/data/overpass/ (one query per tile, ever).
 */
import fs from 'node:fs';
import path from 'node:path';
import { padSources } from '../src/world/aerodrome';
import { clipPolyline, clipTileData } from '../src/world/clip';
import { latLonToEnu, tileBounds, tileForLatLon, type Tile } from '../src/world/geodesy';
import { pmtilesToOverpass, type AerodromeIndex } from '../src/world/osm-pmtiles';
import { overpassQuery, parseOverpass, type OverpassJson } from '../src/world/overpass';
import type { LonLat, OsmTileData } from '../src/world/osm-types';
import { Pmtiles } from '../src/world/pmtiles';

const args = process.argv.slice(2).filter((a) => a !== '--');
const archivePath = args[0];
const ring = Number(args.find((a) => a.startsWith('--ring='))?.slice(7) ?? 1);
const centres = args.slice(1).filter((a) => !a.startsWith('--')).map((a) => a.split(',').map(Number) as [number, number]);
if (!archivePath || !centres.length) throw new Error('usage: compare-osm-tiles.ts <archive.pmtiles> <lat,lon>... [--ring=1]');

const fd = fs.openSync(archivePath, 'r');
const archive = new Pmtiles(async (offset, length) => {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, offset);
  return new Uint8Array(buf.buffer, buf.byteOffset, length);
});
const index = JSON.parse(fs.readFileSync(archivePath.replace(/\.pmtiles$/, '') + '.aerodromes.json', 'utf8')) as AerodromeIndex;

const cacheDir = path.resolve('tiles/data/overpass');
fs.mkdirSync(cacheDir, { recursive: true });

async function overpass(tile: Tile): Promise<OverpassJson> {
  const file = path.join(cacheDir, `${tile.z}-${tile.x}-${tile.y}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sim-unlimited/0.1 (OSM flight sim; dev tile check)' },
        body: new URLSearchParams({ data: overpassQuery(tile, 'full') }),
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      fs.writeFileSync(file, text);
      return JSON.parse(text);
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) throw new Error(`overpass ${res.status}`);
    await new Promise((r) => setTimeout(r, 10000 * (attempt + 1)));
  }
}

function lengthM(pts: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [e, n] = latLonToEnu({ lat: pts[i - 1][1], lon: pts[i - 1][0] }, pts[i][1], pts[i][0], 0);
    m += Math.hypot(e, n);
  }
  return m;
}

function areaM2(ring: LonLat[]): number {
  const o = { lat: ring[0][1], lon: ring[0][0] };
  const xy = ring.map(([lon, lat]) => latLonToEnu(o, lat, lon, 0));
  let a = 0;
  for (let i = 0; i + 1 < xy.length; i++) a += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
  return Math.abs(a / 2);
}

type Stats = Record<string, number>;
const add = (s: Stats, k: string, v = 1) => void (s[k] = (s[k] ?? 0) + v);

const lineKind = (t: Record<string, string>) =>
  t.highway ? `highway=${t.highway.replace(/_link$/, '')}` : t.railway ? 'railway' : t.waterway ? `waterway=${t.waterway}` : t.aeroway ? `aeroway=${t.aeroway}` : t.natural === 'coastline' ? 'coastline' : 'other';
const areaKind = (t: Record<string, string>) =>
  t.aeroway ? `aeroway=${t.aeroway}` : t.natural ? `natural=${t.natural}` : t.landuse ? `landuse=${t.landuse}` : t.leisure ? `leisure=${t.leisure}` : t.waterway ? `waterway=${t.waterway}` : 'other';
const pointKind = (t: Record<string, string>) => (t.entrance ? 'entrance' : t.man_made ? `man_made=${t.man_made}` : t.aeroway ? `aeroway=${t.aeroway}` : 'other');

const BUILDING_TAGS = ['height', 'building:levels', 'roof:shape', 'roof:height', 'roof:colour', 'building:colour', 'building:material', 'min_height'];

function stats(data: OsmTileData, tile: Tile): Stats {
  const s: Stats = {};
  const own = clipTileData(data, tile);
  const b = tileBounds(tile);
  for (const bd of own.buildings) {
    add(s, bd.tags['building:part'] ? 'buildings: parts' : 'buildings: outlines');
    add(s, 'buildings: footprint m²', Math.round(areaM2(bd.rings[0])));
    for (const k of BUILDING_TAGS) if (bd.tags[k] !== undefined) add(s, `buildings with ${k}`);
  }
  for (const a of own.areas) add(s, `area m²: ${areaKind(a.tags)}`, Math.round(a.rings[0].length > 2 ? areaM2(a.rings[0]) : 0));
  for (const l of data.lines) for (const piece of clipPolyline(l.points, b)) add(s, `line m: ${lineKind(l.tags)}`, Math.round(lengthM(piece)));
  for (const p of own.points) add(s, `points: ${pointKind(p.tags)}`);
  return s;
}

function padKeys(data: OsmTileData): string {
  return padSources(data).map((p) => p.key).sort().join(' ');
}

function fmt(n: number | undefined): string {
  return n === undefined ? '—' : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const totalO: Stats = {}, totalP: Stats = {};
let padMismatch = 0, tiles = 0;
for (const [lat, lon] of centres) {
  const c = tileForLatLon(lat, lon, 14);
  for (let dy = -ring; dy <= ring; dy++) {
    for (let dx = -ring; dx <= ring; dx++) {
      const tile = { z: 14, x: c.x + dx, y: c.y + dy };
      const o = parseOverpass(await overpass(tile));
      const p = parseOverpass(pmtilesToOverpass(await archive.tile(14, tile.x, tile.y), tile, index));
      for (const [k, v] of Object.entries(stats(o, tile))) add(totalO, k, v);
      for (const [k, v] of Object.entries(stats(p, tile))) add(totalP, k, v);
      tiles++;
      const ko = padKeys(o), kp = padKeys(p);
      if (ko !== kp) {
        padMismatch++;
        console.log(`pads differ in ${tile.z}/${tile.x}/${tile.y}:\n  overpass ${ko || '(none)'}\n  pmtiles  ${kp || '(none)'}`);
      }
    }
  }
}

console.log(`\n${tiles} tiles; aerodrome pad keys differ in ${padMismatch}\n`);
console.log('metric'.padEnd(36), 'overpass'.padStart(10), 'pmtiles'.padStart(10), '  Δ');
for (const k of [...new Set([...Object.keys(totalO), ...Object.keys(totalP)])].sort()) {
  const a = totalO[k], b = totalP[k];
  const d = a && b ? `${(((b - a) / a) * 100).toFixed(1)}%` : '';
  console.log(k.padEnd(36), fmt(a).padStart(10), fmt(b).padStart(10), ` ${d}`);
}
