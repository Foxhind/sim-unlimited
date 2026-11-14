import earcut from 'earcut';
import { RAMP, snowy } from '../engine/palette';
import { gridLatLon, latLonToEnu, tileCenter, tileSizeMeters, type Tile } from './geodesy';
import { buildBuildingMesh } from './building-mesher';
import { clipTileData } from './clip';
import type { LonLat, OsmArea, OsmDetail, OsmLine, OsmPoint, OsmTileData } from './osm-types';
import type { HeightSampler } from './terrain-source';
import type { TerrainMeshData } from './terrain-mesher';
import type { TerrainTin } from './terrain-tin';

export interface OsmMeshOptions {
  tile: Tile;
  detail: OsmDetail;
  data: OsmTileData;
  sampleHeight: HeightSampler;
  /** Max horizontal triangle edge before subdivision; defaults from tile size. */
  maxEdgeMeters?: number;
  /** include building geometry (default true); the game builds it as a separate mesh */
  buildings?: boolean;
  /**
   * The terrain the mesh lies on. With it, areas are cut by the terrain's faces and every piece
   * lies on its face; without it they are draped on `sampleHeight` (subdivided to maxEdgeMeters).
   */
  tin?: TerrainTin;
}

type P2 = [number, number];

/** convex polygon `subject` cut to the triangle `clip` (Sutherland–Hodgman); lattice coordinates */
function clipToTriangle(subject: P2[], clip: [P2, P2, P2]): P2[] {
  const turn = (clip[1][0] - clip[0][0]) * (clip[2][1] - clip[0][1]) - (clip[1][1] - clip[0][1]) * (clip[2][0] - clip[0][0]);
  if (turn === 0) return [];
  const sign = turn > 0 ? 1 : -1;
  let out = subject;
  for (let e = 0; e < 3 && out.length; e++) {
    const a = clip[e], b = clip[(e + 1) % 3];
    const side = (p: P2) => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const next: P2[] = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = next;
  }
  return out;
}

interface Pt {
  lon: number;
  lat: number;
  x: number;
  z: number;
  y: number;
}

interface AreaStyle {
  ramp: number;
  bias: number;
  water: boolean;
}

/** open ground (fields, parks, beaches...): snow covers it in winter */
const ground = (ramp: number, bias: number): AreaStyle => ({ ramp: snowy(ramp), bias, water: false });

function classifyArea(tags: Record<string, string>): AreaStyle | undefined {
  const natural = tags.natural;
  const landuse = tags.landuse;
  const leisure = tags.leisure;
  const aeroway = tags.aeroway;
  const waterway = tags.waterway;
  if (natural === 'water' || waterway === 'riverbank' || waterway === 'river' || waterway === 'canal') {
    return { ramp: RAMP.WATER, bias: 0.3, water: true };
  }
  if (aeroway === 'runway' || aeroway === 'taxiway' || aeroway === 'apron' || aeroway === 'helipad') {
    return { ramp: RAMP.ASPHALT, bias: 1.0, water: false };
  }
  // no fill for wood/forest (trees only, props-mesher) or landuse other than farmland: Landsat colours the terrain
  if (natural === 'scrub') return ground(RAMP.FOREST, 0.6);
  if (natural === 'beach') return ground(RAMP.SAND, 0.6);
  if (natural === 'bare_rock' || natural === 'scree') return ground(RAMP.ROCK, 0.6);
  if (landuse === 'farmland') return ground(RAMP.FIELD, 0.6);
  if (leisure === 'park' || leisure === 'garden' || leisure === 'golf_course' || leisure === 'pitch') {
    return ground(RAMP.GRASS, 0.6);
  }
  if (tags.building) return { ramp: RAMP.BRICK, bias: 0.7, water: false };
  if (natural === 'wetland') return ground(RAMP.GRASS, 0.5);
  return undefined;
}

interface LineStyle {
  ramp: number;
  width: number;
}

function classifyLine(tags: Record<string, string>): LineStyle | undefined {
  const hw = tags.highway;
  if (hw) {
    const width =
      hw === 'motorway' || hw === 'trunk' ? 20 :
      hw === 'primary' ? 14 :
      hw === 'secondary' ? 11 :
      hw === 'tertiary' ? 9 :
      7;
    return { ramp: RAMP.ASPHALT, width };
  }
  if (tags.railway === 'rail') return { ramp: RAMP.HULL_DARK, width: 6 };
  if (tags.waterway === 'river' || tags.waterway === 'canal') return { ramp: RAMP.WATER, width: 18 };
  if (tags.aeroway === 'runway' || tags.aeroway === 'taxiway') return { ramp: RAMP.ASPHALT, width: 30 };
  return undefined;
}

export function buildOsmMesh(opts: OsmMeshOptions): TerrainMeshData {
  const { tile, sampleHeight } = opts;
  // only this tile's share: the drape knows no terrain beyond the tile border
  const data = clipTileData(opts.data, tile);
  const center = tileCenter(tile);
  const maxEdge = opts.maxEdgeMeters ?? Math.max(120, Math.min(500, tileSizeMeters(tile) / 12));
  // far 'large' layer sits slightly lower so the near 'full' layer wins depth where they overlap
  const biasScale = opts.detail === 'large' ? 0.4 : 1;
  const verts: number[] = [];
  const ramps: number[] = [];

  const enu = (lon: number, lat: number): [number, number] => {
    const [e, n] = latLonToEnu(center, lat, lon, 0);
    return [e, -n];
  };
  const groundY = (lon: number, lat: number, bias: number): number => Math.max(sampleHeight(lon, lat), 0) + bias * biasScale;
  const makePt = (lon: number, lat: number, y: number): Pt => {
    const [x, z] = enu(lon, lat);
    return { lon, lat, x, z, y };
  };

  const emitTri = (a: Pt, b: Pt, c: Pt, ramp: number): void => {
    const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
    const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) {
      verts.push(p.x, p.y, p.z, nx, ny, nz);
      ramps.push(ramp);
    }
  };

  const mid = (a: Pt, b: Pt, bias: number, flatY?: number): Pt => {
    const lon = (a.lon + b.lon) / 2;
    const lat = (a.lat + b.lat) / 2;
    const y = flatY ?? groundY(lon, lat, bias);
    return makePt(lon, lat, y);
  };
  const edgeLen = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);

  const subdivide = (a: Pt, b: Pt, c: Pt, ramp: number, bias: number, depth: number): void => {
    const longest = Math.max(edgeLen(a, b), edgeLen(b, c), edgeLen(c, a));
    if (longest <= maxEdge || depth >= 7) {
      emitTri(a, b, c, ramp);
      return;
    }
    const ab = mid(a, b, bias);
    const bc = mid(b, c, bias);
    const ca = mid(c, a, bias);
    subdivide(a, ab, ca, ramp, bias, depth + 1);
    subdivide(ab, b, bc, ramp, bias, depth + 1);
    subdivide(ca, bc, c, ramp, bias, depth + 1);
    subdivide(ab, bc, ca, ramp, bias, depth + 1);
  };

  // --- areas on the terrain's own faces ---
  const tin = opts.tin;
  const faces = tin
    ? tin.tris.map((t) => {
        const c: [P2, P2, P2] = [[tin.vx[t.a], tin.vy[t.a]], [tin.vx[t.b], tin.vy[t.b]], [tin.vx[t.c], tin.vy[t.c]]];
        // the mesh draws water and anything below it at 0 m
        const h = [Math.max(0, tin.vh[t.a]), Math.max(0, tin.vh[t.b]), Math.max(0, tin.vh[t.c])];
        const det = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[2][0] - c[0][0]) * (c[1][1] - c[0][1]);
        return {
          c, h, det,
          x0: Math.min(c[0][0], c[1][0], c[2][0]), x1: Math.max(c[0][0], c[1][0], c[2][0]),
          y0: Math.min(c[0][1], c[1][1], c[2][1]), y1: Math.max(c[0][1], c[1][1], c[2][1]),
        };
      }).filter((f) => f.det !== 0)
    : [];
  const toLattice = ([lon, lat]: LonLat): P2 => {
    const n = 2 ** tile.z, g = tin!.grid;
    const sinLat = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
    const merc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return [(((lon + 180) / 360) * n - tile.x) * g, (merc * n - tile.y) * g];
  };
  /** one triangle of an area, cut by every terrain face under it: each piece lies on its face */
  const onFaces = (tri: [P2, P2, P2], ramp: number, bias: number): void => {
    const x0 = Math.min(tri[0][0], tri[1][0], tri[2][0]), x1 = Math.max(tri[0][0], tri[1][0], tri[2][0]);
    const y0 = Math.min(tri[0][1], tri[1][1], tri[2][1]), y1 = Math.max(tri[0][1], tri[1][1], tri[2][1]);
    for (const f of faces) {
      if (f.x1 <= x0 || f.x0 >= x1 || f.y1 <= y0 || f.y0 >= y1) continue;
      const piece = clipToTriangle(tri, f.c);
      if (piece.length < 3) continue;
      const pts = piece.map(([x, y]) => {
        const w1 = ((x - f.c[0][0]) * (f.c[2][1] - f.c[0][1]) - (f.c[2][0] - f.c[0][0]) * (y - f.c[0][1])) / f.det;
        const w2 = ((f.c[1][0] - f.c[0][0]) * (y - f.c[0][1]) - (x - f.c[0][0]) * (f.c[1][1] - f.c[0][1])) / f.det;
        const ll = gridLatLon(tile, x, y, tin!.grid);
        return makePt(ll.lon, ll.lat, f.h[0] * (1 - w1 - w2) + f.h[1] * w1 + f.h[2] * w2 + bias * biasScale);
      });
      for (let k = 1; k + 1 < pts.length; k++) emitTri(pts[0], pts[k], pts[k + 1], ramp);
    }
  };

  const buildArea = (area: OsmArea): void => {
    const style = classifyArea(area.tags);
    if (!style) return;
    const flat: number[] = [];
    const holes: number[] = [];
    const lls: LonLat[] = [];
    area.rings.forEach((ring, ri) => {
      let pts = ring;
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
        pts = pts.slice(0, -1);
      }
      if (pts.length < 3) return;
      if (ri > 0) holes.push(lls.length);
      for (const [lon, lat] of pts) {
        flat.push(lon, lat);
        lls.push([lon, lat]);
      }
    });
    if (lls.length < 3) return;
    const tris = earcut(flat, holes.length ? holes : undefined, 2);

    if (style.water) {
      // flat water plane at the sampled boundary height
      let level = 0;
      const outer = area.rings[0];
      const probes = Math.min(outer.length, 8);
      for (let i = 0; i < probes; i++) {
        const [lon, lat] = outer[Math.floor((i / probes) * outer.length)];
        level = Math.max(level, sampleHeight(lon, lat));
      }
      level = Math.max(level, 0) + style.bias * biasScale;
      const pts = lls.map(([lon, lat]) => makePt(lon, lat, level));
      for (let i = 0; i < tris.length; i += 3) emitTri(pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]], style.ramp);
      return;
    }

    if (tin) {
      // cut by the terrain's faces: a piece is coplanar with the face under it, so the terrain
      // cannot show through (a draped triangle spans its creases and it did, in saw-teeth)
      const lp = lls.map(toLattice);
      for (let i = 0; i < tris.length; i += 3) onFaces([lp[tris[i]], lp[tris[i + 1]], lp[tris[i + 2]]], style.ramp, style.bias);
      return;
    }
    const pts = lls.map(([lon, lat]) => makePt(lon, lat, groundY(lon, lat, style.bias)));
    for (let i = 0; i < tris.length; i += 3) {
      subdivide(pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]], style.ramp, style.bias, 0);
    }
  };

  const buildLine = (line: OsmLine): void => {
    const style = classifyLine(line.tags);
    if (!style || line.points.length < 2) return;
    const bias = 1.4;
    const half = style.width / 2;
    // densify long segments so the ribbon follows terrain
    const path: LonLat[] = [];
    for (let i = 0; i < line.points.length - 1; i++) {
      const a = line.points[i];
      const b = line.points[i + 1];
      path.push(a);
      const [ax, az] = enu(a[0], a[1]);
      const [bx, bz] = enu(b[0], b[1]);
      const segLen = Math.hypot(bx - ax, bz - az);
      const steps = Math.min(64, Math.ceil(segLen / maxEdge));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    path.push(line.points[line.points.length - 1]);
    if (path.length < 2) return;

    const centers = path.map(([lon, lat]) => {
      const [x, z] = enu(lon, lat);
      const base = Math.max(sampleHeight(lon, lat), 0);
      return { lon, lat, x, z, y: base + bias * biasScale };
    });
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < centers.length; i++) {
      const prev = centers[Math.max(0, i - 1)];
      const next = centers[Math.min(centers.length - 1, i + 1)];
      let dx = next.x - prev.x;
      let dz = next.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const px = -dz * half;
      const pz = dx * half;
      const c = centers[i];
      left.push({ lon: c.lon, lat: c.lat, x: c.x + px, z: c.z + pz, y: c.y });
      right.push({ lon: c.lon, lat: c.lat, x: c.x - px, z: c.z - pz, y: c.y });
    }
    for (let i = 0; i < centers.length - 1; i++) {
      emitTri(left[i], right[i], left[i + 1], style.ramp);
      emitTri(right[i], right[i + 1], left[i + 1], style.ramp);
    }
  };

  const buildPoint = (p: OsmPoint): void => {
    if (p.tags.aeroway !== 'helipad') return;
    const bias = 1.2;
    const half = 8;
    const y = groundY(p.at[0], p.at[1], bias);
    const c = makePt(p.at[0], p.at[1], y);
    const a = { ...c, x: c.x - half, z: c.z - half };
    const b = { ...c, x: c.x + half, z: c.z - half };
    const d = { ...c, x: c.x + half, z: c.z + half };
    const e = { ...c, x: c.x - half, z: c.z + half };
    emitTri(a, b, d, RAMP.ASPHALT);
    emitTri(a, d, e, RAMP.ASPHALT);
  };

  for (const area of data.areas) buildArea(area);
  for (const line of data.lines) buildLine(line);
  for (const p of data.points) buildPoint(p);

  if (opts.buildings !== false && data.buildings.length) {
    const bm = buildBuildingMesh({ tile, buildings: data.buildings, sampleHeight });
    for (let i = 0; i < bm.vertices.length; i++) verts.push(bm.vertices[i]);
    for (let i = 0; i < bm.ramps.length; i++) ramps.push(bm.ramps[i]);
  }

  const vertexCount = ramps.length;
  return {
    vertices: new Float32Array(verts),
    ramps: new Uint16Array(ramps), // VGA ramps (building colours) go past 255
    vertexCount,
  };
}