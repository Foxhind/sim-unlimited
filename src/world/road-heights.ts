/**
 * Road heights from the raw DEM by a window along the network: the height at a network sample is
 * the kernel average of the DEM over every sample within ROAD_WINDOW_M of path, weighted by the
 * class of the way it lies on. It depends on the network and the DEM near the sample only, so
 * every tile that sees a sample (and the network round it) gives it the same height, and every way
 * through a node has one height there.
 */
import { padAdjust, type Pad } from './aerodrome';
import { EARTH_R } from './geodesy';
import type { RoadNet } from './road-net';
import { demHeights } from './terrain-source';

/** path distance over which the DEM is averaged, metres */
export const ROAD_WINDOW_M = 90;
/** how far beyond its border a tile sees roads (ROAD_REACH_M, overpass.ts) */
const REACH_M = 150;

/**
 * ROAD_WINDOW_M, or less where a tile sees less of a road beyond its border: the PMTiles buffer is
 * 32 of 256 px of a z14 tile (less than 150 m north of ~60°). A function of latitude alone, so
 * both tiles of a seam use the same window.
 */
export function roadWindow(lat: number): number {
  const tile = ((2 * Math.PI * EARTH_R) / 2 ** 14) * Math.cos((lat * Math.PI) / 180);
  const seen = Math.min(REACH_M, (tile * 32) / 256 - 5);
  return Math.max(0, Math.min(ROAD_WINDOW_M, (seen * ROAD_WINDOW_M) / REACH_M));
}

/** the kernel: 1 at the sample, falling smoothly to 0 at the window's end */
function kernel(d: number, window: number): number {
  const u = d / window;
  return u >= 1 ? 0 : (1 - u * u) * (1 - u * u);
}

/**
 * H per sample: the kernel average of `dem` over the network within `window` m of path (Dijkstra
 * from each sample, cut at the window). Tunnel samples give no height; bridge samples give the
 * ground under them. NaN where no sample with a height is in reach.
 */
export function solveRoadHeights(net: RoadNet, dem: ArrayLike<number>, window = ROAD_WINDOW_M): Float64Array {
  const n = net.samples.length;
  const out = new Float64Array(n).fill(NaN);
  if (!(window > 0)) return out;
  const w = Float64Array.from(net.samples, (s, i) => {
    const way = net.ways[s.way];
    return way.tunnel || !Number.isFinite(dem[i]) ? 0 : way.weight;
  });
  const dist = new Float64Array(n);
  const stamp = new Int32Array(n).fill(-1);
  const done = new Int32Array(n).fill(-1);
  // a binary heap of (distance, sample)
  const hd: number[] = [], hi: number[] = [];
  const push = (d: number, i: number) => {
    let k = hd.length;
    hd.push(d);
    hi.push(i);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hd[p] <= d) break;
      hd[k] = hd[p];
      hi[k] = hi[p];
      k = p;
    }
    hd[k] = d;
    hi[k] = i;
  };
  const pop = (): number => {
    const top = hi[0];
    const d = hd.pop()!, i = hi.pop()!;
    if (hd.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= hd.length) break;
        if (c + 1 < hd.length && hd[c + 1] < hd[c]) c++;
        if (hd[c] >= d) break;
        hd[k] = hd[c];
        hi[k] = hi[c];
        k = c;
      }
      hd[k] = d;
      hi[k] = i;
    }
    return top;
  };
  for (let q = 0; q < n; q++) {
    let sum = 0, wsum = 0;
    hd.length = hi.length = 0;
    stamp[q] = q;
    dist[q] = 0;
    push(0, q);
    while (hd.length) {
      const d0 = hd[0];
      const p = pop();
      if (done[p] === q || d0 > dist[p]) continue;
      done[p] = q;
      if (w[p] > 0) {
        const k = kernel(d0, window) * w[p];
        sum += k * dem[p];
        wsum += k;
      }
      for (const [r, m] of net.next[p]) {
        const d = d0 + m;
        if (d >= window || done[r] === q) continue;
        if (stamp[r] !== q || d < dist[r]) {
          stamp[r] = q;
          dist[r] = d;
          push(d, r);
        }
      }
    }
    if (wsum > 0) out[q] = sum / wsum;
  }
  return out;
}

/** raw z14 heights at the network's samples, brought to the pads on and round an aerodrome */
export async function fetchRoadDem(net: RoadNet, pads: ReadonlyArray<Pad>): Promise<Float64Array> {
  const dem = await demHeights(net.samples.map((s) => [s.lon, s.lat] as const), 14);
  if (pads.length) net.samples.forEach((s, i) => {
    if (Number.isFinite(dem[i])) dem[i] = padAdjust(pads, s.lon, s.lat, dem[i]);
  });
  return dem;
}
