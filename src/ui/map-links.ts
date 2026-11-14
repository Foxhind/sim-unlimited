/**
 * Coordinates out of a pasted map link (Google Maps, Apple Maps, Yandex Maps, OpenStreetMap),
 * a geo: URI, a bare "lat, lon" pair or a link of this project (simulator, relief inspector, tile
 * inspector). Pure; no network. Only links that carry coordinates themselves are supported;
 * short links (maps.app.goo.gl, yandex.ru/maps/-/…) are not.
 */
import { tileCenter, type Tile } from '../world/geodesy';

export interface MapPoint {
  lat: number;
  lon: number;
  /** web-map zoom level when the link has one */
  zoom?: number;
  source: 'google' | 'apple' | 'yandex' | 'osm' | 'geo' | 'coords' | 'project';
  /** project links: altitude of the aircraft (simulator) or of the simulator camera (relief inspector), metres */
  alt?: number;
  /** relief inspector links: ground width of the view, metres */
  spanM?: number;
  /** tile inspector links: the tile itself (lat/lon is its centre, zoom its z) */
  tile?: Tile;
}

const NUM = String.raw`[-+]?\d+(?:\.\d+)?`;
const EARTH_CIRCUMFERENCE = 40075016.686;

function valid(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** "a,b" (also "a, b", "a,+b", "a b") → two numbers */
function pair(s: string | null | undefined): [number, number] | null {
  if (!s) return null;
  const m = new RegExp(`^\\s*(${NUM})\\s*(?:,|\\s)\\s*\\+?(${NUM})`).exec(s.replace(/\+/g, ' '));
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

function point(lat: number, lon: number, source: MapPoint['source'], zoom?: number): MapPoint | null {
  if (!valid(lat, lon)) return null;
  const p: MapPoint = { lat, lon, source };
  if (zoom !== undefined && Number.isFinite(zoom)) p.zoom = zoom;
  return p;
}

const zoomParam = (q: URLSearchParams, ...names: string[]): number | undefined => {
  for (const n of names) {
    const v = parseFloat(q.get(n) ?? '');
    if (Number.isFinite(v)) return v;
  }
  return undefined;
};

function google(url: URL): MapPoint | null {
  const href = decodeURIComponent(url.href);
  // viewport: /@lat,lon,15z or /@lat,lon,1234m (3D view: metres of view height)
  const at = new RegExp(`@(${NUM}),(${NUM})(?:,(${NUM})([zm]))?`).exec(href);
  let zoom: number | undefined;
  if (at?.[3]) {
    const v = parseFloat(at[3]);
    zoom = at[4] === 'z' ? v : Math.log2((EARTH_CIRCUMFERENCE * Math.cos((parseFloat(at[1]) * Math.PI) / 180)) / Math.max(1, v));
  }
  zoom ??= zoomParam(url.searchParams, 'z', 'zoom');
  // a dropped pin / place: !3dLAT!4dLON — the point itself, preferred over the viewport centre
  const pin = new RegExp(`!3d(${NUM})!4d(${NUM})`).exec(href);
  if (pin) return point(parseFloat(pin[1]), parseFloat(pin[2]), 'google', zoom);
  for (const name of ['q', 'query', 'll', 'center', 'destination', 'daddr', 'viewpoint']) {
    const p = pair(url.searchParams.get(name));
    if (p) return point(p[0], p[1], 'google', zoom);
  }
  const path = new RegExp(`/(?:search|place|dir)/(?:[^/]*/)*?(${NUM}),\\s*\\+?(${NUM})`).exec(decodeURIComponent(url.pathname));
  if (path) return point(parseFloat(path[1]), parseFloat(path[2]), 'google', zoom);
  if (at) return point(parseFloat(at[1]), parseFloat(at[2]), 'google', zoom);
  return null;
}

function apple(url: URL): MapPoint | null {
  const q = url.searchParams;
  let zoom = zoomParam(q, 'z');
  const span = pair(q.get('spn') ?? q.get('span'));
  if (zoom === undefined && span && span[0] > 0) zoom = Math.log2(180 / span[0]);
  for (const name of ['coordinate', 'll', 'q', 'daddr', 'center', 'sll', 'saddr']) {
    const p = pair(q.get(name));
    if (p) return point(p[0], p[1], 'apple', zoom);
  }
  return null;
}

function yandex(url: URL): MapPoint | null {
  const q = url.searchParams;
  const zoom = zoomParam(q, 'whatshere[zoom]', 'z');
  // Yandex writes lon,lat. pt may hold several points ("lon,lat,style~lon,lat"): take the first.
  for (const name of ['whatshere[point]', 'pt', 'rtext', 'll']) {
    const raw = q.get(name);
    if (!raw) continue;
    const first = name === 'rtext' ? raw.split('~').pop()! : raw.split('~')[0];
    const p = pair(first);
    if (!p) continue;
    return name === 'rtext' ? point(p[0], p[1], 'yandex', zoom) : point(p[1], p[0], 'yandex', zoom); // rtext is lat,lon
  }
  return null;
}

function osm(url: URL): MapPoint | null {
  const q = url.searchParams;
  const map = new RegExp(`map=(${NUM})/(${NUM})/(${NUM})`).exec(url.hash);
  const zoom = map ? parseFloat(map[1]) : zoomParam(q, 'zoom');
  const mlat = parseFloat(q.get('mlat') ?? ''), mlon = parseFloat(q.get('mlon') ?? '');
  if (valid(mlat, mlon)) return point(mlat, mlon, 'osm', zoom);
  if (map) return point(parseFloat(map[2]), parseFloat(map[3]), 'osm', zoom);
  const lat = parseFloat(q.get('lat') ?? ''), lon = parseFloat(q.get('lon') ?? '');
  return valid(lat, lon) ? point(lat, lon, 'osm', zoom) : null;
}

// country domains only (google.at, google.co.uk, google.com.tr), never google.com.evil.example
const GOOGLE = /(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const YANDEX = /(^|\.)(yandex\.(com|[a-z]{2}|com\.[a-z]{2})|ya\.ru)$/;
const isGoogle = (h: string, p: string) => GOOGLE.test(h) && (h.startsWith('maps.') || p.startsWith('/maps'));
const isApple = (h: string) => h === 'maps.apple.com' || h === 'maps.apple';
const isYandex = (h: string, p: string) => YANDEX.test(h) && (h.startsWith('maps.') || p.startsWith('/maps') || p.startsWith('/web-maps'));
const isOsm = (h: string) => /(^|\.)(openstreetmap\.(org|ru|de|fr)|osm\.org)$/.test(h);

/** human name of a link's source (inspector and game menu) */
export const MAP_SOURCE_NAME: Record<MapPoint['source'], string> = {
  google: 'Google Maps', apple: 'Apple Maps', yandex: 'Yandex Maps', osm: 'OpenStreetMap', geo: 'geo:', coords: 'lat, lon',
  project: 'sim-unlimited',
};

/** the relief inspector opens a tile with a view this many tiles wide (and a view maps back to that zoom) */
export const RELIEF_TILES_ACROSS = 3;

/**
 * Links of this project, on whatever host it runs. The page is told by the path:
 *   /            #lat,lon[,alt[,hdg[,aircraft[,time]]]]   simulator
 *   /relief      #lat,lon[,span km[,camera alt]]  or  #z/x/y
 *   /inspector   #z/x/y
 * (with or without .html). Any other path is not ours.
 */
function project(url: URL): MapPoint | null {
  const m = /(?:^|\/)(?:(relief|inspector)(?:\.html)?|(index\.html)?)$/.exec(url.pathname);
  if (!m) return null;
  const page = m[1] ?? 'sim';
  const hash = url.hash.slice(1);
  const t = /^(\d{1,2})\/(\d+)\/(\d+)$/.exec(hash);
  if (t) {
    if (page === 'sim') return null;
    const tile = { z: +t[1], x: +t[2], y: +t[3] };
    if (tile.z > 22 || tile.x >= 2 ** tile.z || tile.y >= 2 ** tile.z) return null;
    const c = tileCenter(tile);
    const p = point(c.lat, c.lon, 'project', tile.z);
    return p && { ...p, tile };
  }
  if (page === 'inspector') return null;
  const parts = hash.split(',');
  if (parts.length < 2 || !new RegExp(`^${NUM}$`).test(parts[0]) || !new RegExp(`^${NUM}$`).test(parts[1])) return null;
  const p = point(parseFloat(parts[0]), parseFloat(parts[1]), 'project');
  if (!p) return null;
  const num = (k: number) => (parts[k] !== undefined && new RegExp(`^${NUM}$`).test(parts[k]) ? parseFloat(parts[k]) : undefined);
  if (page === 'relief') {
    const spanKm = num(2), alt = num(3);
    if (spanKm !== undefined && spanKm > 0) {
      p.spanM = spanKm * 1000;
      p.zoom = Math.log2((EARTH_CIRCUMFERENCE * Math.cos((p.lat * Math.PI) / 180) * RELIEF_TILES_ACROSS) / p.spanM);
    }
    if (alt !== undefined && alt >= 0) p.alt = alt;
  } else {
    const alt = num(2);
    if (alt !== undefined && alt >= 0) p.alt = alt;
  }
  return p;
}

export function parseMapLink(text: string): MapPoint | null {
  const s = text.trim();
  const geo = new RegExp(`^geo:(${NUM}),(${NUM})(?:[^?]*\\?(.*))?$`, 'i').exec(s);
  if (geo) {
    const z = geo[3] ? zoomParam(new URLSearchParams(geo[3]), 'z') : undefined;
    return point(parseFloat(geo[1]), parseFloat(geo[2]), 'geo', z);
  }
  const bare = new RegExp(`^(${NUM})°?\\s*[,;\\s]\\s*(${NUM})°?$`).exec(s);
  if (bare) return point(parseFloat(bare[1]), parseFloat(bare[2]), 'coords');
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const h = url.hostname.toLowerCase(), p = url.pathname;
  // Google's EU consent wall wraps the real link
  if (h.startsWith('consent.') && GOOGLE.test(h) && url.searchParams.get('continue')) return parseMapLink(url.searchParams.get('continue')!);
  if (isGoogle(h, p)) return google(url);
  if (isApple(h)) return apple(url);
  if (isYandex(h, p)) return yandex(url);
  if (isOsm(h)) return osm(url);
  // only what was pasted as a link: a bare "host/…" guess is not enough to call a page ours
  if (/^https?:\/\//i.test(s)) return project(url);
  return null;
}
