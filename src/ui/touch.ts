import { FontRenderer, HUD_AMBER, HUD_GREEN, HUD_WHITE } from '../engine/font';
import { VectorRenderer } from '../engine/vector';
import { RAMP, rampIndex } from '../engine/palette';
import type { Touch } from '../engine/input';
import type { Action, ExtraControls } from '../flight/controls';
import { t, type StringKey } from './i18n';
import type { Lang } from './settings';

/** screen edges kept clear of the notch and the home bar, device px */
export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

export const NO_INSETS: Insets = { l: 0, t: 0, r: 0, b: 0 };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TouchButton extends Rect {
  action: Action;
  label: StringKey;
  /** held while the finger stays (brakes, speed brake, rudder) rather than pressed once */
  hold: boolean;
}

/**
 * Where the touch controls stand, device px. Landscape: the stick bottom left, the throttle lever
 * bottom right with the rudder beside it and the systems above it, the view buttons on the left
 * under the corner map. Portrait: stick and lever at the bottom, every button in rows above them.
 */
export interface TouchLayout {
  landscape: boolean;
  /** the stick's resting centre and its throw */
  stick: { x: number; y: number; r: number };
  /** a finger put down here takes the stick (which then centres on the finger) */
  stickZone: Rect;
  lever: Rect;
  /** a finger put down here takes the lever (it moves the throttle by how far it slides) */
  leverZone: Rect;
  buttons: TouchButton[];
  /** what the HUD must keep clear of (flight/hud.ts HudLayout): a right column, a bottom band, a left column */
  reserve: { right: number; bottom: number; left: number; low?: { y: number; right: number } };
  /** the top of the left column of buttons (landscape): the corner map ends above it */
  leftTop: number;
}

/** the systems, in the order they are laid out */
const SYSTEMS: Array<[Action, StringKey, boolean]> = [
  ['gear', 'gear', false], ['flaps', 'flaps', false],
  ['brakes', 'touchBrake', true], ['speedbrake', 'touchSpdBrk', true],
  ['autopilot', 'touchAp', false], ['autoland', 'touchLand', false],
];
const VIEWS: Array<[Action, StringKey, boolean]> = [
  ['camNext', 'touchCam', false], ['mapMode', 'touchMap', false],
  ['hudMode', 'touchHud', false], ['pause', 'touchPause', false],
];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Where the touch controls stand on a w x h screen (device px, text unit u), clear of the screen's
 * insets and of `bottomRows` rows of text along the bottom (the attribution).
 */
export function touchLayout(w: number, h: number, u: number, inset: Insets = NO_INSETS, bottomRows = 1): TouchLayout {
  const landscape = w >= h;
  const short = Math.min(w, h);
  const r = clamp(short * 0.15, 44 * u, 70 * u);
  const bottom = h - inset.b - (14 + 18 * bottomRows) * u;
  const leverW = 40 * u;
  const leverH = clamp(short * 0.32, 100 * u, 180 * u);
  const lever: Rect = { x: w - inset.r - 20 * u - leverW, y: bottom - leverH, w: leverW, h: leverH };
  const stick = { x: inset.l + 24 * u + r, y: bottom - r, r };
  const bw = 72 * u, bh = 30 * u, gap = 6 * u;
  const buttons: TouchButton[] = [];
  const add = ([action, label, hold]: [Action, StringKey, boolean], x: number, y: number, bwi = bw): void => {
    buttons.push({ action, label, hold, x, y, w: bwi, h: bh });
  };
  // rudder: a pair at the foot of the lever, on its left
  const rw = 36 * u;
  add(['yawRight', 'touchRudR', true], lever.x - 12 * u - rw, bottom - bh, rw);
  add(['yawLeft', 'touchRudL', true], lever.x - 12 * u - 2 * rw - gap, bottom - bh, rw);

  let reserve: TouchLayout['reserve'];
  let stickZone: Rect;
  let leftTop = 0;
  if (landscape) {
    // systems: two columns over the lever, from the lever up
    const colX = w - inset.r - 8 * u - 2 * bw - gap;
    SYSTEMS.forEach((b, i) => {
      const row = Math.floor(i / 2);
      add(b, colX + (i % 2) * (bw + gap), lever.y - 32 * u - (3 - row) * (bh + gap) + gap, bw);
    });
    // views: two by two on the left, over the stick's reach
    const vy = stick.y - r - 16 * u - 2 * bh - gap;
    leftTop = vy;
    VIEWS.forEach((b, i) => add(b, inset.l + 8 * u + (i % 2) * (bw + gap), vy + Math.floor(i / 2) * (bh + gap), bw));
    stickZone = { x: 0, y: stick.y - r - 8 * u, w: w * 0.4, h: h - (stick.y - r - 8 * u) };
    // under the systems only the lever (and its label) stands in the right column
    reserve = { right: 2 * bw + gap + 16 * u, bottom: 0, left: 2 * bw + gap + 16 * u, low: { y: lever.y - 24 * u, right: w - lever.x + 8 * u } };
  } else {
    // every button in rows of five across, above the stick and the lever
    const all = [...SYSTEMS, ...VIEWS];
    const perRow = 5;
    const cw = (w - inset.l - inset.r - 16 * u - gap * (perRow - 1)) / perRow;
    const rows = Math.ceil(all.length / perRow);
    const top = Math.min(stick.y - r, lever.y - 24 * u) - 12 * u - rows * (bh + gap) + gap;
    all.forEach((b, i) => add(b, inset.l + 8 * u + (i % perRow) * (cw + gap), top + Math.floor(i / perRow) * (bh + gap), cw));
    stickZone = { x: 0, y: top + rows * (bh + gap), w: w * 0.55, h: h - (top + rows * (bh + gap)) };
    reserve = { right: 0, bottom: h - top + 8 * u, left: 0 };
    leftTop = top;
  }
  const leverZone: Rect = { x: lever.x - 16 * u, y: lever.y - 20 * u, w: w - lever.x + 16 * u, h: lever.h + 40 * u };
  return { landscape, stick, stickZone, lever, leverZone, buttons, reserve, leftTop };
}

/** the throttle's travel per lever height: a slide the whole height goes from idle to full */
const LEVER_TRAVEL = 1;

/**
 * On-screen flight controls for a touch screen: a floating stick, a throttle lever, rudder and the
 * system buttons, drawn over the HUD in its colours.
 */
export class TouchControls {
  layout: TouchLayout = touchLayout(1, 1, 1);
  /** device px per CSS px */
  private scale = 1;
  private presses = new Set<Action>();
  private stickTouch: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private leverTouch: { id: number; y: number } | null = null;
  private throttle = 0;
  /** device px per CSS px and the frame's layout: call before claim() can be asked */
  setLayout(w: number, h: number, u: number, cssW: number, inset: Insets, bottomRows = 1): void {
    this.scale = w / Math.max(1, cssW);
    this.layout = touchLayout(w, h, u, inset, bottomRows);
  }

  /** Input.claimTouch: which control a finger put down at (CSS px) takes */
  claim(cssX: number, cssY: number): string | null {
    const x = cssX * this.scale, y = cssY * this.scale;
    const L = this.layout;
    for (const b of L.buttons) {
      // a little slack round each button: a fingertip is wider than the frame
      const s = 4 * this.scale;
      if (x >= b.x - s && x <= b.x + b.w + s && y >= b.y - s && y <= b.y + b.h + s) {
        if (!b.hold) this.presses.add(b.action);
        return `btn:${b.action}`;
      }
    }
    if (inside(L.leverZone, x, y)) return 'lever';
    if (inside(L.stickZone, x, y)) return 'stick';
    return null;
  }

  /**
   * The controls the fingers hold this frame. `throttle` is the current throttle, so the lever
   * picks up from it (keys, autopilot) rather than jumping to where the finger is.
   */
  update(touches: ReadonlyMap<number, Touch>, throttle: number): ExtraControls {
    const held = new Set<Action>();
    const out: ExtraControls = { pitch: 0, roll: 0, yaw: 0, throttle: null, held, presses: this.presses };
    this.presses = new Set();
    let stick: Touch | undefined;
    let lever: Touch | undefined;
    for (const tc of touches.values()) {
      if (tc.owner === 'stick' && !stick) stick = tc;
      else if (tc.owner === 'lever' && !lever) lever = tc;
      else if (tc.owner?.startsWith('btn:')) {
        const a = tc.owner.slice(4) as Action;
        if (this.layout.buttons.some((b) => b.action === a && b.hold)) held.add(a);
      }
    }
    const s = this.scale;
    if (stick) {
      if (this.stickTouch?.id !== stick.id) this.stickTouch = { id: stick.id, x0: stick.startX * s, y0: stick.startY * s, x: 0, y: 0 };
      const r = this.layout.stick.r;
      let dx = (stick.x * s - this.stickTouch.x0) / r;
      let dy = (stick.y * s - this.stickTouch.y0) / r;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.stickTouch.x = dx;
      this.stickTouch.y = dy;
      out.roll = dx;
      // the stick pulled down (towards the pilot) raises the nose, as the Down arrow does
      out.pitch = dy;
    } else this.stickTouch = null;
    if (lever) {
      if (this.leverTouch?.id !== lever.id) {
        this.leverTouch = { id: lever.id, y: lever.y * s };
        this.throttle = throttle;
      }
      this.throttle = clamp(this.throttle - ((lever.y * s - this.leverTouch.y) / this.layout.lever.h) * LEVER_TRAVEL, 0, 1);
      this.leverTouch.y = lever.y * s;
      out.throttle = this.throttle;
    } else this.leverTouch = null;
    if (held.has('yawLeft')) out.yaw -= 1;
    if (held.has('yawRight')) out.yaw += 1;
    held.delete('yawLeft');
    held.delete('yawRight');
    return out;
  }

  /**
   * Draw the controls. `lit` marks the buttons whose system is on (gear down, flaps, autopilot...);
   * `held` the ones a finger holds now; `afterburner` the throttle above which it lights, if any.
   */
  draw(vec: VectorRenderer, font: FontRenderer, u: number, lang: Lang, throttle: number, lit: ReadonlySet<Action>, touches: ReadonlyMap<number, Touch>, afterburner?: number): void {
    const L = this.layout;
    const lw = Math.max(1, u);
    const dim = rampIndex(RAMP.HUD_GREEN, 6);
    const fill = rampIndex(RAMP.HUD_GREEN, 3);
    const pressedNow = new Set<string>();
    for (const tc of touches.values()) if (tc.owner) pressedNow.add(tc.owner);

    // stick: the ring where the finger went down (or its resting place) and the knob
    const st = this.stickTouch;
    const cx = st ? st.x0 : L.stick.x;
    const cy = st ? st.y0 : L.stick.y;
    vec.circle(cx, cy, L.stick.r, lw, st ? HUD_GREEN : dim, 32);
    vec.line(cx - 6 * u, cy, cx + 6 * u, cy, lw, dim);
    vec.line(cx, cy - 6 * u, cx, cy + 6 * u, lw, dim);
    const kx = cx + (st ? st.x : 0) * L.stick.r;
    const ky = cy + (st ? st.y : 0) * L.stick.r;
    vec.circle(kx, ky, L.stick.r * 0.35, lw * 2, st ? HUD_WHITE : HUD_GREEN, 20);

    // lever: the track, the throttle filled up to its setting, the afterburner gate
    const lv = L.lever;
    const level = lv.y + lv.h * (1 - throttle);
    vec.fillRect(lv.x + lw, level, lv.w - 2 * lw, lv.y + lv.h - level, fill);
    vec.rect(lv.x, lv.y, lv.w, lv.h, lw, pressedNow.has('lever') ? HUD_WHITE : HUD_GREEN);
    if (afterburner !== undefined) {
      const gy = lv.y + lv.h * (1 - afterburner);
      vec.line(lv.x - 4 * u, gy, lv.x + lv.w + 4 * u, gy, lw, HUD_AMBER);
    }
    vec.line(lv.x - 6 * u, level, lv.x + lv.w + 6 * u, level, lw * 2, afterburner !== undefined && throttle > afterburner ? HUD_AMBER : HUD_WHITE);
    const pct = `${Math.round(throttle * 100)}%`;
    font.text(pct, lv.x + (lv.w - font.measure(pct, u)) / 2, lv.y - 20 * u, u, HUD_GREEN);

    for (const b of L.buttons) {
      const down = pressedNow.has(`btn:${b.action}`);
      const on = lit.has(b.action);
      if (down || on) vec.fillRect(b.x, b.y, b.w, b.h, on && !down ? fill : rampIndex(RAMP.HUD_GREEN, 5));
      vec.rect(b.x, b.y, b.w, b.h, lw, down ? HUD_WHITE : HUD_GREEN);
      let label = t(lang, b.label);
      // a label wider than its button loses letters rather than spilling over
      while (label.length > 1 && font.measure(label, u) > b.w - 6 * u) label = label.slice(0, -1);
      font.text(label, b.x + (b.w - font.measure(label, u)) / 2, b.y + (b.h - 16 * u) / 2, u, down || on ? HUD_WHITE : HUD_GREEN);
    }
  }
}
