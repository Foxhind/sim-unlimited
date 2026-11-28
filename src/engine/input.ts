import { inputEvents } from './frame-pace';

/** a finger on the screen, CSS px relative to the target */
export interface Touch {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** the widget that took it at touch-down (touch controls), or null: it drags the view / scrolls */
  owner: string | null;
}

/** what was used last: the touch controls show for 'touch', the menus' help text follows it */
export type Device = 'keyboard' | 'mouse' | 'touch' | 'pad';

/** gamepad buttons and axes as pseudo key codes: "Pad:B3" a button, "Pad:A2+" / "Pad:A2-" an axis half */
export const padButton = (i: number): string => `Pad:B${i}`;
export const padAxis = (i: number, sign: 1 | -1): string => `Pad:A${i}${sign > 0 ? '+' : '-'}`;

/** button hysteresis: analog triggers / worn buttons hovering near the middle must not chatter */
const PAD_PRESS = 0.6;
const PAD_RELEASE = 0.3;
/** an axis half counts as a button past this (for binding a button action to a hat or trigger axis) */
const AXIS_PRESS = 0.6;
const AXIS_RELEASE = 0.4;
/** a press that moved less than this (CSS px) is a click / tap, more is a drag */
const TAP_SLOP = 10;

/** the state of the first connected gamepad this frame */
export interface PadState {
  id: string;
  /** 'standard' (the browser knows the layout: Xbox / PlayStation style) or '' (a joystick, HOTAS...) */
  mapping: string;
  axes: readonly number[];
  /** analog value of each button, 0..1 */
  buttons: readonly number[];
}

/** a keyboard event's target is a field being typed in */
function typing(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

export class Input {
  readonly keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  mouseX = 0;
  mouseY = 0;
  wheel = 0;
  /** absolute click / tap position in CSS px relative to target, null when consumed */
  click: [number, number] | null = null;
  lastKey: string | null = null;
  device: Device = 'keyboard';
  /** fingers down now, by pointer id */
  readonly touches = new Map<number, Touch>();
  /**
   * Asked at each touch-down (CSS px): the name of the widget that takes this finger, or null.
   * A taken finger neither drags the view nor clicks.
   */
  claimTouch: ((x: number, y: number) => string | null) | null = null;
  /** the gamepad polled by pollPads(), or null */
  pad: PadState | null = null;
  /** codes pressed since the last consumePresses(); OS auto-repeat is ignored, sub-frame taps are kept */
  private presses = new Set<string>();
  /** analog value of the pad pseudo-codes held now */
  private padValues = new Map<string, number>();
  private dragging = false;
  private downAt: [number, number] | null = null;
  private pinch = 0;
  /**
   * Bumped by every key, pointer and wheel event and every pad button or stick crossing its
   * threshold: a frame that would show the same picture as the last one can be skipped while it holds.
   */
  get activity(): number {
    return this.events.count + this.padChanges;
  }
  private readonly events = inputEvents();
  private padChanges = 0;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // typing in a text field (the start screen's search): its keys, not the sim's
      if (typing(e.target)) return;
      this.keys.add(e.code);
      if (!e.repeat) this.presses.add(e.code);
      this.lastKey = e.code;
      this.device = 'keyboard';
      // Tab is the flight map's size, not a focus move
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.touches.clear();
      this.dragging = false;
    });
    const local = (e: PointerEvent): [number, number] => {
      const rect = target.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    target.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      if (e.pointerType === 'touch') {
        this.device = 'touch';
        e.preventDefault();
        const owner = this.claimTouch?.(x, y) ?? null;
        this.touches.set(e.pointerId, { id: e.pointerId, x, y, startX: x, startY: y, owner });
        this.pinch = this.pinchSpan();
        // the first free finger is the "mouse": it taps and drags (camera, menu scroll)
        if (!owner && this.freeTouches().length === 1) {
          this.downAt = [x, y];
          this.mouseX = x - target.clientWidth / 2;
          this.mouseY = y - target.clientHeight / 2;
        }
        target.setPointerCapture?.(e.pointerId);
        return;
      }
      this.device = 'mouse';
      if (e.button === 0) {
        this.dragging = true;
        this.downAt = [x, y];
      }
    });
    const up = (e: PointerEvent): void => {
      const [x, y] = local(e);
      if (e.pointerType === 'touch') {
        const t = this.touches.get(e.pointerId);
        this.touches.delete(e.pointerId);
        this.pinch = this.pinchSpan();
        if (!t || t.owner) return;
        if (e.type === 'pointerup' && this.downAt && Math.hypot(x - this.downAt[0], y - this.downAt[1]) < TAP_SLOP) this.click = [x, y];
        this.downAt = null;
        return;
      }
      if (e.button !== 0) return;
      this.dragging = false;
      // a click is a press and release in place: a drag (camera, menu scroll) is not one
      if (e.type === 'pointerup' && this.downAt && Math.hypot(x - this.downAt[0], y - this.downAt[1]) < TAP_SLOP) this.click = [x, y];
      this.downAt = null;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (e.pointerType === 'touch') {
        const t = this.touches.get(e.pointerId);
        if (!t) return;
        const dx = x - t.x, dy = y - t.y;
        t.x = x;
        t.y = y;
        if (t.owner) return;
        const free = this.freeTouches();
        if (free.length >= 2) {
          // two free fingers: a pinch zooms (as the wheel does: spread = in)
          const span = this.pinchSpan();
          if (this.pinch > 0) this.wheel -= (span - this.pinch) * 4;
          this.pinch = span;
          this.downAt = null;
        } else {
          this.mouseDX += dx;
          this.mouseDY += dy;
          this.mouseX = x - target.clientWidth / 2;
          this.mouseY = y - target.clientHeight / 2;
        }
        return;
      }
      this.mouseX = x - target.clientWidth / 2;
      this.mouseY = y - target.clientHeight / 2;
      if (!this.dragging) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    target.addEventListener('wheel', (e) => {
      this.wheel += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    // no long-press menu, no double-tap zoom, no page scroll under the fingers
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }

  private freeTouches(): Touch[] {
    return [...this.touches.values()].filter((t) => !t.owner);
  }

  private pinchSpan(): number {
    const f = this.freeTouches();
    return f.length >= 2 ? Math.hypot(f[0].x - f[1].x, f[0].y - f[1].y) : 0;
  }

  /**
   * Read the first connected gamepad: its buttons and axis halves become pseudo key codes
   * (padButton, padAxis) held in `keys` and pressed once per press, so bindings, edges and the
   * knobs' auto-repeat treat them as keys. Call once a frame before reading the controls.
   */
  pollPads(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).find((g) => g && g.connected) ?? null;
    if (!p) {
      if (this.pad) this.padChanges++;
      if (this.pad) for (const c of this.padValues.keys()) this.keys.delete(c);
      this.padValues.clear();
      this.pad = null;
      return;
    }
    const buttons = p.buttons.map((b) => b.value || (b.pressed ? 1 : 0));
    this.pad = { id: p.id, mapping: p.mapping, axes: p.axes.slice(), buttons };
    const set = (code: string, v: number, press: number, release: number): void => {
      const was = this.keys.has(code);
      const held = was ? v > release : v > press;
      if (held) {
        this.keys.add(code);
        this.padValues.set(code, v);
        if (!was) {
          this.padChanges++;
          this.presses.add(code);
          this.lastKey = code;
          this.device = 'pad';
        }
      } else if (was) {
        this.padChanges++;
        this.keys.delete(code);
        this.padValues.delete(code);
      }
    };
    buttons.forEach((v, i) => set(padButton(i), v, PAD_PRESS, PAD_RELEASE));
    p.axes.forEach((v, i) => {
      set(padAxis(i, 1), v, AXIS_PRESS, AXIS_RELEASE);
      set(padAxis(i, -1), -v, AXIS_PRESS, AXIS_RELEASE);
    });
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** how far a code is held, 0..1: 1 for a key, the analog value of a pad trigger */
  value(code: string): number {
    if (!this.keys.has(code)) return 0;
    return this.padValues.get(code) ?? 1;
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
