import { FontRenderer, HUD_AMBER, HUD_GREEN, HUD_WHITE } from '../engine/font';
import { VectorRenderer } from '../engine/vector';
import { RAMP, rampIndex } from '../engine/palette';
import { tileForLatLon, type LatLon, type Tile } from '../world/geodesy';
import { decodePngToSampler, fetchTerrariumPng, type HeightSampler } from '../world/terrain-source';
import {
  featureName, featureTiles, KIND_PRIORITY, mapLevelForSpan, MapFeatureSource, type MapFeature, type MapLevel,
} from '../world/map-features';
import { fetchOverpassQuery } from '../world/osm-source';
import { getOsmRaw, putOsmRaw } from '../world/tile-cache';

/** Q22: fixed reference airfields until the M6 global index. */
export const AIRFIELDS = [
  { icao: 'LTBS', name: 'DALAMAN', lat: 36.7131, lon: 28.7925, hdg: 15 },
  { icao: 'LOWI', name: 'INNSBRUCK', lat: 47.2603, lon: 11.3439, hdg: 260 },
] as const;

const N = 96; // map cells per side

/** settlements and airfields for every map, cached with the raw OSM in IndexedDB */
let sharedFeatures: MapFeatureSource | undefined;
function defaultFeatureSource(): MapFeatureSource {
  sharedFeatures ??= new MapFeatureSource(
    {
      get: async (key) => (await getOsmRaw(key))?.json,
      put: (key, json) => putOsmRaw({ key, ts: Date.now(), json }),
    },
    fetchOverpassQuery,
  );
  return sharedFeatures;
}

/** dark halo behind labels so they read over any terrain colour (overlay row: daylight HULL_DARK) */
const LABEL_SHADOW = rampIndex(RAMP.HULL_DARK, 0);
const MAX_LABEL_CHARS = 12;
/** a name is cut to fit, but not below this many characters (a shorter one is never cut) */
const MIN_LABEL_CHARS = 5;

interface Label {
  text: string;
  x: number;
  y: number;
  index: number;
}
const MAX_SAMPLERS = 24;
const MISSING = -99999;

/**
 * Q32: minimap — Terrarium z3–z8 heights quantized to the terrain palette, coastline from the
 * DEM water mask, settlements and airfields from OSM (map-features.ts), the reference airfields.
 */
export class Minimap {
  center: LatLon = { lat: 47.2603, lon: 11.3439 };
  spanM = 500000;
  private heights = new Float32Array(N * N).fill(MISSING);
  private colors = new Uint8Array(N * N);
  private dataVersion = 0;
  private sampledVersion = -1;
  private samplers = new Map<string, HeightSampler>();
  private pending = new Set<string>();
  private zoom = 5;
  private tiles: Tile[] = [];
  private dirty = true;
  private featureLevel: MapLevel = 'region';
  private featureTiles: Tile[] = [];
  /** UI language for place names */
  lang = 'en';

  constructor(private readonly features: MapFeatureSource = defaultFeatureSource()) {}

  setView(center: LatLon, spanM: number): void {
    if (Math.abs(center.lat - this.center.lat) < 1e-6 && Math.abs(center.lon - this.center.lon) < 1e-6 && spanM === this.spanM) return;
    this.center = center;
    this.spanM = spanM;
    this.dirty = true;
  }

  private layout(): void {
    const latRad = (this.center.lat * Math.PI) / 180;
    const worldM = 40075016 * Math.cos(latRad);
    this.zoom = Math.max(3, Math.min(8, Math.round(Math.log2((worldM * 2.5) / this.spanM))));
    const halfLat = this.spanM / 2 / 111320;
    const halfLon = halfLat / Math.max(0.2, Math.cos(latRad));
    const t0 = tileForLatLon(this.center.lat + halfLat, this.center.lon - halfLon, this.zoom);
    const t1 = tileForLatLon(this.center.lat - halfLat, this.center.lon + halfLon, this.zoom);
    this.tiles = [];
    for (let x = t0.x; x <= t1.x; x++) {
      for (let y = t0.y; y <= t1.y; y++) this.tiles.push({ z: this.zoom, x, y });
    }
    this.heights.fill(MISSING);
    this.sampledVersion = -1;
    for (const t of this.tiles) void this.load(t);
    this.featureLevel = mapLevelForSpan(this.spanM);
    this.featureTiles = featureTiles(this.center, halfLat, halfLon, this.featureLevel);
    this.dirty = false;
  }

  private async load(t: Tile): Promise<void> {
    const key = `${t.z}/${t.x}/${t.y}`;
    if (this.samplers.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    try {
      const png = await fetchTerrariumPng(t);
      const sampler = await decodePngToSampler(png, t);
      this.samplers.set(key, sampler);
      this.dataVersion++;
      if (this.samplers.size > MAX_SAMPLERS) {
        const oldest = this.samplers.keys().next().value!;
        this.samplers.delete(oldest);
      }
    } catch {
      // tile stays MISSING; retried on next view change
    } finally {
      this.pending.delete(key);
    }
  }

  private cellLatLon(col: number, row: number): LatLon {
    const latRad = (this.center.lat * Math.PI) / 180;
    const halfLat = this.spanM / 2 / 111320;
    const halfLon = halfLat / Math.max(0.2, Math.cos(latRad));
    return {
      lat: this.center.lat + halfLat - ((row + 0.5) / N) * halfLat * 2,
      lon: this.center.lon - halfLon + ((col + 0.5) / N) * halfLon * 2,
    };
  }

  private sample(): void {
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const ll = this.cellLatLon(col, row);
        const t = tileForLatLon(ll.lat, ll.lon, this.zoom);
        const s = this.samplers.get(`${t.z}/${t.x}/${t.y}`);
        this.heights[row * N + col] = s ? s(ll.lon, ll.lat) : MISSING;
      }
    }
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const h = this.heights[row * N + col];
        let shore = false;
        if (h <= 0 && h !== MISSING) {
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const c2 = col + dc, r2 = row + dr;
            if (c2 >= 0 && c2 < N && r2 >= 0 && r2 < N && this.heights[r2 * N + c2] > 0) { shore = true; break; }
          }
        }
        this.colors[row * N + col] = this.color(h, shore);
      }
    }
  }

  private color(h: number, shore: boolean): number {
    if (h === MISSING) return rampIndex(RAMP.SKY, 1);
    if (h <= 0) return rampIndex(RAMP.WATER, shore ? 11 : 7);
    if (h < 250) return rampIndex(RAMP.GRASS, 7);
    if (h < 800) return rampIndex(RAMP.FOREST, 8);
    if (h < 1800) return rampIndex(RAMP.ROCK, 6);
    if (h < 2600) return rampIndex(RAMP.ROCK, 9);
    return rampIndex(RAMP.SNOW, 10);
  }

  /** Returns the map rect so callers can hit-test clicks. */
  draw(vec: VectorRenderer, font: FontRenderer, x: number, y: number, size: number, u: number, marker?: LatLon, markerHdgDeg?: number): void {
    if (this.dirty) this.layout();
    if (this.sampledVersion !== this.dataVersion) {
      this.sample();
      this.sampledVersion = this.dataVersion;
    }
    const cell = size / N;
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        vec.fillRect(x + col * cell, y + row * cell, Math.ceil(cell), Math.ceil(cell), this.colors[row * N + col]);
      }
    }
    vec.rect(x, y, size, size, Math.max(1, u), HUD_GREEN);
    this.drawFeatures(vec, font, x, y, size, u);
    if (marker) {
      const p = this.project(marker, x, y, size);
      if (p) {
        // north-up map: the triangle's nose points along the heading when one is given
        const a = ((markerHdgDeg ?? 0) * Math.PI) / 180;
        const pt = (fwd: number, side: number): [number, number] =>
          [p[0] + Math.sin(a) * fwd + Math.cos(a) * side, p[1] - Math.cos(a) * fwd + Math.sin(a) * side];
        vec.polyline([pt(6 * u, 0), pt(-4 * u, 4 * u), pt(-4 * u, -4 * u)], Math.max(1, u), markerHdgDeg === undefined ? HUD_GREEN : HUD_WHITE, true);
      }
    }
  }

  /**
   * Settlements (white: city a big square, town a small one, village a dot) and airfields (amber:
   * airport a ring with a runway, airfield a ring, heliport an H), plus the reference airfields.
   * Labels go right of the symbol (left near the edge), most important first, never overlapping.
   */
  private drawFeatures(vec: VectorRenderer, font: FontRenderer, x: number, y: number, size: number, u: number): void {
    const feats: MapFeature[] = this.features.features(this.featureTiles, this.featureLevel)
      .slice()
      .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
    const refCodes = new Set<string>(AIRFIELDS.map((a) => a.icao));
    /** occupied boxes: labels block every later label, a symbol only labels no more important than it */
    const taken: Array<{ box: [number, number, number, number]; prio: number }> = [];
    const labels: Label[] = [];
    const glyph = 8 * u, lineH = 16 * u;
    const place = (text: string, px: number, py: number, r: number, index: number, prio: number): void => {
      if (!text) return;
      const ty = Math.round(py - lineH / 2);
      if (ty < y + u || ty + lineH > y + size - u) return;
      // right of the symbol, else left of it; a long name is cut to the room on that side
      const right = px + r + 2 * u, left = px - r - 2 * u;
      for (const side of ['right', 'left'] as const) {
        const room = side === 'right' ? x + size - u - right : left - (x + u);
        const n = Math.min(text.length, MAX_LABEL_CHARS, Math.floor(room / glyph));
        if (n < Math.min(text.length, MIN_LABEL_CHARS)) continue;
        const t = n < text.length ? text.slice(0, n - 1) + '.' : text;
        const w = t.length * glyph;
        const lx = side === 'right' ? right : left - w;
        const box: [number, number, number, number] = [lx - u, ty, lx + w + u, ty + lineH];
        if (taken.some((o) => o.prio <= prio && box[0] < o.box[2] && box[2] > o.box[0] && box[1] < o.box[3] && box[3] > o.box[1])) continue;
        taken.push({ box, prio: -1 });
        labels.push({ text: t, x: lx, y: ty, index });
        return;
      }
    };

    // symbols first; each reserves its own box so labels do not cover other symbols
    const marks: Array<{ p: [number, number]; r: number; label: string; index: number; prio: number }> = [];
    for (const af of AIRFIELDS) {
      const p = this.project(af, x, y, size);
      if (!p) continue;
      vec.fillRect(p[0] - 2 * u, p[1] - 2 * u, 4 * u, 4 * u, HUD_AMBER);
      taken.push({ box: [p[0] - 2 * u, p[1] - 2 * u, p[0] + 2 * u, p[1] + 2 * u], prio: KIND_PRIORITY.airport });
      marks.push({ p, r: 2 * u, label: af.icao, index: HUD_AMBER, prio: KIND_PRIORITY.airport });
    }
    const seen = new Set<string>();
    for (const f of feats) {
      if (f.code && refCodes.has(f.code)) continue;
      // an airfield crossing a tile border comes with both tiles
      const id = `${f.kind}|${f.code ?? f.names.name ?? ''}|${f.lat.toFixed(3)}|${f.lon.toFixed(3)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = this.project(f, x, y, size);
      if (!p) continue;
      const [px, py] = p;
      let r = u;
      let index = HUD_WHITE;
      let label = featureName(f, this.lang).toUpperCase();
      switch (f.kind) {
        case 'city':
          r = 3 * u;
          vec.fillRect(px - r, py - r, 2 * r, 2 * r, HUD_WHITE);
          break;
        case 'town':
          r = 2 * u;
          vec.fillRect(px - r, py - r, 2 * r, 2 * r, HUD_WHITE);
          break;
        case 'village':
          r = u;
          vec.fillRect(px - u, py - u, 2 * u, 2 * u, HUD_WHITE);
          break;
        case 'airport':
          r = 4 * u;
          index = HUD_AMBER;
          vec.circle(px, py, r, Math.max(1, u), HUD_AMBER, 12);
          vec.line(px - r, py + r * 0.5, px + r, py - r * 0.5, Math.max(1, u), HUD_AMBER);
          label = f.code ?? label;
          break;
        case 'airfield':
          r = 3 * u;
          index = HUD_AMBER;
          vec.circle(px, py, r, Math.max(1, u), HUD_AMBER, 10);
          label = f.code ?? label;
          break;
        case 'heliport':
          r = 2 * u;
          index = HUD_AMBER;
          vec.line(px - r, py - r, px - r, py + r, Math.max(1, u), HUD_AMBER);
          vec.line(px + r, py - r, px + r, py + r, Math.max(1, u), HUD_AMBER);
          vec.line(px - r, py, px + r, py, Math.max(1, u), HUD_AMBER);
          label = '';
          break;
      }
      const prio = KIND_PRIORITY[f.kind];
      taken.push({ box: [px - r, py - r, px + r, py + r], prio });
      marks.push({ p, r, label, index, prio });
    }
    for (const m of marks) place(m.label, m.p[0], m.p[1], m.r, m.index, m.prio);

    // the map and symbols must be under the labels: flush them, then halo, then text by colour
    vec.flush();
    for (const l of labels) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) font.text(l.text, l.x + dx * u, l.y + dy * u, u, LABEL_SHADOW);
    }
    for (const index of [HUD_WHITE, HUD_AMBER]) {
      for (const l of labels) if (l.index === index) font.text(l.text, l.x, l.y, u, index);
    }
    font.flush();
  }

  private project(ll: LatLon, x: number, y: number, size: number): [number, number] | null {
    const latRad = (this.center.lat * Math.PI) / 180;
    const halfLat = this.spanM / 2 / 111320;
    const halfLon = halfLat / Math.max(0.2, Math.cos(latRad));
    const fx = (ll.lon - (this.center.lon - halfLon)) / (halfLon * 2);
    const fy = ((this.center.lat + halfLat) - ll.lat) / (halfLat * 2);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return [x + fx * size, y + fy * size];
  }

  /** In-flight use: keep the view still until the aircraft drifts off-centre, so tiles aren't resampled every frame. */
  follow(pos: LatLon, spanM: number): void {
    const latRad = (this.center.lat * Math.PI) / 180;
    const dN = (pos.lat - this.center.lat) * 111320;
    const dE = (pos.lon - this.center.lon) * 111320 * Math.cos(latRad);
    if (spanM !== this.spanM || Math.hypot(dN, dE) > spanM * 0.2) this.setView(pos, spanM);
  }

  /** Q29: click the map to pick an arbitrary start point. */
  pick(px: number, py: number, x: number, y: number, size: number): LatLon | null {
    const fx = (px - x) / size;
    const fy = (py - y) / size;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    const latRad = (this.center.lat * Math.PI) / 180;
    const halfLat = this.spanM / 2 / 111320;
    const halfLon = halfLat / Math.max(0.2, Math.cos(latRad));
    return {
      lat: this.center.lat + halfLat - fy * halfLat * 2,
      lon: this.center.lon - halfLon + fx * halfLon * 2,
    };
  }
}