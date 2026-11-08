export class Input {
  readonly keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  private dragging = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  consumeMouse(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}