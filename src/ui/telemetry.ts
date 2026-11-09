import type { Renderer } from '../engine/renderer';

const KEY = 'sim-unlimited-consent';

export type Consent = 'yes' | 'no' | null;

export function loadConsent(): Consent {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

export function saveConsent(allow: boolean): void {
  try {
    localStorage.setItem(KEY, allow ? 'yes' : 'no');
  } catch {
    // private mode: consent stays session-only
  }
}

/**
 * Q34: anonymous FPS/GPU/error reports to our own /api/report only.
 * Nothing is sent unless the canvas consent screen was accepted.
 */
export class Telemetry {
  private queue: Record<string, unknown>[] = [];
  private lastFlush = 0;
  private gpu = 'unknown';

  constructor(private enabled: () => boolean, renderer: Renderer) {
    try {
      const gl = renderer.gl;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    } catch {
      // privacy mode: GPU string stays unknown
    }
    window.addEventListener('error', (e) => this.report({ kind: 'error', message: e.message, source: e.filename, line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => this.report({ kind: 'rejection', message: String(e.reason) }));
  }

  report(event: Record<string, unknown>): void {
    if (!this.enabled()) return;
    this.queue.push({ ...event, ts: Date.now(), gpu: this.gpu });
    if (this.queue.length > 50) this.queue.shift();
  }

  tick(now: number, fps: number, drawCalls: number): void {
    if (!this.enabled()) return;
    if (now - this.lastFlush < 60000) return;
    this.lastFlush = now;
    this.report({ kind: 'perf', fps: Math.round(fps), drawCalls });
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    try {
      const body = JSON.stringify(batch);
      if (navigator.sendBeacon?.('/api/report', body)) return;
      void fetch('/api/report', { method: 'POST', body, keepalive: true }).catch(() => {});
    } catch {
      // offline: drop the batch
    }
  }
}