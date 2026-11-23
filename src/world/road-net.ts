/**
 * The road network of a tile: every way with a carriageway (what the OSM layer draws as a road,
 * links included; not footways, paths or steps), sampled along its line and joined where ways share
 * a node. It carries what the roads-first surface needs of each way: its bed (carriageway and
 * shoulder), the band over which the ground is pulled to it, and the weight of its DEM samples.
 */
import { EARTH_R } from './geodesy';
import { classifyLine, isTunnel, roadClassWidth, roadPriority } from './osm-mesher';
import type { OsmLine } from './osm-types';

/** network samples along a way at most this far apart, metres */
export const NET_STEP_M = 10;

export interface NetWay {
  line: OsmLine;
  /** roadPriority of the way: the senior where beds overlap */
  prio: number;
  /** bed half width, m: half the carriageway and the shoulder */
  half: number;
  /** pull band beyond the bed, m: 45 / 40 / 25 by class */
  band: number;
  /**
   * weight of its DEM samples: its class's carriageway width cubed (motorway 8000, residential
   * 343): a street joining a motorway bends it by less than 0.2 m
   */
  weight: number;
  bridge: boolean;
  tunnel: boolean;
  /** its samples: first .. first + count − 1, in the way's order */
  first: number;
  count: number;
}

export interface NetSample {
  lon: number;
  lat: number;
  way: number;
  /** metres along the way */
  d: number;
}

export interface RoadNet {
  ways: NetWay[];
  samples: NetSample[];
  /** per sample: its neighbours along the network and the metres to each */
  next: Array<Array<[number, number]>>;
}

/** a way the OSM layer draws as a road with a carriageway (not a path, railway or area) */
export function isCarriageway(tags: Record<string, string>): boolean {
  if (!tags.highway) return false;
  const style = classifyLine(tags);
  return !!style && !style.path && !style.rail;
}

/** pull band beyond the bed by class, metres */
function bandOf(highway: string): number {
  const cls = highway.replace(/_link$/, '');
  if (cls === 'motorway' || cls === 'trunk' || cls === 'primary') return 45;
  if (cls === 'secondary' || cls === 'tertiary') return 40;
  return 25;
}

const D2R = Math.PI / 180;

/** metres between two lon/lat points (local equirectangular, the sphere of tileSizeMeters) */
export function metresBetween(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const k = Math.cos(((lat0 + lat1) / 2) * D2R);
  return Math.hypot((lon1 - lon0) * k, lat1 - lat0) * D2R * EARTH_R;
}

export function buildRoadNet(lines: ReadonlyArray<OsmLine>): RoadNet {
  const ways: NetWay[] = [];
  const samples: NetSample[] = [];
  const next: Array<Array<[number, number]>> = [];
  const add = (s: NetSample) => {
    next.push([]);
    return samples.push(s) - 1;
  };
  const join = (i: number, j: number, m: number) => {
    next[i].push([j, m]);
    next[j].push([i, m]);
  };
  for (const line of lines) {
    if (!isCarriageway(line.tags) || !line.points.length) continue;
    const style = classifyLine(line.tags)!;
    const way = ways.length;
    const first = samples.length;
    let d = 0;
    let [plon, plat] = line.points[0];
    add({ lon: plon, lat: plat, way, d: 0 });
    for (let k = 1; k < line.points.length; k++) {
      const [lon, lat] = line.points[k];
      const len = metresBetween(plon, plat, lon, lat);
      if (len === 0) continue;
      // the segment cut into equal pieces: the samples depend on its two ends only
      const pieces = Math.ceil(len / NET_STEP_M - 1e-9);
      for (let p = 1; p <= pieces; p++) {
        const f = p / pieces;
        const i = add(p === pieces ? { lon, lat, way, d: d + len } : { lon: plon + (lon - plon) * f, lat: plat + (lat - plat) * f, way, d: d + len * f });
        join(i - 1, i, len / pieces);
      }
      d += len;
      plon = lon;
      plat = lat;
    }
    ways.push({
      line,
      prio: roadPriority(line.tags, style.width),
      half: style.width / 2 + (style.shoulder ?? 0),
      band: bandOf(line.tags.highway),
      weight: (roadClassWidth(line.tags.highway) ?? style.width) ** 3,
      bridge: !!line.tags.bridge && line.tags.bridge !== 'no',
      tunnel: isTunnel(line.tags),
      first,
      count: samples.length - first,
    });
  }
  // shared nodes (and a ring's ends): samples at the same lon/lat joined at no distance
  const at = new Map<string, number[]>();
  samples.forEach((s, i) => {
    const key = `${s.lon},${s.lat}`;
    const same = at.get(key);
    if (same) {
      for (const j of same) if (!next[i].some(([k]) => k === j)) join(i, j, 0);
      same.push(i);
    } else at.set(key, [i]);
  });
  return { ways, samples, next };
}
