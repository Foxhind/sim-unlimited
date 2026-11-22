/**
 * Thunderstorm lightning (Q48): when the strikes come, where, and how bright the sky is at a
 * moment. Deterministic from the seed; time is real seconds (a storm does not speed up with the
 * sim clock, its thunder is heard in real time).
 */

export interface Strike {
  /** when it struck, s */
  t0: number;
  /** where from the camera: bearing in degrees true and distance in m */
  bearingDeg: number;
  distanceM: number;
  /** its flashes, s after t0 (2 to 4 within 0.4 s) */
  pulses: number[];
  /** shapes the bolt (boltPath) */
  seed: number;
}

/** mean and least time between strikes, s */
const MEAN_GAP_S = 12;
const MIN_GAP_S = 2;
const NEAR_M = 2000;
const FAR_M = 15000;
/** a flash dies away in this long, s */
const PULSE_S = 0.09;

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 8) / 16777216;
  };
}

export class Lightning {
  last: Strike | undefined;
  private readonly rand: () => number;
  private next: number | undefined;

  constructor(seed = 0x51f15e) {
    this.rand = rng(seed);
  }

  private gap(): number {
    return Math.max(MIN_GAP_S, -Math.log(1 - this.rand()) * MEAN_GAP_S);
  }

  /** call every frame with the time in s; returns the strike that happened this frame, if one did */
  update(tSec: number, active: boolean): Strike | undefined {
    if (!active) {
      this.next = undefined;
      return undefined;
    }
    if (this.next === undefined) this.next = tSec + this.gap() / 2;
    if (tSec < this.next) return undefined;
    const pulses = [0];
    const count = 2 + Math.floor(this.rand() * 3);
    for (let i = 1; i < count; i++) pulses.push(pulses[i - 1] + 0.05 + this.rand() * 0.08);
    const strike: Strike = {
      t0: tSec,
      bearingDeg: this.rand() * 360,
      distanceM: NEAR_M + this.rand() * (FAR_M - NEAR_M),
      pulses,
      seed: Math.floor(this.rand() * 0x7fffffff),
    };
    this.last = strike;
    this.next = tSec + this.gap();
    return strike;
  }

  /** brightness of the sky at a time, 0..1: each flash snaps on and dies away, dimmer the further the strike */
  flash(tSec: number): number {
    const s = this.last;
    if (!s) return 0;
    const dt = tSec - s.t0;
    if (dt < 0 || dt > s.pulses[s.pulses.length - 1] + PULSE_S) return 0;
    let v = 0;
    for (const p of s.pulses) {
      const a = dt - p;
      if (a >= 0 && a < PULSE_S) v = Math.max(v, 1 - a / PULSE_S);
    }
    const near = 1 - 0.65 * ((s.distanceM - NEAR_M) / (FAR_M - NEAR_M));
    return v * near;
  }
}

/**
 * The bolt's shape: a jagged line from the cloud (y = 1) to the ground (y = 0), x its sideways
 * wander in the same units (fractions of its height).
 */
export function boltPath(seed: number, segments = 9): [number, number][] {
  const rand = rng(seed);
  const pts: [number, number][] = [[0, 1]];
  let x = 0;
  for (let i = 1; i <= segments; i++) {
    x += (rand() - 0.5) * 0.16;
    pts.push([x, 1 - i / segments]);
  }
  return pts;
}
