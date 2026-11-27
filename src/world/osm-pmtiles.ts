/**
 * The sim's own OSM tiles (M6 prototype, tiles/SimProfile.java) as Overpass-shaped JSON, so the raw
 * OSM cache and every reader of it (parseOverpass) stay as they are.
 *
 * A z14 tile has three layers with the raw OSM tags of the Overpass FULL_FILTER selection: `areas`
 * (polygons: buildings, land cover, water, aeroway surfaces), `lines`, `points`. Aerodrome outlines
 * and runway centrelines come whole from `<archive>.aerodromes.json` instead, as Overpass hands
 * them over whole (and from AERODROME_REACH_DEG around the tile, see overpass.ts).
 */
import { tileBounds, type Tile, type TileBounds } from './geodesy';
import { decodeMvt, ringArea, type MvtLayer } from './mvt';
import { AERODROME_REACH_DEG, type OverpassJson, type RawNode, type RawRelation, type RawWay } from './overpass';
import { httpRange, Pmtiles } from './pmtiles';
import type { LonLat } from './osm-types';

export interface AerodromeIndex {
  aerodromes: { tags: Record<string, string>; rings: LonLat[][] }[];
  runways: { tags: Record<string, string>; points: LonLat[] }[];
}

const LAYERS = new Set(['areas', 'lines', 'points']);

/** builds Overpass elements with fresh negative ids */
class Elements {
  readonly elements: (RawNode | RawWay | RawRelation)[] = [];
  private id = 0;

  private node(p: LonLat, tags?: Record<string, string>): number {
    const id = --this.id;
    this.elements.push(tags ? { type: 'node', id, lon: p[0], lat: p[1], tags } : { type: 'node', id, lon: p[0], lat: p[1] });
    return id;
  }

  point(p: LonLat, tags: Record<string, string>): void {
    this.node(p, tags);
  }

  way(points: LonLat[], tags?: Record<string, string>): number {
    const closed = points.length > 3 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
    const ids = (closed ? points.slice(0, -1) : points).map((p) => this.node(p));
    if (closed) ids.push(ids[0]);
    const id = --this.id;
    this.elements.push(tags ? { type: 'way', id, nodes: ids, tags } : { type: 'way', id, nodes: ids });
    return id;
  }

  /** [outer, ...holes]: a closed way when it has no holes, else a multipolygon relation */
  polygon(rings: LonLat[][], tags: Record<string, string>): void {
    if (rings.length === 1) {
      this.way(rings[0], tags);
      return;
    }
    const members = rings.map((r, i) => ({ type: 'way', ref: this.way(r), role: i === 0 ? 'outer' : 'inner' }));
    this.elements.push({ type: 'relation', id: --this.id, members, tags: { ...tags, type: 'multipolygon' } });
  }
}

/** tile units (0..extent, y down) → lon, lat, rounded as Overpass rounds (1e-7°) */
function toLonLat(tile: Tile, extent: number): (p: [number, number]) => LonLat {
  const n = 2 ** tile.z;
  const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
  return ([px, py]) => {
    const x = (tile.x + px / extent) / n;
    const y = (tile.y + py / extent) / n;
    return [r7(x * 360 - 180), r7((Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI)];
  };
}

const strTags = (props: Record<string, string | number | boolean>): Record<string, string> =>
  Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)]));

function addLayers(out: Elements, layers: MvtLayer[], tile: Tile): void {
  for (const layer of layers) {
    const ll = toLonLat(tile, layer.extent);
    for (const f of layer.features) {
      const tags = strTags(f.props);
      if (layer.name === 'points' && f.type === 1) {
        for (const part of f.parts) for (const p of part) out.point(ll(p), tags);
      } else if (layer.name === 'lines' && f.type === 2) {
        for (const part of f.parts) if (part.length >= 2) out.way(part.map(ll), tags);
      } else if (layer.name === 'areas' && f.type === 3) {
        // MVT 2.1: an exterior ring (area > 0 in tile units, y down) and then its holes
        let poly: LonLat[][] | undefined;
        for (const ring of f.parts) {
          if (ring.length < 4) continue;
          if (ringArea(ring) > 0) {
            if (poly) out.polygon(poly, tags);
            poly = [ring.map(ll)];
          } else poly?.push(ring.map(ll));
        }
        if (poly) out.polygon(poly, tags);
      }
    }
  }
}

function bboxOf(pts: LonLat[]): TileBounds {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [lon, lat] of pts) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return { west, east, south, north };
}

const meets = (a: TileBounds, b: TileBounds) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** the window overpassQuery asks aerodrome outlines from */
function aerodromeWindow(b: TileBounds): TileBounds {
  const dLat = AERODROME_REACH_DEG;
  const dLon = AERODROME_REACH_DEG / Math.max(0.1, Math.cos((((b.north + b.south) / 2) * Math.PI) / 180));
  return { west: b.west - dLon, east: b.east + dLon, south: b.south - dLat, north: b.north + dLat };
}

function addAerodromes(out: Elements, index: AerodromeIndex, tile: Tile): void {
  const b = tileBounds(tile);
  const wide = aerodromeWindow(b);
  for (const a of index.aerodromes) if (a.rings[0]?.length && meets(bboxOf(a.rings[0]), wide)) out.polygon(a.rings, a.tags);
  for (const r of index.runways) if (r.points.length >= 2 && meets(bboxOf(r.points), b)) out.way(r.points, r.tags);
}

/** a decompressed z14 tile (or none) + the aerodrome index → Overpass-shaped JSON */
export function pmtilesToOverpass(mvt: Uint8Array | undefined, tile: Tile, index: AerodromeIndex): OverpassJson {
  const out = new Elements();
  if (mvt) addLayers(out, decodeMvt(mvt, LAYERS), tile);
  addAerodromes(out, index, tile);
  return { elements: out.elements };
}

/** the manifest tiles/build.sh writes: the archives' URLs, relative to it (under the site's base path) */
const DEFAULT_MANIFEST = `${import.meta.env?.BASE_URL ?? '/'}tiles/index.json`;

/**
 * VITE_PMTILES_URL: archive URLs, comma-separated, or (default) a manifest .json listing them.
 * Each archive serves the tiles within its bounds; a regional build is one archive per extract.
 */
export function pmtilesSetting(): string {
  return (import.meta.env?.VITE_PMTILES_URL as string | undefined) || DEFAULT_MANIFEST;
}

/** how long a failed opening of the archives stands before a tile asks again */
const OPEN_RETRY_MS = 15000;

interface Archive {
  url: string;
  tiles: Pmtiles;
  index?: Promise<AerodromeIndex>;
}

/** our archives and their aerodrome indexes, shared by every tile of a worker */
export class PmtilesOsm {
  private archives?: Promise<{ archive: Archive; bounds: TileBounds }[]>;
  /** after the manifest or every archive failed: until then each tile fails with the same error, unasked */
  private failedUntil = 0;
  private failure?: unknown;

  constructor(private readonly setting = pmtilesSetting(), private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private async urls(): Promise<string[]> {
    if (!/\.json($|\?)/.test(this.setting)) return this.setting.split(',').map((u) => u.trim()).filter(Boolean);
    const res = await this.fetchImpl(this.setting);
    if (!res.ok) throw new Error(`pmtiles manifest ${this.setting}: ${res.status}`);
    const base = new URL(this.setting, globalThis.location?.href ?? 'http://localhost/');
    return ((await res.json()) as string[]).map((u) => new URL(u, base).href);
  }

  /**
   * Each archive opens on its own: one the manifest lists but the bucket lacks (404) is left out for
   * this page and the rest serve. Only when none opens does it fail; the next tile tries again after
   * OPEN_RETRY_MS, not at once (every tile of every worker asked anew, hundreds of requests a second).
   */
  private open() {
    if (!this.archives && Date.now() < this.failedUntil) return Promise.reject(this.failure);
    this.archives ??= this.urls()
      .then(async (urls) => {
        const opened = await Promise.allSettled(urls.map(async (url) => {
          const archive: Archive = { url, tiles: new Pmtiles(httpRange(url, this.fetchImpl)) };
          return { archive, bounds: (await archive.tiles.header()).bounds };
        }));
        const failed = opened.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        const ok = opened.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));
        if (urls.length && !ok.length) throw failed[0].reason;
        for (const f of failed) console.warn('pmtiles: archive left out:', f.reason);
        return ok;
      })
      .catch((err) => {
        this.archives = undefined;
        this.failure = err;
        this.failedUntil = Date.now() + OPEN_RETRY_MS;
        throw err;
      });
    return this.archives;
  }

  private aerodromes(a: Archive): Promise<AerodromeIndex> {
    a.index ??= this.fetchImpl(a.url.replace(/\.pmtiles$/, '') + '.aerodromes.json')
      .then((r) => {
        if (!r.ok) throw new Error(`aerodrome index ${r.status}`);
        return r.json() as Promise<AerodromeIndex>;
      })
      .catch((err) => {
        a.index = undefined;
        throw err;
      });
    return a.index;
  }

  /** Overpass-shaped JSON of a z14 tile, or null outside every archive (nothing to cache) */
  /**
   * The build of our archives: each one's URL and where its header puts its directories and tiles,
   * which a rebuild moves. Raw tiles cached from another build are stale (tile-cache getOsmRaw).
   */
  async stamp(): Promise<string> {
    const archives = await this.open();
    const parts = await Promise.all(archives.map(async ({ archive }) => {
      const h = await archive.tiles.header();
      return `${archive.url}:${h.rootOffset}:${h.rootLength}:${h.leafOffset}:${h.tileDataOffset}`;
    }));
    return parts.join('|');
  }

  /** the map's prepared names (`<archive>.places.json`, tiles/SimProfile.java) of the archives that meet a box */
  async placesUrls(box: TileBounds): Promise<string[]> {
    const archives = await this.open();
    return archives.filter((a) => meets(box, a.bounds)).map((a) => a.archive.url.replace(/\.pmtiles$/, '') + '.places.json');
  }

  async fetchJson(tile: Tile): Promise<string | null> {
    const archives = await this.open();
    const b = tileBounds(tile);
    const own = archives.filter((a) => meets(b, a.bounds));
    if (!own.length) return null;
    // the first archive that has the tile serves it; aerodromes come from every archive within reach
    let mvt: Uint8Array | undefined;
    for (const a of own) if ((mvt = await a.archive.tiles.tile(tile.z, tile.x, tile.y))) break;
    const wide = aerodromeWindow(b);
    const indexes = await Promise.all(archives.filter((a) => meets(wide, a.bounds)).map((a) => this.aerodromes(a.archive)));
    const index: AerodromeIndex = { aerodromes: indexes.flatMap((i) => i.aerodromes), runways: indexes.flatMap((i) => i.runways) };
    return JSON.stringify(pmtilesToOverpass(mvt, tile, index));
  }
}
