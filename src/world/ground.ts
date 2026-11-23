import { vec3 } from 'gl-matrix';
import { enuToLatLon, tileCenter, tileForLatLon, type LatLon } from './geodesy';
import type { HeightSampler } from './terrain-source';
import { buildGroundTile, groundSampler, type GroundTile, type Prism } from './ground-tile';
import { RetryableError } from '../engine/queue';
import type { GroundContact } from '../flight/model';
import type { GroundResponse } from '../workers/ground.worker';

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
 * Collision ground truth: the rendered terrain surface (Q13 water mask) plus S3DB prisms from
 * cached raw OSM, built in a worker (ground-tile.ts) and sampled on the main thread. Tiles stream
 * in around the jet.
 */
export class GroundProbe {
  private samplers = new Map<string, HeightSampler>();
  private prisms = new Map<string, Prism[]>();
  private pending = new Set<string>();
  private retryAt = new Map<string, number>();
  /** tiles built without Landsat imagery: reload after this time */
  private stale = new Map<string, number>();
  /**
   * Tiles whose OSM arrived after their surface was built (refresh): reloaded as soon as possible,
   * the old surface kept meanwhile. The value is the refresh generation, so a load that started
   * before the refresh does not count as the reload.
   */
  private outdated = new Map<string, number>();
  private generation = 0;
  private active = 0;

  constructor(private origin: () => LatLon) {}

  private worker?: Worker;
  private nextId = 0;
  private waiting = new Map<number, { resolve: (g: GroundTile) => void; reject: (e: Error) => void }>();

  /** a tile's ground, built in the worker (in place where there are no workers: tests) */
  private build(tile: { z: number; x: number; y: number }): Promise<GroundTile> {
    if (typeof Worker === 'undefined') return buildGroundTile(tile);
    if (!this.worker) {
      const worker = new Worker(new URL('../workers/ground.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<GroundResponse>) => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        this.waiting.delete(e.data.id);
        if ('ground' in e.data) w.resolve(e.data.ground);
        else w.reject(e.data.retryable ? new RetryableError(0, e.data.error) : new Error(e.data.error));
      };
      // a failed worker is dropped: the next tile starts a new one (the waiting ones retry later)
      worker.onerror = () => {
        for (const w of this.waiting.values()) w.reject(new Error('ground worker failed'));
        this.waiting.clear();
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      };
      this.worker = worker;
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ id, tile });
    });
  }

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
        const due = this.outdated.has(key) || (this.stale.get(key) ?? Infinity) <= now;
        if ((this.samplers.has(key) && !due) || this.pending.has(key)) continue;
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
        this.outdated.delete(key);
      }
    }
  }

  /**
   * The OSM of `tile` has arrived: rebuild its surface from it (aerodrome pads, coastline,
   * buildings), as the terrain mesh is rebuilt. The current surface stays until the new one is in.
   */
  refresh(tile: { z: number; x: number; y: number }): void {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (this.samplers.has(key) || this.pending.has(key)) this.outdated.set(key, ++this.generation);
  }

  private async load(tile: { z: number; x: number; y: number }, key: string, now: number): Promise<void> {
    const gen = this.outdated.get(key);
    try {
      const ground = await this.build(tile);
      this.samplers.set(key, groundSampler(ground, tile));
      if (this.outdated.get(key) === gen) this.outdated.delete(key);
      this.stale.delete(key);
      if (ground.prisms) this.prisms.set(key, ground.prisms);
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
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    return this.samplers.has(key) && !this.outdated.has(key);
  }
}

export function towerAnchor(latLon: LatLon): { lat: number; lon: number } {
  return tileCenter(tileForLatLon(latLon.lat, latLon.lon, 14));
}