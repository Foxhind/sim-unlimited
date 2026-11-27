/**
 * Kinds of the solid structures in a tile's building mesh (osm.worker bmesh: houses, bridge bodies,
 * antenna masts), by their OSM tags. The mesh carries them as vertex runs (KindRuns) so a viewer can
 * leave a kind out (relief inspector) without a mesh of its own per kind.
 */
export const STRUCTURE = {
  /** any other building=* */
  BUILDING: 0,
  /** building=roof: canopies, open shelters */
  CANOPY: 1,
  /** man_made=chimney, building=chimney */
  CHIMNEY: 2,
  /** towers mapped as buildings: man_made=tower / water_tower / cooling_tower, building=tower… */
  TOWER: 3,
  /** tanks and silos: storage_tank, silo, gasometer, bunker_silo, reservoir_covered */
  TANK: 4,
  /** any other man_made mapped as a building */
  MAN_MADE: 5,
  /** bridge bodies and embankments (bridge-mesher) */
  BRIDGE: 6,
  /** antenna masts and communication towers (mast-mesher), points */
  MAST: 7,
  /** piers and breakwaters (pier-mesher) */
  PIER: 8,
  /** minarets, mapped or guessed by the mosques (minaret-mesher) */
  MINARET: 9,
  /** power line pylons and poles (power-mesher); their conductors too */
  POWER: 10,
  /** ruins: roofless broken walls (ruin-mesher) */
  RUINS: 11,
  /** cable cars and chair lifts: pylons, stations, cabins (aerialway-mesher); their ropes too */
  LIFT: 12,
  /** lighthouses and the sea's lights (lighthouse-mesher); their flashes too */
  LIGHTHOUSE: 13,
  /** tombs: rock-cut fronts, sarcophagi, pillar tombs (tomb-mesher) */
  TOMB: 14,
  /** walls: barrier=wall, retaining_wall, city_wall (wall-mesher) */
  WALL: 15,
  /** stadium stands (stadium-mesher) */
  STADIUM: 16,
  /** dams and weirs (dam-mesher) */
  DAM: 17,
} as const;
export type StructureKind = (typeof STRUCTURE)[keyof typeof STRUCTURE];
export const STRUCTURE_KINDS = 18;
/** every kind shown */
export const ALL_STRUCTURES = (1 << STRUCTURE_KINDS) - 1;

export const STRUCTURE_LABELS: Record<StructureKind, string> = {
  [STRUCTURE.BUILDING]: 'здания (building=*)',
  [STRUCTURE.CANOPY]: 'навесы (building=roof)',
  [STRUCTURE.CHIMNEY]: 'трубы (chimney)',
  [STRUCTURE.TOWER]: 'башни (tower, water_tower, cooling_tower)',
  [STRUCTURE.TANK]: 'резервуары и силосы (storage_tank, silo, gasometer)',
  [STRUCTURE.MAN_MADE]: 'прочие man_made',
  [STRUCTURE.BRIDGE]: 'мосты и насыпи',
  [STRUCTURE.MAST]: 'мачты и антенны (mast, antenna)',
  [STRUCTURE.PIER]: 'пирсы и волноломы',
  [STRUCTURE.MINARET]: 'минареты',
  [STRUCTURE.POWER]: 'ЛЭП: опоры и провода',
  [STRUCTURE.RUINS]: 'руины',
  [STRUCTURE.LIFT]: 'канатные дороги и подъёмники',
  [STRUCTURE.LIGHTHOUSE]: 'маяки и огни',
  [STRUCTURE.TOMB]: 'гробницы (tomb=*)',
  [STRUCTURE.WALL]: 'стены и заборы (wall, retaining_wall, city_wall, fence)',
  [STRUCTURE.STADIUM]: 'трибуны стадионов',
  [STRUCTURE.DAM]: 'плотины и водосливы',
};

const TOWERS = new Set(['tower', 'water_tower', 'cooling_tower', 'transformer_tower']);
const TANKS = new Set(['storage_tank', 'silo', 'gasometer', 'bunker_silo', 'reservoir_covered']);

/** the kind of a building (or building:part) by its tags */
export function structureKind(tags: Record<string, string>): StructureKind {
  const type = tags['building:part'] || tags.building || 'yes';
  const mm = tags.man_made;
  if (mm === 'chimney' || type === 'chimney') return STRUCTURE.CHIMNEY;
  if (TOWERS.has(mm) || TOWERS.has(type)) return STRUCTURE.TOWER;
  if (TANKS.has(mm) || TANKS.has(type)) return STRUCTURE.TANK;
  if (mm) return STRUCTURE.MAN_MADE;
  if (type === 'roof' || type === 'carport') return STRUCTURE.CANOPY;
  return STRUCTURE.BUILDING;
}

/**
 * Kind runs over a mesh's vertices: pairs (first vertex, kind), the firsts ascending; each run lasts
 * up to the next one's first (the last to the end of the mesh).
 */
export class KindRuns {
  readonly pairs: number[] = [];
  /** the vertices from `first` on are of `kind` (merged with the run before when it is the same kind) */
  mark(first: number, kind: number): void {
    const p = this.pairs;
    const n = p.length;
    if (n && p[n - 2] === first) {
      p.length = n - 2; // the run before is empty: replaced
      return this.mark(first, kind);
    }
    if (n && p[n - 1] === kind) return;
    p.push(first, kind);
  }
  /** append `other`'s runs with their firsts moved by `shift` */
  append(other: ArrayLike<number>, shift: number): void {
    for (let i = 0; i < other.length; i += 2) this.mark(other[i] + shift, other[i + 1]);
  }
}

/**
 * The vertex ranges [first, count] of a mesh of `vertexCount` vertices whose kind is in `mask`
 * (bit per kind), adjacent ranges merged. Empty runs: all of it is BUILDING.
 */
export function shownRanges(runs: ArrayLike<number>, vertexCount: number, mask: number): [number, number][] {
  const out: [number, number][] = [];
  const n = runs.length;
  if (n === 0) return mask & (1 << STRUCTURE.BUILDING) ? [[0, vertexCount]] : [];
  for (let i = 0; i < n; i += 2) {
    const first = Math.min(runs[i], vertexCount);
    const end = i + 2 < n ? Math.min(runs[i + 2], vertexCount) : vertexCount;
    if (end <= first || !(mask & (1 << runs[i + 1]))) continue;
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === first) last[1] += end - first;
    else out.push([first, end - first]);
  }
  return out;
}
