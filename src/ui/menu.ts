import { FontRenderer, HUD_AMBER, HUD_GREEN, HUD_WHITE } from '../engine/font';
import { VectorRenderer } from '../engine/vector';
import { RAMP, rampIndex } from '../engine/palette';
import type { Input } from '../engine/input';
import { NO_INSETS, type Insets } from './touch';
import { movedAxis, padAxes, padCodeLabel, PAD_AXIS_ROLES, type PadAxisRole } from '../flight/gamepad';
import type { HdrBlocker } from '../engine/output-mode';
import { t, type StringKey } from './i18n';
import { saveSettings, type Settings } from './settings';
import { AIRFIELDS, Minimap } from './minimap';
import { MAP_SOURCE_NAME, parseMapLink } from './map-links';
import { Geocoder, type Place } from './geocode';
import type { LatLon } from '../world/geodesy';
import { TIMES_OF_DAY, type TimeOfDay } from '../world/time-of-day';
import { WEATHER_PRESETS, type WeatherPreset } from '../world/weather-preset';
import { AIRCRAFT, AIRCRAFT_ORDER, type AircraftId } from '../flight/aircraft';
import { DEFAULT_BINDINGS, type Action, type Controls } from '../flight/controls';

export type MenuScreen = 'consent' | 'start' | 'settings' | 'pause' | 'crashed' | 'none';

export interface FlightConfig {
  aircraft: AircraftId;
  /** national markings and loadout of that aircraft ('' = its defaults) */
  insignia: string;
  loadout: string;
  location: 'LTBS' | 'LOWI' | 'custom';
  customPoint: LatLon | null;
  startMode: 'runway' | 'air';
  timeAccel: number;
  timeOfDay: TimeOfDay;
  /** the weather flown in: the real one, or a preset in its place (world/weather-preset.ts) */
  weather: WeatherPreset;
}

export interface MenuCallbacks {
  onFly(cfg: FlightConfig): void;
  onConsent(allow: boolean): void;
  onResume(): void;
  onRestart(): void;
  onNewPoint(): void;
  onSettingsChanged(): void;
  /** why the frame is SDR though XDR may be on (renderer.hdrBlocker); null: it is HDR */
  hdrStatus(): HdrBlocker | null;
}

interface Button {
  x: number; y: number; w: number; h: number;
  label: string;
  action: () => void;
  selected: boolean;
  amber: boolean;
  /** in the screen's bottom bar: never scrolled, never hidden under it */
  fixed: boolean;
}

const REMAP_ACTIONS: Action[] = [
  'pitchUp', 'pitchDown', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight',
  'throttleUp', 'throttleDown', 'gear', 'flaps', 'brakes', 'speedbrake',
  'pause', 'mute', 'camCockpit', 'camOrbit', 'camChase', 'camFlyby', 'camTower', 'camTarget',
  'camNext', 'autopilot', 'autoland', 'hudMode', 'mapMode',
];
const AXIS_KEY: Record<PadAxisRole, StringKey> = { roll: 'axisRoll', pitch: 'axisPitch', yaw: 'axisYaw', throttle: 'axisThrottle' };
/** narrower than this (text units) a screen's two columns go one under the other */
const TWO_COLUMNS = 820;

const TIME_STEPS = [1, 10, 60, 600];
const TOD_KEY: Record<TimeOfDay, StringKey> = {
  real: 'todReal', morning: 'todMorning', day: 'todDay', evening: 'todEvening', night: 'todNight',
};
const WX_KEY: Record<WeatherPreset, StringKey> = {
  real: 'wxReal', clear: 'wxClear', cloudy: 'wxCloudy', rain: 'wxRain', snow: 'wxSnow', storm: 'wxStorm',
};
/** the menus' panels: the HUD's darkest green, whatever the light (a sky ramp follows the day) */
const PANEL = rampIndex(RAMP.HUD_GREEN, 1);
/** the search field's text: the HUD's green (palette HUD_GREEN, its 13th step) */
const FIELD_COLOUR = '#38e038';
const DIM = rampIndex(RAMP.HUD_GREEN, 6);

export class Menu {
  screen: MenuScreen = 'none';
  config: FlightConfig = { aircraft: 'su27', insignia: '', loadout: '', location: 'LOWI', customPoint: null, startMode: 'air', timeAccel: 1, timeOfDay: 'real', weather: 'real' };
  readonly minimap = new Minimap();
  crashReason = '';
  /** sim clock / sun / moon summary shown on the pause screen */
  clockText = '';
  private buttons: Button[] = [];
  private remap: Action | null = null;
  /** the binding being set: a key or a gamepad button */
  private remapPad = false;
  /** the axis role being assigned, and the axes when it started */
  private remapAxis: { role: PadAxisRole; rest: number[] } | null = null;
  private bindTab: 'keyboard' | 'gamepad' = 'keyboard';
  /** how far each screen is scrolled down (when it is taller than the screen), device px */
  private scroll = 0;
  private scrollMax = 0;
  private scrolled: MenuScreen = 'none';
  /** this frame: the scroll offset applied to what is drawn, and the lowest point drawn */
  private oy = 0;
  private bottom = 0;
  /** last frame's screen size, for the scroll limits */
  private inset: Insets = NO_INSETS;
  /** a touch screen: no hover, no keyboard help */
  private touch = false;
  private controls: Controls | null = null;
  private returnTo: MenuScreen = 'start';
  /** result of the last pasted map link, shown under the start map */
  private pasteNote: { text: string; error: boolean } | null = null;

  constructor(
    private font: FontRenderer,
    private vec: VectorRenderer,
    readonly settings: Settings,
    private cb: MenuCallbacks,
  ) {}

  /**
   * A map link (Google, Apple, Yandex, OSM, geo:, "lat, lon") pasted on the start screen becomes
   * the custom start point, like a click on the map. Returns false when not on the start screen.
   */
  pasteLink(text: string): boolean {
    if (this.screen !== 'start') return false;
    const L = this.settings.lang;
    const p = parseMapLink(text);
    if (!p) {
      this.pasteNote = { text: t(L, 'pasteError'), error: true };
      return true;
    }
    this.config.customPoint = { lat: p.lat, lon: p.lon };
    this.config.location = 'custom';
    this.placeName = '';
    this.pasteNote = { text: `${t(L, 'pastedPoint')} ${MAP_SOURCE_NAME[p.source].toUpperCase()}`, error: false };
    return true;
  }

  openSettings(from: MenuScreen): void {
    this.returnTo = from;
    this.screen = 'settings';
  }

  private text(s: string, x: number, y: number, scale: number, color: number): void {
    this.font.text(s, x, y - this.oy, scale, color);
    this.bottom = Math.max(this.bottom, y + 16 * scale);
  }

  private center(s: string, cx: number, y: number, scale: number, color: number): void {
    this.text(s, cx - this.font.measure(s, scale) / 2, y, scale, color);
  }

  private button(x: number, y: number, w: number, h: number, label: string, action: () => void, selected = false, amber = false): void {
    this.buttons.push({ x, y: y - this.oy, w, h, label, action, selected, amber, fixed: this.inBar });
    if (!this.inBar) this.bottom = Math.max(this.bottom, y + h);
  }

  /** drawing the bottom bar: not scrolled */
  private inBar = false;
  /** the top of this frame's bottom bar: scrolled buttons under it are neither drawn nor pressed */
  private barTop = Infinity;

  /**
   * The screen's bottom bar from y down: what was drawn so far is put on screen, the bar's
   * backdrop covers what scrolled under it, then `draw` adds its buttons and text unscrolled.
   */
  private bar(w: number, h: number, y: number, draw: () => void): number {
    // a backdrop only when something can scroll under the bar (last frame's measure): a screen that
    // fits keeps the scene showing behind its buttons
    if (this.scrollMax > 0) {
      this.font.flush();
      this.vec.flush();
      this.vec.fillRect(0, y - 8 * this.u, w, h - y + 8 * this.u, PANEL);
      this.vec.line(0, y - 8 * this.u, w, y - 8 * this.u, Math.max(1, this.u), DIM);
    }
    const oy = this.oy, bottom = this.bottom;
    this.oy = 0;
    this.inBar = true;
    draw();
    this.inBar = false;
    this.oy = oy;
    this.bottom = bottom;
    this.barTop = y - 8 * this.u;
    return y - 8 * this.u;
  }

  private remapDone(): void {
    saveSettings(this.settings);
    this.remap = null;
    this.cb.onSettingsChanged();
  }

  /** the buttons that can be seen and pressed: not scrolled under the bottom bar */
  private visible(): Button[] {
    return this.buttons.filter((b) => b.fixed || b.y + b.h <= this.barTop);
  }

  /**
   * A line broken into lines no wider than maxW: at spaces, or where it is made of groups apart by
   * two spaces or more (the help: "G GEAR  F FLAPS"), only between the groups.
   */
  private wrap(s: string, maxW: number, scale: number): string[] {
    const out: string[] = [];
    const grouped = / {2}/.test(s);
    const sep = grouped ? '  ' : ' ';
    let line = '';
    for (const word of s.split(grouped ? / {2,}/ : / +/)) {
      const next = line ? `${line}${sep}${word}` : word;
      if (line && this.font.measure(next, scale) > maxW) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  /** wrapped text from y down at x; returns the y under it */
  private para(s: string, x: number, y: number, maxW: number, color: number, centred = false): number {
    for (const line of this.wrap(s, maxW, this.u)) {
      if (centred) this.center(line, x + maxW / 2, y, this.u, color);
      else this.text(line, x, y, this.u, color);
      y += 18 * this.u;
    }
    return y;
  }

  /**
   * A drag or the wheel over a menu scrolls it. Called before the camera takes the mouse, so a
   * drag in the pause menu scrolls the menu and does not swing the view.
   */
  takeScroll(input: Input): void {
    if (this.screen === 'none') return;
    const [, dy] = input.consumeMouse();
    const wheel = input.consumeWheel();
    this.scroll = Math.max(0, Math.min(this.scrollMax, this.scroll - dy * (window.devicePixelRatio || 1) + wheel));
  }

  private drawButtons(hover: [number, number] | null): void {
    const lw = Math.max(1, this.u);
    for (const b of this.visible()) {
      const hov = hover && hover[0] >= b.x && hover[0] <= b.x + b.w && hover[1] >= b.y && hover[1] <= b.y + b.h;
      const color = b.amber ? HUD_AMBER : HUD_GREEN;
      if (b.selected || hov) {
        this.vec.fillRect(b.x, b.y, b.w, b.h, b.amber ? rampIndex(RAMP.HUD_AMBER, 5) : rampIndex(RAMP.HUD_GREEN, 5));
      }
      this.vec.rect(b.x, b.y, b.w, b.h, lw, color);
      const scale = this.u;
      const tw = this.font.measure(b.label, scale);
      this.font.text(b.label, b.x + (b.w - tw) / 2, b.y + (b.h - 16 * scale) / 2, scale, b.selected || hov ? HUD_WHITE : color);
    }
  }

  private u = 1;

  /** Returns true when the menu consumed the frame (world still renders behind). */
  draw(w: number, h: number, u: number, cssW: number, cssH: number, input: Input, marker?: LatLon, inset: Insets = NO_INSETS, controls?: Controls): void {
    this.u = u;
    this.inset = inset;
    this.controls = controls ?? null;
    this.touch = input.device === 'touch';
    this.buttons = [];
    const sx = w / cssW, sy = h / cssH;
    this.cssScale = cssW / w;
    this.preview = null;
    this.fieldShown = false;
    let click = input.consumeClick();
    // a tap elsewhere takes the keyboard from the search field
    if (click && this.typing()) this.field?.blur();
    const hover: [number, number] | null = this.touch ? null : [input.mouseX * sx + w / 2, input.mouseY * sy + h / 2];

    if (this.remap) {
      const key = input.consumeKey();
      if (key === 'Escape') this.remap = null;
      else if (this.remapPad && (key === 'Backspace' || key === 'Delete')) {
        // a gamepad action can be left without a button
        this.settings.padBindings[this.remap] = '';
        this.remapDone();
      } else if (key && key.startsWith('Pad:') === this.remapPad) {
        (this.remapPad ? this.settings.padBindings : this.settings.bindings)[this.remap] = key;
        this.remapDone();
      }
      if (click) { this.remap = null; click = null; }
    }
    if (this.remapAxis) {
      const key = input.consumeKey();
      const pad = input.pad;
      const moved = pad ? movedAxis(this.remapAxis.rest, pad.axes) : null;
      if (moved) {
        this.settings.padAxes[this.remapAxis.role] = { i: moved.i, inv: false };
        this.remapAxis = null;
        saveSettings(this.settings);
      } else if (key === 'Escape' || click) {
        // no axis for this role
        this.settings.padAxes[this.remapAxis.role] = null;
        this.remapAxis = null;
        saveSettings(this.settings);
        click = null;
      }
    }
    const clickDev: [number, number] | null = click ? [click[0] * sx, click[1] * sy] : null;
    if (this.scrolled !== this.screen) {
      this.scrolled = this.screen;
      this.scroll = 0;
    }
    this.oy = this.scroll;
    this.bottom = 0;
    this.barTop = Infinity;

    let bar = 0;
    switch (this.screen) {
      case 'consent': this.drawConsent(w, h, u); break;
      case 'start': bar = this.drawStart(w, h, u, clickDev, input); break;
      case 'settings': bar = this.drawSettings(w, h, u, input); break;
      case 'pause': this.drawPause(w, h, u, marker); break;
      case 'crashed': this.drawCrashed(w, h, u); break;
      case 'none': break;
    }
    if (this.field && !this.fieldShown) {
      this.field.style.display = 'none';
      if (this.typing()) this.field.blur();
    }
    if (this.screen === 'none') return;
    // taller than the screen (above its bottom bar): it scrolls
    this.scrollMax = Math.max(0, this.bottom + 16 * u - (bar || h - inset.b));
    this.scroll = Math.min(this.scroll, this.scrollMax);
    if (this.scrollMax > 0) {
      // a scroll bar at the right edge
      const top = inset.t + 8 * u, len = (bar || h - inset.b) - top - 8 * u;
      const thumb = Math.max(24 * u, (len * len) / (len + this.scrollMax));
      const at = top + ((len - thumb) * this.scroll) / this.scrollMax;
      this.vec.fillRect(w - inset.r - 4 * u, at, 2 * u, thumb, DIM);
    }

    this.drawButtons(hover);
    if (clickDev) {
      // a finger is wider than a pointer: a little slack round each button on a touch screen
      const s = this.touch ? 4 * u : 0;
      for (const b of this.visible()) {
        if (clickDev[0] >= b.x - s && clickDev[0] <= b.x + b.w + s && clickDev[1] >= b.y - s && clickDev[1] <= b.y + b.h + s) {
          b.action();
          break;
        }
      }
    }
    if (this.remap || this.remapAxis) {
      const msg = t(this.settings.lang, this.remapAxis ? 'moveAxis' : 'pressKey');
      const bw = this.font.measure(msg, u * 2) + 40 * u;
      this.vec.fillRect((w - bw) / 2, h * 0.45, bw, 50 * u, PANEL);
      this.vec.rect((w - bw) / 2, h * 0.45, bw, 50 * u, u, HUD_AMBER);
      this.center(msg, w / 2, h * 0.45 + 16 * u, u * 2, HUD_AMBER);
    }
  }

  private drawConsent(w: number, h: number, u: number): void {
    const L = this.settings.lang;
    const pw = w / u < TWO_COLUMNS ? w - this.inset.l - this.inset.r - 16 * u : w * 0.7;
    const px = (w - pw) / 2;
    const lines = t(L, 'consentBody').split('\n').flatMap((line) => this.wrap(line, pw - 32 * u, u));
    const ph = 130 * u + lines.length * 22 * u;
    const py = Math.max(this.inset.t + 8 * u, (h - ph) / 2);
    this.vec.fillRect(px, py - this.oy, pw, ph, PANEL);
    this.vec.rect(px, py - this.oy, pw, ph, u, HUD_GREEN);
    this.center(t(L, 'consentTitle'), w / 2, py + 20 * u, u * 2, HUD_AMBER);
    lines.forEach((line, i) => this.center(line, w / 2, py + 64 * u + i * 22 * u, u, HUD_GREEN));
    const bw = Math.min(180 * u, (pw - 48 * u) / 2), bh = 36 * u, y = py + ph - bh - 16 * u;
    this.button(w / 2 - bw - 8 * u, y, bw, bh, t(L, 'consentYes'), () => this.cb.onConsent(true), false, true);
    this.button(w / 2 + 8 * u, y, bw, bh, t(L, 'consentNo'), () => this.cb.onConsent(false));
  }

  /** the start screen; returns the top of its bottom bar */
  private drawStart(w: number, h: number, u: number, click: [number, number] | null, input: Input): number {
    const L = this.settings.lang;
    const cfg = this.config;
    const ins = this.inset;
    const two = w / u >= TWO_COLUMNS;
    const top = ins.t + (two ? h * 0.04 : 16 * u);
    this.center(t(L, 'title'), w / 2, top, u * 3, HUD_AMBER);
    this.center(t(L, 'subtitle'), w / 2, top + 42 * u, u, HUD_GREEN);

    // two columns on a wide screen: the aircraft and the flight's options, the place; on a narrow
    // one the aircraft, the place, then the options, one under the other
    const x0 = two ? w * 0.05 : ins.l + 16 * u;
    const cw = two ? w * 0.4 : w - x0 - ins.r - 16 * u;
    const rx = two ? w * 0.53 : x0;
    const rw = two ? w * 0.42 : cw;
    const bh = (this.touch ? 34 : 28) * u, gap = 6 * u;
    const yTop = two ? Math.max(h * 0.14, top + 70 * u) : top + 70 * u;
    // dark panels under the columns, as laid out last frame (the sky behind is light), but for the aircraft's window
    for (const p of this.panels) this.vec.fillRect(p.x, p.y - this.oy, p.w, p.h, PANEL);
    const panels: { x: number; y: number; w: number; h: number }[] = [];
    const pad = 10 * u;
    const panel = (px: number, y0: number, pw: number, y1: number): void => { if (y1 > y0) panels.push({ x: px - pad, y: y0, w: pw + 2 * pad, h: y1 - y0 }); };
    let x = x0, colW = cw, y = yTop;
    const label = (key: StringKey): void => { this.text(t(L, key), x, y, u, HUD_AMBER); y += 20 * u; };
    /** a row of buttons across the column, wrapped into more rows when their labels do not fit */
    const row = (items: [string, () => void, boolean][]): void => {
      const widest = Math.max(...items.map(([lbl]) => this.font.measure(lbl, u))) + 12 * u;
      const per = Math.max(1, Math.min(items.length, Math.floor((colW + gap) / (widest + gap))));
      for (let i = 0; i < items.length; i += per) {
        const chunk = items.slice(i, i + per);
        const bw = (colW - gap * (chunk.length - 1)) / chunk.length;
        chunk.forEach(([lbl, act, sel], k) => this.button(x + k * (bw + gap), y, bw, bh, lbl, act, sel));
        y += bh + gap * 2;
      }
    };

    // the aircraft: its model turning in a window (drawn behind the menu by main.ts in `preview`),
    // its name between the arrows that step through them (also ← →), its role under it
    label('aircraft');
    const ph = Math.min(colW * 0.42, two ? h * 0.24 : 200 * u);
    this.preview = { x, y: y - this.oy, w: colW, h: ph };
    panel(x, yTop - pad, colW, y);
    const underPreview = y + ph;
    this.vec.rect(x, y - this.oy, colW, ph, Math.max(1, u), DIM);
    this.bottom = Math.max(this.bottom, y + ph);
    y += ph + gap;
    const step = (d: number): void => {
      const i = AIRCRAFT_ORDER.indexOf(cfg.aircraft);
      const id = AIRCRAFT_ORDER[(i + d + AIRCRAFT_ORDER.length) % AIRCRAFT_ORDER.length];
      Object.assign(cfg, { aircraft: id, insignia: '', loadout: '' });
    };
    if (!this.typing()) {
      const key = input.consumeKey();
      if (key === 'ArrowLeft') step(-1);
      else if (key === 'ArrowRight') step(1);
    }
    const ab = Math.max(bh, 40 * u);
    this.button(x, y, ab, ab, '<', () => step(-1));
    this.button(x + colW - ab, y, ab, ab, '>', () => step(1));
    const ac = AIRCRAFT[cfg.aircraft];
    this.center(this.fit(ac.name, colW - 2 * ab - 8 * u, u * 2), x + colW / 2, y + ab / 2 - 16 * u, u * 2, HUD_WHITE);
    y += ab + gap;
    // a dot for each aircraft, the chosen one lit
    const dot = 6 * u, dg = 8 * u, dw = AIRCRAFT_ORDER.length * (dot + dg) - dg;
    AIRCRAFT_ORDER.forEach((id, i) => {
      const dx = x + colW / 2 - dw / 2 + i * (dot + dg), dy = y - this.oy;
      if (id === cfg.aircraft) this.vec.fillRect(dx, dy, dot, dot, HUD_GREEN);
      else this.vec.rect(dx, dy, dot, dot, Math.max(1, u), DIM);
    });
    y += dot + gap;
    y = this.para(t(L, `acRole_${cfg.aircraft}` as StringKey), x, y, colW, DIM, true) + gap;
    // the chosen aircraft's markings and loadouts, when it has a choice of them (the first is its default)
    const choose = (key: StringKey, items: { id: string; name: string }[] | undefined, field: 'insignia' | 'loadout'): void => {
      if (!items || items.length < 2) return;
      label(key);
      const current = cfg[field] || items[0].id;
      for (let i = 0; i < items.length; i += 4) {
        row(items.slice(i, i + 4).map((it) => [it.name, () => { cfg[field] = it.id; }, it.id === current]));
      }
    };
    choose('insignia', ac.insignia, 'insignia');
    choose('loadout', ac.loadouts, 'loadout');

    const options = (): void => {
      label('startMode');
      row([
        [t(L, 'runway'), () => { cfg.startMode = 'runway'; }, cfg.startMode === 'runway'],
        [t(L, 'air'), () => { cfg.startMode = 'air'; }, cfg.startMode === 'air'],
      ]);
      label('time');
      row(TIME_STEPS.map((s) => [`x${s}`, () => { cfg.timeAccel = s; }, cfg.timeAccel === s] as [string, () => void, boolean]));
      label('timeOfDay');
      row(TIMES_OF_DAY.map((k) => [t(L, TOD_KEY[k]), () => { cfg.timeOfDay = k; }, cfg.timeOfDay === k] as [string, () => void, boolean]));
      label('weather');
      row(WEATHER_PRESETS.map((k) => [t(L, WX_KEY[k]), () => { cfg.weather = k; }, cfg.weather === k] as [string, () => void, boolean]));
    };
    if (two) options();
    const leftBottom = y;
    if (two) panel(x0, underPreview, cw, leftBottom + pad);

    // the place: found by name (Nominatim), one of the airfields, or picked on the map (Q29)
    if (two) { x = rx; colW = rw; y = yTop; } else y += gap;
    label('location');
    const fb = Math.max(this.font.measure(t(L, 'search'), u) + 24 * u, 80 * u);
    this.placeField(x, y - this.oy, colW - fb - gap, bh, h, u);
    this.button(x + colW - fb, y, fb, bh, t(L, 'search'), () => this.runSearch(), false, true);
    y += bh + gap;
    const found = this.found;
    if (found.status === 'busy' || found.status === 'none' || found.status === 'error') {
      const key: StringKey = found.status === 'busy' ? 'searching' : found.status === 'none' ? 'searchNone' : 'searchError';
      y = this.para(t(L, key), x, y, colW, found.status === 'error' ? HUD_AMBER : DIM) + gap;
    }
    if (found.status === 'done') {
      for (const p of found.places) {
        const lbl = this.fit(p.where ? `${p.name} - ${p.where}` : p.name, colW - 12 * u, u);
        this.button(x, y, colW, bh, lbl, () => this.choosePlace(p), cfg.location === 'custom' && cfg.customPoint?.lat === p.lat && cfg.customPoint?.lon === p.lon);
        y += bh + gap;
      }
      this.text(t(L, 'searchCredit'), x, y, u, DIM);
      y += 20 * u;
    }
    row([
      ...AIRFIELDS.map((a): [string, () => void, boolean] => [`${a.icao} ${a.name}`, () => { cfg.location = a.icao; }, cfg.location === a.icao]),
    ]);
    const size = two ? Math.min(colW, Math.max(160 * u, this.barTopAhead(h) - 60 * u - y)) : Math.min(colW, 360 * u);
    const mx = x + (colW - size) / 2, my = y;
    const af = AIRFIELDS.find((a) => a.icao === cfg.location);
    const center = af ?? cfg.customPoint ?? { lat: 47.2603, lon: 11.3439 };
    this.minimap.setView(center, af || !this.placeName ? 500000 : 150000);
    this.minimap.lang = this.settings.lang;
    this.minimap.draw(this.vec, this.font, mx, my - this.oy, size, u, cfg.customPoint ?? undefined);
    this.bottom = Math.max(this.bottom, my + size);
    if (click && click[1] < this.barTopAhead(h)) {
      const p = this.minimap.pick(click[0], click[1], mx, my - this.oy, size);
      if (p) { cfg.customPoint = p; cfg.location = 'custom'; this.pasteNote = null; this.placeName = ''; }
    }
    const note = this.pasteNote;
    let ny = this.para(note ? note.text : t(L, this.touch ? 'pickOnMapTouch' : 'pickOnMap'), x, my + size + 10 * u, colW, note ? (note.error ? HUD_AMBER : HUD_GREEN) : DIM, true);
    const pt = cfg.location === 'custom' && cfg.customPoint
      ? `${this.placeName ? `${this.placeName}  ` : ''}${cfg.customPoint.lat.toFixed(3)}, ${cfg.customPoint.lon.toFixed(3)}`
      : af ? `${af.icao} ${af.name}  ${af.lat.toFixed(3)}, ${af.lon.toFixed(3)}` : '';
    ny = this.para(pt, x, ny + 2 * u, colW, HUD_GREEN, true);
    y = ny + 8 * u;
    if (two) panel(rx, yTop - pad, rw, y + pad);

    if (!two) { x = x0; colW = cw; options(); }

    // the controls' help: the keys, a gamepad's, or the touch controls'; at the end (wide: under the
    // options, just over the bottom bar when there is room)
    const help: string[] = this.touch ? [t(L, 'helpTouch')] : input.pad ? [t(L, 'helpPad')] : [t(L, 'helpAp'), t(L, 'helpNav'), t(L, 'helpFly'), t(L, 'helpKeys')];
    const barY = this.barTopAhead(h) + 8 * u;
    const lines = help.flatMap((line) => this.wrap(line, cw, u));
    let hy = two ? Math.max(leftBottom + 4 * u + pad, barY - 16 * u - lines.length * 18 * u) : y + 4 * u;
    const helpTop = hy - 4 * u;
    for (const line of lines) { this.text(line, x0, hy, u, DIM); hy += 18 * u; }
    if (two) panel(x0, helpTop, cw, hy + 4 * u);
    else panel(x0, underPreview, cw, hy + pad);
    this.panels = panels;

    const bw = two ? cw : Math.min(cw, 420 * u);
    const bx = two ? x0 : x0 + (cw - bw) / 2;
    return this.bar(w, h, barY, () => {
      this.button(bx, barY, bw * 0.45, 40 * u, t(L, 'settings'), () => this.openSettings('start'));
      this.button(bx + bw * 0.5, barY, bw * 0.5, 40 * u, t(L, 'fly') + ' >', () => this.cb.onFly({ ...cfg }), false, true);
    });
  }

  /** `s` cut to `maxW` at this scale, with an ellipsis when it was longer */
  private fit(s: string, maxW: number, scale: number): string {
    if (this.font.measure(s, scale) <= maxW) return s;
    let n = s.length;
    while (n > 1 && this.font.measure(`${s.slice(0, n)}...`, scale) > maxW) n--;
    return `${s.slice(0, n).trimEnd()}...`;
  }

  /** the start screen's panels as laid out last frame (unscrolled device px) */
  private panels: { x: number; y: number; w: number; h: number }[] = [];

  /** where the chosen aircraft is shown on the start screen (device px, as drawn this frame); null on others */
  preview: { x: number; y: number; w: number; h: number } | null = null;

  /** the name of the found place chosen as the start point ('' for a point picked on the map) */
  private placeName = '';
  private readonly geocoder = new Geocoder();
  private found: { status: 'idle' | 'busy' | 'done' | 'none' | 'error'; places: Place[] } = { status: 'idle', places: [] };
  /** the search field: an HTML input over the canvas (a phone's keyboard comes up for it) */
  private field: HTMLInputElement | null = null;
  /** the field shown this frame */
  private fieldShown = false;

  /** the search field has the keyboard */
  private typing(): boolean {
    return !!this.field && document.activeElement === this.field;
  }

  /** the search field over the canvas at (x, y) device px, `fw` × `fh`; hidden under the bottom bar or off screen */
  private placeField(x: number, y: number, fw: number, fh: number, h: number, u: number): void {
    this.vec.rect(x, y, fw, fh, Math.max(1, u), HUD_GREEN);
    if (typeof document === 'undefined') return;
    if (!this.field) {
      const f = document.createElement('input');
      f.type = 'search';
      f.enterKeyHint = 'search';
      f.autocomplete = 'off';
      f.spellcheck = false;
      Object.assign(f.style, {
        position: 'fixed', boxSizing: 'border-box', margin: '0', border: 'none', outline: 'none', background: 'transparent',
        color: FIELD_COLOUR, caretColor: FIELD_COLOUR, fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        // 16 px at least: iOS zooms the page into a smaller one
        fontSize: '16px', padding: '0 8px', textTransform: 'uppercase', zIndex: '2',
      } satisfies Partial<CSSStyleDeclaration>);
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.runSearch(); f.blur(); }
        if (e.key === 'Escape') f.blur();
      });
      document.body.appendChild(f);
      this.field = f;
    }
    const f = this.field;
    f.placeholder = t(this.settings.lang, 'searchHint');
    const visible = y >= this.inset.t && y + fh <= Math.min(h, this.barTopAhead(h)) && !this.remap && !this.remapAxis;
    // the canvas fills the window from its corner: device px × cssScale are the page's px
    const k = this.cssScale;
    Object.assign(f.style, { left: `${x * k}px`, top: `${y * k}px`, width: `${fw * k}px`, height: `${fh * k}px`, display: visible ? 'block' : 'none' });
    this.fieldShown = visible;
  }

  /** off the start screen (no menu drawn at all): no search field */
  hideField(): void {
    if (!this.field || this.field.style.display === 'none') return;
    this.field.style.display = 'none';
    this.field.blur();
  }

  /** css px per device px of the canvas, set by draw */
  private cssScale = 0;

  private runSearch(): void {
    const q = this.field?.value ?? '';
    if (!q.trim() || this.found.status === 'busy') return;
    this.found = { status: 'busy', places: [] };
    this.geocoder.search(q, this.settings.lang === 'ua' ? 'uk' : this.settings.lang).then(
      (places) => {
        this.found = { status: places.length ? 'done' : 'none', places };
        if (places.length === 1) this.choosePlace(places[0]);
      },
      () => { this.found = { status: 'error', places: [] }; },
    );
  }

  private choosePlace(p: Place): void {
    this.config.customPoint = { lat: p.lat, lon: p.lon };
    this.config.location = 'custom';
    this.placeName = p.name;
    this.pasteNote = null;
  }

  /** rows of text along the screen's bottom under the menus (the attribution, in dev the stats) */
  footRows = 1;

  /** where the bottom bar of a screen this tall starts (its buttons' top): over the bottom rows */
  private barTopAhead(h: number): number {
    return Math.min(h * 0.86, h - this.inset.b - (56 + 18 * this.footRows) * this.u);
  }

  /** the settings screen; returns the top of its bottom bar */
  private drawSettings(w: number, h: number, u: number, input: Input): number {
    const L = this.settings.lang;
    const s = this.settings;
    const ins = this.inset;
    const two = w / u >= TWO_COLUMNS;
    const top = ins.t + (two ? h * 0.04 : 16 * u);
    this.center(t(L, 'settings'), w / 2, top, u * 2, HUD_AMBER);

    const x0 = two ? w * 0.05 : ins.l + 16 * u;
    const cw = two ? w * 0.34 : w - x0 - ins.r - 16 * u;
    const bh = 26 * u;
    let y = two ? Math.max(h * 0.13, top + 48 * u) : top + 48 * u;
    const y0 = y;
    const toggle = (key: StringKey, options: [string, boolean][], set: (i: number) => void): void => {
      this.text(t(L, key), x0, y, u, HUD_GREEN);
      y += 18 * u;
      const bw = Math.min(110 * u, (cw - 6 * u * (options.length - 1)) / options.length);
      options.forEach(([lbl, sel], i) => {
        this.button(x0 + i * (bw + 6 * u), y, bw, bh, lbl, () => {
          set(i); saveSettings(s); this.cb.onSettingsChanged();
        }, sel);
      });
      y += bh + 12 * u;
    };
    const onOff = (key: StringKey, get: () => boolean, set: (v: boolean) => void): void => {
      toggle(key, [[t(L, 'off'), !get()], [t(L, 'on'), get()]], (i) => set(i === 1));
    };
    toggle('units', [[t(L, 'metric'), s.units === 'metric'], [t(L, 'imperial'), s.units === 'imperial']], (i) => { s.units = i === 0 ? 'metric' : 'imperial'; });
    toggle('language', [['EN', L === 'en'], ['RU', L === 'ru'], ['UA', L === 'ua']], (i) => { s.lang = (['en', 'ru', 'ua'] as const)[i]; });
    toggle('touchControls', [[t(L, 'auto'), s.touchControls === 'auto'], [t(L, 'on'), s.touchControls === 'on'], [t(L, 'off'), s.touchControls === 'off']], (i) => { s.touchControls = (['auto', 'on', 'off'] as const)[i]; });
    toggle('detail', [[t(L, 'auto'), s.detail === 'auto'], [t(L, 'detailFull'), s.detail === 'full'], [t(L, 'detailPhone'), s.detail === 'phone']], (i) => { s.detail = (['auto', 'full', 'phone'] as const)[i]; });
    onOff('mouseJoystick', () => s.mouseJoystick, (v) => { s.mouseJoystick = v; });
    onOff('sound', () => s.sound, (v) => { s.sound = v; });
    onOff('msaa', () => s.msaa, (v) => { s.msaa = v; });
    onOff('hdr', () => s.hdr, (v) => { s.hdr = v; });
    // XDR on, but the frame is SDR: say why (the browser, the screen, or still starting)
    const blocker = s.hdr ? this.cb.hdrStatus() : null;
    if (blocker !== null && blocker !== 'setting') {
      const why: Record<Exclude<HdrBlocker, 'setting'>, StringKey> = { browser: 'hdrNoBrowser', display: 'hdrNoDisplay', pending: 'hdrPending' };
      y = this.para(t(L, why[blocker]), x0, y - 6 * u, cw, DIM) + 6 * u;
    }

    // bindings (Q37): the keys, or the gamepad's buttons and axes; two columns when there is room
    const kx = two ? w * 0.46 : x0;
    const kw = two ? w * 0.49 : cw;
    let ky = two ? y0 - 4 * u : y + 8 * u;
    const tw = Math.min(140 * u, (kw - 6 * u) / 2);
    this.button(kx, ky, tw, bh, t(L, 'keyboard'), () => { this.bindTab = 'keyboard'; }, this.bindTab === 'keyboard');
    this.button(kx + tw + 6 * u, ky, tw, bh, t(L, 'gamepad'), () => { this.bindTab = 'gamepad'; }, this.bindTab === 'gamepad');
    ky += bh + 12 * u;
    const cols = kw / u >= 560 ? 2 : 1;
    const colW = kw / cols, rowH = 24 * u;
    const pad = input.pad;
    if (this.bindTab === 'gamepad') {
      ky = this.para(pad ? `${pad.id}${pad.mapping === 'standard' ? '' : ' (JOYSTICK)'}` : t(L, 'padNone'), kx, ky, kw, pad ? HUD_GREEN : HUD_AMBER) + 6 * u;
      // the axes: which one drives each control, and whether it is reversed
      this.text(t(L, 'padAxes'), kx, ky, u, HUD_AMBER);
      ky += 20 * u;
      const axes = pad ? padAxes(pad, s.padAxes) : null;
      PAD_AXIS_ROLES.forEach((role, i) => {
        const col = i % cols, rowY = ky + Math.floor(i / cols) * rowH;
        const x = kx + col * colW;
        this.text(t(L, AXIS_KEY[role]), x, rowY + 4 * u, u, DIM);
        const b = axes ? axes[role] : (s.padAxes[role] ?? null);
        const assigning = this.remapAxis?.role === role;
        this.button(x + colW - 140 * u, rowY, 78 * u, rowH - 4 * u, assigning ? '...' : b ? `A${b.i}` : '-', () => {
          if (pad) this.remapAxis = { role, rest: pad.axes.slice() };
        }, assigning);
        this.button(x + colW - 56 * u, rowY, 50 * u, rowH - 4 * u, t(L, 'invert'), () => {
          if (!b) return;
          s.padAxes[role] = { i: b.i, inv: !b.inv };
          saveSettings(s);
        }, !!b?.inv);
      });
      ky += Math.ceil(PAD_AXIS_ROLES.length / cols) * rowH + 12 * u;
    }
    const gamepad = this.bindTab === 'gamepad';
    if (!gamepad) { this.text(t(L, 'keys'), kx, ky, u, HUD_AMBER); ky += 20 * u; }
    REMAP_ACTIONS.forEach((a, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = kx + col * colW, ry = ky + row * rowH;
      this.text(t(L, a as StringKey), x, ry + 4 * u, u, DIM);
      const code = gamepad ? (this.controls?.padBinding(a, s) ?? s.padBindings[a] ?? '') : s.bindings[a] ?? DEFAULT_BINDINGS[a];
      const lbl = this.remap === a ? '...' : gamepad ? (code ? padCodeLabel(code) : '-') : code.replace('Key', '').replace('Arrow', '').replace('Digit', '');
      this.button(x + colW - 84 * u, ry, 78 * u, rowH - 4 * u, lbl, () => { this.remap = a; this.remapPad = gamepad; }, this.remap === a);
    });

    const barY = this.barTopAhead(h) + 8 * u;
    return this.bar(w, h, barY, () => {
      this.button(x0, barY, 160 * u, 36 * u, t(L, 'back'), () => { this.screen = this.returnTo; });
      if (!this.touch && two) this.text(t(L, 'helpMenu'), x0 + 180 * u, barY + 10 * u, u, DIM);
    });
  }

  private drawPause(w: number, h: number, u: number, marker?: LatLon): void {
    const L = this.settings.lang;
    const ins = this.inset;
    const top = ins.t + Math.max(16 * u, h * 0.06);
    this.center(t(L, 'paused'), w / 2, top, u * 3, HUD_AMBER);
    let y = top + 50 * u;
    if (this.clockText) {
      y = this.para(this.clockText, ins.l + 16 * u, y, w - ins.l - ins.r - 32 * u, HUD_GREEN, true) + 8 * u;
    }
    const size = Math.min(w * 0.4, h * 0.5, w - ins.l - ins.r - 32 * u);
    const mx = w / 2 - size / 2, my = Math.max(y, h * 0.16);
    if (marker) this.minimap.setView(marker, 120000);
    this.minimap.lang = this.settings.lang;
    this.minimap.draw(this.vec, this.font, mx, my - this.oy, size, u, marker);

    y = my + size + 16 * u;
    this.center(t(L, 'time'), w / 2, y, u, HUD_AMBER);
    y += 20 * u;
    const room = w - ins.l - ins.r - 32 * u;
    const gap = 8 * u;
    const bw = Math.min(80 * u, (room - gap * (TIME_STEPS.length - 1)) / TIME_STEPS.length);
    TIME_STEPS.forEach((s, i) => {
      this.button(w / 2 - (TIME_STEPS.length * (bw + gap) - gap) / 2 + i * (bw + gap), y, bw, 28 * u, `x${s}`, () => { this.config.timeAccel = s; }, this.config.timeAccel === s);
    });
    y += 44 * u;
    // four in a row, or two by two when they do not fit
    const items: [string, () => void, boolean][] = [
      [t(L, 'resume'), () => this.cb.onResume(), true],
      [t(L, 'restart'), () => this.cb.onRestart(), false],
      [t(L, 'newPoint'), () => this.cb.onNewPoint(), false],
      [t(L, 'settings'), () => this.openSettings('pause'), false],
    ];
    const rg = 10 * u, rh = 32 * u;
    const per = room >= 4 * 150 * u + 3 * rg ? 4 : 2;
    const rw = Math.min(150 * u, (room - rg * (per - 1)) / per);
    const x0 = w / 2 - (per * rw + (per - 1) * rg) / 2;
    items.forEach(([lbl, act, amber], i) => {
      this.button(x0 + (i % per) * (rw + rg), y + Math.floor(i / per) * (rh + rg), rw, rh, lbl, act, false, amber);
    });
  }

  private drawCrashed(w: number, h: number, u: number): void {
    const L = this.settings.lang;
    const room = w - this.inset.l - this.inset.r - 32 * u;
    let y = this.para(`${t(L, 'crash')}: ${this.crashReason}`, this.inset.l + 16 * u, h * 0.3, room, HUD_AMBER, true) + 16 * u;
    // side by side, or one under the other on a narrow screen
    const side = room >= 430 * u;
    const bw = side ? 200 * u : Math.min(room, 260 * u), bh = 40 * u;
    const keys = this.touch ? ['', ''] : [' (R)', ' (N)'];
    if (side) {
      this.button(w / 2 - bw - 15 * u, y, bw, bh, t(L, 'restart') + keys[0], () => this.cb.onRestart(), false, true);
      this.button(w / 2 + 15 * u, y, bw, bh, t(L, 'newPoint') + keys[1], () => this.cb.onNewPoint());
    } else {
      this.button(w / 2 - bw / 2, y, bw, bh, t(L, 'restart') + keys[0], () => this.cb.onRestart(), false, true);
      y += bh + 12 * u;
      this.button(w / 2 - bw / 2, y, bw, bh, t(L, 'newPoint') + keys[1], () => this.cb.onNewPoint());
    }
  }
}
