/**
 * The surface of real dense z14 tiles with their ground covers (fixtures: the inputs of
 * buildSurfaceTin as the OSM worker had them): within the vertex budget in one build, and which
 * ways the budget leaves to their ribbons
 */
import { describe, expect, it } from 'vitest';
import { coastlineWays } from '../src/world/coast';
import { buildGroundCover } from '../src/world/ground-cover';
import type { Pad } from '../src/world/aerodrome';
import { enuToLatLon, latLonToEnu, tileCenter, tileLattice, tileSizeMeters, type Tile } from '../src/world/geodesy';
import { buildOsmMesh, classifyLine, type OsmMeshOptions } from '../src/world/osm-mesher';
import { tinLocator, tinSampler } from '../src/world/terrain-tin';
import type { OsmArea, OsmLine, OsmPoint } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { buildSurfaceTin, MAX_SURFACE_VERTS, roadSurfaceOf, type SurfaceStats } from '../src/world/surface-tin';
import { BANK_M, bridgeCrossings, bridgeDecks, roadPullOf } from '../src/world/road-pull';
import type { TileBorders } from '../src/world/terrain-source';
import type { TinDebug } from '../src/world/terrain-tin';
import { cracks } from './roads-helpers';

interface Fixture {
  tile: Tile;
  grid: number;
  heights: number[];
  borders: Record<'n' | 's' | 'w' | 'e', number[]> & { coarse?: Partial<Record<'n' | 's' | 'w' | 'e', number[]>> };
  pads: Pad[];
  roadDem: number[] | null;
  data: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] };
}

/** the tile's surface with its covers, as the OSM worker builds it */
async function surfaceOf(name: string) {
  const fx = (await import(`./fixtures/${name}.json`)).default as Fixture;
  const f32 = (a: number[]) => Float32Array.from(a);
  const borders: TileBorders = { n: f32(fx.borders.n), s: f32(fx.borders.s), w: f32(fx.borders.w), e: f32(fx.borders.e) };
  if (fx.borders.coarse) borders.coarse = Object.fromEntries(Object.entries(fx.borders.coarse).map(([k, v]) => [k, f32(v!)]));
  const net = buildRoadNet(fx.data.lines);
  const roads = fx.roadDem ? roadSurfaceOf(fx.tile, fx.data, net, Float64Array.from(fx.roadDem)) : undefined;
  const cover = buildGroundCover(fx.tile, fx.grid, fx.data, roads);
  const stats = {} as SurfaceStats, debug = {} as TinDebug;
  const tin = buildSurfaceTin(fx.tile, fx.grid, f32(fx.heights), { borders, coast: coastlineWays(fx.data.lines), pads: fx.pads, roads, cover, stats, debug });
  return { tin, cover, stats, debug, roads, fx };
}

/** Fethiye's tile */
const fixtureTile: Tile = { z: 14, x: 9517, y: 6397 };

/** the roads above a service road */
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|living_street)$/;

describe('real dense tiles in the surface budget', () => {
  it('Fethiye 14/9517/6397: every way and pool in the surface, in one build, every fixed edge in and no crack', async () => {
    const { tin, cover, stats, debug } = await surfaceOf('surface-14-9517-6397');
    expect(cracks(tin)).toBe(0);
    expect(debug.missing).toBe(0);
    expect(stats.builds).toBe(1);
    expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
    expect(tin.loose).toBeUndefined();
    expect(stats.picked).toBe(stats.units);
    expect(cover.shapes.filter((s) => s.kind === 'water').length).toBeGreaterThan(50);
  });

  it('Fethiye 14/9517/6397: each face lies in its own cover (the canal along the bank roads at 36.64774, 29.12803 included)', async () => {
    const { tin, cover } = await surfaceOf('surface-14-9517-6397');
    // the shape under each face's centre (a road's bank is the ground's, in the water's shape)
    const coverAt = (x: number, y: number): number => cover.locate(x, y);
    // halfway from a face's centre to each corner: in the face's cover, but in faces the fixed lines'
    // snapping (insertFixedLines, 1e-3 lattice: 3 cm here) left a sliver of another cover in. At
    // most four reach further, carriageway, shoulder or path, none 20 cm: before the tuning some 750
    // faces did (dropped pools and areas painted by their centre, loose footways); the round end of a
    // cover's stretch shorter than its width reached past its square end (a bridge's cover cut where
    // its deck lifts) until its caps were halves
    const SNAP = 1.1e-3, mPer = 1 / (tin.grid / tileSizeMeters(fixtureTile));
    const off: { kind: string; into: string; reach: number }[] = [];
    tin.tris.forEach((t, f) => {
      const cx = (tin.vx[t.a] + tin.vx[t.b] + tin.vx[t.c]) / 3, cy = (tin.vy[t.a] + tin.vy[t.b] + tin.vy[t.c]) / 3;
      const own = tin.cover![f] < 0 ? coverAt(cx, cy) : tin.cover![f];
      if (![t.a, t.b, t.c].some((v) => coverAt((cx + tin.vx[v]) / 2, (cy + tin.vy[v]) / 2) !== own)) return;
      // how far into the face the other cover reaches (from its sides), lattice cells
      const P = [t.a, t.b, t.c].map((v) => [tin.vx[v], tin.vy[v]]);
      let reach = 0, into = own;
      for (let i = 0; i <= 30; i++) for (let j = 0; i + j <= 30; j++) {
        const a = i / 30, b = j / 30, c = 1 - a - b, x = a * P[0][0] + b * P[1][0] + c * P[2][0], y = a * P[0][1] + b * P[1][1] + c * P[2][1];
        const at = coverAt(x, y);
        if (at === own) continue;
        const d = Math.min(...[0, 1, 2].map((e) => {
          const [ax, ay] = P[e], [bx, by] = P[(e + 1) % 3], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          return Math.hypot(x - ax - dx * u, y - ay - dy * u);
        }));
        if (d > reach) [reach, into] = [d, at];
      }
      const kindOf = (si: number) => (si < 0 ? 'ground' : cover.shapes[si].kind);
      off.push({ kind: kindOf(own), into: kindOf(into), reach });
    });
    const deep = off.filter((o) => o.reach > SNAP);
    expect(deep.length).toBeLessThanOrEqual(4);
    // each between a road's cover and what it meets (a bridge's approach's shoulder mitred onto its lifted deck reaches 11–16 cm past its end line)
    expect(deep.filter((o) => ![o.kind, o.into].some((k) => ['carriageway', 'shoulder', 'path'].includes(k)))).toEqual([]);
    expect(Math.max(0, ...off.map((o) => o.reach)) * mPer).toBeLessThan(0.2);
    // the junctions' surfaces (junctions.ts) meet their arms' trimmed ends and round their kerbs: a few more shallow slivers there
    expect(off.length).toBeLessThanOrEqual(18);
  });

  it('Fethiye 14/9517/6397: no face of a road’s cover falls more than 0.5 m to a river’s water: no road-cover vertex takes its level', async () => {
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6397');
    const pull = roadPullOf(fx.tile, fx.grid, roads!, true);
    const wet: string[] = [];
    tin.tris.forEach((t, f) => {
      const own = tin.cover![f];
      if (own < 0 || !['carriageway', 'shoulder', 'path'].includes(cover.shapes[own].kind)) return;
      const top = Math.max(...[t.a, t.b, t.c].map((v) => tin.vh[v]));
      for (const v of [t.a, t.b, t.c]) {
        const x = tin.vx[v], y = tin.vy[v], water = pull.surface(x, y, 0), land = pull.surface(x, y, 0, () => true);
        // on a river's water (its level, whatever the relief) and at it, below the face's top
        if (water !== land && water === pull.surface(x, y, 1000) && Math.abs(tin.vh[v] - water) < 1e-3 && top - tin.vh[v] > 0.5) wet.push(`${cover.shapes[own].kind} ${x.toFixed(3)},${y.toFixed(3)} ${tin.vh[v].toFixed(2)} under ${top.toFixed(2)}`);
      }
    });
    expect(wet).toEqual([]);
  });

  it('Fethiye 14/9517/6397: the deck of Celal Bayar Caddesi lifted over the whole reach of the canal it crosses, the canal’s water under all its width, no road’s cover over the water', async () => {
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6397');
    const c = tileCenter(fx.tile), enu = ([lon, lat]: [number, number]): [number, number] => { const [e, n] = latLonToEnu(c, lat, lon, 0); return [e, -n]; };
    const net = roads!.net, wi = net.ways.findIndex((x) => x.bridge && Math.abs(x.line.points[0][1] - 36.64778) < 2e-4 && Math.abs(x.line.points[0][0] - 29.12805) < 2e-4), w = net.ways[wi];
    const runs = bridgeDecks(fx.tile, fx.grid, roads!, enu).get(w.line)!;
    const pull = roadPullOf(fx.tile, fx.grid, roads!, true), toL = tileLattice(fx.tile, fx.grid), locate = tinLocator(tin, fx.tile);
    const [a, b] = [w.line.points[0], w.line.points[w.line.points.length - 1]].map(enu);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len, half = classifyLine(w.line.tags)!.width / 2 - 0.1;
    // one stretch: the canal's half width (4 m) and its bank either side of the crossing, whatever the bank roads under it
    const reach = bridgeCrossings(net, fx.data.lines)[wi];
    expect(reach.length).toBe(1);
    expect(reach[0][1] - reach[0][0]).toBeCloseTo(2 * (4 + BANK_M), 6);
    expect(runs.length).toBe(1);
    expect(runs[0][0]).toBeLessThanOrEqual(Math.max(0, reach[0][0]) + 0.02);
    expect(runs[0][1]).toBeGreaterThanOrEqual(Math.min(len, reach[0][1]) - 0.02);
    for (let o = -half; o <= half + 1e-9; o += half / 4) {
      let water = 0;
      for (let d = 0.05; d < len; d += 0.1) {
        const { lon, lat } = enuToLatLon(c, a[0] + ux * d - uz * o, -(a[1] + uz * d + ux * o), 0), [x, y] = toL([lon, lat]);
        // over the canal's water (its level, whatever the relief): the deck lifted, the face under it the canal's, at its level
        const level = pull.surface(x, y, 0);
        if (level !== pull.surface(x, y, 1000) || level === pull.surface(x, y, 0, () => true)) continue;
        expect(runs.some(([r0, r1]) => d >= r0 && d <= r1)).toBe(true);
        const f = locate(lon, lat)!.tri, own = tin.cover![f], kind = own >= 0 ? cover.shapes[own].kind : pull.bank(x, y) ? 'bank' : 'ground';
        // the water, or its bank down from a road's cover's edge; never a road's cover
        expect(['water', 'bank']).toContain(kind);
        if (kind === 'water') water++;
      }
      // the channel between the bank roads' beds: 2.5 m of it or more across all the deck's width
      expect(water).toBeGreaterThanOrEqual(25);
    }
  });

  it('Fethiye 14/9517/6397: over the deck of Celal Bayar Caddesi (its bridge over the canal) one asphalt within 0.3 m of the deck, no step where it lifts', async () => {
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6397');
    const c = tileCenter(fx.tile);
    const enu = (lon: number, lat: number): [number, number] => { const [e, n] = latLonToEnu(c, lat, lon, 0); return [e, -n]; };
    const sample = tinSampler(tin, fx.tile);
    const m = buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight: sample, tin, buildings: false, roads, cover, faceColor: () => 0 } as OsmMeshOptions).roads;
    const net = roads!.net, w = net.ways.find((x) => x.bridge && Math.abs(x.line.points[0][1] - 36.64778) < 2e-4 && Math.abs(x.line.points[0][0] - 29.12805) < 2e-4)!;
    const deck = Array.from(roads!.z.subarray(w.first, w.first + w.count));
    const [a, b] = [w.line.points[0], w.line.points[w.line.points.length - 1]].map(([lon, lat]) => enu(lon, lat));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len, half = classifyLine(w.line.tags)!.width / 2 - 0.1;
    const off: string[] = [];
    let worstStep = 0, brows = 0;
    for (let o = -half; o <= half + 1e-9; o += half / 4) {
      let prev: number | undefined;
      for (let d = 0.05; d < len - 0.05; d += 0.1) {
        const x = a[0] + ux * d - uz * o, z = a[1] + uz * d + ux * o, hs = surfacesOver(m, x, z);
        // the deck's own height there (its samples' along it)
        const f = (d / len) * (deck.length - 1), i = Math.min(deck.length - 2, Math.floor(f)), here = deck[i] + (deck[i + 1] - deck[i]) * (f - i);
        if (hs.length !== 1 || hs[0] < here - 0.3 || hs[0] > here + 0.05) off.push(`${d.toFixed(1)} ${o.toFixed(1)}: ${hs.map((h) => h.toFixed(2))} deck ${here.toFixed(2)}`);
        // but on a bank's brow: under its floor the deck lies on the face, down to the floor under its height
        const { lon, lat } = enuToLatLon(c, x, -z, 0), brow = hs.length === 1 && hs[0] < here - 0.05 && Math.abs(hs[0] - sample(lon, lat)) < 1e-3;
        if (brow) brows++;
        if (hs.length === 1 && !brow && prev !== undefined) worstStep = Math.max(worstStep, Math.abs(hs[0] - prev));
        prev = hs.length === 1 && !brow ? hs[0] : undefined;
      }
    }
    expect(off).toEqual([]);
    expect(worstStep).toBeLessThanOrEqual(0.05);
    // 10 of the 909 probes
    expect(brows).toBeLessThanOrEqual(10);
  }, 30_000);

  it('Fethiye 14/9517/6397: under a drawn piece of the deck of Celal Bayar Caddesi no face of the surface (ground, bank, shoulder, carriageway, water) within 0.3 m of it', async () => {
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6397');
    const c = tileCenter(fx.tile);
    const enu = (lon: number, lat: number): [number, number] => { const [e, n] = latLonToEnu(c, lat, lon, 0); return [e, -n]; };
    const sample = tinSampler(tin, fx.tile), locate = tinLocator(tin, fx.tile);
    const m = buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight: sample, tin, buildings: false, roads, cover, faceColor: () => 0 } as OsmMeshOptions).roads;
    const net = roads!.net, w = net.ways.find((x) => x.bridge && Math.abs(x.line.points[0][1] - 36.64778) < 2e-4 && Math.abs(x.line.points[0][0] - 29.12805) < 2e-4)!;
    const [a, b] = [w.line.points[0], w.line.points[w.line.points.length - 1]].map(([lon, lat]) => enu(lon, lat));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len, half = classifyLine(w.line.tags)!.width / 2 - 0.1;
    const runs = bridgeDecks(fx.tile, fx.grid, roads!, ([lon, lat]) => enu(lon, lat)).get(w.line)!;
    const near: string[] = [];
    let probes = 0, decked = 0;
    for (let o = -half; o <= half + 1e-9; o += half / 7) {
      for (let d = 0.05; d < len; d += 0.1) {
        const x = a[0] + ux * d - uz * o, z = a[1] + uz * d + ux * o, { lon, lat } = enuToLatLon(c, x, -z, 0);
        probes++;
        const own = tin.cover![locate(lon, lat)!.tri], kind = own >= 0 ? cover.shapes[own].kind : 'ground';
        const ground = sample(lon, lat);
        for (const h of surfacesOver(m, x, z)) {
          // on the face itself: a carriageway's own face, or the deck's asphalt under its floor laid on the ground's (a depth level over it)
          if (Math.abs(h - ground) < 1e-3) continue;
          decked++;
          if (h - ground < 0.3) near.push(`${d.toFixed(1)} ${o.toFixed(1)}: deck ${h.toFixed(2)} over ${kind} ${ground.toFixed(2)}`);
        }
      }
    }
    expect(probes).toBeGreaterThan(1400);
    // the deck drawn over the canal and its banks
    expect(runs.length).toBe(1);
    expect(decked).toBeGreaterThan(200);
    expect(near).toEqual([]);
  }, 30_000);

  it('Innsbruck 14/8710/5744: the budget filled in one build, no road above a service road nor a track’s ballast left out, no crack', async () => {
    const { tin, cover, stats, debug } = await surfaceOf('surface-14-8710-5744');
    expect(cracks(tin)).toBe(0);
    expect(debug.missing).toBe(0);
    expect(stats.builds).toBe(1);
    expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
    expect(tin.vx.length).toBeGreaterThan(0.9 * MAX_SURFACE_VERTS);
    const loose = tin.loose ?? new Set<OsmLine>();
    expect([...loose].filter((l) => MAJOR.test(l.tags.highway ?? ''))).toEqual([]);
    expect(cover.shapes.filter((s) => s.kind === 'ballast' && loose.has(s.source as OsmLine))).toEqual([]);
  });
});

describe('the z14 relief of real hills', () => {
  it('Fethiye 14/9514/6399 (no ways): no scar, no lattice of nodes', async () => {
    // isolines simplified to a cell and more and moved uphill (inscribed) lay 20 m under the ground
    // beside the relief's nodes at their own height: needles a metre wide and hundreds of metres
    // long down the slopes; and the nodes, 2000 of them, on the lattice: its squares read
    const { tin, fx } = await surfaceOf('surface-14-9514-6399-hills');
    const g = fx.grid, cell = tileSizeMeters(fx.tile) / g, { vx, vy, vh } = tin;
    const onBorder = (k: number) => vx[k] === 0 || vy[k] === 0 || vx[k] === g || vy[k] === g;
    const scars: string[] = [];
    for (const t of tin.tris) {
      const p = [t.a, t.b, t.c];
      if (p.some(onBorder)) continue;
      const longest = Math.max(...[0, 1, 2].map((k) => Math.hypot(vx[p[k]] - vx[p[(k + 1) % 3]], vy[p[k]] - vy[p[(k + 1) % 3]]))) * cell;
      const area = (Math.abs((vx[t.b] - vx[t.a]) * (vy[t.c] - vy[t.a]) - (vx[t.c] - vx[t.a]) * (vy[t.b] - vy[t.a])) / 2) * cell * cell;
      const width = (2 * area) / longest, rise = Math.max(...p.map((k) => vh[k])) - Math.min(...p.map((k) => vh[k]));
      // a scar: a node of the lattice (the relief's, at its own height) in a needle with an isoline's
      // vertices; not a cliff out of the sea (a vertex of the coastline, at 0 m)
      const node = p.some((k) => Number.isInteger(vx[k]) && Number.isInteger(vy[k])) && p.every((k) => vh[k] > 0);
      if (node && longest > 60 && width < 3 && rise > 2 * Math.max(width, 1)) scars.push(`${p.map((k) => `${vx[k].toFixed(2)},${vy[k].toFixed(2)}@${vh[k].toFixed(1)}`).join(" ")} ${longest.toFixed(0)} m by ${width.toFixed(2)} m, ${rise.toFixed(1)} m up`);
    }
    expect(scars).toEqual([]);
    let nodes = 0;
    for (let k = 0; k < vx.length; k++) if (!onBorder(k) && Number.isInteger(vx[k]) && Number.isInteger(vy[k])) nodes++;
    expect(nodes).toBeLessThan(600);
  });
});

describe('a real shore the DEM blurs past the coastline', () => {
  it('Fethiye 14/9516/6398 (its ways within 400 m of 36.62237, 29.10385): the sea flat at 0 m, a road\'s edge past the coastline too', async () => {
    // the DEM has 5–13 m on the coastline's sea side here: the nodes there, the roads' edges and the
    // vertices on their rows tilted the water faces up to them, in a sawtooth along the shore
    const { tin } = await surfaceOf('surface-14-9516-6398-shore');
    const tilted: string[] = [];
    let sea = 0;
    tin.tris.forEach((t, f) => {
      if (!tin.sea?.[f]) return;
      sea++;
      // the border's vertices stay as the neighbour draws them (the DEM's profile there, terrain-tin)
      const g = tin.grid, onBorder = (v: number) => tin.vx[v] === 0 || tin.vy[v] === 0 || tin.vx[v] === g || tin.vy[v] === g;
      for (const v of [t.a, t.b, t.c]) if (tin.vh[v] > 0 && !onBorder(v)) tilted.push(`${tin.vx[v].toFixed(3)},${tin.vy[v].toFixed(3)} ${tin.vh[v].toFixed(2)}`);
    });
    expect(sea).toBeGreaterThan(500);
    expect(tilted).toEqual([]);
  });
});

describe('a real river mouth: the roads over the DEM\'s shoreline', () => {
  it('Fethiye 14/9517/6398 (its ways within 250 m of the bridges at 36.62525, 29.11589): every vertex of a road\'s cover on its bed at the road\'s height, but in the sea', async () => {
    // the shoreline of the DEM (its 0.5 m line, at 0 m) runs along the river to its mouth, under
    // the ends of the bridges there; a road's vertices on it stayed at 0 m, 3 m under the road
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6398-mouth');
    const pull = roadPullOf(fx.tile, fx.grid, roads!, true), g = fx.grid;
    const wet = new Uint8Array(tin.vx.length);
    tin.tris.forEach((t, f) => { if (tin.sea?.[f]) wet[t.a] = wet[t.b] = wet[t.c] = 1; });
    const off: string[] = [];
    let checked = 0;
    tin.tris.forEach((t, f) => {
      const own = tin.cover![f];
      if (own < 0 || !['carriageway', 'shoulder'].includes(cover.shapes[own].kind)) return;
      for (const v of [t.a, t.b, t.c]) {
        const x = tin.vx[v], y = tin.vy[v];
        if (wet[v] || x === 0 || y === 0 || x === g || y === g || pull.weight(x, y) < 1) continue;
        checked++;
        const want = pull.surface(x, y, 0, () => true);
        if (Math.abs(tin.vh[v] - want) > 0.05) off.push(`${x.toFixed(3)},${y.toFixed(3)} ${tin.vh[v].toFixed(2)} not ${want.toFixed(2)}`);
      }
    });
    expect(checked).toBeGreaterThan(1000);
    expect(off).toEqual([]);
  });

  it('Fethiye 14/9517/6398: the four bridges side by side over the river\'s mouth (a street, a pedestrian way, a cycleway, a footway) at one level, the footway\'s and the cycleway\'s by the roads\' rules', async () => {
    // they stood 3.6–4 m (the street's and the pedestrian way's) and 6–7 m (the paths', lifted over
    // the drawn ground: their clearance over the water stood on the banks)
    const { tin, cover, roads, fx } = await surfaceOf('surface-14-9517-6398-mouth');
    const c = tileCenter(fx.tile);
    const m = buildOsmMesh({ tile: fx.tile, detail: 'full', data: { ...fx.data, buildings: [] }, sampleHeight: tinSampler(tin, fx.tile), tin, buildings: false, roads, cover, faceColor: () => 0 } as OsmMeshOptions).roads;
    const decks = ['secondary', 'pedestrian', 'cycleway', 'footway'].map((hw) => {
      const line = fx.data.lines.find((l) => l.tags.bridge === 'yes' && l.tags.highway === hw && Math.abs(l.points[0][1] - 36.6253) < 3e-4 && Math.abs(l.points[0][0] - 29.1158) < 3e-4)!;
      const [a, b] = [line.points[0], line.points[line.points.length - 1]].map(([lon, lat]) => latLonToEnu(c, lat, lon, 0));
      // a hair off its middle: on no side of a triangle
      const hs = [0.37, 0.43, 0.57].flatMap((t) => surfacesOver(m, a[0] + (b[0] - a[0]) * t + 0.013, -(a[1] + (b[1] - a[1]) * t) + 0.017));
      return Math.max(...hs);
    });
    expect(Math.max(...decks) - Math.min(...decks)).toBeLessThan(0.5);
    // over the water at 0 m, at the streets' level
    for (const h of decks) expect(h).toBeGreaterThan(3.3), expect(h).toBeLessThan(4.5);
  });
});

/** the heights of the mesh's triangles over (x, z) (tile-centre metres), on none of their sides */
function surfacesOver(m: { vertices: Float32Array; vertexCount: number }, x: number, z: number): number[] {
  const v = m.vertices, out: number[] = [];
  for (let t = 0; t + 2 < m.vertexCount; t += 3) {
    const p = [0, 1, 2].map((k) => [v[(t + k) * 6], v[(t + k) * 6 + 1], v[(t + k) * 6 + 2]]);
    const det = (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (p[1][2] - p[0][2]);
    if (Math.abs(det) < 1e-9) continue;
    const w1 = ((x - p[0][0]) * (p[2][2] - p[0][2]) - (p[2][0] - p[0][0]) * (z - p[0][2])) / det;
    const w2 = ((p[1][0] - p[0][0]) * (z - p[0][2]) - (x - p[0][0]) * (p[1][2] - p[0][2])) / det;
    if (w1 < 1e-7 || w2 < 1e-7 || w1 + w2 > 1 - 1e-7) continue;
    out.push(p[0][1] * (1 - w1 - w2) + p[1][1] * w1 + p[2][1] * w2);
  }
  return out;
}
