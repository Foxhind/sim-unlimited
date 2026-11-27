/**
 * How far the world is built and drawn in detail. A desktop draws the full profile; a phone the
 * shorter one: over a big city (central Moscow) the detailed tiles' OSM — the buildings, the road
 * ribbons, the drape — is most of the frame, and the area grows with the square of the radius.
 *
 * Read at run time (chunks.ts, osm-manager.ts, far-osm.ts), so a change takes effect on the next
 * frame: the tiles that fall out of the radius are swapped for their coarse variants.
 */
export interface DetailProfile {
  /** z14 terrain with OSM (meshed buildings, roads, trees) within this slant distance, m */
  detailRadiusM: number;
  /** buildings, road ribbons, greenhouse glass drawn within this slant, m (≤ detailRadiusM) */
  houseRadiusM: number;
  /** the drape (areas and covers on the terrain's faces) within this slant, m */
  drapeRadiusM: number;
  /** a building's small parts (parapets, roof plant, doors, masts) within this slant, m */
  buildingDetailM: number;
  /** power line conductors within this slant, m */
  wireRadiusM: number;
  /** the small props' (air conditioners, lamp posts, signals) radii times this */
  propScale: number;
  /** the far ring (buildings as dots, roads as lines) out to this slant, m */
  farOsmRadiusM: number;
  /** trees drawn within this horizontal distance of a tile's nearest part, m */
  treeRadiusM: number;
  /** the share of each tile's trees drawn (all of them near, thinned farther still: props-mesher TREE_THIN) */
  treeShare: number;
  /**
   * lamp posts, traffic lights, masts and power supports as 1 px lines instead of their solids
   * (the lit lamp lenses, the signals' lenses and the masts' beacons stay)
   */
  simpleProps: boolean;
}

export const FULL_DETAIL: Readonly<DetailProfile> = {
  detailRadiusM: 7000,
  houseRadiusM: 3500,
  drapeRadiusM: 3500,
  buildingDetailM: 1500,
  wireRadiusM: 4000,
  propScale: 1,
  farOsmRadiusM: 21000,
  treeRadiusM: 2000,
  treeShare: 1,
  simpleProps: false,
};

/**
 * A phone: the detailed ring cut to about a third of its area, the buildings and the drape to about
 * half, the far dots to under half, half the trees out to 1.5 km, and the street furniture, masts
 * and pylons as lines. From 1–2 km up a phone's screen shows little more anyway.
 */
export const PHONE_DETAIL: Readonly<DetailProfile> = {
  detailRadiusM: 4000,
  houseRadiusM: 2500,
  drapeRadiusM: 2000,
  buildingDetailM: 900,
  wireRadiusM: 2500,
  propScale: 0.6,
  farOsmRadiusM: 14000,
  treeRadiusM: 1500,
  treeShare: 0.5,
  simpleProps: true,
};

export type DetailMode = 'auto' | 'full' | 'phone';

/** the profile in force (mutated in place by setDetail) */
export const detail: DetailProfile = { ...FULL_DETAIL };

export function setDetail(p: Readonly<DetailProfile>): void {
  Object.assign(detail, p);
}

/**
 * The profile for a setting: 'auto' is the phone's on a device whose only pointer is a finger
 * (phones, tablets without a trackpad), the full one elsewhere.
 */
export function detailFor(mode: DetailMode, touchOnly: boolean): Readonly<DetailProfile> {
  if (mode === 'full') return FULL_DETAIL;
  if (mode === 'phone') return PHONE_DETAIL;
  return touchOnly ? PHONE_DETAIL : FULL_DETAIL;
}
