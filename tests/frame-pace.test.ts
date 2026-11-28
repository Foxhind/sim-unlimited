import { describe, expect, it } from 'vitest';
import { FramePacer } from '../src/engine/frame-pace';

/** frames drawn per second over the second half of a 10 s run at `hz` */
function drawnAt(hz: number): number {
  const p = new FramePacer();
  let drawn = 0;
  for (let i = 1; i <= hz * 10; i++) {
    const jitter = ((i * 7919) % 11) / 11 - 0.5; // ±0.5 ms, repeatable
    if (!p.capped((i * 1000) / hz + jitter * 0.4) && i > hz * 5) drawn++;
  }
  return drawn / 5;
}

describe('frame pacing', () => {
  it('caps a fast display near 60 fps and leaves 60 to 90 Hz in full', () => {
    expect(drawnAt(60)).toBeCloseTo(60, 0);
    expect(drawnAt(90)).toBeCloseTo(90, 0);
    expect(drawnAt(120)).toBeCloseTo(60, 0);
    expect(drawnAt(144)).toBeCloseTo(72, 0);
    expect(drawnAt(240)).toBeCloseTo(60, 0);
  });

  it('draws a still picture once a second, and for a moment after every change', () => {
    const p = new FramePacer(1000, 300);
    const frames = (from: number, to: number, key: string) => {
      let n = 0;
      for (let t = from; t < to; t += 10) if (!p.still(t, key)) n++;
      return n;
    };
    expect(frames(0, 300, 'a')).toBe(30); // first sight: every frame for 300 ms
    expect(frames(300, 2300, 'a')).toBe(2); // then once a second
    expect(frames(2300, 2600, 'b')).toBe(30); // a change: every frame again
    p.wake();
    expect(p.still(2600, 'b')).toBe(false);
  });
});
