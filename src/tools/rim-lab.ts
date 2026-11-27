/**
 * Rim light lab (rim.html): the game itself with the flight frozen, a few fixed views against a low
 * sun and live controls for the rim light shader (engine/rim.ts). Dev tool.
 */
import { quat } from 'gl-matrix';
import { profiler } from '../engine/profiler';
import { DEFAULT_RIM, rim, rimLab, type RimParams } from '../engine/rim';
import { attitudeQuat } from '../flight/model';
import type { LatLon } from '../world/geodesy';
import { sunPosition } from '../world/sun';
import { timeForPreset } from '../world/time-of-day';

interface ViewState {
  /** sun elevation, deg (on the evening side of the day) */
  sunEl: number;
  /** camera: yaw from the line aircraft → away from the sun (0: the camera looks into the sun), deg */
  camYaw: number;
  /** camera elevation over the aircraft, deg (negative: from below) */
  camPitch: number;
  camDist: number;
  /** aircraft attitude; heading relative to the sun's azimuth (0: flying into the sun) */
  pitch: number;
  roll: number;
  hdg: number;
}

interface Preset {
  id: string;
  name: string;
  at: LatLon;
  /** MSL altitude, m */
  alt: number;
  /** extra query (weather overrides) */
  query: string;
  view: ViewState;
}

const PRESETS: Preset[] = [
  {
    id: 'plane',
    name: 'Самолёт на фоне заката (море, Ницца)',
    at: { lat: 43.55, lon: 7.15 },
    alt: 1600,
    query: 'clouds=20',
    view: { sunEl: 3, camYaw: 10, camPitch: -12, camDist: 45, pitch: 25, roll: -25, hdg: 40 },
  },
  {
    id: 'city',
    name: 'Город против солнца (Инсбрук, зима)',
    at: { lat: 47.2655, lon: 11.395 },
    alt: 820,
    query: 'clouds=20&temp=-20',
    view: { sunEl: 2, camYaw: 0, camPitch: 18, camDist: 70, pitch: 0, roll: 30, hdg: -20 },
  },
  {
    // the heaviest frame we know: the detail profiles (world/detail.ts) are measured here
    id: 'moscow',
    name: 'Центр Москвы с 600 м (нагрузка)',
    at: { lat: 55.752, lon: 37.6175 },
    alt: 600,
    query: 'clouds=0',
    view: { sunEl: 20, camYaw: 180, camPitch: 12, camDist: 60, pitch: -5, roll: 0, hdg: 90 },
  },
];

const STORE_RIM = 'rimLab.rim';
const storeView = (id: string) => `rimLab.view.${id}`;

function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch { /* private window, bad JSON: defaults */ }
  return { ...fallback };
}
function save(key: string, v: object): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
}

const params = new URLSearchParams(location.search);
const preset = PRESETS.find((p) => p.id === params.get('view')) ?? PRESETS[0];
const view = load<ViewState>(storeView(preset.id), preset.view);
Object.assign(rim, load<RimParams>(STORE_RIM, DEFAULT_RIM));

/** the moment the sun sets through `el` degrees on the day of `base` (or rises, if it never gets that low after noon) */
function timeForSunEl(loc: LatLon, el: number, base: Date): Date {
  const noon = timeForPreset('day', loc, base).getTime();
  for (let t = noon; t < noon + 14 * 3600000; t += 60000) {
    if (sunPosition(new Date(t), loc).elevationDeg <= el) return new Date(t);
  }
  return new Date(noon);
}
const baseDay = new Date();

// the page URL carries the preset; the game reads its start from the hash
{
  const want = `?view=${preset.id}&${preset.query}`;
  const t = Math.floor(timeForSunEl(preset.at, view.sunEl, baseDay).getTime() / 1000);
  const hash = `#${preset.at.lat},${preset.at.lon},${preset.alt},0,su27,${t}`;
  if (location.search !== want || !location.hash) history.replaceState(null, '', want + hash);
}

rimLab.active = true;
rimLab.frozen = true;
rimLab.hud = load(storeView('hud'), { on: false }).on;

// ---- controls ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function slider(parent: string, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): () => void {
  const box = document.createElement('div');
  box.className = 'slider';
  const name = document.createElement('span');
  name.textContent = label;
  const out = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const show = () => {
    const v = get();
    if (document.activeElement !== input) input.value = String(v);
    out.textContent = v.toFixed(digits);
  };
  input.addEventListener('input', () => { set(Number(input.value)); show(); changed(); });
  box.append(name, out, input);
  $(parent).append(box);
  show();
  return show;
}

const refreshers: (() => void)[] = [];
const viewSlider = (parent: string, label: string, key: keyof ViewState, min: number, max: number, step: number, after?: () => void) =>
  refreshers.push(slider(parent, label, min, max, step, () => view[key], (v) => { view[key] = v; after?.(); applyView(); }));
const rimSlider = (parent: string, label: string, key: keyof RimParams, min: number, max: number, step: number) =>
  refreshers.push(slider(parent, label, min, max, step, () => rim[key] as number, (v) => { (rim[key] as number) = v; }));

viewSlider('sunGroup', 'высота солнца, °', 'sunEl', -6, 20, 0.5, () => { rimLab.time = timeForSunEl(preset.at, view.sunEl, baseDay); });
viewSlider('camGroup', 'поворот от линии на солнце, °', 'camYaw', -180, 180, 1);
viewSlider('camGroup', 'над самолётом, °', 'camPitch', -80, 80, 1);
viewSlider('camGroup', 'расстояние, м', 'camDist', 15, 300, 1);
viewSlider('planeGroup', 'курс от солнца, °', 'hdg', -180, 180, 1);
viewSlider('planeGroup', 'тангаж, °', 'pitch', -60, 60, 1);
viewSlider('planeGroup', 'крен, °', 'roll', -90, 90, 1);

rimSlider('faceGroup', 'сила', 'strength', 0, 4, 0.05);
rimSlider('faceGroup', 'узость кромки (степень)', 'edgePow', 0.2, 8, 0.1);
rimSlider('rimGroup', 'только против солнца (степень)', 'backPow', 0, 8, 0.1);
rimSlider('faceGroup', 'захват теневой стороны', 'sideBias', -0.5, 1, 0.05);
rimSlider('rimGroup', 'ступеней (0 — плавно)', 'steps', 0, 8, 1);
rimSlider('rimGroup', 'цвет: зарево → солнце', 'sunColour', 0, 1, 0.05);
rimSlider('outlineGroup', 'сила', 'outline', 0, 4, 0.05);
rimSlider('outlineGroup', 'ширина, CSS px', 'outlineCss', 0.5, 6, 0.5);
rimSlider('outlineGroup', 'скачок глубины на краю', 'outlineGap', 0.02, 2, 0.02);
rimSlider('weightGroup', 'рельеф', 'terrain', 0, 1.5, 0.05);
rimSlider('weightGroup', 'здания', 'objects', 0, 1.5, 0.05);
rimSlider('weightGroup', 'деревья', 'trees', 0, 1.5, 0.05);
rimSlider('weightGroup', 'самолёт', 'aircraft', 0, 1.5, 0.05);

const viewSel = $<HTMLSelectElement>('view');
for (const p of PRESETS) viewSel.add(new Option(p.name, p.id, false, p.id === preset.id));
viewSel.addEventListener('change', () => {
  location.href = `${location.pathname}?view=${viewSel.value}`;
});
$('resetView').addEventListener('click', () => {
  Object.assign(view, preset.view);
  rimLab.time = timeForSunEl(preset.at, view.sunEl, baseDay);
  applyView();
  changed();
});

const check = (id: string, get: () => boolean, set: (v: boolean) => void) => {
  const el = $<HTMLInputElement>(id);
  el.checked = get();
  el.addEventListener('change', () => { set(el.checked); changed(); });
  refreshers.push(() => { el.checked = get(); });
};
check('rimOn', () => rim.on, (v) => { rim.on = v; });
check('lowSunOnly', () => rim.lowSunOnly, (v) => { rim.lowSunOnly = v; });
check('hud', () => rimLab.hud, (v) => { rimLab.hud = v; save(storeView('hud'), { on: v }); });

$('resetRim').addEventListener('click', () => { Object.assign(rim, DEFAULT_RIM); changed(); });
$('copy').addEventListener('click', () => {
  void navigator.clipboard?.writeText(paramsText()).catch(() => undefined);
});

const round = (v: number) => Math.round(v * 100) / 100;
function paramsText(): string {
  const r = Object.fromEntries(Object.entries(rim).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]));
  const v = Object.fromEntries(Object.entries(view).map(([k, x]) => [k, round(x)]));
  return `rim: ${JSON.stringify(r)}\nview ${preset.id}: ${JSON.stringify(v)}`;
}
function changed(): void {
  for (const r of refreshers) r();
  $('params').textContent = paramsText();
  save(STORE_RIM, rim);
  save(storeView(preset.id), view);
}

// ---- the game ----
interface Sim {
  state: string;
  renderer: { width: number; height: number; msaa: boolean; setMsaa(on: boolean): void };
  chunks: { stats: { drawCalls: number; gpuBuffers: number } };
  osm: { stats: { drawCalls: number } };
  settings: { msaa: boolean };
  sunDir: Float32Array;
  rig: { mode: string; orbitYaw: number; orbitPitch: number; orbitDist: number; setMode(m: string, model: unknown): void };
  model: { quat: quat };
  audio: { setMuted(m: boolean): void };
}
const sim = (): Sim | undefined => (window as unknown as { __sim?: Sim }).__sim;

const D2R = Math.PI / 180;
/** the sun's horizontal direction as the orbit yaw that puts the camera opposite it, and its azimuth (deg) */
function sunFrame(s: Sim): { yaw: number; az: number } {
  const [x, , z] = s.sunDir;
  return { yaw: Math.atan2(-x, -z), az: Math.atan2(x, -z) / D2R };
}

let ready = false;
function applyView(): void {
  const s = sim();
  if (!s || !ready) return;
  const { yaw, az } = sunFrame(s);
  s.rig.orbitYaw = yaw + view.camYaw * D2R;
  s.rig.orbitPitch = view.camPitch * D2R;
  s.rig.orbitDist = view.camDist;
  attitudeQuat(s.model.quat, view.pitch, az + view.hdg, view.roll);
}

let lastSunYaw = NaN;
function watch(): void {
  requestAnimationFrame(watch);
  const s = sim();
  if (!s || s.state !== 'flying') return;
  if (!ready) {
    ready = true;
    s.audio.setMuted(true);
    s.rig.setMode('orbit', s.model);
    applyView();
    changed();
    return;
  }
  const { yaw } = sunFrame(s);
  if (yaw !== lastSunYaw) {
    // the sun moved (its height slider): keep the camera and the aircraft where they are relative to it
    lastSunYaw = yaw;
    applyView();
    return;
  }
  // mouse drags and the wheel move the orbit camera: show it on the sliders
  const cy = ((((s.rig.orbitYaw - yaw) / D2R + 180) % 360) + 360) % 360 - 180;
  const cp = s.rig.orbitPitch / D2R;
  if (Math.abs(cy - view.camYaw) > 0.05 || Math.abs(cp - view.camPitch) > 0.05 || Math.abs(s.rig.orbitDist - view.camDist) > 0.05) {
    view.camYaw = cy;
    view.camPitch = cp;
    view.camDist = s.rig.orbitDist;
    changed();
  }
}

// ---- performance ----
const pad = (v: string, n: number) => v.padStart(n);
const ms = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(2));
function showPerf(): void {
  const s = sim();
  if (!s || !ready) return;
  const st = profiler.stats();
  const r = s.renderer;
  const lines = [
    `FPS ${st.fps.toFixed(1)}   кадр ${st.frameMs.toFixed(1)} мс`,
    `JS за кадр ${st.cpuMs.toFixed(2)} мс   GPU всего ${st.gpuTimer ? `${ms(st.gpuMs)} мс` : 'нет таймера'}`,
    `экран ${r.width}×${r.height}${r.msaa ? ', мир ×2 (MSAA)' : ''}`,
    `вызовов отрисовки ${s.chunks.stats.drawCalls + s.osm.stats.drawCalls}, буферов ${s.chunks.stats.gpuBuffers}`,
    '',
    `${'стадия'.padEnd(28)}${pad('CPU', 7)}${pad('GPU', 7)}`,
    ...st.stages.map((x) => `${(x.name.length > 27 ? x.name.slice(0, 26) + '…' : x.name).padEnd(28)}${pad(ms(x.cpu), 7)}${pad(ms(x.gpu), 7)}`),
  ];
  $('perf').textContent = lines.join('\n');
}
setInterval(showPerf, 500);

const msaaBox = $<HTMLInputElement>('msaa');
msaaBox.addEventListener('change', () => sim()?.renderer.setMsaa(msaaBox.checked));
setInterval(() => { const s = sim(); if (s && document.activeElement !== msaaBox) msaaBox.checked = s.renderer.msaa; }, 500);

changed();
await import('../main');
requestAnimationFrame(watch);
