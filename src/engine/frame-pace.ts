/**
 * Frames that would show nothing new are not drawn, or a laptop heats up over a still picture.
 *
 * capped(): above 60 Hz (a 120 Hz ProMotion display) only every n-th vsync is drawn,
 * n = floor(refresh / 60): half the GPU's work at 120 Hz, 90 Hz drawn in full.
 *
 * still(): the caller names what its picture depends on in a key (the screen, the canvas size, an
 * input counter, the view); while the key holds, the frame is drawn only once a second (tiles still
 * arriving, the HDR state settling), and for a moment after every change of it (a click handled in a
 * frame shows its result in the next).
 */
export const FRAME_CAP_HZ = 60;

export class FramePacer {
  private vsyncMs = 1000 / 60;
  private lastVsync = -1;
  private vsyncs = 0;
  private key: string | null = null;
  private since = 0;
  private drawnAt = -Infinity;

  constructor(readonly redrawMs = 1000, readonly afterChangeMs = 300, readonly capHz = FRAME_CAP_HZ) {}

  /** the display's vsync interval as measured, ms */
  get vsync(): number {
    return this.vsyncMs;
  }

  /** true when this vsync is one of those the cap skips */
  capped(now: number): boolean {
    const gap = this.lastVsync < 0 ? 0 : now - this.lastVsync;
    this.lastVsync = now;
    // a background tab's long gaps are not the display's
    if (gap > 0 && gap < 50) this.vsyncMs += (gap - this.vsyncMs) * 0.05;
    const every = Math.max(1, Math.floor(1000 / this.vsyncMs / this.capHz + 0.1));
    if (++this.vsyncs < every) return true;
    this.vsyncs = 0;
    return false;
  }

  /** true when the picture keyed by `key` need not be drawn this frame */
  still(now: number, key: string): boolean {
    if (key !== this.key) {
      this.key = key;
      this.since = now;
    }
    if (now - this.since < this.afterChangeMs || now - this.drawnAt >= this.redrawMs) {
      this.drawnAt = now;
      return false;
    }
    return true;
  }

  /** the picture moves (a flight, an orbit): the next still() call draws */
  wake(): void {
    this.key = null;
  }
}

/** a count of the user's input events on the window (keys, pointer, wheel, form fields, paste) */
export function inputEvents(target: Window = window): { readonly count: number } {
  const counter = { count: 0 };
  const bump = (): void => { counter.count++; };
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'mousemove', 'wheel', 'input', 'change', 'paste', 'blur', 'hashchange']) {
    target.addEventListener(type, bump, { capture: true, passive: true });
  }
  return counter;
}
