import { mat4, vec3 } from 'gl-matrix';
import unsciiHex from '../assets/fonts/unscii-16.hex?raw';
import uaPatchHex from '../assets/fonts/unscii-16-ua-patch.hex?raw';
import { Renderer, type BaseGround } from './engine/renderer';
import { LANDSAT_ATTRIBUTION } from './world/landsat';
import { DEPTH_FAR } from './engine/shaders';
import { FontRenderer, HUD_AMBER, HUD_GREEN, parseHex } from './engine/font';
import { VectorRenderer } from './engine/vector';
import { BASE_LAND, FLASH_LIGHT, LUT_ENTRIES, RAMP, applyFlameColors, applySunColors, buildLUT, lightUniforms, paletteAt, type LightUniforms, type PaletteParams, shadeColour, snowy, sunColour, sunniness } from './engine/palette';
import { NO_RIM, rim, rimFrame, rimLab } from './engine/rim';
import { profiler } from './engine/profiler';
import { Input } from './engine/input';
import { ChunkManager, type CameraWorld } from './world/chunks';
import { OsmManager } from './world/osm-manager';
import { FarOsmManager } from './world/far-osm-manager';
import { farOsmTiles, OPENFREEMAP_ATTRIBUTION } from './world/far-osm';
import { enuToLatLon, latLonToEnu, tileCenter, type LatLon } from './world/geodesy';
import { GroundProbe, towerAnchor } from './world/ground';
import { buildSkyPoints, limitingMagnitude, PLANETS_OFFSET, planetPoints, skyMatrix, toGlMat3 } from './world/sky';
import { moonPosition, sunPosition } from './world/sun';
import { timeForPreset } from './world/time-of-day';
import { WEATHER_ATTRIBUTION, WeatherService, airConditions, type Weather } from './world/weather';
import { CLOUD_RGB, cloudLayers, type CloudInput } from './world/clouds';
import { CloudField } from './world/cloud-field';
import { AIRCRAFT, fitAircraft, type AircraftId } from './flight/aircraft';
import { FlightModel, type FlightControls } from './flight/model';
import { Autopilot } from './flight/autopilot';
import { Air } from './flight/air';
import { Controls, type Action } from './flight/controls';
import { CameraRig, type CameraMode } from './flight/cameras';
import { AircraftRenderer } from './flight/aircraft-renderer';
import { FlightAudio } from './flight/audio';
import { drawHud } from './flight/hud';
import { loadSettings, saveSettings } from './ui/settings';
import { Menu } from './ui/menu';
import { AIRFIELDS, Minimap } from './ui/minimap';
import { Telemetry, loadConsent, saveConsent } from './ui/telemetry';
import { t } from './ui/i18n';

interface Start {
  latLon: LatLon;
  /** undefined = Q41 air start; 0 = ground spawn; >0 = MSL altitude */
  alt?: number;
  hdg: number;
  aircraft: AircraftId;
  time?: Date;
  /** national markings and loadout ids (empty: the aircraft's defaults) */
  insignia?: string;
  loadout?: string;
}

/** Q18: #lat,lon,alt,hdg,aircraft,time,insignia,loadout — alt may be omitted for air start, the last three left empty. */
function parseStart(): Start {
  const fallback: Start = { latLon: { lat: 47.2603, lon: 11.3439 }, hdg: 0, aircraft: 'su27' };
  const hash = window.location.hash.slice(1);
  if (!hash) return fallback;
  const parts = hash.split(',');
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return fallback;
  const altRaw = parts[2]?.trim();
  const alt = altRaw ? Number(altRaw) : undefined;
  const hdg = Number(parts[3]);
  let time: Date | undefined;
  if (parts[5]) {
    const n = Number(parts[5]);
    time = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(parts[5]);
    if (Number.isNaN(time.getTime())) time = undefined;
  }
  return {
    latLon: { lat, lon },
    alt: alt !== undefined && Number.isFinite(alt) ? Math.max(0, alt) : undefined,
    hdg: Number.isFinite(hdg) ? hdg : 0,
    aircraft: parts[4] in AIRCRAFT ? (parts[4] as AircraftId) : 'su27',
    time,
    insignia: parts[6] || undefined,
    loadout: parts[7] || undefined,
  };
}

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const gl = renderer.gl;
const font = new FontRenderer(gl, parseHex(unsciiHex + '\n' + uaPatchHex));
const vectors = new VectorRenderer(gl);
const input = new Input(canvas);
const settings = loadSettings();
const controls = new Controls();
const audio = new FlightAudio();
audio.setMuted(!settings.sound);
renderer.setMsaa(settings.msaa);
renderer.setHdr(settings.hdr);
let consent = loadConsent();
const telemetry = new Telemetry(() => consent === 'yes', renderer);

const start = parseStart();
const cfg = fitAircraft(AIRCRAFT[start.aircraft], start.insignia, start.loadout);
const model = new FlightModel(cfg);
const rig = new CameraRig();
const aircraftRenderer = new AircraftRenderer(gl);
const chunks = new ChunkManager(gl, start.latLon);
const osm = new OsmManager(gl, start.latLon);
const farOsm = new FarOsmManager(gl, start.latLon);
const clouds = new CloudField(gl, start.latLon);
const ground = new GroundProbe(() => chunks.origin);
const camWorld: CameraWorld = {
  pos: model.pos, // shared reference: rebase zeroes the model position in place
  latLon: start.latLon,
  alt: start.alt ?? 1500,
  velocity: model.vel,
};

/** live weather at the aircraft; ?temp=-20 in the URL forces the temperature (winter looks anywhere) */
const weather = new WeatherService();
{
  const forced = new URLSearchParams(window.location.search).get('temp');
  if (forced !== null && forced.trim() !== '' && Number.isFinite(Number(forced))) weather.tempOverride = Number(forced);
}
/** ?wind=270,12,18 forces the surface wind: from (deg true), speed and optional gust in m/s */
const windOverride = ((): { from: number; ms: number; gust: number } | undefined => {
  const raw = new URLSearchParams(window.location.search).get('wind');
  if (!raw) return undefined;
  const [from, ms, gust] = raw.split(',').map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(ms) || ms < 0) return undefined;
  return { from, ms, gust: Number.isFinite(gust) ? Math.max(ms, gust) : ms };
})();
/**
 * ?clouds=80 forces the total cloud cover in % (how sunny the day looks, palette.ts sunniness, and
 * one low cloud layer of that cover); ?clouds=80,900 also puts its base 900 m above the ground
 */
const [cloudsOverride, cloudBaseOverride] = ((): [number | undefined, number | undefined] => {
  const raw = new URLSearchParams(window.location.search).get('clouds');
  if (raw === null || raw.trim() === '') return [undefined, undefined];
  const [pct, base] = raw.split(',').map((v) => (v.trim() === '' ? NaN : Number(v)));
  if (!Number.isFinite(pct)) return [undefined, undefined];
  return [Math.max(0, Math.min(100, pct)), Number.isFinite(base) ? Math.max(50, base) : undefined];
})();
/** what the clouds are made from: the live weather's layers, or one forced layer (?clouds=) */
function cloudInput(): CloudInput | undefined {
  const w = weather.current;
  const elevation = w?.elevation ?? Math.max(0, ground.heightAt(camWorld.latLon.lon, camWorld.latLon.lat) ?? 0);
  if (cloudsOverride !== undefined) {
    return { cloudPct: cloudsOverride, tempC: w?.tempC, dewPointC: w?.dewPointC, elevation, baseAgl: cloudBaseOverride };
  }
  return w ? { ...w, elevation } : undefined;
}
/** the weather in force: live data with the URL overrides applied (shown on the HUD, flown through) */
let inForceFor: Weather | undefined | null = null;
let inForce: Weather | undefined;
function weatherInForce(): Weather | undefined {
  const w = weather.current;
  if (!windOverride && cloudsOverride === undefined) return w;
  if (w !== inForceFor) {
    inForceFor = w;
    const cloudPct = cloudsOverride ?? w?.cloudPct ?? 0;
    inForce = !windOverride
      ? (w ? { ...w, cloudPct } : undefined)
      : {
        tempC: w?.tempC ?? weather.tempOverride ?? 15, cloudPct, elevation: w?.elevation, pressureHpa: w?.pressureHpa,
        at: w?.at ?? start.latLon, time: w?.time ?? Date.now(),
        // a forced wind replaces the whole column: the measured winds aloft no longer belong to it
        windFromDeg: windOverride.from, windMs: windOverride.ms, gustMs: windOverride.gust, levels: [],
      };
  }
  return inForce;
}
/** the air the flight model flies through: wind, temperature and pressure by height from the weather */
const air = new Air();
let airSource: Weather | undefined;
let airForced = false;

let simTime = start.time ?? new Date();
let sun = sunPosition(simTime, start.latLon);
let moon = moonPosition(simTime, start.latLon);
const sunDir = vec3.clone(sun.dir);
const moonDir = vec3.clone(moon.dir);
/** direction the terrain is shaded from: the sun by day, the moon (weighted by phase) when the sun is down */
const lightDir = vec3.clone(sunDir);
/** distance fog of every world pass, m */
const FOG_START_M = 15000;
const FOG_END_M = 55000;
/** the base ground's height and kind from the last known DEM under the camera (land at 0 m until known) */
let baseY = 0;
let baseSea = false;
/**
 * The base ground under the tiles (renderer.drawSky): at the height of the ground beneath the
 * camera, sea where that is at or below sea level, else land; it fills the view to the horizon
 * before the tiles load and wherever one is missing.
 */
function baseGround(camY: number): BaseGround {
  const h = ground.heightAt(camWorld.latLon.lon, camWorld.latLon.lat);
  if (h !== undefined) {
    baseY = Math.max(0, h);
    baseSea = h <= 0;
  }
  // the nearest overcast deck above and below the camera carries on past its tiles to the horizon
  let up = 0, down = 0;
  for (const l of clouds.current) {
    if (l.kind !== 'deck') continue;
    if (l.base > camY && (up === 0 || l.base - camY < up)) up = l.base - camY;
    if (l.top < camY && (down === 0 || camY - l.top < down)) down = camY - l.top;
  }
  return {
    y: baseY, ramp: baseSea ? RAMP.SEA : snowy(BASE_LAND), fogStart: FOG_START_M, fogEnd: FOG_END_M,
    deck: { up, down, colour: CLOUD_RGB },
  };
}
let sunLoc: LatLon = start.latLon;
/** the sun is rising (morning colours) when it stands higher a minute later */
const sunRising = (): boolean => sunPosition(new Date(simTime.getTime() + 60000), sunLoc).elevationDeg > sun.elevationDeg;
/** how sunny the weather in force is (palette.ts sunniness) */
const sunnyNow = () => sunniness(cloudsOverride ?? weatherInForce()?.cloudPct);
/** day palette for the sun now and the weather in force: sunnier the clearer the sky, cool colours in the morning */
const dayPalette = () => paletteAt(sun.elevationDeg, sunnyNow(), sunRising());
/** the moon's light on faces: by its elevation and phase, once the sun no longer lights them */
const moonLight = (): number =>
  Math.max(0, Math.min(1, moon.elevationDeg / 10)) * moon.illumination * (1 - Math.max(0, Math.min(1, (sun.elevationDeg + 4) / 6)));
/** light uniforms of a palette; frozen water has no waves, glints or glitter path */
function lightOf(p: PaletteParams): LightUniforms {
  const l = lightUniforms(p, sunnyNow());
  l.direct[1] = moonLight();
  if (weather.surface.ice) l.glitter[0] = l.glitter[7] = 0;
  return l;
}
let palette = dayPalette();
let lut = buildLUT(palette, weather.surface);
let light = lightOf(palette);
applySunColors(lut, sun.elevationDeg);
const flashLut = new Uint8Array(LUT_ENTRIES * 4).fill(255);
let lastSunUpdate = 0;
/** stars and planets: J2000 → world directions this frame, and the planets refreshed with the light */
const skyMat = new Float32Array(9);
const planetBuf = planetPoints(simTime);
renderer.setSkyPoints(buildSkyPoints());
renderer.setSkyPoints(planetBuf, PLANETS_OFFSET);
/** whether the current LUT was built with frozen water */
let lutIce = weather.surface.ice;
let previewKey = '';

function updateLight(): void {
  sun = sunPosition(simTime, sunLoc);
  moon = moonPosition(simTime, sunLoc);
  vec3.copy(sunDir, sun.dir);
  vec3.copy(moonDir, moon.dir);
  const sw = Math.max(0, Math.min(1, (sun.elevationDeg + 4) / 6));
  const mw = Math.max(0, Math.min(1, moon.elevationDeg / 10)) * moon.illumination * (1 - sw);
  if (sw + mw < 1e-3) {
    vec3.copy(lightDir, sunDir);
  } else {
    vec3.set(
      lightDir,
      sunDir[0] * sw + moonDir[0] * mw,
      sunDir[1] * sw + moonDir[1] * mw,
      sunDir[2] * sw + moonDir[2] * mw,
    );
    vec3.normalize(lightDir, lightDir);
  }
  renderer.setSkyPoints(planetPoints(simTime, planetBuf), PLANETS_OFFSET);
  palette = dayPalette();
  lut = buildLUT(palette, weather.surface);
  light = lightOf(palette);
  applySunColors(lut, sun.elevationDeg);
}

function startLocation(fc: { location: string; customPoint: LatLon | null }): LatLon {
  const af = AIRFIELDS.find((a) => a.icao === fc.location);
  return fc.location === 'custom' && fc.customPoint ? fc.customPoint : af ?? start.latLon;
}

// Q40: a fresh runway tile invalidates nearby terrain so flattening is applied
osm.onTileReady = (tile, runways, coast) => {
  // runways flatten the terrain and the OSM coastline reshapes the shore: rebuild with the OSM
  if (runways > 0) chunks.invalidateNear(tileCenter(tile), 2500, 12);
  else if (coast) chunks.invalidate(tile); // only this tile's shore changes
};

type SimState = 'menu' | 'loading' | 'flying' | 'paused' | 'crashed';
const hasHash = window.location.hash.length > 1;
let state: SimState = consent !== null && hasHash ? 'loading' : 'menu';
let spawned = false;
let crashTime = 0;
const crashPos = vec3.create();
const towerPos = vec3.create();

const unlock = (): void => audio.unlock();
window.addEventListener('keydown', unlock);
window.addEventListener('mousedown', unlock);

function spawn(): void {
  const groundH = Math.max(0, ground.heightAt(start.latLon.lon, start.latLon.lat) ?? 0);
  const [e, n] = latLonToEnu(chunks.origin, start.latLon.lat, start.latLon.lon, 0);
  if (start.alt === 0) {
    model.spawnGround(vec3.fromValues(e, groundH + cfg.gearHeight, -n), start.hdg, groundH);
  } else {
    const alt = start.alt ?? groundH + 1500;
    model.spawnAir(vec3.fromValues(e, alt, -n), start.hdg);
  }
  camWorld.alt = model.pos[1];
  rig.setMode('cockpit', model);
  spawned = true;
}

function respawn(): void {
  spawned = false;
  state = 'loading';
  menu.screen = 'none';
  controls.throttle = 0;
  model.crashed = false;
  model.crashReason = '';
}

const menu = new Menu(font, vectors, settings, {
  onFly: (fc) => {
    const af = AIRFIELDS.find((a) => a.icao === fc.location);
    const ll = startLocation(fc);
    const alt = fc.startMode === 'runway' ? '0' : '';
    // 'real' leaves the time field empty so a reload always starts at the current clock
    const when = fc.timeOfDay === 'real' ? '' : Math.floor(timeForPreset(fc.timeOfDay, ll, new Date()).getTime() / 1000);
    window.location.hash = `${ll.lat.toFixed(5)},${ll.lon.toFixed(5)},${alt},${af?.hdg ?? 0},${fc.aircraft},${when},${fc.insignia},${fc.loadout}`;
    window.location.reload();
  },
  onConsent: (allow) => {
    saveConsent(allow);
    consent = allow ? 'yes' : 'no';
    if (hasHash) {
      state = 'loading';
      menu.screen = 'none';
    } else {
      menu.screen = 'start';
    }
  },
  onResume: () => { state = 'flying'; menu.screen = 'none'; },
  onRestart: () => respawn(),
  onNewPoint: () => {
    window.location.hash = '';
    window.location.reload();
  },
  onSettingsChanged: () => {
    audio.setMuted(!settings.sound);
    renderer.setMsaa(settings.msaa);
    renderer.setHdr(settings.hdr);
  },
});
if (state === 'menu') menu.screen = consent === null ? 'consent' : 'start';

// a map link pasted on the start screen sets the custom start point (same parser as the inspector)
document.addEventListener('paste', (e) => {
  if (state !== 'menu') return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (menu.pasteLink(text)) e.preventDefault();
});

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sim = {
    renderer, chunks, osm, farOsm, clouds, font, vectors, model, rig, ground, controls, settings, audio, sunDir, moonDir, camWorld, menu, weather, air,
    get state() { return state; },
    get simTime() { return simTime; },
    get palette() { return palette; },
    get consent() { return consent; },
    respawn,
  };
}

if (rimLab.active) profiler.enable(gl);

const camActions: [Action, CameraMode][] = [
  ['camCockpit', 'cockpit'], ['camOrbit', 'orbit'], ['camChase', 'chase'],
  ['camFlyby', 'flyby'], ['camTower', 'tower'], ['camTarget', 'target'],
];

let last = performance.now();
const autopilot = new Autopilot();
autopilot.groundAt = (x, z) => {
  const ll = enuToLatLon(chunks.origin, x, -z, 0);
  return Math.max(0, ground.heightAt(ll.lon, ll.lat) ?? 0);
};
let apOn = false;
const flightMap = new Minimap();
const FLIGHT_MAP_SPAN_M = 40000;
let landingField: (typeof AIRFIELDS)[number] | null = null;
let fpsAvg = 60;
let lastUrlUpdate = 0;
let prevGear = true;
let prevFlaps = false;
let prevTouchdown = 0;
const proj = mat4.create();
const crashView = mat4.create();
const crashCamPos = vec3.create();
const menuView = mat4.create();
const menuCamPos = vec3.create();
const menuTarget = vec3.create();

function frame(now: number): void {
  requestAnimationFrame(frame); // scheduled first: a bad frame must not kill the loop
  profiler.frameStart(now);
  profiler.stage('управление и физика');
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dt > 0) fpsAvg += (1 / dt - fpsAvg) * 0.05;

  renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  mat4.perspective(proj, (60 * Math.PI) / 180, renderer.width / renderer.height, 0.5, DEPTH_FAR);
  font.setScreenSize(renderer.width, renderer.height);
  vectors.setScreenSize(renderer.width, renderer.height);

  let flight: FlightControls = controls.update(dt, input, settings, canvas.clientWidth, canvas.clientHeight);
  if (controls.justPressed('autopilot') && state === 'flying') {
    apOn = !apOn;
    if (apOn) autopilot.engage(model);
    else autopilot.stopLanding();
  }
  // L: autoland on the nearest reference airfield (within 80 km), approaching along its runway heading
  if (controls.justPressed('autoland') && state === 'flying' && !model.onGround) {
    let best: (typeof AIRFIELDS)[number] | null = null;
    let bestD = 80000;
    for (const af of AIRFIELDS) {
      const [e, n] = latLonToEnu(chunks.origin, af.lat, af.lon, 0);
      const d = Math.hypot(e - model.pos[0], -n - model.pos[2]);
      if (d < bestD) { bestD = d; best = af; }
    }
    if (best) {
      const [e, n] = latLonToEnu(chunks.origin, best.lat, best.lon, 0);
      landingField = best;
      autopilot.startLanding(model, e, -n, best.hdg);
      apOn = true;
    }
  }
  if (apOn && autopilot.landing && landingField) {
    const [e, n] = latLonToEnu(chunks.origin, landingField.lat, landingField.lon, 0);
    autopilot.moveThreshold(e, -n);
    if (autopilot.landing === 'rollout' && model.onGround && model.speed < 1) {
      apOn = false;
      autopilot.stopLanding();
    }
  }
  // stick deflection by the pilot takes over; the autopilot only flies hands-off
  const landingRoll = autopilot.landing === 'rollout';
  if (apOn && (Math.abs(flight.pitch) > 0.25 || Math.abs(flight.roll) > 0.25 || state !== 'flying' || (model.onGround && !landingRoll))) {
    apOn = false;
    autopilot.stopLanding();
  }
  if (apOn) {
    flight = autopilot.update(dt, model, flight);
    controls.syncSystems(flight.gearDown, flight.flaps);
  }
  if (menu.screen === 'none') {
    input.consumeClick(); // flight drags must not fire menu buttons later
    input.consumeKey();
  }

  if (controls.justPressed('mute')) {
    settings.sound = !settings.sound;
    audio.setMuted(!settings.sound);
    saveSettings(settings);
  }
  for (const [action, mode] of camActions) {
    if (controls.justPressed(action) && state === 'flying') rig.setMode(mode, model);
  }
  if (controls.justPressed('pause') && spawned && (state === 'flying' || state === 'paused')) {
    if (menu.screen === 'settings') menu.screen = 'pause';
    else if (state === 'paused') { state = 'flying'; menu.screen = 'none'; }
    else { state = 'paused'; menu.screen = 'pause'; }
  }
  if (state === 'crashed') {
    if (controls.justPressed('restart')) respawn();
    if (controls.justPressed('newPoint')) {
      window.location.hash = '';
      window.location.reload();
    }
    // respawn() leaves 'crashed' state; without this check the crash screen reappeared blank over the new flight
    if (state === 'crashed' && now - crashTime > 1000 && menu.screen !== 'crashed') {
      menu.crashReason = model.crashReason;
      menu.screen = 'crashed';
    }
  }

  if (rimLab.time) {
    simTime = rimLab.time;
    rimLab.time = undefined;
    lastSunUpdate = 0;
  }
  if (state === 'flying' && spawned && !rimLab.frozen) {
    // feed the air model whenever new weather arrives; until then it is the calm standard atmosphere
    const wNow = weatherInForce();
    if (wNow !== airSource && (wNow !== undefined || !airForced)) {
      if (wNow) {
        airSource = wNow;
        air.set(airConditions(wNow, weather.tempOverride, Math.max(0, ground.heightAt(wNow.at.lon, wNow.at.lat) ?? 0)));
      } else if (weather.tempOverride !== undefined) {
        // no data yet but a forced temperature: still air at that temperature
        airForced = true;
        const elevation = Math.max(0, ground.heightAt(camWorld.latLon.lon, camWorld.latLon.lat) ?? 0);
        air.set({ elevation, tempC: weather.tempOverride, windFromDeg: 0, windMs: 0, gustMs: 0 });
      }
    }
    const damageBefore = model.damage.length;
    model.update(dt, flight, (p) => ground.probe(p), air);
    if (model.damage.length > damageBefore) {
      audio.touchdown(true); // the bang of a part letting go
    }
    simTime = new Date(simTime.getTime() + dt * 1000 * menu.config.timeAccel);
    if (flight.gearDown !== prevGear || flight.flaps !== prevFlaps) audio.gear();
    prevGear = flight.gearDown;
    prevFlaps = flight.flaps;
    if (model.touchdownTimer > 0 && prevTouchdown <= 0) audio.touchdown(model.touchdownSink > 2.5);
    prevTouchdown = model.touchdownTimer;
    if (model.crashed) {
      state = 'crashed';
      crashTime = now;
      vec3.copy(crashPos, model.pos);
      audio.crash();
      telemetry.report({ kind: 'crash', reason: model.crashReason, aircraft: cfg.id });
    }
    // keep inside the Mercator-valid band
    if (Math.abs(camWorld.latLon.lat) > 85) {
      const ll = { lat: Math.sign(camWorld.latLon.lat) * 85, lon: camWorld.latLon.lon };
      const [e, n] = latLonToEnu(chunks.origin, ll.lat, ll.lon, 0);
      model.pos[0] = e;
      model.pos[2] = -n;
      model.vel[0] = 0;
      model.vel[2] = 0;
    }
  }
  if (spawned) audio.update(model, flight, now / 1000);

  camWorld.latLon = enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], model.pos[1]);
  camWorld.alt = model.pos[1];
  if (chunks.rebaseIfNeeded(camWorld)) {
    camWorld.latLon = enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], model.pos[1]);
  }
  ground.update(camWorld.latLon, now);

  // OSM is not a spawn gate: an Overpass outage must not ground the sim
  if (state === 'loading' && !spawned && chunks.nearReady(camWorld.latLon, 3000) && ground.ready) {
    spawn();
    state = 'flying';
  }

  const anchor = towerAnchor(camWorld.latLon);
  const [te, tn] = latLonToEnu(chunks.origin, anchor.lat, anchor.lon, 0);
  vec3.set(towerPos, te, (ground.heightAt(anchor.lon, anchor.lat) ?? 0) + 2, -tn);

  let view: mat4;
  let camPos: vec3;
  if (state === 'menu') {
    // slow orbit over the start area as a live backdrop for the menus
    const a = now * 0.00004;
    const gy = ground.heightAt(start.latLon.lon, start.latLon.lat) ?? 500;
    vec3.set(menuTarget, 0, gy, 0);
    vec3.set(menuCamPos, Math.cos(a) * 3200, gy + 2200, Math.sin(a) * 3200);
    mat4.lookAt(menuView, menuCamPos, menuTarget, vec3.fromValues(0, 1, 0));
    view = menuView;
    camPos = menuCamPos;
  } else if (state === 'crashed') {
    const t = (now - crashTime) / 1000;
    const a = t * 0.3;
    vec3.set(crashCamPos, crashPos[0] + Math.cos(a) * 90, crashPos[1] + 35, crashPos[2] + Math.sin(a) * 90);
    const cll = enuToLatLon(chunks.origin, crashCamPos[0], -crashCamPos[2], crashCamPos[1]);
    const gh = ground.heightAt(cll.lon, cll.lat);
    if (gh !== undefined) crashCamPos[1] = Math.max(crashCamPos[1], gh + 25);
    mat4.lookAt(crashView, crashCamPos, crashPos, vec3.fromValues(0, 1, 0));
    view = crashView;
    camPos = crashCamPos;
  } else {
    rig.update(model, state === 'paused' ? 0 : dt, input, towerPos);
    view = rig.view;
    camPos = rig.pos;
  }

  profiler.stage('тайлы: выбор и загрузка');
  // a detailed (z14) tile is shown only once its OSM is ready; until then its coarse parent stands in
  chunks.update(camWorld, view, proj, now, (key) => osm.ready(key));
  osm.update(camWorld, view, proj, now, chunks.origin, chunks.detailTiles, chunks.shownDetail);
  const detailKeys = new Set(chunks.detailTiles.map((t) => `${t.z}/${t.x}/${t.y}`));
  farOsm.update(camWorld, view, proj, now, chunks.origin, farOsmTiles(camWorld.latLon, camWorld.alt, detailKeys), chunks.shownDetail);

  profiler.stage('облака: тайлы');
  clouds.setLayers(cloudLayers(cloudInput()));
  // the clouds drift with the wind at their height (the clock runs as fast as the sim's)
  const cloudDt = state === 'flying' && !rimLab.frozen ? dt * menu.config.timeAccel : state === 'menu' ? dt : 0;
  if (cloudDt > 0) clouds.advance(cloudDt, (alt) => air.meanWind(alt, alt - air.surfaceElevation));
  const camLatLon = enuToLatLon(chunks.origin, camPos[0], -camPos[2], camPos[1]);
  clouds.update(camLatLon, chunks.origin, view, proj);

  profiler.stage('солнце, погода, палитра');
  if (state === 'menu' && menu.screen === 'start') {
    // live backdrop follows the chosen place and time of day
    const ll = startLocation(menu.config);
    const key = `${menu.config.timeOfDay}|${ll.lat}|${ll.lon}`;
    if (key !== previewKey) {
      previewKey = key;
      simTime = timeForPreset(menu.config.timeOfDay, ll, new Date());
      sunLoc = ll;
      lastSunUpdate = 0;
    }
  } else {
    sunLoc = camWorld.latLon;
  }
  weather.update(sunLoc, now);
  const surface = weather.surface;
  if (surface.ice !== lutIce) lastSunUpdate = 0; // rebuild the LUT now: water freezes or thaws
  // fast clocks need a finer refresh than the 1 s default or the sky visibly steps
  if (now - lastSunUpdate > (menu.config.timeAccel > 1 && state === 'flying' ? 100 : 1000)) {
    lastSunUpdate = now;
    updateLight();
    lutIce = surface.ice;
  }
  if (menu.screen === 'pause') {
    const hh = simTime.toISOString().slice(0, 16).replace('T', ' ');
    menu.clockText = `${hh} UTC  SUN ${Math.round(sun.elevationDeg)}\u00B0  MOON ${Math.round(moon.illumination * 100)}% ${Math.round(moon.elevationDeg)}\u00B0`;
  }
  const flashing = state === 'crashed' && now - crashTime < 150;
  const u = Math.max(1, Math.round(window.devicePixelRatio || 1));
  profiler.stage('начало кадра: LUT, очистка');
  applyFlameColors(lut, now / 1000);
  renderer.beginFrame(flashing ? flashLut : lut, flashing ? FLASH_LIGHT : light);
  const lightsOn = sun.elevationDeg < 2;
  renderer.nightGlow = lightsOn;
  renderer.time = now / 1000;
  renderer.snow = surface.snow;
  renderer.rim = flashing ? NO_RIM : rimFrame(rim, palette, sunColour(sun.elevationDeg), sun.elevationDeg);
  profiler.stage('небо');
  renderer.drawSky(view, proj, camPos, sunDir, moonDir, baseGround(camPos[1]));
  if (!flashing) {
    toGlMat3(skyMatrix(simTime, sunLoc), skyMat);
    renderer.drawStars(skyMat, limitingMagnitude(sun.elevationDeg, moon.elevationDeg, moon.illumination), u);
  }
  renderer.rimWeight = rim.terrain;
  profiler.stage('рельеф');
  chunks.draw(renderer, view, proj, camPos, lightDir, FOG_START_M, FOG_END_M);
  renderer.rimWeight = rim.objects;
  renderer.rimTreeWeight = rim.trees;
  profiler.stage('OSM: здания, дороги, вода, деревья, огни');
  osm.draw(renderer, view, proj, camPos, lightDir, FOG_START_M, FOG_END_M, lightsOn, 3 * u);
  farOsm.draw(renderer, view, proj, camPos, lightsOn, 3 * u);
  profiler.stage('облака');
  clouds.draw(renderer, view, proj, camPos, lightDir, FOG_START_M, FOG_END_M);
  renderer.rimWeight = rim.aircraft;
  profiler.stage('самолёт');
  if (rig.mode !== 'cockpit' && state !== 'crashed' && spawned) {
    aircraftRenderer.draw(renderer, model, view, proj, camPos, lightDir, flight.throttle, now / 1000);
  }

  // inside a cloud: white out (not in the menu backdrop, whose orbit may cut through one)
  if (state !== 'menu' && !flashing) {
    const veil = clouds.density(camLatLon, camPos[1]);
    if (veil > 0) {
      const c = shadeColour([(CLOUD_RGB >> 16) & 255, (CLOUD_RGB >> 8) & 255, CLOUD_RGB & 255], 8, palette);
      renderer.drawVeil(veil, [c[0] / 255, c[1] / 255, c[2] / 255]);
    }
  }
  profiler.stage('пост-проход: силуэт, MSAA');
  renderer.beginOverlay();
  profiler.stage('HUD, меню, карта');
  const pad = 8 * u;
  if (spawned && state === 'flying' && rimLab.hud) {
    drawHud(font, vectors, renderer.width, renderer.height, u, {
      model, controls: flight, camera: rig.mode, units: settings.units, now: now / 1000, soundOn: settings.sound, autopilot: apOn ? { ...autopilot.targets, mode: autopilot.landing ?? undefined } : null,
      weather: { data: weatherInForce(), tempC: weather.tempC },
    });
    // simple north-up minimap, bottom-left: terrain, reference airfields, own aircraft with heading
    const mapSize = Math.round(Math.min(renderer.width, renderer.height) * 0.22);
    const mapY = renderer.height - 68 * u - mapSize; // above the HUD throttle line at h - 60u
    const own = enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], 0);
    flightMap.lang = settings.lang;
    flightMap.follow(own, FLIGHT_MAP_SPAN_M);
    flightMap.draw(vectors, font, pad, mapY, mapSize, u, own, model.headingDeg);
    font.text(`N  ${FLIGHT_MAP_SPAN_M / 1000} KM`, pad, mapY - 18 * u, u, HUD_GREEN);
  }
  if (!spawned && state === 'loading') {
    const msg = t(settings.lang, 'loading');
    font.text(msg, (renderer.width - font.measure(msg, u * 2)) / 2, renderer.height / 2, u * 2, HUD_AMBER);
  }
  if (menu.screen !== 'none') {
    menu.draw(renderer.width, renderer.height, u, canvas.clientWidth, canvas.clientHeight, input, spawned ? camWorld.latLon : undefined);
  }
  if (import.meta.env.DEV && rimLab.hud) {
    const st = chunks.stats;
    const os = osm.stats;
    const fs = farOsm.stats;
    font.text(
      `FPS ${Math.round(fpsAvg)}  DRAW ${st.drawCalls + os.drawCalls + farOsm.drawCalls + clouds.drawCalls}  BUF ${st.gpuBuffers}  OSM ERR ${os.errors}  FAR ${fs.ready}/${fs.chunks}  ${state.toUpperCase()}`,
      // a row above the attribution (which fills the bottom row) and below the throttle readout
      pad, renderer.height - pad - 34 * u, u, HUD_GREEN,
    );
  }
  const attr = `© OpenStreetMap contributors · ${OPENFREEMAP_ATTRIBUTION} · ${LANDSAT_ATTRIBUTION} · ${WEATHER_ATTRIBUTION}`;
  font.text(attr, renderer.width - font.measure(attr, u) - pad, renderer.height - pad - 16 * u, u, HUD_GREEN);
  font.flush();
  vectors.flush();
  profiler.stage('вывод на экран');
  renderer.resolve();
  profiler.end();
  telemetry.tick(now, fpsAvg, chunks.stats.drawCalls + osm.stats.drawCalls + farOsm.drawCalls);

  if (spawned && state === 'flying' && !rimLab.active && now - lastUrlUpdate > 1000) {
    lastUrlUpdate = now;
    const ll = camWorld.latLon;
    history.replaceState(
      null, '',
      `#${ll.lat.toFixed(5)},${ll.lon.toFixed(5)},${Math.round(model.pos[1])},${Math.round(model.headingDeg)},${cfg.id},${Math.floor(simTime.getTime() / 1000)},${cfg.insigniaId ?? ''},${cfg.loadoutId ?? ''}`,
    );
  }
  profiler.frameEnd();
}

requestAnimationFrame(frame);