import { tileForLatLon, type Tile } from './geodesy';
import { decodePngToSampler, fetchTerrariumPng, type HeightSampler } from './terrain-source';

const MAX_TILES = 48;
const RETRY_MS = 10000;

/**
 * Coarse terrain height anywhere, from Terrarium tiles loaded on demand (z12: ~25 m cells).
 * The ground probe only knows the few kilometres around the aircraft; the autopilot needs the
 * runway threshold and the terrain ahead from much further out. Undefined until a tile arrives.
 */
export class FarElevation {
  private readonly samplers = new Map<string, HeightSampler>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly zoom = 12,
    private readonly load: (t: Tile) => Promise<HeightSampler> = async (t) => decodePngToSampler(await fetchTerrariumPng(t), t),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  heightAt(lon: number, lat: number): number | undefined {
    const t = tileForLatLon(lat, lon, this.zoom);
    const key = `${t.z}/${t.x}/${t.y}`;
    const s = this.samplers.get(key);
    if (s) {
      // most recently used last, so the oldest goes first
      this.samplers.delete(key);
      this.samplers.set(key, s);
      return s(lon, lat);
    }
    const failed = this.failedAt.get(key);
    if (!this.pending.has(key) && (failed === undefined || this.clock() - failed > RETRY_MS)) {
      this.pending.add(key);
      this.load(t)
        .then((sampler) => {
          this.samplers.set(key, sampler);
          this.failedAt.delete(key);
          if (this.samplers.size > MAX_TILES) this.samplers.delete(this.samplers.keys().next().value!);
        })
        .catch(() => this.failedAt.set(key, this.clock()))
        .finally(() => this.pending.delete(key));
    }
    return undefined;
  }
}
