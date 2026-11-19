import { describe, expect, it } from 'vitest';
import { FarElevation } from '../src/world/far-elevation';
import type { Tile } from '../src/world/geodesy';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('FarElevation', () => {
  it('is undefined until its tile loads, then samples it; one load per tile', async () => {
    const loads: Tile[] = [];
    const far = new FarElevation(12, async (t) => { loads.push(t); return () => 581; });
    expect(far.heightAt(11.35, 47.26)).toBeUndefined();
    expect(far.heightAt(11.351, 47.261)).toBeUndefined();
    await flush();
    expect(far.heightAt(11.35, 47.26)).toBe(581);
    expect(loads).toHaveLength(1);
  });

  it('retries a failed tile only after a pause', async () => {
    let now = 0;
    let calls = 0;
    const far = new FarElevation(12, async () => { calls++; throw new Error('offline'); }, () => now);
    far.heightAt(11.35, 47.26);
    await flush();
    far.heightAt(11.35, 47.26);
    expect(calls).toBe(1);
    now = 11000;
    far.heightAt(11.35, 47.26);
    expect(calls).toBe(2);
  });
});
