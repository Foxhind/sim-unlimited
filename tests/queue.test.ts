import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestQueue, RetryableError } from '../src/engine/queue';

describe('RequestQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs higher priority (lower number) first', async () => {
    const q = new RequestQueue(1);
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
    };
    const p1 = q.submit('low', 10, job('low'));
    const p2 = q.submit('high', 1, job('high'));
    const p3 = q.submit('mid', 5, job('mid'));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([p1, p2, p3]);
    expect(order[0]).toBe('low'); // first submit starts immediately
    expect(order.slice(1)).toEqual(['high', 'mid']);
  });

  it('caps concurrency', async () => {
    const q = new RequestQueue(2);
    let running = 0;
    let peak = 0;
    const job = () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
    };
    const ps = Array.from({ length: 6 }, (_, i) => q.submit(`j${i}`, i, job()));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(ps);
    expect(peak).toBe(2);
  });

  it('dedups by key and keeps the better priority', async () => {
    const q = new RequestQueue(1);
    let calls = 0;
    const run = async () => {
      calls++;
      return 42;
    };
    const blocker = q.submit('block', 0, async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const a = q.submit('same', 10, run);
    const b = q.submit('same', 2, run);
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([blocker, a, b]);
    expect(calls).toBe(1);
  });

  it('backs off exponentially on RetryableError then succeeds', async () => {
    const q = new RequestQueue(1, 100, 10000);
    let attempts = 0;
    const p = q.submit('flaky', 0, async () => {
      attempts++;
      if (attempts < 3) throw new RetryableError(0);
      return 'ok';
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(200); // 100*2^1
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(400); // 100*2^2
    expect(attempts).toBe(3);
    await expect(p).resolves.toBe('ok');
  });

  it('rejects non-retryable errors and frees the slot', async () => {
    const q = new RequestQueue(1);
    const p = q.submit('bad', 0, async () => {
      throw new Error('fatal');
    });
    await expect(p).rejects.toThrow('fatal');
    expect(q.activeCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it('gives up after max attempts', async () => {
    const q = new RequestQueue(1, 10, 100);
    let attempts = 0;
    const p = q.submit('always', 0, async () => {
      attempts++;
      throw new RetryableError(0);
    });
    const expectation = expect(p).rejects.toBeInstanceOf(RetryableError);
    await vi.advanceTimersByTimeAsync(100000);
    await expectation;
    expect(attempts).toBe(7); // initial + 6 retries
  });
});