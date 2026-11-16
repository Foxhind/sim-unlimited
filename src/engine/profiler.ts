/**
 * Per-stage frame profiler (the rim lab, rim.html): CPU time of each stage (JS, including issuing
 * its GL commands) and, where the browser exposes EXT_disjoint_timer_query_webgl2, its GPU time.
 * Off unless enabled: then stage() / end() cost a function call each.
 */

/** averaging window, frames */
const WINDOW = 60;

interface Stage {
  cpu: number[];
  gpu: number[];
}

interface Pending {
  name: string;
  q: WebGLQuery;
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export interface StageStats {
  name: string;
  /** mean CPU ms per frame */
  cpu: number;
  /** mean GPU ms per frame, undefined without the timer extension (or before results arrive) */
  gpu?: number;
}

export interface FrameStats {
  fps: number;
  /** mean time between frames, ms */
  frameMs: number;
  /** mean JS time inside the frame, ms */
  cpuMs: number;
  /** sum of the stages' GPU times, ms */
  gpuMs?: number;
  gpuTimer: boolean;
  stages: StageStats[];
}

class Profiler {
  enabled = false;
  private gl: WebGL2RenderingContext | undefined;
  private ext: TimerExt | null = null;
  private stages = new Map<string, Stage>();
  private order: string[] = [];
  private current: string | undefined;
  private t0 = 0;
  private query: WebGLQuery | null = null;
  private pending: Pending[] = [];
  private free: WebGLQuery[] = [];
  private frameT0 = 0;
  private lastFrame = 0;
  private frames: number[] = [];
  private cpuFrames: number[] = [];

  enable(gl: WebGL2RenderingContext): void {
    this.enabled = true;
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  frameStart(now: number): void {
    if (!this.enabled) return;
    if (this.lastFrame > 0) push(this.frames, now - this.lastFrame);
    this.lastFrame = now;
    this.frameT0 = performance.now();
    this.collect();
  }

  frameEnd(): void {
    if (!this.enabled) return;
    this.end();
    push(this.cpuFrames, performance.now() - this.frameT0);
  }

  /** ends the stage running, if any, and starts `name` */
  stage(name: string): void {
    if (!this.enabled) return;
    this.end();
    this.current = name;
    if (!this.stages.has(name)) {
      this.stages.set(name, { cpu: [], gpu: [] });
      this.order.push(name);
    }
    const gl = this.gl;
    if (gl && this.ext) {
      this.query = this.free.pop() ?? gl.createQuery();
      if (this.query) gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    }
    this.t0 = performance.now();
  }

  end(): void {
    if (!this.enabled || this.current === undefined) return;
    const name = this.current;
    push(this.stages.get(name)!.cpu, performance.now() - this.t0);
    const gl = this.gl;
    if (gl && this.ext && this.query) {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push({ name, q: this.query });
      this.query = null;
    }
    this.current = undefined;
  }

  /** GPU results arrive a few frames late: take the ones ready, oldest first */
  private collect(): void {
    const gl = this.gl;
    if (!gl || !this.ext) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    let i = 0;
    for (; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
      if (!disjoint) push(this.stages.get(p.name)!.gpu, ns / 1e6);
      this.free.push(p.q);
    }
    this.pending.splice(0, i);
  }

  stats(): FrameStats {
    const frameMs = mean(this.frames);
    const stages = this.order.map((name) => {
      const s = this.stages.get(name)!;
      return { name, cpu: mean(s.cpu), gpu: s.gpu.length ? mean(s.gpu) : undefined };
    });
    const timed = stages.filter((s) => s.gpu !== undefined);
    return {
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      frameMs,
      cpuMs: mean(this.cpuFrames),
      gpuMs: timed.length ? timed.reduce((a, s) => a + (s.gpu ?? 0), 0) : undefined,
      gpuTimer: this.ext !== null,
      stages,
    };
  }
}

function push(a: number[], v: number): void {
  a.push(v);
  if (a.length > WINDOW) a.shift();
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export const profiler = new Profiler();
