import { quat, vec3 } from 'gl-matrix';
import { FontRenderer, HUD_AMBER, HUD_GREEN, HUD_WHITE } from '../engine/font';
import { VectorRenderer } from '../engine/vector';
import type { Units } from '../ui/settings';
import { cloudCode, compassPoint, type Weather } from '../world/weather';
import type { CameraMode } from './cameras';
import type { PartId } from './aircraft';
import type { FlightModel, FlightControls } from './model';
import { angDiff, freqText, rwyText, type Cdi, type Navaid, type Reception } from './navaids';

const D2R = Math.PI / 180;

export function speedValue(ms: number, units: Units): number {
  return units === 'metric' ? ms * 3.6 : ms * 1.94384;
}

export function altValue(m: number, units: Units): number {
  return units === 'metric' ? m : m * 3.28084;
}

export function speedUnit(units: Units): string {
  return units === 'metric' ? 'KM/H' : 'KT';
}

export function altUnit(units: Units): string {
  return units === 'metric' ? 'M' : 'FT';
}

interface Labels {
  stall: string;
  spin: string;
  lost: string;
  parts: Record<PartId, string>;
  touchdown: string;
  gear: string;
  flaps: string;
  brakes: string;
  speedbrake: string;
  ab: string;
  hdg: string;
  vs: string;
  thr: string;
  nav1: string;
  adf: string;
  crs: string;
  to: string;
  from: string;
  dme: string;
  sel: string;
  ra: string;
  dh: string;
  vapp: string;
  rwThr: string;
  noIls: string;
  noSignal: string;
  hudNav: string;
  hudApp: string;
  apArm: string;
  rollout: string;
}

const RU: Labels = {
  stall: 'СВАЛИВАНИЕ', spin: 'ШТОПОР', lost: 'ПОТЕРЯНО',
  parts: {
    wingL: 'ЛЕВОЕ КРЫЛО', wingR: 'ПРАВОЕ КРЫЛО', stabL: 'ЛЕВЫЙ СТАБИЛИЗАТОР', stabR: 'ПРАВЫЙ СТАБИЛИЗАТОР',
    finL: 'ЛЕВЫЙ КИЛЬ', finR: 'ПРАВЫЙ КИЛЬ',
  },
  touchdown: 'КАСАНИЕ', gear: 'ШАССИ', flaps: 'ЗАКРЫЛКИ',
  brakes: 'ТОРМОЗ', speedbrake: 'ЩИТКИ', ab: 'ФОРСАЖ', hdg: 'КУРС', vs: 'ВЕРТ', thr: 'ТЯГА',
  nav1: 'НАВ1', adf: 'АРК', crs: 'ЗПУ', to: 'НА', from: 'ОТ', dme: 'ДАЛ', sel: 'ЗАД', ra: 'РВ', dh: 'ВПР',
  vapp: 'VПОС', rwThr: 'ТОРЕЦ', noIls: 'НЕТ ИЛС', noSignal: 'НЕТ СИГН', hudNav: 'НАВ', hudApp: 'ПОС',
  apArm: 'ВЗВ', rollout: 'ПРОБЕГ',
};
const EN: Labels = {
  stall: 'STALL', spin: 'SPIN', lost: 'LOST',
  parts: { wingL: 'LEFT WING', wingR: 'RIGHT WING', stabL: 'LEFT STAB', stabR: 'RIGHT STAB', finL: 'LEFT FIN', finR: 'RIGHT FIN' },
  touchdown: 'TOUCHDOWN', gear: 'GEAR', flaps: 'FLAPS',
  brakes: 'BRAKE', speedbrake: 'SPD BRK', ab: 'AFTERBURNER', hdg: 'HDG', vs: 'V/S', thr: 'THR',
  nav1: 'NAV1', adf: 'ADF', crs: 'CRS', to: 'TO', from: 'FR', dme: 'DME', sel: 'SEL', ra: 'RA', dh: 'MINIMUMS',
  vapp: 'VAPP', rwThr: 'THR', noIls: 'NO ILS', noSignal: 'NO SIGNAL', hudNav: 'NAV', hudApp: 'APP',
  apArm: 'ARM', rollout: 'ROLLOUT',
};

function rotate(x: number, y: number, cx: number, cy: number, ang: number): [number, number] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** NAV: en-route symbology; APP: approach — conformal scale, ILS raw data, runway outline, minimums */
export type HudMode = 'NAV' | 'APP';

/** what the radios and the approach give the HUD */
export interface HudNav {
  /** the tuned NAV1 station (VOR or ILS) and what it reads; rx.inRange false when there is no signal */
  nav1?: { rx: Reception; cdi: Cdi } | null;
  /** the tuned ADF (NDB) */
  adf?: { rx: Reception } | null;
  /** APP: the runway of the tuned ILS, relative to the aircraft in world axes (x east, y up, z south), m */
  runway?: { corners: [number, number, number][]; aim: [number, number, number] } | null;
  /** height above the ground under the aircraft, m */
  ra: number;
  /** approach speed, m/s */
  vapp: number;
}

/** decision height for the MINIMUMS call, m above the ground */
export const DH_M = 60;

export interface HudState {
  model: FlightModel;
  controls: FlightControls;
  camera: CameraMode;
  units: Units;
  now: number;
  soundOn: boolean;
  /** engaged autopilot targets, or null when off; mode is the autoland phase, lateral 'HDG' | 'NAV' */
  autopilot?: { altitude: number; speed: number; heading: number; mode?: string; lateral?: string } | null;
  hudMode?: HudMode;
  nav?: HudNav;
  /** vertical field of view of the cockpit camera, deg: APP symbology is drawn conformal to it */
  fovYDeg?: number;
  /** live weather (world/weather.ts), shown top right; tempC may be overridden */
  weather?: { data?: Weather; tempC?: number };
  /** the sim's date and time, shown top right above the weather */
  time?: Date;
  /** a phone's screen: the notch to keep clear of and the touch controls' room (absent: none) */
  layout?: HudLayout;
}

/**
 * What the HUD keeps clear of, device px. inset: the screen's unsafe edges (notch, rounded corners,
 * home bar). reserve: the touch controls — a column on the right below the top rows, a band across
 * the bottom, a column on the left beside the bottom-left corner.
 */
export interface HudLayout {
  inset: { l: number; t: number; r: number; b: number };
  reserve: { right: number; bottom: number; left: number; low?: { y: number; right: number } };
  /** where the camera's axis meets the screen when its projection is shifted off centre (main.ts), px */
  boresightY?: number;
}

/** what the right column leaves below low.y (only the lever stands there): low.right */
const NO_LAYOUT: HudLayout = { inset: { l: 0, t: 0, r: 0, b: 0 }, reserve: { right: 0, bottom: 0, left: 0 } };

/** narrower than this many text units the top rows cannot share a line: the centre line goes under them */
const NARROW_UNITS = 640;

/** the sim date and time in UTC, as aviation keeps it: "21.11.2026 08:45:07Z" */
export function clockLine(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}

/** wind speed in the HUD: m/s (Russian practice) in metric, knots otherwise */
function windValue(ms: number, units: Units): number {
  return units === 'metric' ? ms : ms * 1.94384;
}

/**
 * Weather lines for the top-right corner: temperature, wind (from, speed, gusts), cloud cover.
 * Before the first response: one "loading" line.
 */
export function weatherLines(data: Weather | undefined, tempC: number | undefined, units: Units, lang: 'ru' | 'en'): string[] {
  const ru = lang === 'ru';
  if (tempC === undefined) return [ru ? 'ПОГОДА...' : 'WEATHER...'];
  const t = `${ru ? 'ТЕМП' : 'TEMP'} ${tempC > 0 ? '+' : ''}${Math.round(tempC)}\u00B0C`;
  if (!data) return [t];
  const unit = units === 'metric' ? (ru ? 'М/С' : 'M/S') : 'KT';
  const spd = Math.round(windValue(data.windMs, units));
  const gust = Math.round(windValue(data.gustMs, units));
  const dir = String(Math.round(data.windFromDeg) % 360).padStart(3, '0');
  const wind = spd === 0
    ? `${ru ? 'ВЕТЕР' : 'WIND'} ${ru ? 'ШТИЛЬ' : 'CALM'}`
    : `${ru ? 'ВЕТЕР' : 'WIND'} ${dir}\u00B0 ${compassPoint(data.windFromDeg, lang)} ${spd}${gust > spd + 2 ? `G${gust}` : ''} ${unit}`;
  const cloud = `${ru ? 'ОБЛ' : 'CLD'} ${cloudCode(data.cloudPct)} ${Math.round(data.cloudPct)}%`;
  const fall = precipLine(data, units, lang);
  return fall ? [t, wind, cloud, fall] : [t, wind, cloud];
}

/** "RAIN 2.4 MM/H", "SNOW …", "TSTM …" (a thunderstorm) for what falls; '' in dry weather */
export function precipLine(data: Weather, units: Units, lang: 'ru' | 'en'): string {
  const ru = lang === 'ru';
  const falling = data.precipKind !== undefined && data.precipKind !== 'none' && (data.precipMmH ?? 0) > 0;
  if (!falling && !data.thunder) return '';
  const name = data.thunder ? (ru ? 'ГРОЗА' : 'TSTM') : data.precipKind === 'snow' ? (ru ? 'СНЕГ' : 'SNOW') : (ru ? 'ДОЖДЬ' : 'RAIN');
  if (!falling) return name;
  const mmH = data.precipMmH ?? 0;
  if (units === 'imperial') return `${name} ${(mmH / 25.4).toFixed(2)} IN/H`;
  return `${name} ${mmH >= 10 ? Math.round(mmH) : mmH.toFixed(1)} ${ru ? 'ММ/Ч' : 'MM/H'}`;
}

/** "LOST: LEFT WING, RIGHT FIN" for the parts that have separated, in the order they went; '' when intact */
export function damageLine(model: FlightModel, lang: 'ru' | 'en'): string {
  if (model.damage.length === 0) return '';
  const L = lang === 'ru' ? RU : EN;
  return `${L.lost}: ${model.damage.map((d) => L.parts[d.part]).join(', ')}`;
}

/** flashing stall / spin alert at y, with the standing list of lost parts under it */
function drawAlerts(font: FontRenderer, w: number, y: number, u: number, st: HudState, L: Labels): void {
  const { model, now } = st;
  if (model.stall && Math.floor(now * 3) % 2 === 0) {
    const text = model.spin ? L.spin : L.stall;
    font.text(text, (w - font.measure(text, u * 2)) / 2, y, u * 2, HUD_AMBER);
  }
  const lost = damageLine(model, model.cfg.hudLang);
  if (lost) font.text(lost, (w - font.measure(lost, u)) / 2, y + 38 * u, u, HUD_AMBER);
}

/** right-aligned weather block from y down, its right edge at `right` */
function drawWeather(font: FontRenderer, right: number, y: number, u: number, st: HudState, lang: 'ru' | 'en'): number {
  const lines = [
    ...(st.time ? [clockLine(st.time)] : []),
    ...(st.weather ? weatherLines(st.weather.data, st.weather.tempC, st.units, lang) : []),
  ];
  lines.forEach((line, i) => {
    font.text(line, right - font.measure(line, u), y + i * 18 * u, u, HUD_GREEN);
  });
  return lines.length;
}

const TMP_Q = quat.create();
const TMP_V = vec3.create();

/**
 * A point given relative to the aircraft in world axes onto the HUD, in perspective about the
 * boresight (cx, cy) with focal length f px — conformal with the cockpit camera. Null when behind.
 */
function toScreen(q: quat, rel: readonly [number, number, number], cx: number, cy: number, f: number): [number, number] | null {
  quat.conjugate(TMP_Q, q);
  vec3.transformQuat(TMP_V, vec3.set(TMP_V, rel[0], rel[1], rel[2]), TMP_Q);
  if (TMP_V[2] > -1) return null;
  return [cx + (f * TMP_V[0]) / -TMP_V[2], cy - (f * TMP_V[1]) / -TMP_V[2]];
}

/** the autopilot holds true airspeed; the HUD shows it as indicated, like the speed box beside it */
function asIndicated(tas: number, model: FlightModel): number {
  return model.airspeed > 1 && model.indicatedSpeed > 0 ? (tas * model.indicatedSpeed) / model.airspeed : tas;
}

const pad3 = (deg: number): string => String(((Math.round(deg) % 360) + 360) % 360 || 360).padStart(3, '0');

/** distance on the HUD: km in metric, NM in imperial, one decimal under 100 */
export function distText(m: number, units: Units): string {
  const v = units === 'metric' ? m / 1000 : m / 1852;
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${units === 'metric' ? 'KM' : 'NM'}`;
}

/** time to go at the given ground speed, m:ss (h:mm over an hour); '' when not closing */
export function eteText(distM: number, gsMs: number): string {
  if (gsMs < 20) return '';
  const s = Math.round(distM / gsMs);
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}H`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "VOR OWI 113.40", "ILS 26 IOWI 109.70", "NDB RE 340" */
export function stationText(n: Navaid): string {
  return n.kind === 'ILS' ? `ILS ${rwyText(n)} ${n.ident} ${freqText(n)}` : `${n.kind} ${n.ident} ${freqText(n)}`;
}

/**
 * Flight mode annunciation, top centre: AP, then the speed, lateral and vertical modes with their
 * selected values; while autolanding the approach phase stands for the lateral and vertical modes.
 */
export function fmaText(st: HudState, lang: 'ru' | 'en'): string {
  const ap = st.autopilot;
  if (!ap) return '';
  const L = lang === 'ru' ? RU : EN;
  const units = st.units;
  const spd = `SPD ${Math.round(speedValue(asIndicated(ap.speed, st.model), units))}`;
  const alt = `ALT ${Math.round(altValue(ap.altitude, units))}`;
  const ils = st.nav?.nav1?.rx.nav.kind === 'ILS' ? st.nav.nav1.rx.nav : undefined;
  switch (ap.mode) {
    case 'intercept':
      return `AP  ${spd}  HDG ${pad3(ap.heading)}  ${alt}  APP ${L.apArm}${ils ? ` ${ils.ident}` : ''}`;
    case 'final':
      return `AP  ${spd}  LOC${ils ? ` ${ils.ident}` : ''}  G/S`;
    case 'rollout':
      return `AP  ${L.rollout}`;
  }
  if (ap.lateral === 'NAV') {
    const n = st.nav?.nav1?.rx;
    const lat = !n ? `NAV ${L.noSignal}` : `${n.nav.kind === 'ILS' ? 'LOC' : 'NAV'} ${n.nav.ident}${n.inRange ? '' : ` ${L.noSignal}`}`;
    return `AP  ${spd}  ${lat}  ${alt}`;
  }
  return `AP  ${spd}  HDG ${pad3(ap.heading)}  ${alt}`;
}

/** the NAV1 / ADF / approach text block, top to bottom */
export function navLines(st: HudState, lang: 'ru' | 'en'): Array<{ text: string; warn: boolean }> {
  const L = lang === 'ru' ? RU : EN;
  const nav = st.nav;
  const out: Array<{ text: string; warn: boolean }> = [];
  if (!nav) return out;
  const gs = Math.hypot(st.model.vel[0], st.model.vel[2]);
  const n1 = nav.nav1;
  if (n1) {
    const { rx, cdi } = n1;
    out.push({ text: `${L.nav1} ${stationText(rx.nav)}`, warn: !rx.inRange });
    if (!rx.inRange) out.push({ text: L.noSignal, warn: true });
    else {
      const tf = cdi.toFrom === 'TO' ? ` ${L.to}` : cdi.toFrom === 'FROM' ? ` ${L.from}` : '';
      out.push({ text: `${L.crs} ${pad3(cdi.course)}${tf}`, warn: false });
      if (rx.nav.dme) {
        const ete = eteText(rx.slantM, gs);
        out.push({ text: `${L.dme} ${distText(rx.slantM, st.units)}${ete ? `  ${ete}` : ''}`, warn: false });
      }
      if (cdi.thrDistM !== undefined && st.hudMode === 'APP') {
        out.push({ text: `${L.rwThr} ${distText(Math.max(0, cdi.thrDistM), st.units)}`, warn: false });
      }
    }
  }
  const adf = nav.adf;
  if (adf) {
    out.push({
      text: `${L.adf} ${adf.rx.nav.ident} ${freqText(adf.rx.nav)}${adf.rx.inRange ? `  ${pad3(adf.rx.bearing)}` : ` ${L.noSignal}`}`,
      warn: !adf.rx.inRange,
    });
  }
  return out;
}

/** a heading-strip offset for a heading, clamped to the strip; `clamped` when it was off the strip */
function stripX(cx: number, stripW: number, hdg: number, target: number): { x: number; clamped: boolean } {
  const off = angDiff(target, hdg) * (stripW / 90);
  const lim = stripW / 2;
  return { x: cx + Math.max(-lim, Math.min(lim, off)), clamped: Math.abs(off) > lim };
}

export function drawHud(
  font: FontRenderer,
  vec: VectorRenderer,
  w: number,
  h: number,
  u: number,
  st: HudState,
): void {
  const { model, controls, camera, units } = st;
  const cfg = model.cfg;
  const L = cfg.hudLang === 'ru' ? RU : EN;
  const green = HUD_GREEN;
  const amber = HUD_AMBER;
  const lw = Math.max(1, u);
  const { inset, reserve } = st.layout ?? NO_LAYOUT;
  /** margins: the edges and the notch */
  const ml = 8 * u + inset.l;
  const mr = 8 * u + inset.r;
  const mt = 8 * u + inset.t;
  /** the bottom the HUD's lower rows stand on: above the home bar and the touch controls' band */
  const hb = h - inset.b - reserve.bottom;
  const narrow = w / u < NARROW_UNITS;

  // Q28: external cameras carry only a minimal data line
  if (camera !== 'cockpit') {
    const line =
      `V ${Math.round(speedValue(model.indicatedSpeed, units))} ${speedUnit(units)}   ` +
      `H ${Math.round(altValue(model.pos[1], units))} ${altUnit(units)}   ` +
      `${L.hdg} ${String(Math.round(model.headingDeg) % 360).padStart(3, '0')}`;
    const name = `${cfg.name}  [${camera.toUpperCase()}]`;
    font.text(name, ml, mt, u, amber);
    const rows = drawWeather(font, w - mr, mt, u, st, cfg.hudLang);
    // on a narrow screen the data line goes under the corners' rows
    font.text(line, (w - font.measure(line, u)) / 2, narrow ? mt + Math.max(2, rows + 1) * 18 * u : mt, u, green);
    drawAlerts(font, w, h * 0.2, u, st, L);
    return;
  }

  const app = st.hudMode === 'APP';
  const nav = st.nav;
  const cx = w / 2;
  // APP is conformal with the cockpit camera: boresight at the screen centre, perspective scale
  const f = h / 2 / Math.tan(((st.fovYDeg ?? 60) / 2) * D2R);
  // NAV: a little above the middle of what the touch controls leave; APP: the boresight, conformal
  const cy = app ? (st.layout?.boresightY ?? h / 2) : inset.t + (hb - inset.t) * 0.46;
  const pxPerDeg = 5 * u;
  /** screen offset of an angle from the boresight */
  const ang = app ? (deg: number): number => f * Math.tan(Math.max(-80, Math.min(80, deg)) * D2R) : (deg: number): number => deg * pxPerDeg;
  const bank = -model.bankDeg * D2R;
  const pitch = model.pitchDeg;

  if (cfg.id === 'su27') {
    // circular attitude director with internal pitch ladder and bank scale
    const R = Math.min(w, h) * 0.21;
    vec.circle(cx, cy, R, lw, green, 40);
    for (let deg = -30; deg <= 30; deg += 10) {
      const dy = ang(pitch - deg);
      if (Math.abs(dy) > R * 0.75) continue;
      const half = (deg === 0 ? R * 0.8 : R * 0.38) * Math.sqrt(Math.max(0.05, 1 - (dy / R) ** 2));
      const [x0, y0] = rotate(cx - half, cy + dy, cx, cy, bank);
      const [x1, y1] = rotate(cx + half, cy + dy, cx, cy, bank);
      vec.line(x0, y0, x1, y1, lw, green);
      if (deg !== 0) {
        const tick = 6 * u;
        const sgn = deg > 0 ? 1 : -1;
        const [tx0, ty0] = rotate(cx - half, cy + dy, cx, cy, bank);
        const [tx1, ty1] = rotate(cx - half, cy + dy + sgn * tick, cx, cy, bank);
        vec.line(tx0, ty0, tx1, ty1, lw, green);
        const [ux0, uy0] = rotate(cx + half, cy + dy, cx, cy, bank);
        const [ux1, uy1] = rotate(cx + half, cy + dy + sgn * tick, cx, cy, bank);
        vec.line(ux0, uy0, ux1, uy1, lw, green);
        const label = String(Math.abs(deg));
        const [lx, ly] = rotate(cx + half + 6 * u, cy + dy - 8 * u, cx, cy, bank);
        font.text(label, lx, ly, u, green);
      }
    }
    // bank scale arc + pointer
    for (const a of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
      const an = (-90 + a) * D2R;
      const r0 = R + 4 * u;
      const r1 = R + (a % 30 === 0 ? 14 : 8) * u;
      vec.line(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0, cx + Math.cos(an) * r1, cy + Math.sin(an) * r1, lw, green);
    }
    const pAng = (-90 - model.bankDeg) * D2R;
    const px = cx + Math.cos(pAng) * (R + 18 * u);
    const py = cy + Math.sin(pAng) * (R + 18 * u);
    vec.polyline([
      [px, py],
      [px + Math.cos(pAng + 2.6) * 10 * u, py + Math.sin(pAng + 2.6) * 10 * u],
      [px + Math.cos(pAng - 2.6) * 10 * u, py + Math.sin(pAng - 2.6) * 10 * u],
    ], lw, amber, true);
    // fixed waterline (aircraft symbol)
    vec.polyline([[cx - 40 * u, cy], [cx - 12 * u, cy], [cx - 6 * u, cy + 8 * u], [cx, cy]], lw * 1.5, amber);
    vec.polyline([[cx + 40 * u, cy], [cx + 12 * u, cy], [cx + 6 * u, cy + 8 * u], [cx, cy]], lw * 1.5, amber);
    if (app) drawFpm(vec, cx, cy, u, lw, model, ang, amber);
  } else {
    // F-117: linear pitch ladder + flight path marker (APP declutters it to every 10 deg)
    const half = Math.min(w * 0.16, 170 * u);
    for (let deg = -30; deg <= 30; deg += app ? 10 : 5) {
      const dy = ang(pitch - deg);
      if (Math.abs(dy) > h * 0.26) continue;
      const len = deg === 0 ? half : half * 0.45;
      const gap = deg === 0 ? 0 : 24 * u;
      const [x0, y0] = rotate(cx - len, cy + dy, cx, cy, bank);
      const [x1, y1] = rotate(cx - gap, cy + dy, cx, cy, bank);
      const [x2, y2] = rotate(cx + gap, cy + dy, cx, cy, bank);
      const [x3, y3] = rotate(cx + len, cy + dy, cx, cy, bank);
      vec.line(x0, y0, x1, y1, lw, green);
      // the horizon is one line across (its gap is zero), the other rungs are split
      if (deg !== 0) vec.line(x2, y2, x3, y3, lw, green);
      else vec.line(x1, y1, x3, y3, lw, green);
      if (deg !== 0 && deg % 10 === 0) {
        const [lx, ly] = rotate(cx + len + 8 * u, cy + dy - 8 * u, cx, cy, bank);
        font.text(String(Math.abs(deg)), lx, ly, u, green);
      }
    }
    drawFpm(vec, cx, cy, u, lw, model, ang, amber);
    // fixed gun cross
    vec.line(cx - 14 * u, cy, cx - 5 * u, cy, lw, green);
    vec.line(cx + 5 * u, cy, cx + 14 * u, cy, lw, green);
    vec.line(cx, cy - 14 * u, cx, cy - 5 * u, lw, green);
  }

  if (app) {
    // -3 deg glide reference: put the flight path marker on it and on the runway's aim point
    const dy = ang(pitch + 3);
    const half = Math.min(w * 0.16, 170 * u);
    for (const sgn of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const a0 = sgn * (half * 0.55 + k * 14 * u);
        const [x0, y0] = rotate(cx + a0, cy + dy, cx, cy, bank);
        const [x1, y1] = rotate(cx + a0 + sgn * 8 * u, cy + dy, cx, cy, bank);
        vec.line(x0, y0, x1, y1, lw, green);
      }
    }
    if (nav?.runway) drawRunway(vec, cx, cy, f, u, lw, model, nav.runway, green);
  }

  // speed tape (left) and altitude tape (right)
  const tapeY = cy - 20 * u;
  const tapeW = 96 * u;
  const tapeH = 40 * u;
  // either side of the attitude display, but on the screen and clear of the touch controls' columns
  const leftX = Math.max(ml + reserve.left, cx - Math.min(w, h) * 0.34 - tapeW);
  const rightX = Math.min(w - mr - reserve.right - tapeW, cx + Math.min(w, h) * 0.34);
  /**
   * A line under the altitude box at y: from the box, or moved left as far as it must to stay on
   * screen and clear of the touch controls (below low.y only the lever's narrower column is theirs)
   */
  const rightText = (line: string, y: number, scale = u): number => {
    const keep = reserve.low && y >= reserve.low.y ? reserve.low.right : reserve.right;
    return Math.min(rightX, w - mr - keep - font.measure(line, scale));
  };
  const spd = Math.round(speedValue(model.indicatedSpeed, units));
  const alt = Math.round(altValue(model.pos[1], units));
  vec.rect(leftX, tapeY, tapeW, tapeH, lw, green);
  vec.rect(rightX, tapeY, tapeW, tapeH, lw, green);
  const spdStr = String(spd);
  font.text(spdStr, leftX + (tapeW - font.measure(spdStr, u * 2)) / 2, tapeY + 12 * u, u * 2, HUD_WHITE);
  const altStr = String(alt);
  font.text(altStr, rightX + (tapeW - font.measure(altStr, u * 2)) / 2, tapeY + 12 * u, u * 2, HUD_WHITE);
  font.text(speedUnit(units), leftX, tapeY + tapeH + 6 * u, u, green);
  font.text(altUnit(units), rightX, tapeY + tapeH + 6 * u, u, green);
  // selected speed and altitude (autopilot targets), right-aligned under the boxes
  if (st.autopilot && !st.autopilot.mode) {
    const s = `${L.sel} ${Math.round(speedValue(asIndicated(st.autopilot.speed, model), units))}`;
    font.text(s, leftX + tapeW - font.measure(s, u), tapeY + tapeH + 6 * u, u, amber);
    const a = `${L.sel} ${Math.round(altValue(st.autopilot.altitude, units))}`;
    font.text(a, rightX + tapeW - font.measure(a, u), tapeY + tapeH + 6 * u, u, amber);
  }
  const vs = model.verticalSpeed;
  const vsStr = `${L.vs} ${vs >= 0 ? '+' : ''}${Math.round(units === 'metric' ? vs : vs * 196.85)} ${units === 'metric' ? 'M/S' : 'FT/M'}`;
  font.text(vsStr, rightX, tapeY - 22 * u, u, green);
  const aoa = `A ${model.airDataValid ? model.alphaDeg.toFixed(1) : '--'}  G ${model.gLoad.toFixed(1)}`;
  font.text(aoa, leftX, tapeY - 22 * u, u, green);

  // under the speed box: the approach speed in APP; under the altitude box: radio altitude in APP, then the radios
  // (a narrow screen has no room beside or under the attitude display: top left, under the HUD mode)
  let navY = narrow ? mt + 40 * u : tapeY + tapeH + 28 * u;
  const navX = (line: string, scale = u): number => (narrow ? ml : rightText(line, navY, scale));
  if (app && nav) {
    const va = `${L.vapp} ${Math.round(speedValue(asIndicated(nav.vapp, model), units))}`;
    font.text(va, leftX, tapeY + tapeH + 28 * u, u, green);
    if (nav.ra < 760) {
      const ra = `${L.ra} ${Math.round(altValue(Math.max(0, nav.ra), units))}`;
      font.text(ra, navX(ra, u * (nav.ra < 150 ? 2 : 1)), navY, u * (nav.ra < 150 ? 2 : 1), nav.ra < DH_M ? amber : green);
      navY += (nav.ra < 150 ? 36 : 18) * u;
    }
  }
  for (const line of navLines(st, cfg.hudLang)) {
    font.text(line.text, navX(line.text), navY, u, line.warn ? amber : green);
    navY += 18 * u;
  }

  // heading strip (bottom center)
  const stripW = Math.min(w * 0.4, 360 * u);
  const stripY = hb - 74 * u;
  const hdg = model.headingDeg;
  vec.line(cx - stripW / 2, stripY, cx + stripW / 2, stripY, lw, green);
  for (let d = -40; d <= 40; d += 5) {
    let mark = Math.round(hdg / 5) * 5 + d;
    const off = (((mark - hdg + 540) % 360) - 180) * (stripW / 90);
    if (Math.abs(off) > stripW / 2) continue;
    mark = ((mark % 360) + 360) % 360;
    const tall = mark % 10 === 0;
    vec.line(cx + off, stripY, cx + off, stripY - (tall ? 12 : 6) * u, lw, green);
    if (mark % 30 === 0) {
      const lbl = String(mark === 0 ? 360 : mark / 10).padStart(2, '0');
      font.text(lbl, cx + off - font.measure(lbl, u) / 2, stripY - 30 * u, u, green);
    }
  }
  vec.polyline([[cx - 6 * u, stripY + 8 * u], [cx + 6 * u, stripY + 8 * u], [cx, stripY + 1 * u]], lw, amber, true);
  const hdgStr = `${L.hdg} ${String(Math.round(hdg) % 360).padStart(3, '0')}`;
  font.text(hdgStr, cx - font.measure(hdgStr, u) / 2, stripY + 14 * u, u, green);
  drawStripMarks(vec, cx, stripY, stripW, u, lw, hdg, st);

  // course deviation (NAV: VOR or localizer) / ILS raw data (APP: localizer and glide slope)
  const n1 = nav?.nav1;
  const devY = stripY - 52 * u;
  if (n1 && n1.rx.inRange && n1.rx.nav.kind !== 'NDB') {
    drawDeviation(vec, font, cx, devY, u, lw, n1.cdi, L);
    if (app && n1.cdi.gsDots !== undefined) drawGlideSlope(vec, rightX - 22 * u, cy, u, lw, n1.cdi.gsDots);
  } else if (app) {
    font.text(L.noIls, cx - font.measure(L.noIls, u) / 2, devY - 8 * u, u, amber);
  }

  // corners: identity and HUD mode, power, configuration
  font.text(`${cfg.name}`, ml, mt, u, amber);
  font.text(`HUD ${app ? L.hudApp : L.hudNav}`, ml, mt + 18 * u, u, green);
  font.text(`${L.thr} ${Math.round(controls.throttle * 100)}%`, ml + reserve.left, hb - 60 * u, u, green);
  const abOn = cfg.thrustAfterburner > cfg.thrustDry && controls.throttle > 0.85;
  const config: string[] = [];
  config.push(`${L.gear} ${controls.gearDown ? 'DOWN' : 'UP'}`);
  if (controls.flaps) config.push(L.flaps);
  if (controls.brakes) config.push(L.brakes);
  if (controls.speedbrake) config.push(L.speedbrake);
  if (abOn) config.push(L.ab);
  config.forEach((line, i) => {
    font.text(line, w - mr - reserve.right - font.measure(line, u), hb - 60 * u - i * 18 * u, u, i === 0 ? green : amber);
  });
  font.text(st.soundOn ? 'M SOUND ON' : 'M SOUND OFF', w - font.measure('M SOUND OFF', u) - mr, mt, u, green);
  const rows = 1 + drawWeather(font, w - mr, mt + 18 * u, u, st, cfg.hudLang);
  // the flight modes, top centre; on a narrow screen under the corners' rows (the radios' on the left)
  const fma = fmaText(st, cfg.hudLang);
  const below = Math.max(mt + rows * 18 * u, narrow ? navY : 0);
  if (fma) font.text(fma, (w - font.measure(fma, u)) / 2, narrow ? below + 8 * u : mt, u, amber);

  // warnings
  drawAlerts(font, w, h * 0.16, u, st, L);
  if (model.touchdownTimer > 0) {
    font.text(L.touchdown, (w - font.measure(L.touchdown, u)) / 2, h * 0.3, u, HUD_WHITE);
  } else if (app && nav && !model.onGround && nav.ra < DH_M && nav.ra > 5 && model.verticalSpeed < 0) {
    font.text(L.dh, (w - font.measure(L.dh, u * 2)) / 2, h * 0.26, u * 2, HUD_WHITE);
  }
}

/** flight path marker at the velocity vector over the ground (body axes, so it is not rotated with bank) */
function drawFpm(vec: VectorRenderer, cx: number, cy: number, u: number, lw: number, model: FlightModel, ang: (deg: number) => number, color: number): void {
  const fx = cx + ang(model.pathBetaDeg);
  const fy = cy + ang(model.pathAlphaDeg);
  const r = 8 * u;
  vec.circle(fx, fy, r, lw * 1.5, color, 16);
  vec.line(fx - r * 2.4, fy, fx - r, fy, lw * 1.5, color);
  vec.line(fx + r, fy, fx + r * 2.4, fy, lw * 1.5, color);
  vec.line(fx, fy - r, fx, fy - r * 2, lw * 1.5, color);
}

/** synthetic runway: outline, extended centreline (a dash every 600 m out to 4.2 km) and the aim point */
function drawRunway(
  vec: VectorRenderer, cx: number, cy: number, f: number, u: number, lw: number, model: FlightModel,
  rw: NonNullable<HudNav['runway']>, color: number,
): void {
  const pts = rw.corners.map((c) => toScreen(model.quat, c, cx, cy, f));
  if (pts.every((p) => p)) vec.polyline(pts as [number, number][], lw, color, true);
  const [a, b, c, d] = rw.corners;
  const thr: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const far: [number, number, number] = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2, (c[2] + d[2]) / 2];
  const len = Math.hypot(thr[0] - far[0], thr[1] - far[1], thr[2] - far[2]) || 1;
  const dir = [(thr[0] - far[0]) / len, (thr[1] - far[1]) / len, (thr[2] - far[2]) / len];
  for (let k = 300; k <= 4200; k += 600) {
    const p0 = toScreen(model.quat, [thr[0] + dir[0] * k, thr[1] + dir[1] * k, thr[2] + dir[2] * k], cx, cy, f);
    const p1 = toScreen(model.quat, [thr[0] + dir[0] * (k + 250), thr[1] + dir[1] * (k + 250), thr[2] + dir[2] * (k + 250)], cx, cy, f);
    if (p0 && p1) vec.line(p0[0], p0[1], p1[0], p1[1], lw, color);
  }
  const aim = toScreen(model.quat, rw.aim, cx, cy, f);
  if (aim) {
    const s = 4 * u;
    vec.line(aim[0] - s, aim[1], aim[0] + s, aim[1], lw, color);
    vec.line(aim[0], aim[1] - s, aim[0], aim[1] + s, lw, color);
  }
}

/** heading strip: the selected heading (amber bug), the course (white), the NAV1 bearing (diamond) and the ADF bearing (ring) */
function drawStripMarks(vec: VectorRenderer, cx: number, stripY: number, stripW: number, u: number, lw: number, hdg: number, st: HudState): void {
  const ap = st.autopilot;
  if (ap && !ap.mode && ap.lateral !== 'NAV') {
    const { x } = stripX(cx, stripW, hdg, ap.heading);
    vec.polyline([[x - 5 * u, stripY - 16 * u], [x - 5 * u, stripY - 20 * u], [x + 5 * u, stripY - 20 * u], [x + 5 * u, stripY - 16 * u]], lw * 1.5, HUD_AMBER);
  }
  const n1 = st.nav?.nav1;
  if (n1 && n1.rx.inRange && n1.rx.nav.kind !== 'NDB') {
    const { x, clamped } = stripX(cx, stripW, hdg, n1.cdi.course);
    if (!clamped) vec.polyline([[x, stripY - 22 * u], [x - 3 * u, stripY - 28 * u], [x + 3 * u, stripY - 28 * u]], lw, HUD_WHITE, true);
    const b = stripX(cx, stripW, hdg, n1.rx.bearing);
    const y = stripY + 4 * u;
    vec.polyline([[b.x, y], [b.x + 3 * u, y + 4 * u], [b.x, y + 8 * u], [b.x - 3 * u, y + 4 * u]], lw, HUD_GREEN, true);
  }
  const adf = st.nav?.adf;
  if (adf && adf.rx.inRange) {
    const b = stripX(cx, stripW, hdg, adf.rx.bearing);
    vec.circle(b.x, stripY + 8 * u, 3 * u, lw, HUD_GREEN, 10);
  }
}

/** horizontal deviation scale: dots either side, the bar where the course is, TO/FROM flag */
function drawDeviation(vec: VectorRenderer, font: FontRenderer, cx: number, y: number, u: number, lw: number, cdi: Cdi, L: Labels): void {
  const n = cdi.fullScale;
  const step = (n === 2 ? 60 : 24) * u;
  for (let i = 1; i <= n; i++) {
    for (const s of [-1, 1]) vec.circle(cx + s * i * step, y, 2.5 * u, lw, HUD_GREEN, 8);
  }
  vec.line(cx, y - 8 * u, cx, y + 8 * u, lw, HUD_GREEN);
  const x = cx + Math.max(-n - 0.4, Math.min(n + 0.4, cdi.dots)) * step;
  if (n === 2) {
    // localizer: a diamond
    vec.polyline([[x, y - 7 * u], [x + 6 * u, y], [x, y + 7 * u], [x - 6 * u, y]], lw * 1.5, HUD_WHITE, true);
  } else {
    vec.line(x, y - 12 * u, x, y + 12 * u, lw * 2, HUD_WHITE);
    const end = cx + (n + 1) * step;
    if (cdi.toFrom === 'TO') vec.polyline([[end, y - 6 * u], [end + 6 * u, y + 4 * u], [end - 6 * u, y + 4 * u]], lw, HUD_GREEN, true);
    if (cdi.toFrom === 'FROM') vec.polyline([[end, y + 6 * u], [end + 6 * u, y - 4 * u], [end - 6 * u, y - 4 * u]], lw, HUD_GREEN, true);
    const tf = cdi.toFrom === 'TO' ? L.to : cdi.toFrom === 'FROM' ? L.from : '';
    if (tf) font.text(tf, end + 10 * u, y - 8 * u, u, HUD_GREEN);
  }
}

/** vertical glide-slope scale beside the altitude: the diamond is where the glide path is */
function drawGlideSlope(vec: VectorRenderer, x: number, cy: number, u: number, lw: number, dots: number): void {
  const step = 24 * u;
  for (let i = 1; i <= 2; i++) {
    for (const s of [-1, 1]) vec.circle(x, cy + s * i * step, 2.5 * u, lw, HUD_GREEN, 8);
  }
  vec.line(x - 8 * u, cy, x + 8 * u, cy, lw, HUD_GREEN);
  const y = cy - Math.max(-2.4, Math.min(2.4, dots)) * step;
  vec.polyline([[x, y - 7 * u], [x + 6 * u, y], [x, y + 7 * u], [x - 6 * u, y]], lw * 1.5, HUD_WHITE, true);
}
