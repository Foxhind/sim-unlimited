import { vec3 } from 'gl-matrix';
import { enuToLatLon, latLonToEnu, tileCenter, tileForLatLon, tileKey, type LatLon } from './geodesy';
import { decodePngToSampler, loadTileDem, fetchTerrariumPng, type HeightSampler } from './terrain-source';
import { buildTerrainTin, tinSampler } from './terrain-tin';
import { loadLandsatTerrain } from './landsat-process';
import { flattenRunways } from './runway';
import { gridForZoom } from './chunks';
import { getOsmRaw } from './tile-cache';
import { OSM_SCHEMA_VERSION } from './osm-source';
import { parseOverpass } from './overpass';
import { buildingHeights } from './building-mesher';
import type { GroundContact } from '../flight/model';

interface Prism {
  lat: number;
  lon: number;
  /** footprint rings in local meters [x=east, z=-north] relative to (lat, lon) */
  rings: [number, number][][];
  base: number;
  top: number;
  boundR: number;
}

function pointInRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Collision ground truth on the main thread: bilinear DEM samples (Q13 water
 * mask) plus S3DB prisms from cached raw OSM. Tiles stream in around the jet.
 */
export class GroundProbe {
  private samplers = new Map<string, HeightSampler>();
  private prisms = new Map<string, Prism[]>();
  private pending = new Set<string>();
  private retryAt = new Map<string, number>();
  /** tiles built without Landsat imagery: reload after this time */
  private stale = new Map<string, number>();
  private active = 0;

  constructor(private origin: () => LatLon) {}

  private tileLatLon = { lat: 0, lon: 0 };

  update(cam: LatLon, now: number): void {
    this.tileLatLon = cam;
    const center = tileForLatLon(cam.lat, cam.lon, 14);
    const wanted = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const n = 2 ** 14;
        const tile = { z: 14, x: ((center.x + dx) % n + n) % n, y: Math.max(0, Math.min(n - 1, center.y + dy)) };
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        wanted.add(key);
        if ((this.samplers.has(key) && !((this.stale.get(key) ?? Infinity) <= now)) || this.pending.has(key)) continue;
        if ((this.retryAt.get(key) ?? 0) > now) continue;
        if (this.active >= 2) continue;
        this.pending.add(key);
        this.active++;
        void this.load(tile, key, now).finally(() => {
          this.pending.delete(key);
          this.active--;
        });
      }
    }
    for (const key of [...this.samplers.keys()]) {
      if (!wanted.has(key)) {
        this.samplers.delete(key);
        this.prisms.delete(key);
        this.stale.delete(key);
      }
    }
  }

  private async load(tile: { z: number; x: number; y: number }, key: string, now: number): Promise<void> {
    try {
      const png = await fetchTerrariumPng(tile);
      const sampler = await decodePngToSampler(png, tile);
      // the OSM raw cache is keyed with a '/full' suffix (see osm.worker); without it buildings never collided
      const raw = await getOsmRaw(`${tileKey('osm', tile, OSM_SCHEMA_VERSION)}/full`).catch(() => undefined);
      let data: ReturnType<typeof parseOverpass> | undefined;
      if (raw) {
        try {
          data = parseOverpass(JSON.parse(raw.json));
        } catch {
          data = undefined;
        }
      }
      // the surface is the rendered one: same lattice (runway-flattened when OSM is cached) → same isoline TIN as the mesh
      const grid = gridForZoom(tile.z);
      const { heights: lattice, borders } = await loadTileDem(tile, grid);
      if (data) {
        try {
          flattenRunways(lattice, tile, grid, data.lines, sampler);
        } catch {
          // fall back to the unflattened lattice, like the terrain worker
        }
      }
      // Landsat colour boundaries are part of the TIN; without imagery use the plain TIN for now and
      // reload the tile later so collision matches the mesh once it is rebuilt with imagery
      const ls = await loadLandsatTerrain(tile, grid);
      const surface = tinSampler(buildTerrainTin(tile, grid, lattice, { borders, colourLines: ls ? { lines: ls.lines, maxVerts: ls.maxVerts } : undefined }), tile);
      this.samplers.set(key, surface);
      if (!ls) this.stale.set(key, now + 10000);
      else this.stale.delete(key);
      if (data) {
        try {
          const list: Prism[] = [];
          for (const b of data.buildings) {
            const outer = b.rings[0];
            if (!outer || outer.length < 3) continue;
            let lat = 0;
            let lon = 0;
            for (const [lo, la] of outer) {
              lon += lo;
              lat += la;
            }
            lon /= outer.length;
            lat /= outer.length;
            const h = buildingHeights(b);
            const rings = b.rings.map((ring) =>
              ring.map(([lo, la]) => {
                const [e, n] = latLonToEnu({ lat, lon }, la, lo, 0);
                return [e, -n] as [number, number];
              }),
            );
            const base = Math.max(0, surface(lon, lat));
            const boundR = rings[0].reduce((m, [x, z]) => Math.max(m, Math.hypot(x, z)), 0);
            list.push({ lat, lon, rings, base, top: base + h.min + h.wall + h.roof, boundR });
          }
          this.prisms.set(key, list);
        } catch {
          this.prisms.set(key, []);
        }
      }
    } catch {
      this.retryAt.set(key, now + 5000);
    }
  }

  heightAt(lon: number, lat: number): number | undefined {
    const tile = tileForLatLon(lat, lon, 14);
    const sampler = this.samplers.get(`${tile.z}/${tile.x}/${tile.y}`);
    return sampler ? sampler(lon, lat) : undefined;
  }

  /** terrain + water + building contact for an ENU position relative to the current origin */
  probe(pos: vec3): GroundContact {
    const ll = enuToLatLon(this.origin(), pos[0], -pos[2], pos[1]);
    const height = this.heightAt(ll.lon, ll.lat) ?? 0;
    const contact: GroundContact = { height, water: height <= 0, building: false };
    const cosLat = Math.cos((ll.lat * Math.PI) / 180);
    const center = tileForLatLon(ll.lat, ll.lon, 14);
    const n = 2 ** 14;
    for (let dx = -1; dx <= 1 && !contact.building; dx++) {
      for (let dy = -1; dy <= 1 && !contact.building; dy++) {
        const key = `14/${((center.x + dx) % n + n) % n}/${Math.max(0, Math.min(n - 1, center.y + dy))}`;
        const list = this.prisms.get(key);
        if (!list) continue;
        for (const p of list) {
          const ex = (ll.lon - p.lon) * 111320 * cosLat;
          const nz = -(ll.lat - p.lat) * 111320;
          if (Math.hypot(ex, nz) > p.boundR + 30) continue;
          if (pos[1] > p.top || pos[1] < p.base - 10) continue;
          if (!pointInRing(ex, nz, p.rings[0])) continue;
          if (p.rings.slice(1).some((hole) => pointInRing(ex, nz, hole))) continue;
          contact.building = true;
          break;
        }
      }
    }
    return contact;
  }

  /** runway/tower anchor: tile center of the start tile, grounded */
  get ready(): boolean {
    const tile = tileForLatLon(this.tileLatLon.lat, this.tileLatLon.lon, 14);
    return this.samplers.has(`${tile.z}/${tile.x}/${tile.y}`);
  }
}

export function towerAnchor(latLon: LatLon): { lat: number; lon: number } {
  return tileCenter(tileForLatLon(latLon.lat, latLon.lon, 14));
}