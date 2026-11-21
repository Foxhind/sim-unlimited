/**
 * OpenStreetMap editing API 0.6 (`/api/0.6/map.json`) as a fallback OSM source for when Overpass
 * is unreachable. Its JSON has the same `elements` shape as Overpass, but it returns everything in
 * the bbox, so the Overpass filter statements are applied here, client-side, from the same text
 * (single source of truth for what the sim draws).
 *
 * Unlike Overpass, `map` returns a relation without its members outside the bbox, so a cut
 * multipolygon would come back as an open ring; selected relations missing members are completed
 * with `/relation/{id}/full` (or dropped when huge) before filtering.
 *
 * Limits of the API: a bbox of at most 0.25 square degrees and 50 000 nodes. Near ('full') z14
 * tiles fit, dense ones are split into quarters; far ('large') tiles do not, so they are not
 * served here. The API is meant for editing: this is a low-volume fallback (a handful of near
 * tiles, cached raw in IndexedDB), not a bulk source.
 */
import { RetryableError } from '../engine/queue';
import type { TileBounds } from './geodesy';
import type { OsmDetail } from './osm-types';
import { osmFilter, ROAD_SELECTOR, roadReachBounds, type OverpassJson, type RawNode, type RawRelation, type RawWay } from './overpass';

export const OSM_API = 'https://api.openstreetmap.org/api/0.6';
export const OSM_API_MAP = `${OSM_API}/map.json`;
/** a relation cut by the bbox is completed with /relation/{id}/full only up to this many members */
const MAX_RELATION_MEMBERS = 300;
/** quarter a bbox at most this many times when the API reports too many nodes */
const MAX_SPLIT_DEPTH = 2;

type Element = RawNode | RawWay | RawRelation;

interface Selector {
  type: Element['type'];
  /** every clause must hold: key present, key = value, or key ~ regex (unanchored, like Overpass) */
  clauses: Array<{ key: string; op?: '=' | '~'; value?: string; re?: RegExp }>;
}

/** `way["highway"~"motorway|trunk"]; relation["building"]["type"="multipolygon"];` → selectors */
export function parseFilter(text: string): Selector[] {
  const out: Selector[] = [];
  for (const m of text.matchAll(/(node|way|relation)((?:\[[^\]]*\])+)\s*;/g)) {
    const clauses: Selector['clauses'] = [];
    for (const c of m[2].matchAll(/\["([^"]+)"(?:(=|~)"([^"]*)")?\]/g)) {
      const op = c[2] as '=' | '~' | undefined;
      clauses.push({ key: c[1], op, value: c[3], re: op === '~' ? new RegExp(c[3]) : undefined });
    }
    out.push({ type: m[1] as Selector['type'], clauses });
  }
  return out;
}

function matches(el: Element, selectors: Selector[]): boolean {
  const tags = el.tags;
  if (!tags) return false;
  return selectors.some(
    (s) =>
      s.type === el.type &&
      s.clauses.every((c) => {
        const v = tags[c.key];
        if (v === undefined) return false;
        if (c.op === '=') return v === c.value;
        if (c.op === '~') return c.re!.test(v);
        return true;
      }),
  );
}

/**
 * Keep what the Overpass query `(filter); out body; >; out skel qt;` would return: matching
 * elements with their tags, plus the members and nodes they need for geometry, without tags.
 */
export function filterOsmApi(json: OverpassJson, detail: OsmDetail): OverpassJson {
  const selectors = parseFilter(osmFilter(detail));
  const ways = new Map<number, RawWay>();
  for (const el of json.elements) if (el.type === 'way') ways.set(el.id, el);
  const keepWay = new Map<number, boolean>(); // id → keep tags
  const keepNode = new Map<number, boolean>();
  const keepRel = new Set<number>();
  for (const el of json.elements) {
    if (!matches(el, selectors)) continue;
    if (el.type === 'node') keepNode.set(el.id, true);
    else if (el.type === 'way') keepWay.set(el.id, true);
    else {
      keepRel.add(el.id);
      for (const m of el.members) {
        if (m.type === 'way' && !keepWay.has(m.ref)) keepWay.set(m.ref, false);
        if (m.type === 'node' && !keepNode.has(m.ref)) keepNode.set(m.ref, false);
      }
    }
  }
  for (const [id, tagged] of keepWay) {
    // a member way that also matched on its own keeps its tags
    const w = ways.get(id);
    if (!w) continue;
    if (!tagged && matches(w, selectors)) keepWay.set(id, true);
    for (const n of w.nodes) if (!keepNode.has(n)) keepNode.set(n, false);
  }
  const skel = <T extends Element>(el: T, tagged: boolean): T => {
    if (tagged || !el.tags) return el;
    const copy = { ...el };
    delete copy.tags;
    return copy;
  };
  const elements: Element[] = [];
  for (const el of json.elements) {
    if (el.type === 'node' && keepNode.has(el.id)) elements.push(skel(el, keepNode.get(el.id)!));
    else if (el.type === 'way' && keepWay.has(el.id)) elements.push(skel(el, keepWay.get(el.id)!));
    else if (el.type === 'relation' && keepRel.has(el.id)) elements.push(el);
  }
  return { elements };
}

function quarters(b: TileBounds): TileBounds[] {
  const mx = (b.west + b.east) / 2, my = (b.south + b.north) / 2;
  return [
    { west: b.west, south: my, east: mx, north: b.north },
    { west: mx, south: my, east: b.east, north: b.north },
    { west: b.west, south: b.south, east: mx, north: my },
    { west: mx, south: b.south, east: b.east, north: my },
  ];
}

/**
 * The limit is per client IP, not per request: after a 429/509 every request to the API is
 * pointless until the penalty ends, so all of them wait on one shared deadline instead of each
 * tile finding out for itself (that is what turned one 509 into a burst of failed requests).
 */
let blockedUntil = 0;
/** for tests */
export function resetOsmApiCooldown(): void {
  blockedUntil = 0;
}

/** the penalty the API announces with 509 ("try again in 60 seconds") when Retry-After is unreadable */
const DEFAULT_LIMIT_MS = 60000;
const DEFAULT_DOWN_MS = 10000;

async function getJson(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const wait = blockedUntil - Date.now();
  if (wait > 0) throw new RetryableError(wait, 'osm api rate limited, waiting for Retry-After');
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new RetryableError(5000, `osm api unreachable: ${err instanceof Error ? err.message : err}`);
  }
}

const retryable = (status: number) => status === 429 || status === 509 || status >= 500;

/** Retry-After: delta-seconds or an HTTP date → ms from now; null when absent or malformed */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : null;
}

/**
 * Rate limited or down: wait for the server's Retry-After. Across origins the browser hides that
 * header unless the server lists it in Access-Control-Expose-Headers (api.openstreetmap.org does
 * not), so for 429/509 fall back to the 60 s the response body announces. Limits stop all requests.
 */
function retryLater(res: Response): RetryableError {
  const limited = res.status === 429 || res.status === 509;
  const ms = parseRetryAfter(res.headers.get('retry-after')) ?? (limited ? DEFAULT_LIMIT_MS : DEFAULT_DOWN_MS);
  if (limited) blockedUntil = Math.max(blockedUntil, Date.now() + ms);
  return new RetryableError(ms, `osm api ${res.status}`);
}

/**
 * Selected relations (multipolygons, buildings) that `map` cut at the bbox get their missing
 * members from `/relation/{id}/full`; a huge one, or one gone from the database, is dropped
 * instead of being drawn as a wrongly closed polygon.
 */
export async function completeRelations(json: OverpassJson, detail: OsmDetail, fetchImpl: typeof fetch = fetch): Promise<OverpassJson> {
  const selectors = parseFilter(osmFilter(detail));
  const have = new Set(json.elements.map((e) => `${e.type}/${e.id}`));
  const cut = json.elements.filter(
    (e): e is RawRelation => e.type === 'relation' && matches(e, selectors) && e.members.some((m) => m.type === 'way' && !have.has(`way/${m.ref}`)),
  );
  if (!cut.length) return json;
  const drop = new Set<number>();
  const extra: Element[] = [];
  for (const r of [...cut].sort((a, b) => a.id - b.id)) {
    if (r.members.length > MAX_RELATION_MEMBERS) {
      drop.add(r.id);
      continue;
    }
    const res = await getJson(`${OSM_API}/relation/${r.id}/full.json`, fetchImpl);
    if (retryable(res.status)) throw retryLater(res);
    if (!res.ok) {
      drop.add(r.id); // 404 / 410: deleted since
      continue;
    }
    for (const el of ((await res.json()) as OverpassJson).elements) {
      const k = `${el.type}/${el.id}`;
      if (have.has(k)) continue;
      have.add(k);
      extra.push(el);
    }
  }
  return { elements: [...json.elements.filter((e) => !(e.type === 'relation' && drop.has(e.id))), ...extra] };
}

/** a near tile from the API: map, completed relations, then the sim's filter */
export async function fetchOsmApiTile(b: TileBounds, detail: OsmDetail, fetchImpl: typeof fetch = fetch): Promise<OverpassJson> {
  const tile = filterOsmApi(await completeRelations(await fetchOsmApiMap(b, fetchImpl), detail, fetchImpl), detail);
  return detail === 'full' ? withRoadReach(tile, b, fetchImpl) : tile;
}

/** the four strips of ROAD_REACH_M round a tile (north and south full width, east and west between) */
function reachStrips(b: TileBounds): TileBounds[] {
  const r = roadReachBounds(b);
  return [
    { west: r.west, south: b.north, east: r.east, north: r.north },
    { west: r.west, south: r.south, east: r.east, north: b.south },
    { west: r.west, south: b.south, east: b.west, north: b.north },
    { west: b.east, south: b.south, east: r.east, north: b.north },
  ];
}

/**
 * The tile's elements plus the drawn roads with a node within ROAD_REACH_M round it (overpass
 * roadReachBounds): `map` of the strips round the tile, only their roads and those roads' nodes
 */
async function withRoadReach(tile: OverpassJson, b: TileBounds, fetchImpl: typeof fetch): Promise<OverpassJson> {
  const roads = parseFilter(`${ROAD_SELECTOR};`);
  const seen = new Set(tile.elements.map((el) => `${el.type}/${el.id}`));
  const elements = [...tile.elements];
  for (const strip of reachStrips(b)) {
    const raw = (await fetchOsmApiMap(strip, fetchImpl)).elements;
    const nodes = new Map<number, Element>();
    for (const el of raw) if (el.type === 'node') nodes.set(el.id, el);
    for (const el of raw) {
      if (el.type !== 'way' || !matches(el, roads) || seen.has(`way/${el.id}`)) continue;
      seen.add(`way/${el.id}`);
      elements.push(el);
      for (const id of el.nodes) {
        const n = nodes.get(id);
        if (!n || seen.has(`node/${id}`)) continue;
        seen.add(`node/${id}`);
        // only its position: a tagged node out here (an entrance, a mast) belongs to another tile
        elements.push({ type: 'node', id, lat: (n as RawNode).lat, lon: (n as RawNode).lon });
      }
    }
  }
  return { ...tile, elements };
}

/** raw `map.json` of a bbox; quarters it (sequentially) when the API reports too many nodes */
export async function fetchOsmApiMap(b: TileBounds, fetchImpl: typeof fetch = fetch, depth = 0): Promise<OverpassJson> {
  const bbox = [b.west, b.south, b.east, b.north].map((v) => v.toFixed(7)).join(',');
  const res = await getJson(`${OSM_API_MAP}?bbox=${bbox}`, fetchImpl);
  if (res.status === 400 && depth < MAX_SPLIT_DEPTH) {
    const text = await res.text();
    if (!/too many nodes/i.test(text)) throw new Error(`osm api 400: ${text.slice(0, 200)}`);
    const seen = new Set<string>();
    const elements: Element[] = [];
    for (const q of quarters(b)) {
      for (const el of (await fetchOsmApiMap(q, fetchImpl, depth + 1)).elements) {
        const k = `${el.type}/${el.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        elements.push(el);
      }
    }
    return { elements };
  }
  if (retryable(res.status)) throw retryLater(res);
  if (!res.ok) throw new Error(`osm api fetch failed: ${res.status}`);
  return (await res.json()) as OverpassJson;
}
