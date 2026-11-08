import { describe, expect, it } from 'vitest';
import { GROUND_SIZE, groundHeight } from '../src/world/ground';

describe('groundHeight (M0 placeholder)', () => {
  it('is periodic over GROUND_SIZE so floating-origin offsets tile seamlessly', () => {
    for (const [x, z] of [[0, 0], [1234.5, -9876.5], [20480, 3000], [-15000, 15000]]) {
      expect(groundHeight(x + GROUND_SIZE, z)).toBeCloseTo(groundHeight(x, z), 6);
      expect(groundHeight(x, z + GROUND_SIZE)).toBeCloseTo(groundHeight(x, z), 6);
      expect(groundHeight(x + GROUND_SIZE, z - GROUND_SIZE)).toBeCloseTo(groundHeight(x, z), 6);
    }
  });

  it('produces finite heights in a gentle range', () => {
    for (let x = -20480; x <= 20480; x += 640) {
      for (let z = -20480; z <= 20480; z += 640) {
        const h = groundHeight(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(Math.abs(h)).toBeLessThan(60);
      }
    }
  });
});