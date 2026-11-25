/**
 * The road network of a tile: every way with a carriageway (what the OSM layer draws as a road,
 * links included; not footways, paths or steps), sampled along its line and joined where ways share
 * a node. It carries what the roads-first surface needs of each way: its bed (carriageway and
 * shoulder), the band over which the ground is pulled to it, and the weight of its DEM samples.
 * Rivers, canals and streams are in it too, as water ways: their bed is the water, level across,
 * at the water's height along them, and their banks are pulled to it. So are the railways: their
 * ballast is a bed like a carriageway's, its height smoothed along the line, the ground pulled to it.
 */
import { EARTH_R } from './geodesy';
import { classifyLine, isTunnel, roadClassWidth, roadPriority, waterwayWidth } from './osm-mesher';
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
  /** a tunnel, or a waterway in a culvert: pulls nothing */
  tunnel: boolean;
  /** a river, canal or stream: its bed is the water */
  water: boolean;
  /** water: how far its surface lies under the ground the DEM gives there (its channel), metres; roads 0 */
  depth: number;
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

/**
 * The urban paths: footways, cycleways and steps take the roads' rules (heights of their own from
 * the network, a bed the ground is pulled to): a footway's bridge lifted over the drawn ground stood
 * its clearance on the banks, 6–7 m up beside the street's at 4 m (14/9517/6398). A trail (path,
 * bridleway) follows the relief, as before.
 */
const URBAN_PATHS = new Set(['footway', 'cycleway', 'steps']);
export function isUrbanPath(tags: Record<string, string>): boolean {
  return URBAN_PATHS.has(tags.highway ?? '') && tags.area !== 'yes';
}

/** a way the OSM layer draws as a road with a carriageway (not a path, railway or area) */
export function isCarriageway(tags: Record<string, string>): boolean {
  if (!tags.highway) return false;
  const style = classifyLine(tags);
  return !!style && !style.path && !style.rail;
}

/**
 * A railway the OSM layer draws (railway=rail, narrow_gauge, light_rail): by the roads' rules, its
 * ballast a bed with a height of its own. Left on the raw DEM it took every bump of it, and the
 * ground beside a road bridge's approach climbed over the tracks (55.80917, 37.94793).
 */
export function isRailWay(tags: Record<string, string>): boolean {
  return !tags.highway && !!classifyLine(tags)?.rail;
}
/** a railway's band: an embankment's or a cutting's slopes */
const RAIL_BAND_M = 40;
/**
 * above every road where beds meet (a level crossing: the road comes up to the rails), and its
 * samples weighted as a motorway's: a street joining it bends it by nothing
 */
const RAIL_PRIO = 10;
const RAIL_WEIGHT = 8000;

/** waterways in the network: the surface of their water is level across */
const WATER_KINDS = new Set(['river', 'canal', 'stream']);
/** a river, canal or stream the OSM layer draws (not an area) */
export function isWaterWay(tags: Record<string, string>): boolean {
  return WATER_KINDS.has(tags.waterway ?? '') && tags.area !== 'yes' && waterwayWidth(tags) !== undefined;
}
/** banks pulled to the water this far beyond its edge, metres: rivers and canals, streams */
const WATER_BAND_M = 30;
const STREAM_BAND_M = 12;
/**
 * A waterway's surface under the ground the DEM gives along it, metres: the DEM's 30 m pixels do
 * not see a channel a few metres wide, and the water at the DEM's height lay level with the street
 * (a bridge over it then climbed its clearance over the street: 14/9517/6397)
 */
export const WATER_DEPTH_M: Readonly<Record<string, number>> = { river: 2.5, canal: 2.5, stream: 1 };
/** below every road: a ford is the road's surface */
const WATER_PRIO = -1;

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
    const water = isWaterWay(line.tags);
    const rail = !water && isRailWay(line.tags);
    if ((!water && !rail && !isCarriageway(line.tags) && !isUrbanPath(line.tags)) || !line.points.length) continue;
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
    if (water) {
      const width = waterwayWidth(line.tags)!;
      ways.push({
        line, prio: WATER_PRIO + Math.min(width, 100) / 1000, half: width / 2,
        band: line.tags.waterway === 'stream' ? STREAM_BAND_M : WATER_BAND_M, weight: 1,
        bridge: false, tunnel: !!line.tags.tunnel && line.tags.tunnel !== 'no', water: true,
        depth: WATER_DEPTH_M[line.tags.waterway] ?? 0,
        first, count: samples.length - first,
      });
      continue;
    }
    const style = classifyLine(line.tags)!;
    ways.push({
      line,
      prio: rail ? RAIL_PRIO : roadPriority(line.tags, style.width),
      half: style.width / 2 + (style.shoulder ?? 0),
      band: rail ? RAIL_BAND_M : bandOf(line.tags.highway),
      weight: rail ? RAIL_WEIGHT : (roadClassWidth(line.tags.highway) ?? style.width) ** 3,
      bridge: !!line.tags.bridge && line.tags.bridge !== 'no',
      tunnel: isTunnel(line.tags),
      water: false,
      depth: 0,
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
