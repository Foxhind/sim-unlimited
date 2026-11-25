export class RetryableError extends Error {
  constructor(readonly retryMs: number, message = 'retryable') {
    super(message);
  }
}

const MAX_SERVER_DELAY_MS = 600000;

interface Entry<T> {
  key: string;
  priority: number;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  promise: Promise<T>;
  attempts: number;
  notBefore: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** tile workers of a kind (terrain, OSM): half the cores, 2 to TILE_WORKERS.MAX (2 alike everywhere left a dense city centre minutes behind) */
export const TILE_WORKERS = { MIN: 2, MAX: 4 } as const;
export function tileWorkerCount(cores: number | undefined = globalThis.navigator?.hardwareConcurrency): number {
  return Math.max(TILE_WORKERS.MIN, Math.min(TILE_WORKERS.MAX, Math.floor((cores ?? 4) / 2)));
}

/**
 * Priority queue with capped concurrency, key dedup and exponential backoff
 * for RetryableError (429/504). Lower priority number runs first.
 */
export class RequestQueue {
  private pending = new Map<string, Entry<unknown>>();
  private active = 0;

  constructor(readonly concurrency: number, private baseBackoffMs = 1000, private maxBackoffMs = 30000) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  get activeCount(): number {
    return this.active;
  }

  submit<T>(key: string, priority: number, run: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise as Promise<T>;
    }
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry<T> = { key, priority, run, resolve, reject, promise, attempts: 0, notBefore: 0 };
    this.pending.set(key, entry as Entry<unknown>);
    this.pump();
    return promise;
  }

  cancel(key: string): void {
    const e = this.pending.get(key);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    this.pending.delete(key);
    e.reject(new Error('cancelled'));
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const now = Date.now();
      let best: Entry<unknown> | undefined;
      for (const e of this.pending.values()) {
        if (e.notBefore > now || e.timer) continue;
        if (!best || e.priority < best.priority) best = e;
      }
      if (!best) return;
      this.pending.delete(best.key);
      this.active++;
      void this.execute(best);
    }
  }

  private async execute(e: Entry<unknown>): Promise<void> {
    try {
      const result = await e.run();
      e.resolve(result);
    } catch (err) {
      if (err instanceof RetryableError && e.attempts < 6) {
        e.attempts++;
        // a delay the server asked for (Retry-After) is honoured, not capped by the backoff ceiling
        const delay = err.retryMs > 0 ? Math.min(MAX_SERVER_DELAY_MS, err.retryMs) : Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** e.attempts);
        e.notBefore = Date.now() + delay;
        this.pending.set(e.key, e);
        e.timer = setTimeout(() => {
          e.timer = undefined;
          this.pump();
        }, delay);
      } else {
        e.reject(err);
      }
    } finally {
      this.active--;
      this.pump();
    }
  }
}