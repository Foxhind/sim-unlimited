/**
 * The junctions regression set (tests/fixtures/junctions.json) as pictures: the ground cover round
 * each junction from above, framed as the relief inspector frames it (`span` km across 1100 px), the
 * roads' paint from their vertex attributes as WORLD_FS roadMarkAt draws it; `--lines` the road
 * covers' outlines over it (carriageways red, shoulders yellow). For a look before and after a change.
 *
 *   npx vite-node tools/junction-render.ts -- <outdir> [suffix] [--only=j01,j03] [--lines]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { enuToLatLon, latLonToEnu, tileCenter, tileForLatLon, tileLattice, type Tile } from '../src/world/geodesy';
import { buildGroundCover, COVER_RANK, type CoverKind } from '../src/world/ground-cover';

/** whether (x, y) lies in one of the triangles `t` (six numbers each) */
function inTris(t: Float64Array, x: number, y: number): boolean {
  for (let o = 0; o < t.length; o += 6) {
    const d1 = (t[o + 2] - t[o]) * (y - t[o + 1]) - (t[o + 3] - t[o + 1]) * (x - t[o]);
    const d2 = (t[o + 4] - t[o + 2]) * (y - t[o + 3]) - (t[o + 5] - t[o + 3]) * (x - t[o + 2]);
    const d3 = (t[o] - t[o + 4]) * (y - t[o + 5]) - (t[o + 1] - t[o + 5]) * (x - t[o + 4]);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
  }
  return false;
}
import type { OsmLine } from '../src/world/osm-types';
import * as palette from '../src/engine/palette';

const { ROAD_MARK, ROAD_U_BASE } = palette;
/** the edge-off bits of the paint code (palette ROAD_EDGE_OFF; none before them: renders older revisions too) */
const EDGE_OFF = (palette as { ROAD_EDGE_OFF?: { LEFT: number; RIGHT: number } }).ROAD_EDGE_OFF ?? { LEFT: 0, RIGHT: 0 };

const args = process.argv.slice(2).filter((a) => a !== '--');
const outDir = args[0], suffix = args[1] && !args[1].startsWith('--') ? args[1] : '';
if (!outDir) throw new Error('usage: junction-render.ts <outdir> [suffix] [--only=j01,j03] [--lines]');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const withLines = args.includes('--lines');
const GRID = 64, W = 1100, H = 1000;
const set = JSON.parse(fs.readFileSync('tests/fixtures/junctions.json', 'utf8')) as { name: string; at: [number, number]; span: number; tile: Tile; lines: OsmLine[] }[];

const COL: Partial<Record<CoverKind, [number, number, number]>> = {
  carriageway: [74, 72, 70], shoulder: [128, 116, 92], path: [150, 138, 110], water: [60, 90, 130], ballast: [110, 100, 95],
  railZone: [80, 80, 60], runway: [74, 72, 70], aeroArea: [90, 90, 90], carPark: [85, 85, 85],
};
const paintLine = (d: number, fw: number) => { const hw = Math.max(0.075, 0.5 * fw); return Math.abs(d) < hw ? Math.min(1, 0.075 / hw) : 0; };
const roadDash = (u: number, fwu: number) => { const f = u / 12 - Math.floor(u / 12); const s = f <= 0.25 ? 1 : 0; const k = Math.max(0, Math.min(1, 2 - fwu / 1.5)); return 0.25 + (s - 0.25) * k; };
/** WORLD_FS roadMarkAt's paint share at (u, v) with edge attributes */
function paintAt(u: number, v: number, ex: number, ey: number, ez: number, fw: number): number {
  const atEnd = u < 0, d = Math.abs(u) - ROAD_U_BASE;
  const code = Math.round(ez), wp = Math.round(ey), tp = Math.round(-2 - ex);
  const gap = (atEnd ? (code >> 13) & 63 : (code >> 7) & 63) * 0.5;
  if (d < gap) return 0;
  const full = (wp & 1023) * 0.25, narrow = (atEnd ? (wp >> 15) & 31 : (wp >> 10) & 31) * 0.5, taper = (atEnd ? tp & 63 : tp >> 6) * 2;
  const w = taper > 0 ? full - narrow * (1 - Math.min(1, d / taper)) : full;
  let a = 0;
  const lanes = code & ROAD_MARK.LANES, lw = full / Math.max(lanes, 1), dash = roadDash(d, fw);
  if (code & ROAD_MARK.EDGES) {
    const noL = code & EDGE_OFF.LEFT, noR = code & EDGE_OFF.RIGHT;
    a = Math.max(noL ? 0 : paintLine(v - 0.35, fw), noR ? 0 : paintLine(w - 0.35 - v, fw));
  }
  if (code & ROAD_MARK.ONEWAY) {
    for (let k = 1; k < 15; k++) { if (k >= lanes || k * lw > w - 0.5) break; a = Math.max(a, paintLine(v - k * lw, fw) * dash); }
  } else if (lanes >= 2) {
    const mid = 0.5 * w;
    if (code & ROAD_MARK.DOUBLE) a = Math.max(a, paintLine(v - mid - 0.15, fw), paintLine(v - mid + 0.15, fw));
    else a = Math.max(a, paintLine(v - mid, fw) * dash);
    for (let k = 1; k < 8; k++) { if (k >= Math.floor(lanes * 0.5)) break; a = Math.max(a, Math.max(paintLine(v - mid - k * lw, fw), paintLine(v - mid + k * lw, fw)) * dash); }
  }
  return a;
}

function png(file: string, w: number, h: number, rgb: Uint8Array): void {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

for (const fx of set) {
  const name = fx.name;
  if (only && !only.includes(name)) continue;
  const [lat, lon] = fx.at;
  const span = fx.span * 1000, mpp = span / W, centre = { lat, lon };
  const rgb = new Uint8Array(W * H * 3);
  const covers = new Map<string, { cover: ReturnType<typeof buildGroundCover>; toLattice: (p: readonly [number, number]) => [number, number]; tc: { lat: number; lon: number } }>();
  const t0 = Date.now();
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const e = (px + 0.5 - W / 2) * mpp, n = (H / 2 - py - 0.5) * mpp;
    const ll = enuToLatLon(centre, e, n, 0);
    const tile = tileForLatLon(ll.lat, ll.lon, 14), key = `${tile.x}/${tile.y}`;
    // the fixture holds the junction's own tile: past it, nothing
    if (tile.x !== fx.tile.x || tile.y !== fx.tile.y) continue;
    let c = covers.get(key);
    if (!c) {
      c = { cover: buildGroundCover(tile, GRID, { lines: fx.lines, areas: [], points: [] }, undefined, false), toLattice: tileLattice(tile, GRID), tc: tileCenter(tile) };
      covers.set(key, c);
    }
    const [x, y] = c.toLattice([ll.lon, ll.lat]);
    let si = c.cover.locate(x, y);
    // the overlays (a junction's shoulders) over the ground and the covers junior to them, not over water
    if (si < 0 || COVER_RANK[c.cover.shapes[si].kind] > COVER_RANK.shoulder) {
      const ov = c.cover.shapes.findIndex((sh) => sh.overlay && inTris(sh.tris, x, y));
      if (ov >= 0 && (si < 0 || c.cover.shapes[si].kind !== 'water')) si = ov;
    }
    let col: [number, number, number] = [36, 52, 30];
    if (si >= 0) {
      const sh = c.cover.shapes[si];
      col = COL[sh.kind] ?? [50, 66, 42];
      if (sh.attr) {
        const [ee, nn] = latLonToEnu(c.tc, ll.lat, ll.lon, 0);
        const a = sh.attr.segs[sh.attr.segAt(x, y)]({ x: ee, z: -nn });
        if (a[2] < -1.5) {
          const p = paintAt(a[0], a[1], a[2], a[3], a[4], mpp);
          col = col.map((v) => v + (Math.min(v * 3, 235) - v) * p) as [number, number, number];
        }
      }
    }
    rgb.set(col.map(Math.round), (py * W + px) * 3);
  }
  if (withLines) {
    // cover outlines of the roads, red
    for (const c of covers.values()) for (const sh of c.cover.shapes) {
      if (sh.kind !== 'carriageway' && sh.kind !== 'shoulder') continue;
      const colr = sh.kind === 'carriageway' ? [230, 40, 40] : [240, 200, 60];
      for (const line of sh.outline) for (let k = 1; k < line.length; k++) {
        const steps = 200;
        for (let s = 0; s <= steps; s++) {
          const lx = line[k - 1][0] + (line[k][0] - line[k - 1][0]) * s / steps, ly = line[k - 1][1] + (line[k][1] - line[k - 1][1]) * s / steps;
          // lattice → pixel: invert by sampling the tile's lattice linearly round the centre
          const p = latticeToPixel(c, lx, ly);
          if (!p) continue;
          const [qx, qy] = p;
          if (qx >= 0 && qx < W && qy >= 0 && qy < H) rgb.set(colr, (qy * W + qx) * 3);
        }
      }
    }
  }
  png(`${outDir}/${name}${suffix}.png`, W, H, rgb);
  console.log(name, `${Date.now() - t0} ms`);

  function latticeToPixel(c: { toLattice: (p: readonly [number, number]) => [number, number] }, lx: number, ly: number): [number, number] | undefined {
    // the lattice is linear enough over a view: from three probes
    const probe = (e: number, n: number) => { const q = enuToLatLon(centre, e, n, 0); return c.toLattice([q.lon, q.lat]); };
    const o = probe(0, 0), ex = probe(1, 0), ny = probe(0, 1);
    const ax = ex[0] - o[0], ay = ex[1] - o[1], bx = ny[0] - o[0], by = ny[1] - o[1], det = ax * by - ay * bx;
    const dx = lx - o[0], dy = ly - o[1];
    const e = (dx * by - dy * bx) / det, n = (ax * dy - ay * dx) / det;
    return [Math.round(W / 2 + e / mpp - 0.5), Math.round(H / 2 - n / mpp - 0.5)];
  }
}
