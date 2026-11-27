/**
 * Finding a start point by name: OpenStreetMap's Nominatim (https://nominatim.org). Its usage policy
 * (operations.osmfoundation.org/policies/nominatim) allows no autocomplete and at most one request a
 * second: a search runs on Enter or the search button only, and one asked sooner after the last
 * waits its turn. The browser's Referer identifies the application. A pasted map link or a
 * "lat, lon" pair is read here, with no request (map-links).
 */
import { parseMapLink } from './map-links';

export interface Place {
  /** the place's name, and where it is (region, country): as Nominatim names them in the asked language */
  name: string;
  where: string;
  lat: number;
  lon: number;
}

export const NOMINATIM = {
  URL: 'https://nominatim.openstreetmap.org/search',
  /** results asked for */
  LIMIT: 6,
  /** the least time between two requests, ms (the usage policy's one a second) */
  GAP_MS: 1100,
} as const;

interface NominatimHit {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
}

/**
 * A Nominatim hit as a Place, in capitals as the HUD writes: its own name, and the rest of its display
 * name as where it is (the last three parts, postcodes left out)
 */
export function placeOf(hit: NominatimHit): Place | null {
  const lat = parseFloat(hit.lat), lon = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const parts = (hit.display_name ?? '').split(',').map((s) => s.trim()).filter((s) => s && !/^\d[\d -]*$/.test(s));
  const name = hit.name?.trim() || parts[0] || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  const rest = parts[0] === name ? parts.slice(1) : parts;
  return { name: name.toUpperCase(), where: rest.slice(-3).join(', ').toUpperCase(), lat, lon };
}

/** the places with the same name and place as one before them left out (a city and its district of one name) */
export function distinctPlaces(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter((p) => { const k = `${p.name}|${p.where}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export class Geocoder {
  private last = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    private now: () => number = () => Date.now(),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * The places a query names: a map link or coordinates as one place at once; else Nominatim's
   * answer in `lang`, no sooner than GAP_MS after the request before. Throws when it fails.
   */
  search(query: string, lang: string): Promise<Place[]> {
    const q = query.trim();
    if (!q) return Promise.resolve([]);
    const p = parseMapLink(q);
    if (p) return Promise.resolve([{ name: `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, where: '', lat: p.lat, lon: p.lon }]);
    const run = this.queue.then(async () => {
      const wait = this.last + NOMINATIM.GAP_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      const url = `${NOMINATIM.URL}?${new URLSearchParams({ q, format: 'jsonv2', limit: String(NOMINATIM.LIMIT), 'accept-language': lang })}`;
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const hits = (await res.json()) as NominatimHit[];
      return distinctPlaces(hits.map(placeOf).filter((x): x is Place => x !== null));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
