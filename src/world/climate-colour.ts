/**
 * Experimental terrain colouring by a two-dimensional scheme: height × the temperature at that
 * height (replaces Landsat imagery). No data is fetched: the colour of a land face is a function of
 * its mean height, its slope and the latitude of the tile.
 *
 *   temperature: the annual mean of the climate formula (palette.ts CLIMATE): by latitude and
 *                height, ≈ 29 °C at the equator, 13 at 45°, 2.5 at 60°, −24 at the poles, −6 °C per km;
 *   scheme:      CLIMATE_TABLE — rows by temperature (ice … tropics), columns by height
 *                (lowland … high mountains), bilinear between the nodes;
 *   slope:       steep faces turn to bare rock.
 */
import { climateTemperature, colour, type RGB } from '../engine/palette';
import type { FaceColor } from './landsat';
import { gridLatLon, tileSizeMeters, type Tile } from './geodesy';

/** mean annual temperature at sea level, °C (palette.ts CLIMATE) */
export function seaLevelTemperature(latDeg: number): number {
  return climateTemperature(latDeg, 0);
}

/** mean annual temperature at `heightM` metres, °C: vegetation follows the year, not the season */
export function temperatureAt(latDeg: number, heightM: number): number {
  return climateTemperature(latDeg, heightM);
}

/** height nodes of the scheme, metres */
export const CLIMATE_HEIGHTS = [0, 500, 1500, 3000] as const;
/** temperature nodes of the scheme, °C (rows of CLIMATE_TABLE) */
export const CLIMATE_TEMPS = [-10, -3, 3, 9, 16, 24] as const;

/** colours [temperature][height]: what the ground looks like under ordinary daylight */
export const CLIMATE_TABLE: ReadonlyArray<ReadonlyArray<RGB>> = [
  // ≤ −10 °C: ice cap, glaciers
  [[226, 232, 238], [222, 228, 236], [218, 224, 234], [214, 220, 232]],
  // −3 °C: tundra (moss, lichen) → fell field → scree
  [[118, 116, 92], [116, 110, 96], [124, 119, 110], [140, 138, 134]],
  // 3 °C: taiga → subalpine heath → bare upland
  [[50, 70, 42], [56, 72, 46], [86, 88, 68], [120, 115, 105]],
  // 9 °C: temperate mixed forest and meadows → upland pasture → alpine
  [[76, 102, 50], [70, 92, 48], [94, 98, 66], [124, 118, 100]],
  // 16 °C: warm temperate, dry grass and shrub → steppe → dry highland
  [[122, 126, 70], [130, 120, 78], [138, 120, 88], [140, 125, 105]],
  // ≥ 24 °C: tropics, lush lowland → montane forest → paramo
  [[58, 96, 40], [62, 96, 42], [90, 102, 58], [128, 116, 94]],
];

const ROCK: RGB = [118, 112, 104];
/**
 * Face normal y below which the slope starts to turn to rock (≈ 40°), and where it is rock
 * entirely (≈ 63°): forest and meadow hold on slopes up to ~40°, only cliffs are bare.
 */
const STEEP_START = 0.77;
const STEEP_FULL = 0.45;

/** position of `v` between the nodes of `nodes`: lower index and fraction */
function bracket(nodes: readonly number[], v: number): [number, number] {
  if (v <= nodes[0]) return [0, 0];
  const last = nodes.length - 1;
  if (v >= nodes[last]) return [last - 1, 1];
  let i = 0;
  while (v > nodes[i + 1]) i++;
  return [i, (v - nodes[i]) / (nodes[i + 1] - nodes[i])];
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** the scheme: colour at height `heightM` and temperature `tempC` */
export function climateRgb(heightM: number, tempC: number): RGB {
  const [ti, tf] = bracket(CLIMATE_TEMPS, tempC);
  const [hi, hf] = bracket(CLIMATE_HEIGHTS, Math.max(0, heightM));
  const lo = mix(CLIMATE_TABLE[ti][hi], CLIMATE_TABLE[ti][hi + 1], hf);
  const hiRow = mix(CLIMATE_TABLE[ti + 1][hi], CLIMATE_TABLE[ti + 1][hi + 1], hf);
  return mix(lo, hiRow, tf);
}

/** colour of a land face: the scheme at its height and latitude, steep slopes as rock */
export function climateFaceRgb(heightM: number, latDeg: number, normalY: number): RGB {
  const c = climateRgb(heightM, temperatureAt(latDeg, heightM));
  const steep = Math.min(1, Math.max(0, (STEEP_START - normalY) / (STEEP_START - STEEP_FULL)));
  const r = steep > 0 && temperatureAt(latDeg, heightM) > -6 ? mix(c, ROCK, steep) : c;
  return [Math.round(r[0]), Math.round(r[1]), Math.round(r[2])];
}

/** lattice cells over which the slope is measured on each side (smooths the TIN's facets away) */
const SLOPE_RADIUS = 2;

/**
 * FaceColor of a terrain tile from its height lattice ((grid+1)² heights, row-major north→south).
 * Height and slope are read from the lattice at the face centroid, not from the face itself: the
 * isoline TIN has long slivers and flat triangles lying on one contour (normal straight up) in the
 * middle of steep slopes, and colouring them by their own normal leaves stray triangles.
 */
export function climateFaceColor(tile: Tile, grid: number, heights: Float32Array): FaceColor {
  const side = grid + 1;
  const cell = tileSizeMeters(tile) / grid;
  // per node: y of the upward normal of the lattice surface, from central differences ±SLOPE_RADIUS
  const ny = new Float32Array(side * side);
  const at = (i: number, j: number) => Math.max(0, heights[Math.min(grid, Math.max(0, j)) * side + Math.min(grid, Math.max(0, i))]);
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const i0 = Math.max(0, i - SLOPE_RADIUS), i1 = Math.min(grid, i + SLOPE_RADIUS);
      const j0 = Math.max(0, j - SLOPE_RADIUS), j1 = Math.min(grid, j + SLOPE_RADIUS);
      const gx = (at(i1, j) - at(i0, j)) / ((i1 - i0) * cell);
      const gy = (at(i, j1) - at(i, j0)) / ((j1 - j0) * cell);
      ny[j * side + i] = 1 / Math.sqrt(1 + gx * gx + gy * gy);
    }
  }
  const sample = (f: Float32Array, gx: number, gy: number): number => {
    const i = Math.max(0, Math.min(grid - 1, Math.floor(gx)));
    const j = Math.max(0, Math.min(grid - 1, Math.floor(gy)));
    const tx = Math.min(1, Math.max(0, gx - i)), ty = Math.min(1, Math.max(0, gy - j));
    const k = j * side + i;
    return f[k] * (1 - tx) * (1 - ty) + f[k + 1] * tx * (1 - ty) + f[k + side] * (1 - tx) * ty + f[k + side + 1] * tx * ty;
  };
  return (ax, ay, bx, by, cx, cy) => {
    const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3;
    const h = Math.max(0, sample(heights, gx, gy));
    const lat = gridLatLon(tile, gx, gy, grid).lat;
    const [r, g, b] = climateFaceRgb(h, lat, sample(ny, gx, gy));
    return colour(r, g, b);
  };
}
