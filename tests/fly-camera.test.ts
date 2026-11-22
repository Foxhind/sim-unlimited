import { describe, expect, it } from 'vitest';
import { BOOST, cruiseSpeed, flyStep, forwardOf, look, noKeys, PITCH_LIMIT, SPEED_MAX, SPEED_MIN } from '../src/tools/fly-camera';

const close = (a: number[], b: number[]) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], 6));

describe('relief free flight', () => {
  it('yaw 0 looks north, 90° east', () => {
    close(forwardOf(0, 0), [0, 0, -1]);
    close(forwardOf(Math.PI / 2, 0), [1, 0, 0]);
  });

  it('W flies along the view, A/D level sideways, Space/Z straight up and down', () => {
    const k = noKeys();
    close(flyStep(0, 0, { ...k, forward: true }, 10, 1), [0, 0, -10]);
    close(flyStep(0, 0, { ...k, right: true }, 10, 1), [10, 0, 0]);
    close(flyStep(Math.PI / 2, 0, { ...k, left: true }, 10, 1), [0, 0, -10]);
    close(flyStep(0, 0.5, { ...k, up: true }, 10, 1), [0, 10, 0]);
    close(flyStep(0, 0, { ...k, down: true }, 10, 1), [0, -10, 0]);
    // looking down, W descends
    expect(flyStep(0, -0.5, { ...k, forward: true }, 10, 1)[1]).toBeLessThan(0);
  });

  it('diagonals are no faster, Shift boosts, nothing pressed stays', () => {
    const k = noKeys();
    const d = flyStep(0.3, 0.2, { ...k, forward: true, right: true, up: true }, 10, 1);
    expect(Math.hypot(...d)).toBeCloseTo(10, 6);
    expect(Math.hypot(...flyStep(0, 0, { ...k, forward: true, boost: true }, 10, 1))).toBeCloseTo(10 * BOOST, 6);
    close(flyStep(0, 0, k, 10, 1), [0, 0, 0]);
    close(flyStep(0, 0, { ...k, forward: true, back: true }, 10, 1), [0, 0, 0]);
  });

  it('mouse turns right and up, pitch is limited, yaw wraps', () => {
    const a = look(0, 0, 100, -100);
    expect(a.yaw).toBeGreaterThan(0);
    expect(a.pitch).toBeGreaterThan(0);
    expect(look(0, 0, 0, -1e6).pitch).toBe(PITCH_LIMIT);
    expect(look(0, 0, 0, 1e6).pitch).toBe(-PITCH_LIMIT);
    expect(Math.abs(look(3, 0, 1000, 0).yaw)).toBeLessThanOrEqual(Math.PI);
  });

  it('speed follows the altitude within its limits', () => {
    expect(cruiseSpeed(0)).toBe(SPEED_MIN);
    expect(cruiseSpeed(1e7)).toBe(SPEED_MAX);
    expect(cruiseSpeed(1000)).toBeGreaterThan(cruiseSpeed(200));
  });
});
