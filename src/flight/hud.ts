import { FontRenderer, HUD_AMBER, HUD_GREEN, HUD_WHITE } from '../engine/font';
import { VectorRenderer } from '../engine/vector';
import type { Units } from '../ui/settings';
import type { CameraMode } from './cameras';
import type { FlightModel, FlightControls } from './model';

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
  touchdown: string;
  gear: string;
  flaps: string;
  brakes: string;
  speedbrake: string;
  ab: string;
  hdg: string;
  vs: string;
  thr: string;
}

const RU: Labels = {
  stall: 'СВАЛИВАНИЕ', touchdown: 'КАСАНИЕ', gear: 'ШАССИ', flaps: 'ЗАКРЫЛКИ',
  brakes: 'ТОРМОЗ', speedbrake: 'ЩИТКИ', ab: 'ФОРСАЖ', hdg: 'КУРС', vs: 'ВЕРТ', thr: 'ТЯГА',
};
const EN: Labels = {
  stall: 'STALL', touchdown: 'TOUCHDOWN', gear: 'GEAR', flaps: 'FLAPS',
  brakes: 'BRAKE', speedbrake: 'SPD BRK', ab: 'AFTERBURNER', hdg: 'HDG', vs: 'V/S', thr: 'THR',
};

function rotate(x: number, y: number, cx: number, cy: number, ang: number): [number, number] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export interface HudState {
  model: FlightModel;
  controls: FlightControls;
  camera: CameraMode;
  units: Units;
  now: number;
  soundOn: boolean;
}

export function drawHud(
  font: FontRenderer,
  vec: VectorRenderer,
  w: number,
  h: number,
  u: number,
  st: HudState,
): void {
  const { model, controls, camera, units, now } = st;
  const cfg = model.cfg;
  const L = cfg.hudLang === 'ru' ? RU : EN;
  const green = HUD_GREEN;
  const amber = HUD_AMBER;
  const lw = Math.max(1, u);

  // Q28: external cameras carry only a minimal data line
  if (camera !== 'cockpit') {
    const line =
      `V ${Math.round(speedValue(model.speed, units))} ${speedUnit(units)}   ` +
      `H ${Math.round(altValue(model.pos[1], units))} ${altUnit(units)}   ` +
      `${L.hdg} ${String(Math.round(model.headingDeg) % 360).padStart(3, '0')}`;
    font.text(line, (w - font.measure(line, u)) / 2, 8 * u, u, green);
    const name = `${cfg.name}  [${camera.toUpperCase()}]`;
    font.text(name, 8 * u, 8 * u, u, amber);
    if (model.stall && Math.floor(now * 3) % 2 === 0) {
      font.text(L.stall, (w - font.measure(L.stall, u * 2)) / 2, h * 0.2, u * 2, amber);
    }
    return;
  }

  const cx = w / 2;
  const cy = h * 0.46;
  const pxPerDeg = 5 * u;
  const bank = -model.bankDeg * D2R;
  const pitch = model.pitchDeg;

  if (cfg.id === 'su27') {
    // circular attitude director with internal pitch ladder and bank scale
    const R = Math.min(w, h) * 0.21;
    vec.circle(cx, cy, R, lw, green, 40);
    for (let deg = -30; deg <= 30; deg += 10) {
      const dy = (pitch - deg) * pxPerDeg;
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
      const ang = (-90 + a) * D2R;
      const r0 = R + 4 * u;
      const r1 = R + (a % 30 === 0 ? 14 : 8) * u;
      vec.line(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0, cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1, lw, green);
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
  } else {
    // F-117: linear pitch ladder + flight path marker
    const half = Math.min(w * 0.16, 170 * u);
    for (let deg = -30; deg <= 30; deg += 5) {
      const dy = (pitch - deg) * pxPerDeg;
      if (Math.abs(dy) > h * 0.26) continue;
      const len = deg === 0 ? half : half * 0.45;
      const gap = deg === 0 ? 0 : 24 * u;
      const [x0, y0] = rotate(cx - len, cy + dy, cx, cy, bank);
      const [x1, y1] = rotate(cx - gap, cy + dy, cx, cy, bank);
      const [x2, y2] = rotate(cx + gap, cy + dy, cx, cy, bank);
      const [x3, y3] = rotate(cx + len, cy + dy, cx, cy, bank);
      vec.line(x0, y0, x1, y1, lw, green);
      if (deg !== 0) vec.line(x2, y2, x3, y3, lw, green);
      else vec.line(x1, y1, x2, y2, lw, green);
      if (deg !== 0 && deg % 10 === 0) {
        const [lx, ly] = rotate(cx + len + 8 * u, cy + dy - 8 * u, cx, cy, bank);
        font.text(String(Math.abs(deg)), lx, ly, u, green);
      }
    }
    // flight path marker at the velocity vector
    const fpmX = cx + model.betaDeg * pxPerDeg;
    const fpmY = cy + model.alphaDeg * pxPerDeg;
    const [fx, fy] = rotate(fpmX, fpmY, cx, cy, bank);
    const r = 8 * u;
    vec.circle(fx, fy, r, lw * 1.5, amber, 16);
    vec.line(fx - r * 2.4, fy, fx - r, fy, lw * 1.5, amber);
    vec.line(fx + r, fy, fx + r * 2.4, fy, lw * 1.5, amber);
    vec.line(fx, fy - r, fx, fy - r * 2, lw * 1.5, amber);
    // fixed gun cross
    vec.line(cx - 14 * u, cy, cx - 5 * u, cy, lw, green);
    vec.line(cx + 5 * u, cy, cx + 14 * u, cy, lw, green);
    vec.line(cx, cy - 14 * u, cx, cy - 5 * u, lw, green);
  }

  // speed tape (left) and altitude tape (right)
  const tapeY = cy - 20 * u;
  const tapeW = 96 * u;
  const tapeH = 40 * u;
  const leftX = cx - Math.min(w, h) * 0.34 - tapeW;
  const rightX = cx + Math.min(w, h) * 0.34;
  const spd = Math.round(speedValue(model.speed, units));
  const alt = Math.round(altValue(model.pos[1], units));
  vec.rect(leftX, tapeY, tapeW, tapeH, lw, green);
  vec.rect(rightX, tapeY, tapeW, tapeH, lw, green);
  const spdStr = String(spd);
  font.text(spdStr, leftX + (tapeW - font.measure(spdStr, u * 2)) / 2, tapeY + 12 * u, u * 2, HUD_WHITE);
  const altStr = String(alt);
  font.text(altStr, rightX + (tapeW - font.measure(altStr, u * 2)) / 2, tapeY + 12 * u, u * 2, HUD_WHITE);
  font.text(speedUnit(units), leftX, tapeY + tapeH + 6 * u, u, green);
  font.text(altUnit(units), rightX, tapeY + tapeH + 6 * u, u, green);
  const vs = model.verticalSpeed;
  const vsStr = `${L.vs} ${vs >= 0 ? '+' : ''}${Math.round(units === 'metric' ? vs : vs * 196.85)} ${units === 'metric' ? 'M/S' : 'FT/M'}`;
  font.text(vsStr, rightX, tapeY - 22 * u, u, green);
  const aoa = `A ${model.alphaDeg.toFixed(1)}  G ${model.gLoad.toFixed(1)}`;
  font.text(aoa, leftX, tapeY - 22 * u, u, green);

  // heading strip (bottom center)
  const stripW = Math.min(w * 0.4, 360 * u);
  const stripY = h - 74 * u;
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

  // corners: identity, power, configuration
  font.text(`${cfg.name}`, 8 * u, 8 * u, u, amber);
  font.text(`${L.thr} ${Math.round(controls.throttle * 100)}%`, 8 * u, h - 60 * u, u, green);
  const abOn = cfg.thrustAfterburner > cfg.thrustDry && controls.throttle > 0.85;
  const config: string[] = [];
  config.push(`${L.gear} ${controls.gearDown ? 'DOWN' : 'UP'}`);
  if (controls.flaps) config.push(L.flaps);
  if (controls.brakes) config.push(L.brakes);
  if (controls.speedbrake) config.push(L.speedbrake);
  if (abOn) config.push(L.ab);
  config.forEach((line, i) => {
    font.text(line, w - font.measure(line, u) - 8 * u, h - 60 * u - i * 18 * u, u, i === 0 ? green : amber);
  });
  font.text(st.soundOn ? 'M SOUND ON' : 'M SOUND OFF', w - font.measure('M SOUND OFF', u) - 8 * u, 8 * u, u, green);

  // warnings
  if (model.stall && Math.floor(now * 3) % 2 === 0) {
    font.text(L.stall, (w - font.measure(L.stall, u * 2)) / 2, h * 0.16, u * 2, amber);
  }
  if (model.touchdownTimer > 0) {
    font.text(L.touchdown, (w - font.measure(L.touchdown, u)) / 2, h * 0.3, u, HUD_WHITE);
  }
}