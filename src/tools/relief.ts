/**
 * Relief inspector: the simulator's own terrain and OSM pipeline — ChunkManager, OsmManager, the
 * workers, the mesh cache and the world shaders — drawn in an orthographic projection, so seams,
 * level-of-detail boundaries and whole neighbourhoods of tiles can be looked at from above.
 * Levels of detail are chosen from a "simulator camera" (a point and an altitude), as in flight.
 */
import { mat4, vec3, vec4 } from 'gl-matrix';
import { BASE_LAND, frameLighting, litShare, moonLightOn, paletteAt, seasonOf, snowy, solarHour, sunColour, WINDOWS } from '../engine/palette';
import { rim, rimFrame } from '../engine/rim';
import { Renderer } from '../engine/renderer';
import { DEPTH_FAR, REVERSED_NEAR } from '../engine/shaders';
import { parseMapLink, RELIEF_TILES_ACROSS } from '../ui/map-links';
import { CLOUD_RGB } from '../world/clouds';
import { hazeDensity } from '../world/haze';
import { ChunkManager, DETAIL_RADIUS_M, type CameraWorld, type Chunk } from '../world/chunks';
import { farOsmTiles } from '../world/far-osm';
import { FarOsmManager } from '../world/far-osm-manager';
import { enuToLatLon, gridLatLon, latLonToEnu, tileBounds, tileCenter, tileSizeMeters, type LatLon, type Tile } from '../world/geodesy';
import { ALL_OSM_LAYERS, HOUSE_RADIUS_M, OsmManager, type OsmLayers } from '../world/osm-manager';
import { ALL_STRUCTURES, STRUCTURE_KINDS, STRUCTURE_LABELS, type StructureKind } from '../world/structure-kinds';
import { FOG_CLEAR } from '../world/precipitation';
import { isNeutralGrade, NEUTRAL_GRADE, type ColourGrade } from '../world/landsat-process';
import { moonPosition, sunPosition } from '../world/sun';
import { deleteCachedMeshes, isTileMeshKey } from '../world/tile-cache';
import { solarClock, solarInstant } from '../world/time-of-day';
import { cruiseSpeed, FLY_KEY_CODES, flyStep, look, noKeys, type FlyKeys } from './fly-camera';
import { PRESETS, SOURCE } from './presets';

/**
 * The inspector has no weather: it is lit as the simulator lights a clear day (palette.ts
 * sunniness 1, the 'clear' preset), so what it shows is what one flies over in good weather.
 */
const CLEAR_SUNNY = 1;
const CLOUD: [number, number, number] = [(CLOUD_RGB >> 16) & 255, (CLOUD_RGB >> 8) & 255, CLOUD_RGB & 255];
/** a sun set by hand has no moon with it */
const NO_MOON = new Float32Array([0, -1, 0]);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const D2R = Math.PI / 180;

/** the view looks at its centre from this far; the orthographic far plane is twice that (within DEPTH_FAR) */
const EYE_DISTANCE_M = 90000;
/** the camera looks down from 90° (plan view) to this many degrees above the horizon */
const MIN_ELEVATION_DEG = 15;
const MAX_TILT_DEG = 90 - MIN_ELEVATION_DEG;
const CAM_ALT_MAX_M = 20000;
const SPAN_MIN_M = 200;
const SPAN_MAX_M = 180000;
/** the lights' size in the simulator at its usual 1× HUD scale */
const POINT_SIZE = 3;
/** the lights are on while the sun is below this, degrees (main.ts lightsOn) */
const LIGHTS_ON_SUN_DEG = 2;
const EDGE_NAMES = ['север', 'юг', 'запад', 'восток'];
/** tile outline by zoom, coarse to fine */
/** the colour correction is kept between visits (this browser only) */
const GRADE_STORAGE = 'relief.landsatGrade';
/** the drawing mode and the layers shown are kept between visits too */
const DISPLAY_STORAGE = 'relief.display';
const ZOOM_COLOURS = ['#7d8794', '#7d8794', '#8f7fd6', '#5b8def', '#4fc3d9', '#5fd38d', '#f0b54a'];

interface State {
  centre: LatLon;
  /** ground width of the view, metres */
  span: number;
  tilt: number;
  yaw: number;
  exag: number;
  camAlt: number;
  follow: boolean;
  /** the simulator camera when it does not follow the view */
  pinned: LatLon;
  /** the sun and the moon stand where they do at `date`, `minutes`; otherwise the sun is at sunAz, sunEl */
  byTime: boolean;
  /** local mean solar date (YYYY-MM-DD) and minutes into it at the view's centre */
  date: string;
  minutes: number;
  sunAz: number;
  sunEl: number;
  /** Landsat colour correction */
  grade: ColourGrade;
}

/**
 * The address keeps the view: #lat,lon,span km,camera alt,yaw,tilt (degrees), and in free flight
 * also ,fly,alt,heading,pitch: the flying camera's height above sea level (m) and where it looks
 * (degrees); lat,lon are then the flying camera's own place. #z/x/y opens a tile.
 */
function parseHash(): Partial<State> {
  const h = location.hash.slice(1);
  const tile = /^(\d+)\/(\d+)\/(\d+)$/.exec(h);
  if (tile) {
    const t = { z: +tile[1], x: +tile[2], y: +tile[3] };
    return { centre: tileCenter(t), span: tileSizeMeters(t) * RELIEF_TILES_ACROSS };
  }
  const p = h.split(',').map(Number);
  if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 85 || Math.abs(p[1]) > 180) return {};
  return {
    centre: { lat: p[0], lon: p[1] },
    ...(Number.isFinite(p[2]) && p[2] > 0 ? { span: p[2] * 1000 } : {}),
    ...(Number.isFinite(p[3]) && p[3] >= 0 ? { camAlt: p[3] } : {}),
    ...(Number.isFinite(p[4]) ? { yaw: ((p[4] + 540) % 360) - 180 } : {}),
    ...(Number.isFinite(p[5]) ? { tilt: Math.max(0, Math.min(MAX_TILT_DEG, p[5])) } : {}),
  };
}

/** the free flight in the address: null for the view from above or an address without the view's fields */
function hashFly(): { alt: number; heading: number; pitch: number } | null | undefined {
  const p = location.hash.slice(1).split(',');
  if (p.length < 6) return undefined;
  if (p[6] !== 'fly') return null;
  const [alt, heading, pitch] = p.slice(7, 10).map(Number);
  return [alt, heading, pitch].every(Number.isFinite) ? { alt, heading, pitch } : null;
}

/** put the flying camera where the address or the query says, starting free flight if it is off */
function flyTo(ll: LatLon, alt: number, heading: number, pitch: number): void {
  setFly(true);
  state.centre = fly.latLon = ll;
  fly.alt = Math.max(1, Math.min(FLY_ALT_MAX_M, alt));
  fly.yaw = heading * D2R;
  fly.pitch = Math.max(-89, Math.min(89, pitch)) * D2R;
}

/** the view as the address keeps it (parseHash, hashFly) */
function viewHash(): string {
  const r1 = (v: number) => +v.toFixed(1);
  let h = `#${state.centre.lat.toFixed(5)},${state.centre.lon.toFixed(5)},${(state.span / 1000).toFixed(2)},${Math.round(state.camAlt)},${r1(state.yaw)},${r1(state.tilt)}`;
  if (fly.on) {
    const heading = (((fly.yaw / D2R) % 360) + 360) % 360;
    h += `,fly,${Math.round(fly.alt)},${r1(heading)},${r1(fly.pitch / D2R)}`;
  }
  return h;
}

/** the view's address in place of the page's: it replaces a ?fly= start, which would otherwise win on reload */
function writeHash(): void {
  const url = new URL(location.href);
  url.searchParams.delete('fly');
  url.hash = viewHash();
  if (url.href !== location.href) history.replaceState(null, '', url);
}

const state: State = {
  centre: { lat: PRESETS[0][1], lon: PRESETS[0][2] },
  span: 30000,
  tilt: 0,
  yaw: 0,
  exag: 1,
  camAlt: 1500,
  follow: true,
  pinned: { lat: PRESETS[0][1], lon: PRESETS[0][2] },
  byTime: true,
  // today, mid-morning: a sun high enough to light the ground and low enough to model it
  date: solarClock(new Date(), 0).date,
  minutes: 10 * 60,
  sunAz: 150,
  sunEl: 30,
  grade: NEUTRAL_GRADE,
  ...parseHash(),
};
state.span = Math.max(SPAN_MIN_M, Math.min(SPAN_MAX_M, state.span));

const canvas = $<HTMLCanvasElement>('screen');
const marks = $<HTMLCanvasElement>('marks');
const renderer = new Renderer(canvas);
const chunks = new ChunkManager(renderer.gl, state.centre);
const osm = new OsmManager(renderer.gl, state.centre);
/** the far ring round the simulator camera, as in flight: building dots by day, window lights by night */
const farOsm = new FarOsmManager(renderer.gl, state.centre);
osm.onTileReady = (tile, runways, coast, roads) => {
  // as in the simulator: terrain under a runway, by the coast or under roads is rebuilt once its OSM is known
  if (runways > 0) chunks.invalidateNear(tileCenter(tile), 2500, 12);
  else if (coast || roads) chunks.invalidate(tile); // only this tile changes
};

const view = mat4.create();
const proj = mat4.create();
const viewProj = mat4.create();
const invViewProj = mat4.create();
/** the true directions of the sun and the moon, and the light the faces are shaded by (the simulator's lightDir) */
const sunDir = vec3.create();
const moonDir = vec3.create();
const lightDir = vec3.create();
const cam: CameraWorld = { pos: vec3.create(), latLon: state.centre, alt: state.camAlt, velocity: vec3.create() };
let palette = paletteAt(state.sunEl, CLEAR_SUNNY);
let { lut, light } = frameLighting(palette, state.sunEl, CLEAR_SUNNY, CLOUD, 0);
/** what the light was last worked out for */
let lightKey = '';
let selected: Tile | null = null;

/**
 * Free flight: a perspective camera at `latLon`, `alt` m above sea level, flown with W A S D,
 * Space / Z and the captured mouse (fly-camera.ts). Its position is kept as a place, not as world
 * coordinates, so the world origin can move under it (chunks.rebaseIfNeeded).
 */
const fly = {
  on: false,
  latLon: state.centre,
  alt: 1500,
  yaw: 0,
  pitch: 0,
  /** the wheel's factor on the cruising speed */
  speedFactor: 1,
  keys: noKeys() as FlyKeys,
  mouseDX: 0,
  mouseDY: 0,
  last: 0,
};
const FLY_FOV_RAD = (60 * Math.PI) / 180;
const FLY_ALT_MAX_M = 30000;
const FLY_SPEED_FACTOR_MIN = 1 / 16;
const FLY_SPEED_FACTOR_MAX = 16;
const locked = () => document.pointerLockElement === canvas;
/** capture the mouse; the browser may refuse (too soon after Esc, an embedded page): a click retries */
function capture(): void {
  try {
    const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  } catch {
    // refused: the hint still says to click
  }
}

const checked = (id: string) => $<HTMLInputElement>(id).checked;

function world(ll: LatLon): vec3 {
  const [e, n] = latLonToEnu(chunks.origin, ll.lat, ll.lon, 0);
  return vec3.fromValues(e, 0, -n);
}

/** view and projection for the current state (and the canvas size in CSS pixels) */
function updateMatrices(): void {
  if (fly.on) {
    const eye = world(fly.latLon);
    eye[1] = fly.alt;
    const cp = Math.cos(fly.pitch);
    const ahead = vec3.fromValues(Math.sin(fly.yaw) * cp, Math.sin(fly.pitch), -Math.cos(fly.yaw) * cp);
    mat4.lookAt(view, eye, vec3.add(vec3.create(), eye, ahead), [0, 1, 0]);
    const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
    mat4.perspective(proj, FLY_FOV_RAD, aspect, REVERSED_NEAR, DEPTH_FAR);
    mat4.multiply(viewProj, proj, view);
    mat4.invert(invViewProj, viewProj);
    return;
  }
  const target = world(state.centre);
  const th = state.tilt * D2R, ps = state.yaw * D2R;
  const ahead = vec3.fromValues(Math.sin(ps), 0, -Math.cos(ps)); // the ground direction at the top of the screen
  const eye = vec3.fromValues(
    target[0] - ahead[0] * EYE_DISTANCE_M * Math.sin(th),
    EYE_DISTANCE_M * Math.cos(th),
    target[2] - ahead[2] * EYE_DISTANCE_M * Math.sin(th),
  );
  mat4.lookAt(view, eye, target, ahead);
  mat4.scale(view, view, [1, state.exag, 1]);
  const hw = state.span / 2;
  const hh = (hw * Math.max(1, canvas.clientHeight)) / Math.max(1, canvas.clientWidth);
  mat4.ortho(proj, -hw, hw, -hh, hh, 0, 2 * EYE_DISTANCE_M);
  mat4.multiply(viewProj, proj, view);
  mat4.invert(invViewProj, viewProj);
}

/** the point of the sea-level plane under a canvas pixel */
function groundAt(px: number, py: number): LatLon {
  updateMatrices();
  const x = (px / canvas.clientWidth) * 2 - 1, y = 1 - (py / canvas.clientHeight) * 2;
  const a = vec4.transformMat4(vec4.create(), [x, y, -1, 1], invViewProj);
  const b = vec4.transformMat4(vec4.create(), [x, y, 1, 1], invViewProj);
  const t = a[1] / (a[1] - b[1] || 1);
  return enuToLatLon(chunks.origin, a[0] + (b[0] - a[0]) * t, -(a[2] + (b[2] - a[2]) * t), 0);
}

function project(p: vec3): [number, number] {
  const c = vec4.transformMat4(vec4.create(), [p[0], p[1], p[2], 1], viewProj);
  return [(c[0] / c[3] * 0.5 + 0.5) * canvas.clientWidth, (0.5 - c[1] / c[3] * 0.5) * canvas.clientHeight];
}

function tileAt(ll: LatLon): Chunk | undefined {
  return chunks.renderList.find((c) => {
    const b = tileBounds(c.tile);
    return ll.lat <= b.north && ll.lat >= b.south && ll.lon >= b.west && ll.lon <= b.east;
  });
}

const simCamera = () => (state.follow ? state.centre : state.pinned);

// ---------- frame ----------

/** the instant of the chosen solar date and time at the view's centre */
const sunInstant = (): Date => solarInstant(state, state.centre.lon) ?? new Date();

/**
 * The light for the current state, worked out again only when what it depends on changed: by date
 * and time the sun and the moon as the simulator has them over the view's centre (so the light
 * follows the view), otherwise a sun at the given azimuth and elevation.
 */
function updateLight(): void {
  const key = state.byTime
    ? `t|${state.date}|${state.minutes}|${state.centre.lat.toFixed(2)}|${state.centre.lon.toFixed(2)}`
    : `m|${state.sunAz}|${state.sunEl}`;
  if (key === lightKey) return;
  lightKey = key;
  let morning = false;
  let moonLight = 0;
  if (state.byTime) {
    const t = sunInstant();
    const sun = sunPosition(t, state.centre), moon = moonPosition(t, state.centre);
    vec3.copy(sunDir, sun.dir);
    vec3.copy(moonDir, moon.dir);
    state.sunEl = sun.elevationDeg;
    state.sunAz = ((Math.atan2(sun.dir[0], -sun.dir[2]) / D2R) + 360) % 360;
    morning = sunPosition(new Date(t.getTime() + 60000), state.centre).elevationDeg > sun.elevationDeg;
    // as in the simulator: the faces' light leans from the sun to the moon as the sun goes down
    const sw = Math.max(0, Math.min(1, (sun.elevationDeg + 4) / 6));
    const mw = moonLightOn(sun.elevationDeg, moon.elevationDeg, moon.illumination);
    moonLight = mw;
    if (sw + mw < 1e-3) vec3.copy(lightDir, sunDir);
    else vec3.normalize(lightDir, vec3.scaleAndAdd(lightDir, vec3.scale(lightDir, sunDir, sw), moonDir, mw));
    renderer.season = seasonOf(t);
    renderer.litShare = litShare(solarHour(t, state.centre.lon));
    syncSun();
  } else {
    const el = state.sunEl * D2R, az = state.sunAz * D2R;
    vec3.set(sunDir, Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    vec3.copy(moonDir, NO_MOON);
    vec3.copy(lightDir, sunDir);
    renderer.season = 0;
    renderer.litShare = WINDOWS.LIT_SHARE;
  }
  palette = paletteAt(state.sunEl, CLEAR_SUNNY, morning);
  ({ lut, light } = frameLighting(palette, state.sunEl, CLEAR_SUNNY, CLOUD, moonLight));
}

let frames = 0;
let fps = 0;
let fpsSince = performance.now();
let hashAt = 0;

function frame(now: number): void {
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);

  if (fly.on) flyFrame(now);
  else fly.last = 0;
  // in free flight the levels of detail are chosen from the flying camera itself
  cam.latLon = fly.on ? fly.latLon : simCamera();
  cam.alt = fly.on ? fly.alt : state.camAlt;
  const place = () => {
    const [e, n] = latLonToEnu(chunks.origin, cam.latLon.lat, cam.latLon.lon, 0);
    vec3.set(cam.pos, e, cam.alt, -n);
  };
  place();
  if (chunks.rebaseIfNeeded(cam)) place();
  updateMatrices();
  updateLight();

  const osmOn = checked('osm');
  chunks.stitch = checked('stitch');
  // without OSM a detailed tile has nothing to wait for
  chunks.update(cam, view, proj, now, osmOn ? (key) => osm.ready(key) : () => true);
  if (osmOn) {
    osm.update(cam, view, proj, now, chunks.origin, chunks.detailTiles, chunks.shownDetail);
    const detailKeys = new Set(chunks.detailTiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    farOsm.update(cam, view, proj, now, chunks.origin, farOsmTiles(cam.latLon, cam.alt, detailKeys), chunks.shownDetail);
  }

  // the simulator's rule: the lights come on as the sun goes below LIGHTS_ON_SUN_DEG
  const mode = $<HTMLSelectElement>('night').value;
  const night = mode === 'on' || (mode === 'auto' && state.sunEl < LIGHTS_ON_SUN_DEG);
  renderer.orthoFar = fly.on ? 0 : 2 * EYE_DISTANCE_M;
  renderer.originLat = chunks.origin.lat;
  renderer.nightGlow = night;
  // the lit windows' flicker and the water's glitter run on it
  renderer.time = now / 1000;
  // as in the simulator: sun shadows (in free flight only: the renderer casts none in the plan view)
  if (renderer.beginShadows(cam.pos, 0, view, sunDir)) {
    chunks.drawShadows(renderer);
    if (osmOn) osm.drawShadows(renderer, cam.pos);
    renderer.endShadows();
  }
  renderer.beginFrame(lut, light);
  renderer.setSunMoon(sunDir, moonDir);
  renderer.rim = rimFrame(rim, palette, sunColour(state.sunEl), state.sunEl);
  // in free flight the sky and the clear-weather fog of the simulator; from above no fog: the view
  // has no single distance to the ground
  const [fogStart, fogEnd] = fly.on ? [FOG_CLEAR.start, FOG_CLEAR.end] : [1e9, 2e9];
  if (fly.on) {
    renderer.drawSky(view, proj, cam.pos, sunDir, moonDir, {
      y: 0, ramp: snowy(BASE_LAND), fogStart, fogEnd,
    });
  }
  renderer.rimWeight = rim.terrain;
  chunks.draw(renderer, view, proj, cam.pos, lightDir, fogStart, fogEnd, osmOn ? HOUSE_RADIUS_M : undefined);
  renderer.rimWeight = rim.objects;
  renderer.rimTreeWeight = rim.trees;
  if (osmOn) {
    osm.draw(renderer, view, proj, cam.pos, lightDir, fogStart, fogEnd, night, POINT_SIZE * dpr);
    farOsm.draw(renderer, view, proj, cam.pos, night, POINT_SIZE * dpr, fogStart, fogEnd);
  }
  renderer.beginOverlay();
  renderer.resolve();

  drawMarks(dpr);

  frames++;
  if (now - fpsSince > 500) {
    fps = Math.round((frames * 1000) / (now - fpsSince));
    frames = 0;
    fpsSince = now;
    showStats(osmOn);
    showTile();
    if (fly.on) {
      for (const [id, v] of [['lat', fly.latLon.lat], ['lon', fly.latLon.lon]] as const) {
        const el = $<HTMLInputElement>(id);
        if (document.activeElement !== el) el.value = v.toFixed(5);
      }
    }
  }
  if (now - hashAt > 700) {
    hashAt = now;
    writeHash();
  }
  requestAnimationFrame(frame);
}

// ---------- free flight ----------

/** move and turn the flying camera by this frame's keys and mouse */
function flyFrame(now: number): void {
  const dt = fly.last ? Math.min(0.1, (now - fly.last) / 1000) : 0;
  fly.last = now;
  // a place chosen in the panel (a preset, «Перейти», a pasted link) moves the camera there
  if (state.centre !== fly.latLon) fly.latLon = state.centre;
  if (fly.mouseDX || fly.mouseDY) {
    Object.assign(fly, look(fly.yaw, fly.pitch, fly.mouseDX, fly.mouseDY));
    fly.mouseDX = fly.mouseDY = 0;
  }
  const speed = cruiseSpeed(fly.alt) * fly.speedFactor;
  const d = flyStep(fly.yaw, fly.pitch, fly.keys, speed, dt);
  if (d[0] || d[1] || d[2]) {
    const p = world(fly.latLon);
    const ll = enuToLatLon(chunks.origin, p[0] + d[0], -(p[2] + d[2]), 0);
    fly.latLon = { lat: Math.max(-85, Math.min(85, ll.lat)), lon: ((ll.lon + 540) % 360) - 180 };
    fly.alt = Math.max(1, Math.min(FLY_ALT_MAX_M, fly.alt + d[1]));
  }
  // the light, the address and the panel follow the camera
  state.centre = fly.latLon;
  const heading = ((Math.round(fly.yaw / D2R) % 360) + 360) % 360;
  $('hover').textContent = [
    `${fly.latLon.lat.toFixed(5)}, ${fly.latLon.lon.toFixed(5)} · высота ${Math.round(fly.alt)} м · курс ${heading}° · ${Math.round(speed)} м/с`,
    locked() ? 'Esc — отпустить мышь' : 'щёлкните по виду — захватить мышь',
  ].join('\n');
}

function setFly(on: boolean): void {
  if (on === fly.on) return;
  fly.on = on;
  fly.keys = noKeys();
  fly.mouseDX = fly.mouseDY = 0;
  if (on) {
    // from the view's centre, looking at it 30° down from a height that suits the width of the view
    const pitch = -30 * D2R;
    fly.alt = Math.max(300, Math.min(FLY_ALT_MAX_M, state.span * 0.1));
    fly.yaw = state.yaw * D2R;
    fly.pitch = pitch;
    const back = fly.alt / Math.tan(-pitch);
    const c = world(state.centre);
    const ll = enuToLatLon(chunks.origin, c[0] - Math.sin(fly.yaw) * back, -(c[2] + Math.cos(fly.yaw) * back), 0);
    fly.latLon = { lat: Math.max(-85, Math.min(85, ll.lat)), lon: ll.lon };
    state.centre = fly.latLon;
    capture();
  } else {
    if (locked()) document.exitPointerLock();
    state.yaw = Math.round(((fly.yaw / D2R + 540) % 360) - 180);
    $('hover').textContent = '';
  }
  canvas.style.cursor = on ? 'crosshair' : '';
  $('viewTitle').textContent = on ? 'Перспектива · свободный полёт' : 'Ортографическая проекция';
  const b = $<HTMLButtonElement>('fly');
  b.textContent = on ? 'Вернуться к виду сверху' : 'Свободный полёт';
  // Space must not press the button again
  b.blur();
  syncInputs();
}

function initFly(): void {
  $('fly').onclick = () => setFly(!fly.on);
  const typing = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  window.addEventListener('keydown', (e) => {
    if (!fly.on || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = FLY_KEY_CODES[e.code];
    if (!k) return;
    fly.keys[k] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const k = FLY_KEY_CODES[e.code];
    if (k) fly.keys[k] = false;
  });
  window.addEventListener('blur', () => (fly.keys = noKeys()));
  document.addEventListener('pointerlockchange', () => {
    if (!locked()) fly.mouseDX = fly.mouseDY = 0;
  });
  document.addEventListener('mousemove', (e) => {
    if (!fly.on || !locked()) return;
    fly.mouseDX += e.movementX;
    fly.mouseDY += e.movementY;
  });
}

function corners(t: Tile): Array<[number, number]> {
  // nw, ne, se, sw
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([i, j]) => project(world(gridLatLon(t, i, j, 1))));
}

function drawMarks(dpr: number): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (marks.width !== Math.round(w * dpr) || marks.height !== Math.round(h * dpr)) {
    marks.width = Math.round(w * dpr);
    marks.height = Math.round(h * dpr);
  }
  const g = marks.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // the tile outlines are drawn for the view from above only
  if (fly.on) return;
  g.font = '11px ui-monospace, Menlo, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const path = (pts: Array<[number, number]>, close = true) => {
    g.beginPath();
    pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (close) g.closePath();
    g.stroke();
  };

  const grid = checked('grid'), labels = checked('labels'), coarse = checked('coarse');
  for (const c of chunks.renderList) {
    const q = corners(c.tile);
    if (grid) {
      g.lineWidth = 1;
      g.strokeStyle = ZOOM_COLOURS[Math.max(0, Math.min(ZOOM_COLOURS.length - 1, c.tile.z - 8))];
      path(q);
    }
    if (coarse && c.coarse) {
      g.lineWidth = 3;
      g.strokeStyle = '#ff4d6d';
      // bits 1 n, 2 s, 4 w, 8 e
      [[q[0], q[1]], [q[3], q[2]], [q[0], q[3]], [q[1], q[2]]].forEach((edge, e) => {
        if (c.coarse & (1 << e)) path(edge as Array<[number, number]>, false);
      });
    }
    if (labels && Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) > 76) {
      g.fillStyle = 'rgba(16,19,24,.7)';
      const text = c.key;
      const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
      g.fillRect(cx - g.measureText(text).width / 2 - 3, cy - 8, g.measureText(text).width + 6, 16);
      g.fillStyle = '#d6dbe2';
      g.fillText(text, cx, cy);
    }
  }
  if (selected) {
    g.lineWidth = 2;
    g.strokeStyle = '#f0b54a';
    path(corners(selected));
  }

  // the simulator camera, and the ground radius inside which it asks for detailed tiles
  const ll = simCamera();
  const [cx, cy] = project(world(ll));
  g.lineWidth = 1.5;
  g.strokeStyle = '#ffffff';
  path([[cx - 7, cy], [cx + 7, cy]], false);
  path([[cx, cy - 7], [cx, cy + 7]], false);
  const r = Math.sqrt(Math.max(0, DETAIL_RADIUS_M ** 2 - state.camAlt ** 2));
  if (r > 0) {
    const o = world(ll);
    g.setLineDash([4, 4]);
    path(Array.from({ length: 64 }, (_, k) => {
      const a = (k / 64) * 2 * Math.PI;
      return project(vec3.fromValues(o[0] + r * Math.cos(a), 0, o[2] + r * Math.sin(a)));
    }));
    g.setLineDash([]);
  }
}

// ---------- side panel ----------

function showStats(osmOn: boolean): void {
  const st = chunks.stats;
  const byZoom = new Map<number, number>();
  let verts = 0;
  for (const c of chunks.renderList) {
    byZoom.set(c.tile.z, (byZoom.get(c.tile.z) ?? 0) + 1);
    verts += c.mesh?.vertexCount ?? 0;
  }
  const zooms = [...byZoom].sort((a, b) => a[0] - b[0]).map(([z, n]) => `z${z}: ${n}`).join('  ');
  const os = osm.stats;
  $('stats').textContent = [
    `${fps} кадр/с`,
    `тайлов в кадре ${chunks.renderList.length} (${zooms || '—'})`,
    `треугольников ${Math.round(verts / 3)}`,
    `рельеф: загружено ${st.chunks}, в очереди ${st.pending}`,
    osmOn ? `OSM: загружено ${os.chunks}, в очереди ${os.pending}, ошибок ${os.errors}` : 'OSM: выключен',
    fly.on
      ? `скорость ×${+fly.speedFactor.toFixed(3)} (колесо), высота ${Math.round(fly.alt)} м`
      : `масштаб ${(state.span / canvas.clientWidth).toFixed(1)} м/пкс`,
  ].join('\n');
}

function showTile(): void {
  const has = selected !== null;
  $<HTMLButtonElement>('openTile').disabled = !has;
  $<HTMLButtonElement>('dropTile').disabled = !has;
  const info = $('tileInfo');
  if (!selected) {
    info.textContent = 'Щёлкните по тайлу на карте.';
    return;
  }
  const key = `${selected.z}/${selected.x}/${selected.y}`;
  const c = chunks.chunks.get(key);
  const status = !c ? 'не загружен' : c.status === 'ready' ? 'готов' : c.status === 'pending' ? 'строится' : 'ошибка';
  const drawn = chunks.renderList.some((d) => d.key === key);
  const edges = c && c.coarse ? EDGE_NAMES.filter((_, e) => c.coarse & (1 << e)).join(', ') : 'нет';
  const o = osm.chunks.get(key);
  info.textContent = [
    `тайл ${key} · ${(tileSizeMeters(selected) / 1000).toFixed(2)} км`,
    `рельеф: ${status}${drawn ? ', в кадре' : ''}`,
    `треугольников ${c?.mesh ? Math.round(c.mesh.vertexCount / 3) : '—'}`,
    `сшитые края: ${edges}`,
    `OSM: ${!o ? 'нет' : o.status === 'ready' ? 'готов' : o.status === 'pending' ? 'строится' : 'ошибка'}`,
  ].join('\n');
}

function cacheMsg(text: string, error = false): void {
  const el = $('cacheMsg');
  el.textContent = text;
  el.className = error ? 'err' : 'hint';
}

/** forget the cached meshes of `tiles` (all when omitted) and rebuild them from their sources */
async function dropCache(tiles?: Tile[]): Promise<void> {
  try {
    const n = await deleteCachedMeshes((key) => !tiles || tiles.some((t) => isTileMeshKey(key, t)));
    if (tiles) {
      for (const t of tiles) {
        chunks.invalidate(t);
        osm.invalidate(t);
      }
    } else {
      chunks.invalidate();
      osm.invalidate();
    }
    cacheMsg(`удалено записей кэша: ${n}; ${tiles ? `тайлов пересобирается: ${tiles.length}` : 'пересобирается всё'}`);
  } catch (err) {
    cacheMsg(`кэш не сброшен: ${(err as Error).message}`, true);
  }
}

interface Display {
  wire: 'off' | 'object' | 'mono';
  wireColor: string;
  wireFill: string;
  layers: OsmLayers;
  /** structure kinds hidden, a bit per kind (structure-kinds STRUCTURE): kinds added later show */
  hiddenStructures: number;
  /** trees in a wood or forest × the game's (props-mesher FOREST) */
  treeDensity: number;
}

const TREE_DENSITY_MAX = 8;
const DEFAULT_DISPLAY: Display = { wire: 'off', wireColor: '#4fc3d9', wireFill: '#101318', layers: { ...ALL_OSM_LAYERS }, hiddenStructures: 0, treeDensity: 1 };
const treeDensityOf = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(TREE_DENSITY_MAX, v)) : 1;

function loadDisplay(): Display {
  try {
    const d = JSON.parse(localStorage.getItem(DISPLAY_STORAGE) ?? 'null') as Partial<Display> | null;
    const hex = (v: unknown, dflt: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : dflt);
    const layers = { ...ALL_OSM_LAYERS };
    for (const k of Object.keys(layers) as Array<keyof OsmLayers>) if (typeof d?.layers?.[k] === 'boolean') layers[k] = d.layers[k];
    return {
      wire: d?.wire === 'object' || d?.wire === 'mono' ? d.wire : 'off',
      wireColor: hex(d?.wireColor, DEFAULT_DISPLAY.wireColor),
      wireFill: hex(d?.wireFill, DEFAULT_DISPLAY.wireFill),
      layers,
      hiddenStructures: Number.isInteger(d?.hiddenStructures) ? d!.hiddenStructures! & ALL_STRUCTURES : 0,
      treeDensity: treeDensityOf(d?.treeDensity),
    };
  } catch {
    return { ...DEFAULT_DISPLAY, layers: { ...ALL_OSM_LAYERS } };
  }
}

const rgb01 = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** the wireframe mode and the OSM layers: the controls, the renderer and the OSM manager kept in step */
function initDisplay(): void {
  const d = loadDisplay();
  const wire = $<HTMLSelectElement>('wire');
  const wireColor = $<HTMLInputElement>('wireColor');
  const wireFill = $<HTMLInputElement>('wireFill');
  const treeDensity = $<HTMLInputElement>('treeDensity');
  const layerBoxes = [...document.querySelectorAll<HTMLInputElement>('input[data-layer]')];
  const all = $<HTMLInputElement>('structAll');
  const list = $('structures');
  list.innerHTML = Array.from({ length: STRUCTURE_KINDS }, (_, k) =>
    `<label><input type="checkbox" data-kind="${k}" /> ${STRUCTURE_LABELS[k as StructureKind]}</label>`).join('');
  const kindBoxes = [...list.querySelectorAll<HTMLInputElement>('input[data-kind]')];

  wire.value = d.wire;
  wireColor.value = d.wireColor;
  wireFill.value = d.wireFill;
  treeDensity.value = String(d.treeDensity);
  osm.treeDensity = d.treeDensity;
  for (const b of layerBoxes) b.checked = d.layers[b.dataset.layer as keyof OsmLayers];
  for (const b of kindBoxes) b.checked = (d.hiddenStructures & (1 << +b.dataset.kind!)) === 0;

  const apply = () => {
    const mode = wire.value as Display['wire'];
    wireColor.disabled = mode !== 'mono';
    wireFill.disabled = mode === 'off';
    renderer.wire = mode === 'off' ? undefined : { mode, color: rgb01(wireColor.value), fill: rgb01(wireFill.value) };
    const layers = { ...ALL_OSM_LAYERS };
    for (const b of layerBoxes) layers[b.dataset.layer as keyof OsmLayers] = b.checked;
    osm.layers = layers;
    let mask = 0;
    for (const b of kindBoxes) if (b.checked) mask |= 1 << +b.dataset.kind!;
    osm.structures = mask;
    all.checked = mask !== 0;
    all.indeterminate = mask !== 0 && mask !== ALL_STRUCTURES;
    try {
      const out: Display = { wire: mode, wireColor: wireColor.value, wireFill: wireFill.value, layers, hiddenStructures: ALL_STRUCTURES & ~mask, treeDensity: osm.treeDensity };
      localStorage.setItem(DISPLAY_STORAGE, JSON.stringify(out));
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };
  all.addEventListener('change', () => {
    for (const b of kindBoxes) b.checked = all.checked;
    apply();
  });
  // the forest's trees are planted with the OSM meshes: a new density rebuilds them
  treeDensity.addEventListener('change', () => {
    const v = treeDensityOf(parseFloat(treeDensity.value));
    treeDensity.value = String(v);
    if (v === osm.treeDensity) return;
    osm.treeDensity = v;
    osm.invalidate();
    apply();
  });
  for (const el of [wire, wireColor, wireFill, ...layerBoxes, ...kindBoxes]) {
    el.addEventListener(el === wireColor || el === wireFill ? 'input' : 'change', apply);
  }
  apply();
}

function loadGrade(): ColourGrade {
  try {
    const g = JSON.parse(localStorage.getItem(GRADE_STORAGE) ?? 'null') as Partial<ColourGrade> | null;
    const out = { ...NEUTRAL_GRADE };
    for (const k of Object.keys(out) as Array<keyof ColourGrade>) if (Number.isFinite(g?.[k])) out[k] = g![k]!;
    // the same ranges as the inputs
    out.brightness = Math.max(-1, Math.min(1, out.brightness));
    out.contrast = Math.max(0, Math.min(4, out.contrast));
    out.gamma = Math.max(0.2, Math.min(5, out.gamma));
    out.saturation = Math.max(0, Math.min(4, out.saturation));
    return out;
  } catch {
    return { ...NEUTRAL_GRADE };
  }
}

/** set the Landsat colour correction and rebuild every tile with it */
function setGrade(g: ColourGrade, note = 'тайлы пересобираются с новой коррекцией'): void {
  const same = (Object.keys(g) as Array<keyof ColourGrade>).every((k) => g[k] === chunks.grade[k]);
  state.grade = g;
  if (same) return;
  chunks.grade = g;
  osm.grade = g;
  chunks.invalidate();
  osm.invalidate();
  try {
    localStorage.setItem(GRADE_STORAGE, JSON.stringify(g));
  } catch {
    // storage unavailable: the correction lasts for this page only
  }
  const el = $('gradeMsg');
  el.textContent = isNeutralGrade(g) ? 'без коррекции; тайлы пересобираются' : note;
  el.className = 'hint';
}

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
  const notes: string[] = [];
  // links of the project carry more than a point: a tile, the width of a view, an altitude
  if (p.tile) {
    selected = p.tile;
    state.span = tileSizeMeters(p.tile) * RELIEF_TILES_ACROSS;
    notes.push(`тайл ${p.tile.z}/${p.tile.x}/${p.tile.y}`);
    showTile();
  } else if (p.spanM !== undefined) {
    state.span = p.spanM;
  }
  state.span = Math.max(SPAN_MIN_M, Math.min(SPAN_MAX_M, state.span));
  if (p.alt !== undefined) {
    state.camAlt = Math.max(0, Math.min(CAM_ALT_MAX_M, p.alt));
    notes.push(`высота камеры ${Math.round(state.camAlt)} м`);
  }
  pasteMsg([`${SOURCE[p.source]}: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, ...notes].join(', '));
  syncInputs();
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** the sun's inputs: by date and time the azimuth and elevation only show where it stands */
function syncSun(): void {
  const set = (id: string, v: number | string) => {
    const el = $<HTMLInputElement>(id);
    // not under the user's hands
    if (document.activeElement !== el) el.value = String(v);
  };
  $<HTMLInputElement>('byTime').checked = state.byTime;
  set('sunDate', state.date);
  set('sunTime', hhmm(state.minutes));
  set('sunSlider', state.minutes);
  set('sunAz', +state.sunAz.toFixed(1));
  set('sunEl', +state.sunEl.toFixed(1));
  for (const id of ['sunDate', 'sunTime', 'sunSlider']) $<HTMLInputElement>(id).disabled = !state.byTime;
}

function syncInputs(): void {
  const set = (id: string, v: number | string) => ($<HTMLInputElement>(id).value = String(v));
  set('lat', state.centre.lat.toFixed(5));
  set('lon', state.centre.lon.toFixed(5));
  set('span', (state.span / 1000).toFixed(1));
  set('camAlt', Math.round(state.camAlt));
  set('elev', Math.round(90 - state.tilt));
  set('yaw', Math.round(state.yaw));
  set('exag', state.exag);
  syncSun();
  set('lsBright', state.grade.brightness);
  set('lsContrast', state.grade.contrast);
  set('lsGamma', state.grade.gamma);
  set('lsSat', state.grade.saturation);
  $<HTMLInputElement>('follow').checked = state.follow;
}

function openTileInspector(t: Tile): void {
  window.open(`inspector.html#${t.z}/${t.x}/${t.y}`, '_blank');
}

function init(): void {
  initDisplay();
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
  num('camAlt', 0, CAM_ALT_MAX_M, (v) => (state.camAlt = v));
  num('elev', MIN_ELEVATION_DEG, 90, (v) => (state.tilt = 90 - v));
  num('yaw', -180, 360, (v) => (state.yaw = v));
  num('exag', 1, 20, (v) => (state.exag = v));
  // a sun set by hand: the date and time no longer hold
  num('sunAz', 0, 360, (v) => { state.sunAz = v; state.byTime = false; });
  num('sunEl', -10, 90, (v) => { state.sunEl = v; state.byTime = false; });
  $('byTime').addEventListener('change', () => {
    state.byTime = checked('byTime');
    syncSun();
  });
  $<HTMLInputElement>('sunDate').addEventListener('change', () => {
    const v = $<HTMLInputElement>('sunDate').value;
    if (solarInstant({ date: v, minutes: 0 }, 0)) state.date = v;
    syncSun();
  });
  $<HTMLInputElement>('sunTime').addEventListener('change', () => {
    const m = /^(\d{2}):(\d{2})/.exec($<HTMLInputElement>('sunTime').value);
    if (m) state.minutes = Math.min(1439, +m[1] * 60 + +m[2]);
    syncSun();
  });
  $<HTMLInputElement>('sunSlider').addEventListener('input', () => {
    state.minutes = Math.max(0, Math.min(1439, Math.round(+$<HTMLInputElement>('sunSlider').value)));
    $<HTMLInputElement>('sunTime').value = hhmm(state.minutes);
  });
  $('sunNow').onclick = () => {
    Object.assign(state, solarClock(new Date(), state.centre.lon), { byTime: true });
    syncSun();
  };
  $('sunNoon').onclick = () => {
    state.minutes = 12 * 60;
    state.byTime = true;
    syncSun();
  };
  num('lsBright', -1, 1, (v) => setGrade({ ...state.grade, brightness: v }));
  num('lsContrast', 0, 4, (v) => setGrade({ ...state.grade, contrast: v }));
  num('lsGamma', 0.2, 5, (v) => setGrade({ ...state.grade, gamma: v }));
  num('lsSat', 0, 4, (v) => setGrade({ ...state.grade, saturation: v }));
  $('lsReset').onclick = () => {
    setGrade({ ...NEUTRAL_GRADE });
    syncInputs();
  };

  $('go').onclick = () => {
    const lat = parseFloat($<HTMLInputElement>('lat').value), lon = parseFloat($<HTMLInputElement>('lon').value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180) state.centre = { lat, lon };
    syncInputs();
  };
  $('follow').addEventListener('change', () => {
    state.follow = checked('follow');
    if (!state.follow) state.pinned = state.centre;
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-turn]')) {
    b.onclick = () => {
      state.yaw = ((state.yaw + Number(b.dataset.turn) + 540) % 360) - 180;
      syncInputs();
    };
  }
  $('topDown').onclick = () => {
    state.tilt = 0;
    state.yaw = 0;
    syncInputs();
  };
  $('toSim').onclick = () => {
    const c = simCamera();
    const hdg = ((Math.round(state.yaw) % 360) + 360) % 360;
    // by date and time the simulator opens at the same moment (its 6th field), otherwise at the current clock
    const when = state.byTime ? `,,${Math.floor(sunInstant().getTime() / 1000)}` : '';
    window.open(`index.html#${c.lat.toFixed(5)},${c.lon.toFixed(5)},${Math.round(state.camAlt)},${hdg}${when}`, '_blank');
  };
  $('openTile').onclick = () => selected && openTileInspector(selected);
  $('dropTile').onclick = () => selected && void dropCache([selected]);
  $('dropView').onclick = () => void dropCache(chunks.renderList.map((c) => c.tile));
  $('dropAll').onclick = () => {
    if (confirm('Удалить все кэшированные меши рельефа и OSM? Они будут собраны заново из исходных данных.')) void dropCache();
  };

  // mouse: drag pans, right button or Alt rotates and tilts, wheel zooms about the cursor
  let drag: { x: number; y: number; rotate: boolean; grab: LatLon; moved: number } | null = null;
  const at = (e: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** move the view so that the ground point `g` comes back under the pixel */
  const pinGround = (g: LatLon, px: number, py: number) => {
    const now = groundAt(px, py);
    state.centre = {
      lat: Math.max(-85, Math.min(85, state.centre.lat + g.lat - now.lat)),
      lon: state.centre.lon + g.lon - now.lon,
    };
  };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (fly.on) {
      if (!locked()) capture();
      return;
    }
    const [x, y] = at(e);
    drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.altKey, grab: groundAt(x, y), moved: 0 };
  });
  window.addEventListener('mousemove', (e) => {
    if (fly.on) return;
    const [x, y] = at(e);
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.rotate) {
        state.yaw = ((state.yaw - dx * 0.3 + 540) % 360) - 180;
        state.tilt = Math.max(0, Math.min(MAX_TILT_DEG, state.tilt - dy * 0.3));
      } else {
        pinGround(drag.grab, x, y);
      }
      syncInputs();
    }
    if (e.target === canvas) {
      const ll = groundAt(x, y);
      const c = tileAt(ll);
      $('hover').textContent = `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}${c ? ` · тайл ${c.key}` : ''}`;
    }
  });
  window.addEventListener('mouseup', (e) => {
    const d = drag;
    drag = null;
    if (fly.on || !d || d.moved > 4 || d.rotate || e.target !== canvas) return;
    const [x, y] = at(e);
    const ll = groundAt(x, y);
    if (e.shiftKey) {
      state.follow = false;
      state.pinned = ll;
      syncInputs();
    } else {
      selected = tileAt(ll)?.tile ?? null;
      showTile();
    }
  });
  canvas.addEventListener('dblclick', (e) => {
    if (fly.on) return;
    const [x, y] = at(e);
    const c = tileAt(groundAt(x, y));
    if (c) openTileInspector(c.tile);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (fly.on) {
      // the wheel sets the speed, by steps of ×1.25
      const f = fly.speedFactor * 1.25 ** -Math.sign(e.deltaY);
      fly.speedFactor = Math.max(FLY_SPEED_FACTOR_MIN, Math.min(FLY_SPEED_FACTOR_MAX, f));
      return;
    }
    const [x, y] = at(e);
    const g = groundAt(x, y);
    state.span = Math.max(SPAN_MIN_M, Math.min(SPAN_MAX_M, state.span * Math.exp(e.deltaY * 0.0015)));
    pinGround(g, x, y);
    syncInputs();
  }, { passive: false });

  document.addEventListener('paste', onPaste);
  initFly();
  const f = hashFly();
  if (f) flyTo(state.centre, f.alt, f.heading, f.pitch);
  startFromQuery();
  window.addEventListener('hashchange', () => {
    const f = hashFly();
    // leaving flight first: it hands its heading to the view's yaw, which the address then sets
    if (f === null) setFly(false);
    Object.assign(state, parseHash());
    if (f) flyTo(state.centre, f.alt, f.heading, f.pitch);
    syncInputs();
  });

  const grade = loadGrade();
  if (!isNeutralGrade(grade)) setGrade(grade, 'восстановлена сохранённая коррекция');
  syncInputs();
  requestAnimationFrame(frame);
}

/**
 * A view given in the page's query, to set beside a photograph taken from the same place:
 * ?fly=lat,lon,alt,heading,pitch starts free flight there (degrees; metres above sea level),
 * ?at=<ISO instant> puts the sun and the moon where they stood at that moment, and ?aod=<optical
 * depth> sets the haze to that day's aerosol (haze.ts; without it the game's default).
 */
function startFromQuery(): void {
  const q = new URLSearchParams(location.search);
  const f = (q.get('fly') ?? '').split(',').map(Number);
  if (f.length >= 3 && f.every(Number.isFinite) && Math.abs(f[0]) <= 85 && Math.abs(f[1]) <= 180) {
    flyTo({ lat: f[0], lon: f[1] }, f[2], f[3] ?? 0, f[4] ?? 0);
  }
  const at = new Date(q.get('at') ?? '');
  if (!Number.isNaN(at.getTime())) Object.assign(state, solarClock(at, state.centre.lon), { byTime: true });
  const aod = parseFloat(q.get('aod') ?? '');
  if (Number.isFinite(aod)) renderer.hazeDensity = hazeDensity({ aod });
}

init();
