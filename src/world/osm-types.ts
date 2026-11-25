import type { Tile } from './geodesy';

export type LonLat = [number, number];

export interface OsmArea {
  /** [outer, ...holes], each ring closed or open (mesher closes it) */
  rings: LonLat[][];
  tags: Record<string, string>;
}

export interface OsmLine {
  points: LonLat[];
  tags: Record<string, string>;
}

export interface OsmPoint {
  at: LonLat;
  tags: Record<string, string>;
}

/** S3DB footprint: [outer, ...holes]; parts are emitted instead of the outline when present. */
export interface OsmBuilding {
  rings: LonLat[][];
  tags: Record<string, string>;
}

export interface OsmTileData {
  areas: OsmArea[];
  lines: OsmLine[];
  points: OsmPoint[];
  buildings: OsmBuilding[];
}

export type OsmDetail = 'full' | 'large';

/** Q2: every OSM data source hides behind this interface (Overpass now, PMTiles in M6). */
export interface TileSource {
  readonly name: string;
  fetch(tile: Tile, detail: OsmDetail): Promise<OsmTileData>;
}

/** a part's footprint vertex all the parts of its building draw their default colours by ("lon,lat") */
export const STYLE_AT_TAG = 'sim:style_at';
/** the building type whose wall palette all the parts of a building take (building-mesher wallRamp) */
export const STYLE_TYPE_TAG = 'sim:style_type';
