/**
 * Area style editor (areas.html): the colour and blend mode of each OSM area drawn as a filter over
 * the terrain imagery (area-styles.ts), tuned on the simulator's own terrain and OSM pipeline —
 * ChunkManager, OsmManager, the workers and the world shaders — seen from above. Every change
 * rebuilds the OSM tiles in view with the edited styles (not cached); the result is copied as code
 * for DEFAULT_AREA_STYLES.
 */
import { mat4, vec3, vec4 } from 'gl-matrix';
import { BLEND_MODES, buildLUT, LAND_PALETTE, lightUniforms, paletteAt, type BlendMode, type RGB } from '../engine/palette';
import { Renderer } from '../engine/renderer';
import { parseMapLink } from '../ui/map-links';
import { AREA_KINDS, DEFAULT_AREA_STYLES, filterColour, isDefaultAreaStyles, type AreaFilter, type AreaKind, type AreaStyles } from '../world/area-styles';
import { ChunkManager, type CameraWorld } from '../world/chunks';
import { enuToLatLon, latLonToEnu, tileCenter, type LatLon } from '../world/geodesy';
import { HOUSE_RADIUS_M, OsmManager } from '../world/osm-manager';
import { PRESETS, SOURCE } from './presets';

const NO_MOON = new Float32Array([0, -1, 0]);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const D2R = Math.PI / 180;
const EYE_DISTANCE_M = 20000;
/** OSM is detailed only near the simulator camera: the view stays within its radius */
const SPAN_MIN_M = 200;
const SPAN_MAX_M = 12000;
/** the camera that picks the levels of detail hangs this high over the view's centre */
const CAM_ALT_M = 800;
const POINT_SIZE = 3;
const STORAGE = 'areas.styles';
/** colour pickers and sliders: the tiles are rebuilt once the value rests this long, ms */
const REBUILD_DELAY_MS = 350;
/** "find": the kind drawn in this colour, fully */
const HIGHLIGHT: AreaFilter = { colour: [255, 0, 255], mode: 'normal', strength: 1 };

const MODE_NAMES: Record<BlendMode, string> = {
  normal: 'обычный', multiply: 'умножение', screen: 'экран', overlay: 'перекрытие', 'soft-light': 'мягкий свет',
  'hard-light': 'жёсткий свет', darken: 'замена тёмным', lighten: 'замена светлым', 'color-dodge': 'осветление основы',
  'color-burn': 'затемнение основы', difference: 'разница', exclusion: 'исключение', hue: 'цветовой тон',
  saturation: 'насыщенность', color: 'цветность', luminosity: 'яркость',
};

/** imagery colours to show each filter on: ten spread over the land palette */
const SAMPLES: RGB[] = Array.from({ length: 10 }, (_, k) => LAND_PALETTE[Math.floor(((k + 0.5) * LAND_PALETTE.length) / 10)]);

interface State {
  centre: LatLon;
  span: number;
  sunEl: number;
  styles: AreaStyles;
  /** the kind drawn in HIGHLIGHT, if any */
  found: AreaKind | null;
}

function parseHash(): Partial<State> {
  const p = location.hash.slice(1).split(',').map(Number);
  if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 85 || Math.abs(p[1]) > 180) return {};
  return { centre: { lat: p[0], lon: p[1] }, ...(Number.isFinite(p[2]) && p[2] > 0 ? { span: p[2] * 1000 } : {}) };
}

const copyStyles = (s: AreaStyles): AreaStyles =>
  Object.fromEntries(AREA_KINDS.map(({ kind }) => [kind, { ...s[kind], colour: [...s[kind].colour] as RGB }])) as AreaStyles;

function loadStyles(): AreaStyles {
  const out = copyStyles(DEFAULT_AREA_STYLES);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Partial<Record<AreaKind, Partial<AreaFilter>>> | null;
    for (const { kind } of AREA_KINDS) {
      const f = saved?.[kind];
      if (!f) continue;
      if (Array.isArray(f.colour) && f.colour.length === 3 && f.colour.every((v) => Number.isFinite(v))) {
        out[kind].colour = f.colour.map((v) => Math.max(0, Math.min(255, Math.round(v)))) as unknown as RGB;
      }
      if (BLEND_MODES.includes(f.mode as BlendMode)) out[kind].mode = f.mode as BlendMode;
      if (Number.isFinite(f.strength)) out[kind].strength = Math.max(0, Math.min(1, f.strength!));
    }
  } catch {
    // storage unavailable or unreadable: the game's styles
  }
  return out;
}

function saveStyles(): void {
  try {
    if (isDefaultAreaStyles(state.styles)) localStorage.removeItem(STORAGE);
    else localStorage.setItem(STORAGE, JSON.stringify(state.styles));
  } catch {
    // storage unavailable: the styles last for this page only
  }
}

const state: State = {
  centre: { lat: 55.7298, lon: 37.6028 }, // Парк Горького
  span: 3000,
  sunEl: 40,
  styles: loadStyles(),
  found: null,
  ...parseHash(),
};
state.span = Math.max(SPAN_MIN_M, Math.min(SPAN_MAX_M, state.span));

const canvas = $<HTMLCanvasElement>('screen');
const renderer = new Renderer(canvas);
const chunks = new ChunkManager(renderer.gl, state.centre);
const osm = new OsmManager(renderer.gl, state.centre);
osm.onTileReady = (tile, runways, coast, roads) => {
  if (runways > 0) chunks.invalidateNear(tileCenter(tile), 2500, 12);
  else if (coast || roads) chunks.invalidate(tile);
};

const view = mat4.create();
const proj = mat4.create();
const viewProj = mat4.create();
const invViewProj = mat4.create();
const sunDir = vec3.create();
const cam: CameraWorld = { pos: vec3.create(), latLon: state.centre, alt: CAM_ALT_M, velocity: vec3.create() };
let lut = buildLUT(paletteAt(state.sunEl));

function world(ll: LatLon): vec3 {
  const [e, n] = latLonToEnu(chunks.origin, ll.lat, ll.lon, 0);
  return vec3.fromValues(e, 0, -n);
}

function updateMatrices(): void {
  const target = world(state.centre);
  mat4.lookAt(view, [target[0], EYE_DISTANCE_M, target[2]], target, [0, 0, -1]);
  const hw = state.span / 2;
  const hh = (hw * Math.max(1, canvas.clientHeight)) / Math.max(1, canvas.clientWidth);
  mat4.ortho(proj, -hw, hw, -hh, hh, 0, 2 * EYE_DISTANCE_M);
  mat4.multiply(viewProj, proj, view);
  mat4.invert(invViewProj, viewProj);
}

function groundAt(px: number, py: number): LatLon {
  updateMatrices();
  const x = (px / canvas.clientWidth) * 2 - 1, y = 1 - (py / canvas.clientHeight) * 2;
  const a = vec4.transformMat4(vec4.create(), [x, y, -1, 1], invViewProj);
  const b = vec4.transformMat4(vec4.create(), [x, y, 1, 1], invViewProj);
  const t = a[1] / (a[1] - b[1] || 1);
  return enuToLatLon(chunks.origin, a[0] + (b[0] - a[0]) * t, -(a[2] + (b[2] - a[2]) * t), 0);
}

function setSun(): void {
  const el = state.sunEl * D2R, az = 150 * D2R;
  vec3.set(sunDir, Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
  lut = buildLUT(paletteAt(state.sunEl));
}

let frames = 0;
let fps = 0;
let fpsSince = performance.now();
let hashAt = 0;

function frame(now: number): void {
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
  cam.latLon = state.centre;
  const place = () => {
    const [e, n] = latLonToEnu(chunks.origin, cam.latLon.lat, cam.latLon.lon, 0);
    vec3.set(cam.pos, e, CAM_ALT_M, -n);
  };
  place();
  if (chunks.rebaseIfNeeded(cam)) place();
  updateMatrices();

  const osmOn = $<HTMLInputElement>('osm').checked;
  chunks.update(cam, view, proj, now, osmOn ? (key) => osm.ready(key) : () => true);
  if (osmOn) osm.update(cam, view, proj, now, chunks.origin, chunks.detailTiles, chunks.shownDetail);

  renderer.orthoFar = 2 * EYE_DISTANCE_M;
  renderer.originLat = chunks.origin.lat;
  renderer.nightGlow = false;
  renderer.beginFrame(lut, lightUniforms(paletteAt(state.sunEl)));
  renderer.setSunMoon(sunDir, NO_MOON);
  chunks.draw(renderer, view, proj, cam.pos, sunDir, 1e9, 2e9, osmOn ? HOUSE_RADIUS_M : undefined);
  if (osmOn) osm.draw(renderer, view, proj, cam.pos, sunDir, 1e9, 2e9, false, POINT_SIZE * dpr);
  renderer.beginOverlay();
  renderer.resolve();

  frames++;
  if (now - fpsSince > 500) {
    fps = Math.round((frames * 1000) / (now - fpsSince));
    frames = 0;
    fpsSince = now;
    const os = osm.stats;
    $('stats').textContent = [
      `${fps} кадр/с`,
      `рельеф: загружено ${chunks.stats.chunks}, в очереди ${chunks.stats.pending}`,
      osmOn ? `OSM: загружено ${os.chunks}, в очереди ${os.pending}, ошибок ${os.errors}` : 'OSM: выключен',
      `масштаб ${(state.span / canvas.clientWidth).toFixed(2)} м/пкс`,
    ].join('\n');
  }
  if (now - hashAt > 700) {
    hashAt = now;
    const h = `#${state.centre.lat.toFixed(5)},${state.centre.lon.toFixed(5)},${(state.span / 1000).toFixed(2)}`;
    if (h !== location.hash) history.replaceState(null, '', h);
  }
  requestAnimationFrame(frame);
}

// ---------- styles ----------

const hex = (c: RGB) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as RGB;
const css = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

/** the styles the tiles are built with: the edited ones, the found kind in HIGHLIGHT */
function effectiveStyles(): AreaStyles {
  const s = copyStyles(state.styles);
  if (state.found) s[state.found] = HIGHLIGHT;
  return s;
}

let rebuildTimer = 0;
let builtWith = '';
function scheduleRebuild(delay = REBUILD_DELAY_MS): void {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    const s = effectiveStyles();
    const key = JSON.stringify(s);
    if (key === builtWith) return;
    builtWith = key;
    osm.areaStyles = isDefaultAreaStyles(s) ? undefined : s;
    chunks.areaStyles = osm.areaStyles;
    osm.invalidate();
    // the terrain draws the area covers now: its detailed tiles are rebuilt with the styles too
    chunks.invalidateDetail();
    styleMsg(isDefaultAreaStyles(s) ? 'стили игры; OSM пересобирается' : 'OSM пересобирается с новыми стилями');
  }, delay);
}

function styleMsg(text: string, error = false): void {
  const el = $('styleMsg');
  el.textContent = text;
  el.className = error ? 'err' : 'hint';
}

function code(): string {
  const f = (a: AreaFilter) => `{ colour: [${a.colour.map((v) => Math.round(v)).join(', ')}], mode: '${a.mode}', strength: ${+a.strength.toFixed(2)} }`;
  return [
    'export const DEFAULT_AREA_STYLES: AreaStyles = {',
    ...AREA_KINDS.map(({ kind }) => `  ${kind}: ${f(state.styles[kind])},`),
    '};',
  ].join('\n');
}

function swatches(el: HTMLElement, f: AreaFilter | null): void {
  el.innerHTML = SAMPLES.map((c) => `<span style="background:${css(f ? filterColour(c, f) : c)}"></span>`).join('');
}

function renderKinds(): void {
  const box = $('kinds');
  box.innerHTML = '';
  const modes = BLEND_MODES.map((m) => `<option value="${m}">${MODE_NAMES[m]} (${m})</option>`).join('');
  for (const { kind, name, tags } of AREA_KINDS) {
    const el = document.createElement('div');
    el.className = 'kind';
    el.innerHTML = `
      <div class="row"><span class="name">${name}</span><button class="tiny" data-act="find">Найти</button><button class="tiny" data-act="reset" title="как в игре">↺</button></div>
      <div class="hint">${tags}</div>
      <div class="row"><input type="color" data-f="colour" /><select data-f="mode">${modes}</select></div>
      <div class="row"><span style="flex:0 0 auto">сила</span><input type="range" min="0" max="1" step="0.01" data-f="strength" /><input class="num" type="number" min="0" max="1" step="0.05" data-f="strengthNum" /></div>
      <div class="swatches" data-sw="before" title="снимок"></div>
      <div class="swatches after" data-sw="after" title="с фильтром"></div>`;
    const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const colourIn = q<HTMLInputElement>('[data-f=colour]');
    const modeIn = q<HTMLSelectElement>('[data-f=mode]');
    const strengthIn = q<HTMLInputElement>('[data-f=strength]');
    const strengthNum = q<HTMLInputElement>('[data-f=strengthNum]');
    const findBtn = q<HTMLButtonElement>('[data-act=find]');
    const sync = () => {
      const f = state.styles[kind];
      colourIn.value = hex(f.colour);
      modeIn.value = f.mode;
      strengthIn.value = String(f.strength);
      strengthNum.value = f.strength.toFixed(2);
      findBtn.classList.toggle('on', state.found === kind);
      el.classList.toggle('changed', JSON.stringify(f) !== JSON.stringify(DEFAULT_AREA_STYLES[kind]));
      swatches(q('[data-sw=after]'), f);
      $('code').textContent = code();
    };
    swatches(q('[data-sw=before]'), null);
    const edit = (patch: Partial<AreaFilter>, delay?: number) => {
      state.styles[kind] = { ...state.styles[kind], ...patch };
      saveStyles();
      sync();
      scheduleRebuild(delay);
    };
    colourIn.addEventListener('input', () => edit({ colour: fromHex(colourIn.value) }));
    modeIn.addEventListener('change', () => edit({ mode: modeIn.value as BlendMode }, 0));
    strengthIn.addEventListener('input', () => edit({ strength: +strengthIn.value }));
    strengthNum.addEventListener('change', () => {
      const v = parseFloat(strengthNum.value);
      edit({ strength: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : state.styles[kind].strength }, 0);
    });
    q<HTMLButtonElement>('[data-act=reset]').onclick = () => edit({ ...DEFAULT_AREA_STYLES[kind], colour: [...DEFAULT_AREA_STYLES[kind].colour] as RGB }, 0);
    findBtn.onclick = () => {
      state.found = state.found === kind ? null : kind;
      for (const b of box.querySelectorAll('[data-act=find]')) b.classList.remove('on');
      findBtn.classList.toggle('on', state.found === kind);
      scheduleRebuild(0);
    };
    box.appendChild(el);
    sync();
  }
}

// ---------- place ----------

function pasteMsg(text: string, error = false): void {
  const el = $('pasteMsg');
  el.textContent = text;
  el.className = error ? 'err' : 'hint';
}

function onPaste(e: ClipboardEvent): void {
  if (e.target instanceof HTMLInputElement) return;
  const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
  if (!text || text.length > 4000) return;
  const p = parseMapLink(text);
  if (!p) {
    if (/^https?:\/\//i.test(text)) pasteMsg(`в ссылке нет координат (короткие ссылки не поддерживаются): ${text.slice(0, 80)}`, true);
    return;
  }
  e.preventDefault();
  state.centre = { lat: p.lat, lon: p.lon };
  if (p.spanM !== undefined) state.span = Math.max(SPAN_MIN_M, Math.min(SPAN_MAX_M, p.spanM));
  pasteMsg(`${SOURCE[p.source]}: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
  syncInputs();
}

function syncInputs(): void {
  const set = (id: string, v: number | string) => ($<HTMLInputElement>(id).value = String(v));
  set('lat', state.centre.lat.toFixed(5));
  set('lon', state.centre.lon.toFixed(5));
  set('span', (state.span / 1000).toFixed(1));
  set('sunEl', state.sunEl);
}

function init(): void {
  const sel = $<HTMLSelectElement>('preset');
  sel.innerHTML = '<option value="">— пресеты —</option>' + PRESETS.map((p, k) => `<option value="${k}">${p[0]}</option>`).join('');
  sel.onchange = () => {
    const p = PRESETS[+sel.value];
    if (!sel.value || !p) return;
    state.centre = { lat: p[1], lon: p[2] };
    syncInputs();
  };
  const num = (id: string, lo: number, hi: number, apply: (v: number) => void) => {
    $<HTMLInputElement>(id).addEventListener('change', () => {
      const v = parseFloat($<HTMLInputElement>(id).value);
      if (Number.isFinite(v)) apply(Math.max(lo, Math.min(hi, v)));
      syncInputs();
    });
  };
  num('span', SPAN_MIN_M / 1000, SPAN_MAX_M / 1000, (v) => (state.span = v * 1000));
  num('sunEl', -10, 90, (v) => { state.sunEl = v; setSun(); });
  $('go').onclick = () => {
    const lat = parseFloat($<HTMLInputElement>('lat').value), lon = parseFloat($<HTMLInputElement>('lon').value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180) state.centre = { lat, lon };
    syncInputs();
  };

  $('resetAll').onclick = () => {
    state.styles = copyStyles(DEFAULT_AREA_STYLES);
    state.found = null;
    saveStyles();
    renderKinds();
    scheduleRebuild(0);
  };
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code());
      styleMsg('код DEFAULT_AREA_STYLES скопирован — вставьте его в src/world/area-styles.ts');
    } catch {
      styleMsg('буфер обмена недоступен — скопируйте код ниже вручную', true);
    }
  };

  // mouse: drag pans, wheel zooms about the cursor
  let drag: { grab: LatLon } | null = null;
  const at = (e: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const pinGround = (g: LatLon, px: number, py: number) => {
    const now = groundAt(px, py);
    state.centre = { lat: Math.max(-85, Math.min(85, state.centre.lat + g.lat - now.lat)), lon: state.centre.lon + g.lon - now.lon };
  };
  canvas.addEventListener('mousedown', (e) => {
    const [x, y] = at(e);
    drag = { grab: groundAt(x, y) };
  });
  window.addEventListener('mousemove', (e) => {
    const [x, y] = at(e);
    if (drag) {
      pinGround(drag.grab, x, y);
      syncInputs();
    }
    if (e.target === canvas) {
      const ll = groundAt(x, y);
      $('hover').textContent = `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`;
    }
  });
  window.addEventListener('mouseup', () => (drag = null));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = at(e);
    const g = groundAt(x, y);
    state.span = Math.max(SPAN_MIN_M, Math.min(SPAN_MAX_M, state.span * Math.exp(e.deltaY * 0.0015)));
    pinGround(g, x, y);
    syncInputs();
  }, { passive: false });
  document.addEventListener('paste', onPaste);
  window.addEventListener('hashchange', () => {
    Object.assign(state, parseHash());
    syncInputs();
  });

  renderKinds();
  if (!isDefaultAreaStyles(state.styles)) {
    osm.areaStyles = copyStyles(state.styles);
    chunks.areaStyles = osm.areaStyles;
    builtWith = JSON.stringify(state.styles);
    styleMsg('восстановлены сохранённые стили');
  } else {
    builtWith = JSON.stringify(state.styles);
  }
  syncInputs();
  setSun();
  requestAnimationFrame(frame);
}

init();
