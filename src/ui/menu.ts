import { FontRenderer, HUD_AMBER, HUD_GREEN, HUD_WHITE } from '../engine/font';
import { VectorRenderer } from '../engine/vector';
import { RAMP, rampIndex } from '../engine/palette';
import type { Input } from '../engine/input';
import { t, type StringKey } from './i18n';
import { saveSettings, type Settings } from './settings';
import { AIRFIELDS, Minimap } from './minimap';
import { MAP_SOURCE_NAME, parseMapLink } from './map-links';
import type { LatLon } from '../world/geodesy';
import { TIMES_OF_DAY, type TimeOfDay } from '../world/time-of-day';
import { AIRCRAFT, type AircraftId } from '../flight/aircraft';
import { DEFAULT_BINDINGS, type Action } from '../flight/controls';

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
}

export interface MenuCallbacks {
  onFly(cfg: FlightConfig): void;
  onConsent(allow: boolean): void;
  onResume(): void;
  onRestart(): void;
  onNewPoint(): void;
  onSettingsChanged(): void;
}

interface Button {
  x: number; y: number; w: number; h: number;
  label: string;
  action: () => void;
  selected: boolean;
  amber: boolean;
}

const REMAP_ACTIONS: Action[] = [
  'pitchUp', 'pitchDown', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight',
  'throttleUp', 'throttleDown', 'gear', 'flaps', 'brakes', 'speedbrake',
  'pause', 'mute', 'camCockpit', 'camOrbit', 'camChase', 'camFlyby', 'camTower', 'camTarget',
];

const TIME_STEPS = [1, 10, 60, 600];
const TOD_KEY: Record<TimeOfDay, StringKey> = {
  real: 'todReal', morning: 'todMorning', day: 'todDay', evening: 'todEvening', night: 'todNight',
};
const PANEL = rampIndex(RAMP.SKY, 2);
const DIM = rampIndex(RAMP.HUD_GREEN, 6);

export class Menu {
  screen: MenuScreen = 'none';
  config: FlightConfig = { aircraft: 'su27', insignia: '', loadout: '', location: 'LOWI', customPoint: null, startMode: 'air', timeAccel: 1, timeOfDay: 'real' };
  readonly minimap = new Minimap();
  crashReason = '';
  /** sim clock / sun / moon summary shown on the pause screen */
  clockText = '';
  private buttons: Button[] = [];
  private remap: Action | null = null;
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
    this.pasteNote = { text: `${t(L, 'pastedPoint')} ${MAP_SOURCE_NAME[p.source].toUpperCase()}`, error: false };
    return true;
  }

  openSettings(from: MenuScreen): void {
    this.returnTo = from;
    this.screen = 'settings';
  }

  private text(s: string, x: number, y: number, scale: number, color: number): void {
    this.font.text(s, x, y, scale, color);
  }

  private center(s: string, cx: number, y: number, scale: number, color: number): void {
    this.font.text(s, cx - this.font.measure(s, scale) / 2, y, scale, color);
  }

  private button(x: number, y: number, w: number, h: number, label: string, action: () => void, selected = false, amber = false): void {
    this.buttons.push({ x, y, w, h, label, action, selected, amber });
  }

  private drawButtons(hover: [number, number] | null): void {
    const lw = Math.max(1, this.u);
    for (const b of this.buttons) {
      const hov = hover && hover[0] >= b.x && hover[0] <= b.x + b.w && hover[1] >= b.y && hover[1] <= b.y + b.h;
      const color = b.amber ? HUD_AMBER : HUD_GREEN;
      if (b.selected || hov) {
        this.vec.fillRect(b.x, b.y, b.w, b.h, b.amber ? rampIndex(RAMP.HUD_AMBER, 3) : rampIndex(RAMP.HUD_GREEN, 3));
      }
      this.vec.rect(b.x, b.y, b.w, b.h, lw, color);
      const scale = this.u;
      const tw = this.font.measure(b.label, scale);
      this.font.text(b.label, b.x + (b.w - tw) / 2, b.y + (b.h - 16 * scale) / 2, scale, b.selected || hov ? HUD_WHITE : color);
    }
  }

  private u = 1;

  /** Returns true when the menu consumed the frame (world still renders behind). */
  draw(w: number, h: number, u: number, cssW: number, cssH: number, input: Input, marker?: LatLon): void {
    this.u = u;
    this.buttons = [];
    const sx = w / cssW, sy = h / cssH;
    const click = input.consumeClick();
    const clickDev: [number, number] | null = click ? [click[0] * sx, click[1] * sy] : null;
    const hover: [number, number] = [input.mouseX * sx + w / 2, input.mouseY * sy + h / 2];

    if (this.remap) {
      const key = input.consumeKey();
      if (key === 'Escape') this.remap = null;
      else if (key) {
        this.settings.bindings[this.remap] = key;
        saveSettings(this.settings);
        this.remap = null;
        this.cb.onSettingsChanged();
      }
    }

    switch (this.screen) {
      case 'consent': this.drawConsent(w, h, u); break;
      case 'start': this.drawStart(w, h, u, clickDev); break;
      case 'settings': this.drawSettings(w, h, u); break;
      case 'pause': this.drawPause(w, h, u, marker); break;
      case 'crashed': this.drawCrashed(w, h, u); break;
      case 'none': return;
    }

    this.drawButtons(hover);
    if (clickDev) {
      for (const b of this.buttons) {
        if (clickDev[0] >= b.x && clickDev[0] <= b.x + b.w && clickDev[1] >= b.y && clickDev[1] <= b.y + b.h) {
          b.action();
          break;
        }
      }
    }
    if (this.remap) {
      const msg = t(this.settings.lang, 'pressKey');
      const bw = this.font.measure(msg, u * 2) + 40 * u;
      this.vec.fillRect((w - bw) / 2, h * 0.45, bw, 50 * u, PANEL);
      this.vec.rect((w - bw) / 2, h * 0.45, bw, 50 * u, u, HUD_AMBER);
      this.center(msg, w / 2, h * 0.45 + 16 * u, u * 2, HUD_AMBER);
    }
  }

  private drawConsent(w: number, h: number, u: number): void {
    const L = this.settings.lang;
    this.vec.fillRect(w * 0.15, h * 0.2, w * 0.7, h * 0.55, PANEL);
    this.vec.rect(w * 0.15, h * 0.2, w * 0.7, h * 0.55, u, HUD_GREEN);
    this.center(t(L, 'consentTitle'), w / 2, h * 0.26, u * 2, HUD_AMBER);
    const lines = t(L, 'consentBody').split('\n');
    lines.forEach((line, i) => this.center(line, w / 2, h * 0.36 + i * 22 * u, u, HUD_GREEN));
    const bw = 180 * u, bh = 36 * u, y = h * 0.62;
    this.button(w / 2 - bw - 20 * u, y, bw, bh, t(L, 'consentYes'), () => this.cb.onConsent(true), false, true);
    this.button(w / 2 + 20 * u, y, bw, bh, t(L, 'consentNo'), () => this.cb.onConsent(false));
  }

  private drawStart(w: number, h: number, u: number, click: [number, number] | null): void {
    const L = this.settings.lang;
    const cfg = this.config;
    this.center(t(L, 'title'), w / 2, h * 0.05, u * 3, HUD_AMBER);
    this.center(t(L, 'subtitle'), w / 2, h * 0.05 + 42 * u, u, HUD_GREEN);

    const x0 = w * 0.06, cw = w * 0.36, bh = 28 * u, gap = 6 * u;
    let y = h * 0.17;
    const label = (key: StringKey): void => { this.text(t(L, key), x0, y, u, HUD_AMBER); y += 20 * u; };
    const row = (items: [string, () => void, boolean][]): void => {
      const bw = (cw - gap * (items.length - 1)) / items.length;
      items.forEach(([lbl, act, sel], i) => this.button(x0 + i * (bw + gap), y, bw, bh, lbl, act, sel));
      y += bh + gap * 2;
    };

    label('aircraft');
    const pick = (id: AircraftId, name: string): [string, () => void, boolean] => [name, () => {
      if (cfg.aircraft !== id) Object.assign(cfg, { aircraft: id, insignia: '', loadout: '' });
    }, cfg.aircraft === id];
    row([pick('su27', 'SU-27 FLANKER'), pick('f117', 'F-117A NIGHTHAWK')]);
    row([pick('f16', 'F-16AM FALCON'), pick('an225', 'AN-225 MRIYA')]);
    // the chosen aircraft's markings and loadouts, when it has a choice of them (the first is its default)
    const ac = AIRCRAFT[cfg.aircraft];
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
    label('location');
    row([
      ['LTBS', () => { cfg.location = 'LTBS'; }, cfg.location === 'LTBS'],
      ['LOWI', () => { cfg.location = 'LOWI'; }, cfg.location === 'LOWI'],
      [t(L, 'custom'), () => { cfg.location = 'custom'; }, cfg.location === 'custom'],
    ]);
    label('startMode');
    row([
      [t(L, 'runway'), () => { cfg.startMode = 'runway'; }, cfg.startMode === 'runway'],
      [t(L, 'air'), () => { cfg.startMode = 'air'; }, cfg.startMode === 'air'],
    ]);
    label('time');
    row(TIME_STEPS.map((s) => [`x${s}`, () => { cfg.timeAccel = s; }, cfg.timeAccel === s] as [string, () => void, boolean]));
    label('timeOfDay');
    row(TIMES_OF_DAY.map((k) => [t(L, TOD_KEY[k]), () => { cfg.timeOfDay = k; }, cfg.timeOfDay === k] as [string, () => void, boolean]));

    // minimap: click to pick an arbitrary point (Q29)
    const size = Math.min(w * 0.42, h * 0.52);
    const mx = w * 0.52, my = h * 0.17;
    const af = AIRFIELDS.find((a) => a.icao === cfg.location);
    const center = af ?? cfg.customPoint ?? { lat: 47.2603, lon: 11.3439 };
    this.minimap.setView(center, 500000);
    this.minimap.lang = this.settings.lang;
    this.minimap.draw(this.vec, this.font, mx, my, size, u, cfg.customPoint ?? undefined);
    if (click) {
      const p = this.minimap.pick(click[0], click[1], mx, my, size);
      if (p) { cfg.customPoint = p; cfg.location = 'custom'; this.pasteNote = null; }
    }
    const note = this.pasteNote;
    this.center(note ? note.text : t(L, 'pickOnMap'), mx + size / 2, my + size + 10 * u, u, note ? (note.error ? HUD_AMBER : HUD_GREEN) : DIM);
    const pt = cfg.location === 'custom' && cfg.customPoint
      ? `${cfg.customPoint.lat.toFixed(3)}, ${cfg.customPoint.lon.toFixed(3)}`
      : af ? `${af.icao} ${af.name}  ${af.lat.toFixed(3)}, ${af.lon.toFixed(3)}` : '';
    this.center(pt, mx + size / 2, my + size + 30 * u, u, HUD_GREEN);

    const by = h * 0.86;
    this.button(x0, by, cw * 0.45, 40 * u, t(L, 'settings'), () => this.openSettings('start'));
    this.button(x0 + cw * 0.5, by, cw * 0.5, 40 * u, t(L, 'fly') + ' >', () => this.cb.onFly({ ...cfg }), false, true);
    this.text(t(L, 'helpFly'), x0, h * 0.86 - 44 * u, u, DIM);
    this.text(t(L, 'helpKeys'), x0, h * 0.86 - 26 * u, u, DIM);
    this.text(t(L, 'helpAp'), x0, h * 0.86 - 80 * u, u, DIM);
    this.text(t(L, 'helpNav'), x0, h * 0.86 - 62 * u, u, DIM);
  }

  private drawSettings(w: number, h: number, u: number): void {
    const L = this.settings.lang;
    const s = this.settings;
    this.center(t(L, 'settings'), w / 2, h * 0.04, u * 2, HUD_AMBER);

    const x0 = w * 0.05, cw = w * 0.34, bh = 26 * u;
    let y = h * 0.13;
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
    onOff('mouseJoystick', () => s.mouseJoystick, (v) => { s.mouseJoystick = v; });
    onOff('sound', () => s.sound, (v) => { s.sound = v; });
    onOff('msaa', () => s.msaa, (v) => { s.msaa = v; });
    onOff('hdr', () => s.hdr, (v) => { s.hdr = v; });

    // key bindings (Q37): two columns
    const kx = w * 0.46, kw = w * 0.49, colW = kw / 2, rowH = 24 * u;
    this.text(t(L, 'keys'), kx, h * 0.13 - 4 * u, u, HUD_AMBER);
    REMAP_ACTIONS.forEach((a, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = kx + col * colW, ry = h * 0.13 + 20 * u + row * rowH;
      this.text(t(L, a as StringKey), x, ry + 4 * u, u, DIM);
      const code = s.bindings[a] ?? DEFAULT_BINDINGS[a];
      const lbl = this.remap === a ? '...' : code.replace('Key', '').replace('Arrow', '').replace('Digit', '');
      this.button(x + colW - 84 * u, ry, 78 * u, rowH - 4 * u, lbl, () => { this.remap = a; }, this.remap === a);
    });

    this.button(x0, h * 0.9, 160 * u, 36 * u, t(L, 'back'), () => { this.screen = this.returnTo; });
    this.text(t(L, 'helpMenu'), x0 + 180 * u, h * 0.9 + 10 * u, u, DIM);
  }

  private drawPause(w: number, h: number, u: number, marker?: LatLon): void {
    const L = this.settings.lang;
    this.center(t(L, 'paused'), w / 2, h * 0.06, u * 3, HUD_AMBER);
    if (this.clockText) this.center(this.clockText, w / 2, h * 0.06 + 50 * u, u, HUD_GREEN);
    const size = Math.min(w * 0.4, h * 0.5);
    const mx = w / 2 - size / 2, my = h * 0.16;
    if (marker) this.minimap.setView(marker, 120000);
    this.minimap.lang = this.settings.lang;
    this.minimap.draw(this.vec, this.font, mx, my, size, u, marker);

    let y = my + size + 16 * u;
    this.center(t(L, 'time'), w / 2, y, u, HUD_AMBER);
    y += 20 * u;
    const bw = 80 * u, gap = 8 * u;
    TIME_STEPS.forEach((s, i) => {
      this.button(w / 2 - (TIME_STEPS.length * (bw + gap)) / 2 + i * (bw + gap), y, bw, 28 * u, `x${s}`, () => { this.config.timeAccel = s; }, this.config.timeAccel === s);
    });
    y += 44 * u;
    const rw = 150 * u, rh = 32 * u, rg = 10 * u;
    const total = rw * 4 + rg * 3;
    const x0 = w / 2 - total / 2;
    this.button(x0, y, rw, rh, t(L, 'resume'), () => this.cb.onResume(), false, true);
    this.button(x0 + rw + rg, y, rw, rh, t(L, 'restart'), () => this.cb.onRestart());
    this.button(x0 + (rw + rg) * 2, y, rw, rh, t(L, 'newPoint'), () => this.cb.onNewPoint());
    this.button(x0 + (rw + rg) * 3, y, rw, rh, t(L, 'settings'), () => this.openSettings('pause'));
  }

  private drawCrashed(w: number, h: number, u: number): void {
    const L = this.settings.lang;
    this.center(`${t(L, 'crash')}: ${this.crashReason}`, w / 2, h * 0.3, u * 2, HUD_AMBER);
    const bw = 200 * u, bh = 40 * u, y = h * 0.45;
    this.button(w / 2 - bw - 15 * u, y, bw, bh, t(L, 'restart') + ' (R)', () => this.cb.onRestart(), false, true);
    this.button(w / 2 + 15 * u, y, bw, bh, t(L, 'newPoint') + ' (N)', () => this.cb.onNewPoint());
  }
}