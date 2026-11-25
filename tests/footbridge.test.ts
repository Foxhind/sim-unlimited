/**
 * A footbridge and the paths that climb to it: structures of one kind (decks on walls, the ground
 * under them left as it was), met in mitres; the rest of a long pavement a way on the ground
 */
import { describe, expect, it } from 'vitest';
import { deckJoint, PARAPET_M, PARAPET_THICK_M } from '../src/world/bridge-mesher';
import { latLonToEnu, tileCenter } from '../src/world/geodesy';
import { buildOsmMesh } from '../src/world/osm-mesher';
import type { LonLat } from '../src/world/osm-types';
import { buildRoadNet } from '../src/world/road-net';
import { bridgeDecks, DECK_CLEAR_M } from '../src/world/road-pull';
import { roadSurfaceOf } from '../src/world/surface-tin';
import { data, demOf, GRID, osmMeshOf, road, TILE } from './roads-helpers';

const flat = () => 100;
const c = tileCenter(TILE);
const enu = ([lon, lat]: LonLat): [number, number] => {
  const [e, n] = latLonToEnu(c, lat, lon, 0);
  return [e, -n];
};

/**
 * A footbridge (layer 1) west to east over a street, a pavement from its west end 4 cells (some
 * 110 m) south, a second pavement on from there, and one far from any bridge
 */
function fixture() {
  const street = road({ highway: 'tertiary' }, [[30, 10], [30, 50]]);
  const bridge = road({ highway: 'footway', bridge: 'yes', layer: '1' }, [[29.5, 30], [30.5, 30]]);
  const ramp = road({ highway: 'footway' }, [[29.5, 30], [29.5, 34]]);
  const on = road({ highway: 'footway' }, [[29.5, 34], [29.5, 40]]);
  const steps = road({ highway: 'steps' }, [[30.5, 30], [30.5, 30.5]]);
  const far = road({ highway: 'footway' }, [[10, 10], [14, 10]]);
  return { street, bridge, ramp, on, steps, far, d: data([street, bridge, ramp, on, steps, far]) };
}

describe('a footbridge and its approaches', () => {
  it('the network: the urban paths within reach of a footbridge\'s end along the paths are its approaches, structures like it', () => {
    const f = fixture();
    const net = buildRoadNet(f.d.lines);
    const way = (l: unknown) => net.ways.find((w) => w.line === l)!;
    expect([way(f.bridge).bridge, way(f.bridge).approach]).toEqual([true, undefined]);
    for (const l of [f.ramp, f.steps]) expect([way(l).bridge, way(l).approach]).toEqual([true, true]);
    // the pavement on from the ramp's foot begins further than the reach from the bridge: a way like any
    for (const l of [f.on, f.far, f.street]) expect([way(l).bridge, way(l).approach]).toEqual([false, undefined]);
    // a ramp mapped in two pieces: the second an approach too
    const half = [road({ highway: 'footway' }, [[29.5, 30], [29.5, 31]]), road({ highway: 'footway' }, [[29.5, 31], [29.5, 34]])];
    const net2 = buildRoadNet([f.street, f.bridge, ...half]);
    expect(net2.ways.filter((w) => w.approach).map((w) => w.line)).toEqual(half);
  });

  it('an approach is a deck only where the bridge\'s lift holds it up: from the bridge down to DECK_CLEAR_M, not all along the pavement', () => {
    const f = fixture();
    const net = buildRoadNet(f.d.lines), roads = roadSurfaceOf(TILE, f.d, net, demOf(net, flat));
    const decks = bridgeDecks(TILE, GRID, roads, enu);
    const wi = net.ways.findIndex((w) => w.line === f.ramp), w = net.ways[wi];
    const run = decks.get(f.ramp)!;
    expect(run.length).toBe(1);
    expect(run[0][0]).toBe(0);
    // its end: where the lift falls under DECK_CLEAR_M, well before the pavement's own
    const len = net.samples[w.first + w.count - 1].d;
    // (down at PATH_GRADE, 45°, between the network's samples, 10 m apart at most)
    expect(run[0][1]).toBeGreaterThan(4);
    expect(run[0][1]).toBeLessThan(10);
    expect(len).toBeGreaterThan(100);
    const lift = roads.lift!;
    let i = w.first;
    while (net.samples[i + 1].d < run[0][1]) i++;
    const t = (run[0][1] - net.samples[i].d) / (net.samples[i + 1].d - net.samples[i].d);
    expect(lift[i] + (lift[i + 1] - lift[i]) * t).toBeCloseTo(DECK_CLEAR_M, 1);
    // without the lift (a surface made by hand): no deck of an approach at all
    expect(bridgeDecks(TILE, GRID, { net, z: roads.z, dem: roads.dem }, enu).get(f.ramp)).toEqual([]);
  });

  it('the mesh: the ramp a deck on walls with parapets, met with the bridge in a mitre at their node', () => {
    const f = fixture();
    const { opts, cover } = osmMeshOf(f.d, flat);
    const b = buildOsmMesh({ ...opts, cover }).bridges;
    const v: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < b.vertexCount; i++) v.push({ x: b.vertices[i * 6], y: b.vertices[i * 6 + 1], z: b.vertices[i * 6 + 2] });
    const node = enu(f.ramp.points[0]);
    // the ramp down from the bridge (its stretch to the next vertex of its line): its walls at its edges (1 m each side), from under the ground to the parapet's top over the deck
    const at30 = v.filter((p) => p.z - node[1] > 0.5 && p.z - node[1] < 12 && Math.abs(p.x - node[0]) < 3);
    expect(at30.length).toBeGreaterThan(0);
    expect(Math.max(...at30.map((p) => Math.abs(p.x - node[0])))).toBeCloseTo(1, 1);
    expect(Math.min(...at30.map((p) => p.y))).toBeLessThan(100);
    const top = Math.max(...at30.map((p) => p.y));
    expect(top).toBeGreaterThan(100 + 1 + PARAPET_M);
    expect(top).toBeLessThan(100 + 6 + PARAPET_M + 0.01);
    // nothing built along the pavement past the deck's end
    expect(v.filter((p) => p.z - node[1] > 15 && Math.abs(p.x - node[0]) < 3)).toEqual([]);
    // at the node, from the deck up: the node itself and the two decks' shared corners (their edges' and their parapets' inner edges'), no square end
    const legs = [{ dir: [1, 0] as [number, number], half: 1 }, { dir: [0, 1] as [number, number], half: 1 }];
    const corners = [node, ...deckJoint(node, legs).flatMap((e) => [e.l, e.r]), ...deckJoint(node, legs, PARAPET_THICK_M).flatMap((e) => [e.l, e.r])];
    const deck = Math.max(...v.filter((p) => Math.hypot(p.x - node[0], p.z - node[1]) < 0.05).map((p) => p.y));
    const round = v.filter((p) => Math.hypot(p.x - node[0], p.z - node[1]) < 1.6 && p.y > deck - 0.01);
    expect(round.length).toBeGreaterThan(12);
    for (const p of round) expect(Math.min(...corners.map((q) => Math.hypot(p.x - q[0], p.z - q[1])))).toBeLessThan(0.02);
    // each outer corner carries a parapet's top: the parapets run on round the corner
    for (const q of deckJoint(node, legs)[0] ? [deckJoint(node, legs)[0].l, deckJoint(node, legs)[0].r] : []) {
      expect(round.some((p) => Math.hypot(p.x - q[0], p.z - q[1]) < 0.02 && Math.abs(p.y - (deck + 0.03 + PARAPET_M)) < 0.02)).toBe(true);
    }
  });
});
