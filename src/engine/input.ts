export class Input {
  readonly keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  mouseX = 0;
  mouseY = 0;
  wheel = 0;
  /** absolute click position in CSS px relative to target, null when consumed */
  click: [number, number] | null = null;
  lastKey: string | null = null;
  /** codes pressed since the last consumePresses(); OS auto-repeat is ignored, sub-frame taps are kept */
  private presses = new Set<string>();
  private dragging = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (!e.repeat) this.presses.add(e.code);
      this.lastKey = e.code;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.dragging = true;
        const rect = target.getBoundingClientRect();
        this.click = [e.clientX - rect.left, e.clientY - rect.top];
      }
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      const rect = target.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left - rect.width / 2;
      this.mouseY = e.clientY - rect.top - rect.height / 2;
      if (!this.dragging) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    target.addEventListener('wheel', (e) => {
      this.wheel += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** Discrete key presses since the previous call (one entry per physical press). */
  consumePresses(): Set<string> {
    const p = this.presses;
    this.presses = new Set();
    return p;
  }

  consumeMouse(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  consumeClick(): [number, number] | null {
    const c = this.click;
    this.click = null;
    return c;
  }

  consumeKey(): string | null {
    const k = this.lastKey;
    this.lastKey = null;
    return k;
  }
}