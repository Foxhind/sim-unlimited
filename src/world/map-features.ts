import type { OverpassJson } from './overpass';

/** what the minimap marks: settlements by size, airfields by kind */
export type MapFeatureKind = 'city' | 'town' | 'village' | 'airport' | 'airfield' | 'heliport';

export interface MapFeature {
  kind: MapFeatureKind;
  lat: number;
  lon: number;
  /** local name and its translations (name:ru, name:en, ...), as tagged */
  names: Record<string, string>;
  /** ICAO (or IATA, local) code of an airfield */
  code?: string;
  /** the airfield has an ICAO code (the start-screen map shows only those) */
  icao?: boolean;
}

/**
 * Two levels of detail: 'local' for the flight map (spans up to LOCAL_MAX_SPAN_M) — villages, every
 * aerodrome and heliport; 'region' for the start-screen map — cities and towns, aerodromes with an ICAO code.
 */
export type MapLevel = 'local' | 'region';
/** map spans up to this use the local level */
export const LOCAL_MAX_SPAN_M = 80000;

export function mapLevelForSpan(spanM: number): MapLevel {
  return spanM <= LOCAL_MAX_SPAN_M ? 'local' : 'region';
}

/** what a level shows */
export function shownAt(f: MapFeature, level: MapLevel): boolean {
  if (level === 'local') return true;
  return f.kind === 'city' || f.kind === 'town' || ((f.kind === 'airport' || f.kind === 'airfield') && !!f.icao);
}

type Element = { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

function airfieldKind(tags: Record<string, string>): MapFeatureKind {
  if (tags.aeroway === 'heliport') return 'heliport';
  // an airport: an ICAO code and an international/public/regional or military role
  const role = tags['aerodrome:type'] ?? tags.aerodrome ?? '';
  if (tags.icao && (tags.iata || /international|public|regional|military/.test(role))) return 'airport';
  return 'airfield';
}

/** Overpass-shaped JSON (`<archive>.places.json`, tiles/SimProfile.java) → map features (ways at their centre) */
export function parseMapFeatures(json: OverpassJson): MapFeature[] {
  const out: MapFeature[] = [];
  for (const raw of json.elements as unknown as Element[]) {
    const tags = raw.tags ?? {};
    const lat = raw.lat ?? raw.center?.lat;
    const lon = raw.lon ?? raw.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) if (k === 'name' || k.startsWith('name:')) names[k] = v;
    let kind: MapFeatureKind | undefined;
    if (tags.aeroway === 'aerodrome' || tags.aeroway === 'heliport') kind = airfieldKind(tags);
    else if (tags.place === 'city' || tags.place === 'town' || tags.place === 'village') kind = tags.place;
    if (!kind) continue;
    const code = tags.icao || tags.iata || tags['local_ref'] || tags.ref;
    const field = kind !== 'city' && kind !== 'town' && kind !== 'village';
    out.push({ kind, lat, lon, names, ...(code && field ? { code } : {}), ...(field && tags.icao ? { icao: true } : {}) });
  }
  return out;
}

/** the label of a feature in the UI language: name:<lang>, then name:en, then the local name */
export function featureName(f: MapFeature, lang: string): string {
  const osmLang = lang === 'ua' ? 'uk' : lang;
  return f.names[`name:${osmLang}`] ?? f.names['name:en'] ?? f.names.name ?? '';
}

/** draw and label priority: lower first */
export const KIND_PRIORITY: Record<MapFeatureKind, number> = { city: 0, airport: 1, town: 2, airfield: 3, village: 4, heliport: 5 };

/** the box a map shows */
export interface MapBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** where the prepared names lie: the archives' `<base>.places.json` URLs whose bounds meet a box */
export type PlacesLocator = (box: MapBox) => Promise<string[]>;

/** after a failed fetch, a file is not asked for again for this long */
const RETRY_MS = 30000;

/**
 * Map features from the prepared `<archive>.places.json` files that come with our PMTiles archives
 * (tiles/SimProfile.java), one whole file per archive, kept in memory. No Overpass: outside every
 * archive the map has no names. Missing files are fetched in the background; `version` changes
 * whenever one arrives, so maps know to redraw.
 */
export class MapFeatureSource {
  version = 0;
  private files = new Map<string, MapFeature[]>();
  private loading = new Set<string>();
  private retryAt = new Map<string, number>();
  /** the URLs for the box asked last (the locator answers asynchronously) */
  private urls: string[] = [];
  private lastBox?: MapBox;
  private locating = false;

  constructor(
    private readonly locate: PlacesLocator,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** features of the files loaded so far inside `box` (missing files are fetched, not waited for) */
  features(box: MapBox, level: MapLevel, now = Date.now()): MapFeature[] {
    this.relocate(box);
    const out: MapFeature[] = [];
    for (const url of this.urls) {
      const hit = this.files.get(url);
      if (!hit) {
        this.load(url, now);
        continue;
      }
      for (const f of hit) {
        if (f.lat >= box.south && f.lat <= box.north && f.lon >= box.west && f.lon <= box.east && shownAt(f, level)) out.push(f);
      }
    }
    return out;
  }

  private relocate(box: MapBox): void {
    const b = this.lastBox;
    if (this.locating || (b && b.west === box.west && b.south === box.south && b.east === box.east && b.north === box.north)) return;
    this.locating = true;
    this.lastBox = box;
    this.locate(box)
      .then((urls) => {
        if (urls.join() !== this.urls.join()) {
          this.urls = urls;
          this.version++;
        }
      })
      .catch(() => {
        this.lastBox = undefined; // ask again on the next frame
      })
      .finally(() => {
        this.locating = false;
      });
  }

  private load(url: string, now: number): void {
    if (this.loading.has(url) || (this.retryAt.get(url) ?? 0) > now) return;
    this.loading.add(url);
    this.fetchImpl(url)
      .then(async (r) => {
        if (r.status === 404) {
          // an archive built before places.json existed: there is nothing to ask for again on this page
          this.retryAt.set(url, Infinity);
          return;
        }
        if (!r.ok) throw new Error(`map places ${url}: ${r.status}`);
        this.files.set(url, parseMapFeatures((await r.json()) as OverpassJson));
        this.retryAt.delete(url);
        this.version++;
      })
      .catch((err) => {
        console.warn('map places:', err);
        this.retryAt.set(url, Date.now() + RETRY_MS);
      })
      .finally(() => this.loading.delete(url));
  }
}
