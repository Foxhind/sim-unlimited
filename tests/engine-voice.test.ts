import { describe, expect, it } from 'vitest';
import { AIRCRAFT } from '../src/flight/aircraft';
import { engineVoice } from '../src/flight/audio';

describe('engine voice', () => {
  it('takes the kind from the powerplant and gives each engine its own voice', () => {
    const v = (id: keyof typeof AIRCRAFT) => engineVoice(AIRCRAFT[id]);
    expect([v('c150').kind, v('c150').pans.length]).toEqual(['piston', 1]);
    expect([v('f16').kind, v('f16').pans.length]).toEqual(['fighter', 1]);
    expect([v('su27').kind, v('su27').pans.length]).toEqual(['fighter', 2]);
    expect([v('f117').kind, v('f117').pans.length]).toEqual(['turbojet', 2]);
    expect([v('an225').kind, v('an225').pans.length]).toEqual(['turbofan', 6]);
  });

  it('pans engines to their side of the airframe and a big fan spools slower than a fighter', () => {
    const an = engineVoice(AIRCRAFT.an225);
    expect(an.pans.filter((p) => p < 0)).toHaveLength(3);
    expect(an.pans.filter((p) => p > 0)).toHaveLength(3);
    for (const p of an.pans) expect(Math.abs(p)).toBeLessThanOrEqual(0.6);
    expect(an.spoolUp).toBeGreaterThan(engineVoice(AIRCRAFT.su27).spoolUp);
    expect(engineVoice(AIRCRAFT.c150).spoolUp).toBeLessThan(engineVoice(AIRCRAFT.f16).spoolUp);
  });
});
