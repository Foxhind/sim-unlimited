/**
 * The traffic lights' cycle (traffic-signals.ts): a junction's approaches grouped by their axes, each
 * group's slots, the junction's shift, and the lenses lit at a moment of sim time; the night duty
 */
import { describe, expect, it } from 'vitest';
import { isMinorRoad, LENS, SIGNAL, signalAspect, signalPlan, signalShift, type SignalApproach } from '../src/world/traffic-signals';
import type { P2 } from '../src/world/ribbon-shapes';

const at = (deg: number): P2 => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const ap = (deg: number, prio: number): SignalApproach => ({ facing: at(deg), prio });
const CYCLE = SIGNAL.PHASES * SIGNAL.PHASE_S;
/** a moment of the cycle's start (an epoch second divisible by the cycle) */
const T0 = 1_700_000_040;
/** green or yellow alone: traffic may go */
const go = (a: number) => (a & LENS.GREEN) !== 0 || a === LENS.YELLOW;

describe('signalPlan', () => {
  it('a 4-way crossing: two groups, the senior road the first half', () => {
    expect(signalPlan([ap(90, 5), ap(0, 6), ap(270, 5), ap(180, 6)])).toEqual([0b1100, 0b0011, 0b1100, 0b0011]);
  });
  it('a T: the road through one group, the street joining it the other', () => {
    expect(signalPlan([ap(0, 6), ap(180, 6), ap(90, 5)])).toEqual([0b0011, 0b0011, 0b1100]);
  });
  it('a single axis: open three slots of four', () => {
    expect(signalPlan([ap(10, 5), ap(185, 5)])).toEqual([0b0111, 0b0111]);
    expect(signalPlan([ap(0, 5)])).toEqual([0b0111]);
  });
  it('arms within 45° of an axis go with it', () => {
    expect(signalPlan([ap(0, 6), ap(200, 5), ap(90, 5)])).toEqual([0b0011, 0b0011, 0b1100]);
  });
  it('three axes: the senior half the cycle, the others a quarter each', () => {
    expect(signalPlan([ap(0, 7), ap(60, 6), ap(120, 5)])).toEqual([0b0011, 0b0100, 0b1000]);
  });
  it('four axes exactly 45° apart: four groups, a quarter each, the senior first', () => {
    const r = Math.SQRT1_2;
    const arms: SignalApproach[] = [{ facing: [0, 1], prio: 5 }, { facing: [1, 0], prio: 8 }, { facing: [-r, r], prio: 6 }, { facing: [r, r], prio: 7 }];
    expect(signalPlan(arms)).toEqual([0b1000, 0b0001, 0b0100, 0b0010]);
  });
  it('five arms on axes 36° apart: never more than four groups, each with its slots', () => {
    // axes closer than 45° join the first group they are parallel to: four groups at most in 180°
    // (the merge of the closest past PHASES is a guard)
    const masks = signalPlan([0, 36, 72, 108, 144].map((d, k) => ap(d, 9 - k)));
    expect(new Set(masks).size).toBeLessThanOrEqual(4);
    expect(masks.every((m) => m !== 0)).toBe(true);
    // no two groups share a slot
    const groups = [...new Set(masks)];
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) expect(groups[a] & groups[b]).toBe(0);
  });
  it('the same whatever the order the approaches come in', () => {
    const arms = [ap(0, 6), ap(93, 5), ap(181, 6), ap(268, 5), ap(45, 5.5)];
    const ref = signalPlan(arms);
    const perms = [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2]];
    for (const p of perms) {
      const got = signalPlan(p.map((k) => arms[k]));
      p.forEach((k, i) => expect(got[i]).toBe(ref[k]));
    }
  });
});

describe('signalShift', () => {
  it('stable, within the slots, not all the same', () => {
    const keys = Array.from({ length: 40 }, (_, k) => `37.${6000 + k * 7},55.${7000 + k * 3}`);
    const shifts = keys.map(signalShift);
    expect(keys.map(signalShift)).toEqual(shifts);
    for (const s of shifts) expect([0, 1, 2, 3]).toContain(s);
    expect(new Set(shifts).size).toBeGreaterThan(1);
  });
});

describe('isMinorRoad', () => {
  it('residential and lower are minor, tertiary and up (and links) not', () => {
    for (const h of ['residential', 'unclassified', 'living_street', 'service', 'track', 'road', 'pedestrian']) expect(isMinorRoad({ highway: h })).toBe(true);
    for (const h of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'primary_link', 'tertiary_link']) expect(isMinorRoad({ highway: h })).toBe(false);
  });
});

describe('signalAspect', () => {
  const asp = (mask: number, t: number, shift = 0) => signalAspect(mask, shift, false, T0 + t, 12, 0);
  it('green, yellow at the slot’s end, red, red and yellow, green', () => {
    const m = 0b0011;
    expect(asp(m, 0)).toBe(LENS.GREEN);
    // the slots 0 and 1 one long green: no yellow at the end of slot 0
    expect(asp(m, 14)).toBe(LENS.GREEN);
    expect(asp(m, 26.9)).toBe(LENS.GREEN);
    expect(asp(m, 27.1)).toBe(LENS.YELLOW);
    expect(asp(m, 29.9)).toBe(LENS.YELLOW);
    expect(asp(m, 30)).toBe(LENS.RED);
    expect(asp(m, 57.9)).toBe(LENS.RED);
    expect(asp(m, 58.1)).toBe(LENS.RED | LENS.YELLOW);
    expect(asp(m, 60)).toBe(LENS.GREEN);
  });
  it('a shift turns the whole schedule by its slots', () => {
    for (let t = 0; t < CYCLE; t += 0.7) expect(asp(0b0011, t, 1)).toBe(asp(0b0011, t + SIGNAL.PHASE_S, 0));
  });
  it('before the epoch too', () => {
    expect(signalAspect(0b0011, 0, false, -CYCLE * 3 + 1, 12, 0)).toBe(LENS.GREEN);
  });
  it('never two groups of a junction going at once; each goes within a cycle', () => {
    for (const plan of [[0b0111], [0b0011, 0b1100], [0b0011, 0b0100, 0b1000], [1, 2, 4, 8]]) {
      for (const shift of [0, 1, 2, 3]) {
        const went = plan.map(() => false);
        for (let t = 0; t < CYCLE; t += 0.25) {
          const a = plan.map((m) => signalAspect(m, shift, false, T0 + t, 12, 0));
          expect(a.filter(go).length).toBeLessThanOrEqual(1);
          a.forEach((x, i) => { if (x & LENS.GREEN) went[i] = true; });
        }
        expect(went.every(Boolean)).toBe(true);
      }
    }
  });
  it('on duty at night: yellow flashing at 1 Hz, in step, whatever the slot', () => {
    for (const h of [0, 2.5, 4.99]) {
      expect(signalAspect(0b0011, 0, true, T0 + 33, h, 100.2)).toBe(LENS.YELLOW);
      expect(signalAspect(0b1100, 3, true, T0 + 7, h, 100.2)).toBe(LENS.YELLOW);
      expect(signalAspect(0b0011, 0, true, T0 + 33, h, 100.7)).toBe(0);
    }
  });
  it('the normal cycle from 05:00, and all night where not on duty', () => {
    expect(signalAspect(0b0011, 0, true, T0, 5, 100.7)).toBe(LENS.GREEN);
    expect(signalAspect(0b0011, 0, true, T0, 23.5, 100.7)).toBe(LENS.GREEN);
    expect(signalAspect(0b0011, 0, false, T0, 2, 100.7)).toBe(LENS.GREEN);
    expect(signalAspect(0b0011, 0, false, T0 + 40, 2, 100.2)).toBe(LENS.RED);
  });
});
