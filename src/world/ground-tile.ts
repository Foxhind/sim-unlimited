/**
 * One tile of the collision ground (ground.ts): the rendered terrain surface (surface-tin.ts, with
 * the aerodrome pads, the coastline and the ground under the roads) and the buildings as prisms. Built off
 * the main thread (ground.worker.ts) and handed over as plain arrays.
 */
import { applyPads, loadPads, type Pad } from './aerodrome';
import { applyPeaks, peaksOf } from './peaks';
import { buildingFooting, buildingHeights } from './building-mesher';
import { DETAIL_Z, gridForZoom } from './chunks';
import { coastlineWays } from './coast';
import { latLonToEnu, type Tile } from './geodesy';
import { osmRawKey } from './osm-source';
import { parseOverpass } from './overpass';
import { buildGroundCover } from './ground-cover';
import { buildSurfaceTin, fetchRoadSurface } from './surface-tin';
import { loadTileDem, type HeightSampler } from './terrain-source';
import { tinSampler, type TerrainTin } from './terrain-tin';
import { getOsmRaw } from './tile-cache';

export interface Prism {
  lat: number;
  lon: number;
  /** footprint rings in local meters [x=east, z=-north] relative to (lat, lon) */
  rings: [number, number][][];
  base: number;
  top: number;
  boundR: number;
}

/** a ground tile as it crosses the worker boundary */
export interface GroundTile {
  grid: number;
  vx: Float64Array;
  vy: Float64Array;
  vh: Float64Array;
  /** three vertex indices a face */
  tris: Uint32Array;
  /** undefined: no OSM cached for the tile (no buildings known) */
  prisms?: Prism[];
}

export function packGround(tin: TerrainTin, prisms: Prism[] | undefined): GroundTile {
  const tris = new Uint32Array(tin.tris.length * 3);
  tin.tris.forEach((t, i) => tris.set([t.a, t.b, t.c], i * 3));
  return { grid: tin.grid, vx: Float64Array.from(tin.vx), vy: Float64Array.from(tin.vy), vh: Float64Array.from(tin.vh), tris, prisms };
}

/** the surface of a packed ground tile, as tinSampler samples the TIN it was packed from */
export function groundSampler(g: GroundTile, tile: Tile): HeightSampler {
  const tris = Array.from({ length: g.tris.length / 3 }, (_, i) => ({ a: g.tris[i * 3], b: g.tris[i * 3 + 1], c: g.tris[i * 3 + 2] }));
  return tinSampler({ grid: g.grid, vx: Array.from(g.vx), vy: Array.from(g.vy), vh: Array.from(g.vh), tris }, tile);
}

/** the tile's ground from its DEM and its cached raw OSM, as the terrain mesh is built */
export async function buildGroundTile(tile: Tile): Promise<GroundTile> {
  // the OSM raw cache is keyed with a '/full' suffix (see osm.worker); without it buildings never collided
  const raw = await getOsmRaw(osmRawKey(tile)).catch(() => undefined);
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
  const dem = await loadTileDem(tile, grid);
  const { heights: lattice, borders } = dem;
  const pads: Pad[] = data ? await loadPads(data) : [];
  applyPads(dem, tile, grid, pads);
  // mapped summits up to their height, as the terrain mesh has them
  if (data) applyPeaks(dem, tile, grid, peaksOf(data.points));
  // the same TIN as the mesh (no colour boundaries: faces are coloured by height × temperature),
  // built under the roads
  const roads = data ? await fetchRoadSurface(tile, data, pads) : undefined;
  // and with the same covers (where the terrain worker builds them: z14 with OSM, roads or not)
  const cover = data && tile.z === DETAIL_Z ? buildGroundCover(tile, grid, data, roads) : undefined;
  const tin = buildSurfaceTin(tile, grid, lattice, {
    borders,
    coast: data ? coastlineWays(data.lines) : undefined,
    pads,
    roads,
    cover,
  });
  if (!data) return packGround(tin, undefined);
  const surface = tinSampler(tin, tile);
  let prisms: Prism[] = [];
  try {
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
      // as the mesh stands it: walls at the highest ground under it (capped), a plinth down to the lowest
      const footing = buildingFooting(outer, surface);
      const base = footing.low;
      const boundR = rings[0].reduce((m, [x, z]) => Math.max(m, Math.hypot(x, z)), 0);
      prisms.push({ lat, lon, rings, base, top: footing.base + h.min + h.wall + h.roof, boundR });
    }
  } catch {
    prisms = [];
  }
  return packGround(tin, prisms);
}
