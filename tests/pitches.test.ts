import { describe, expect, it } from 'vitest';
import { rampGlowLevel, RAMP, withGlow } from '../src/engine/palette';
import { enuToLatLon, tileCenter, type Tile } from '../src/world/geodesy';
import { buildOsmMesh, LIT_PITCH_LINE_INDEX, PITCH_GLOW, PITCH_LINE_INDEX } from '../src/world/osm-mesher';
import type { LonLat, OsmTileData } from '../src/world/osm-types';
import { baseballMarkings, orientedRect, pitchFrame, pitchMarkings, pitchSport, pitchSurface, type PitchSport } from '../src/world/pitch-markings';
import { INSTANCE, TREE_STRIDE } from '../src/world/props-mesher';
import { buildTerrainTin, tinSampler } from '../src/world/terrain-tin';

describe('pitch kinds', () => {
  it('reads the first marked sport of sport=a;b', () => {
    expect(pitchSport({ sport: 'soccer' })).toBe('soccer');
    expect(pitchSport({ sport: 'multi;basketball' })).toBe('basketball');
    expect(pitchSport({ sport: 'hockey' })).toBe('field_hockey');
    expect(pitchSport({ sport: 'skateboard' })).toBeUndefined();
  });
  it('surfaces: grass keeps the imagery, others a solid colour, by sport when untagged', () => {
    expect(pitchSurface({ sport: 'soccer' })).toBeUndefined();
    expect(pitchSurface({ sport: 'soccer', surface: 'artificial_turf' })).toBeDefined();
    expect(pitchSurface({ sport: 'basketball' })).toBeDefined();
    expect(pitchSurface({ sport: 'tennis', surface: 'grass' })).toBeUndefined();
  });
});

describe('oriented rectangle', () => {
  it('finds a turned rectangle and its long side', () => {
    const a = 0.5, c = Math.cos(a), s = Math.sin(a);
    const ring: [number, number][] = [[-50, -30], [50, -30], [50, 30], [-50, 30]].map(([x, z]) => [10 + x * c - z * s, 20 + x * s + z * c]);
    const r = orientedRect(ring)!;
    expect(r.length).toBeCloseTo(100, 6);
    expect(r.width).toBeCloseTo(60, 6);
    expect(r.cx).toBeCloseTo(10, 6);
    expect(r.cz).toBeCloseTo(20, 6);
    expect(Math.abs(r.ux * c + r.uz * s)).toBeCloseTo(1, 6);
  });
});

describe('markings', () => {
  const sizes: Record<Exclude<PitchSport, 'baseball'>, [number, number]> = {
    soccer: [105, 68], ice_hockey: [60, 30], field_hockey: [91.4, 55], basketball: [28, 15], tennis: [23.77, 10.97], volleyball: [18, 9],
  };
  for (const [sport, [l, w]] of Object.entries(sizes) as [Exclude<PitchSport, 'baseball'>, [number, number]][]) {
    it(`${sport}: lines inside the pitch`, () => {
      const segs = pitchMarkings(sport, l, w)!;
      expect(segs.length).toBeGreaterThan(6);
      for (const [s0, t0, s1, t1] of segs) {
        for (const [s, t] of [[s0, t0], [s1, t1]]) {
          expect(Math.abs(s)).toBeLessThanOrEqual(l / 2 + 1e-6);
          expect(Math.abs(t)).toBeLessThanOrEqual(w / 2 + 1e-6);
        }
      }
    });
  }
  it('a court keeps its real size on a bigger plot, shrinks on a smaller one', () => {
    const span = (segs: number[][]) => Math.max(...segs.flatMap(([s0, , s1]) => [Math.abs(s0), Math.abs(s1)])) * 2;
    expect(span(pitchMarkings('basketball', 40, 25)!)).toBeCloseTo(28, 6);
    expect(span(pitchMarkings('basketball', 20, 12)!)).toBeLessThanOrEqual(20 + 1e-6);
  });
  it('baseball: a 27.43 m diamond from home and foul lines as long as the field', () => {
    const segs = baseballMarkings(100);
    expect(Math.hypot(segs[0][2], segs[0][3])).toBeCloseTo(27.43, 2);
    const foul = segs[4];
    expect(Math.hypot(foul[2], foul[3])).toBeCloseTo(100, 6);
  });
});

describe('pitch frame', () => {
  it('a soccer pitch: its markings at the rectangle’s size, in the rectangle’s frame', () => {
    const c = Math.cos(0.4), s = Math.sin(0.4);
    const ring = [[-52.5, -34], [52.5, -34], [52.5, 34], [-52.5, 34]].map(([x, z]): [number, number] => [100 + x * c - z * s, 50 + x * s + z * c]);
    const f = pitchFrame(ring, { leisure: 'pitch', sport: 'soccer' })!;
    expect(f.rect.length).toBeCloseTo(105, 6);
    expect(f.rect.width).toBeCloseTo(68, 6);
    expect(f.segs).toEqual(pitchMarkings('soccer', f.rect.length, f.rect.width));
    expect(f.frame).toBe(f.toXZ);
    // the corners of the touch lines are the ring's corners
    for (const [es, et] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const [x, z] = f.frame((es * f.rect.length) / 2, (et * f.rect.width) / 2);
      expect(Math.min(...ring.map(([px, pz]) => Math.hypot(px - x, pz - z)))).toBeLessThan(1e-6);
    }
  });
  it('baseball: from home plate, the fan’s right-angled corner, towards the middle', () => {
    const ring: [number, number][] = [[0, 0], [100, 0], [95, 60], [60, 95], [0, 100]];
    const f = pitchFrame(ring, { leisure: 'pitch', sport: 'baseball' })!;
    expect(f.frame(0, 0)[0]).toBeCloseTo(0, 9);
    expect(f.frame(0, 0)[1]).toBeCloseTo(0, 9);
    const reach = Math.max(...ring.map(([x, z]) => Math.hypot(x, z)));
    expect(f.segs).toEqual(baseballMarkings(reach * 0.95));
    const [x, z] = f.frame(10, 0);
    expect(Math.atan2(z, x)).toBeGreaterThan(0.6);
    expect(Math.atan2(z, x)).toBeLessThan(1);
  });
  it('no sport, no markings; no ring, no frame', () => {
    expect(pitchFrame([[0, 0], [30, 0], [30, 20], [0, 20]], { leisure: 'pitch' })!.segs).toBeUndefined();
    expect(pitchFrame([[0, 0], [30, 0]], { leisure: 'pitch', sport: 'soccer' })).toBeUndefined();
  });
});

describe('pitches in the mesh', () => {
  const TILE: Tile = { z: 14, x: 8800, y: 5500 };
  const GRID = 16;
  const tin = buildTerrainTin(TILE, GRID, new Float32Array((GRID + 1) * (GRID + 1)).fill(100));
  const center = tileCenter(TILE);
  /** a w × h m pitch in the middle of the tile */
  const pitch = (tags: Record<string, string>, w = 100, h = 60): OsmTileData => {
    const ring: LonLat[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]].map(([e, n]) => {
      const ll = enuToLatLon(center, e, n, 0);
      return [ll.lon, ll.lat];
    });
    return { areas: [{ rings: [ring], tags: { leisure: 'pitch', ...tags } }], lines: [], points: [], buildings: [] };
  };
  const build = (data: OsmTileData) => buildOsmMesh({ tile: TILE, detail: 'full', data, sampleHeight: tinSampler(tin, TILE), tin });
  const lampPosts = (m: { lampPosts: Float32Array }) => {
    const out: [number, number][] = [];
    for (let i = 0; i < m.lampPosts.length; i += TREE_STRIDE) if (m.lampPosts[i + 5] === INSTANCE.LAMP) out.push([m.lampPosts[i], m.lampPosts[i + 2]]);
    return out;
  };

  it('a football pitch: white 1 px markings, four floodlights on its corners, lit at night', () => {
    const m = build(pitch({ sport: 'soccer' }));
    expect(m.pitchLines.length).toBeGreaterThan(40 * 8);
    for (let i = 3; i < m.pitchLines.length; i += 4) expect(m.pitchLines[i]).toBe(LIT_PITCH_LINE_INDEX);
    const posts = lampPosts(m);
    expect(posts).toHaveLength(4);
    for (const [x, z] of posts) {
      expect(Math.abs(Math.abs(x) - 50)).toBeLessThan(2);
      expect(Math.abs(Math.abs(z) - 30)).toBeLessThan(2);
    }
    expect(m.lamps.length / 4).toBe(4);
    expect(Array.from(m.ramps).some((r) => rampGlowLevel(r) === PITCH_GLOW)).toBe(true);
  });

  it('no sport: no markings, still floodlit; a small one: neither', () => {
    const plain = build(pitch({}));
    expect(plain.pitchLines.length).toBe(0);
    expect(lampPosts(plain)).toHaveLength(4);
    const small = build(pitch({ sport: 'basketball' }, 15, 12));
    expect(lampPosts(small)).toHaveLength(0);
    expect(small.pitchLines.length).toBeGreaterThan(0);
    expect(small.pitchLines[3]).toBe(PITCH_LINE_INDEX);
    expect(Array.from(small.ramps).some((r) => withGlow(r, 0) === withGlow(RAMP.ASPHALT, 0) && rampGlowLevel(r) === PITCH_GLOW)).toBe(false);
  });
});
