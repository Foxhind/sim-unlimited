import { mat4, vec3 } from 'gl-matrix';
import unsciiHex from '../assets/fonts/unscii-16.hex?raw';
import uaPatchHex from '../assets/fonts/unscii-16-ua-patch.hex?raw';
import { Renderer } from './engine/renderer';
import { FontRenderer, HUD_AMBER, HUD_GREEN, parseHex } from './engine/font';
import { VectorRenderer } from './engine/vector';
import { buildLUT, paletteAt } from './engine/palette';
import { Input } from './engine/input';
import { ChunkManager, type CameraWorld } from './world/chunks';
import { OsmManager } from './world/osm-manager';
import { enuToLatLon, latLonToEnu, tileCenter, type LatLon } from './world/geodesy';
import { GroundProbe, towerAnchor } from './world/ground';
import { sunPosition } from './world/sun';
import { AIRCRAFT } from './flight/aircraft';
import { FlightModel, type FlightControls } from './flight/model';
import { Controls, type Action } from './flight/controls';
import { CameraRig, type CameraMode } from './flight/cameras';
import { AircraftRenderer } from './flight/aircraft-renderer';
import { FlightAudio } from './flight/audio';
import { drawHud } from './flight/hud';
import { loadSettings, saveSettings } from './ui/settings';

interface Start {
  latLon: LatLon;
  /** undefined = Q41 air start; 0 = ground spawn; >0 = MSL altitude */
  alt?: number;
  hdg: number;
  aircraft: 'su27' | 'f117';
  time?: Date;
}

/** Q18: #lat,lon,alt,hdg,aircraft,time — alt may be omitted for air start. */
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
    aircraft: parts[4] === 'f117' ? 'f117' : 'su27',
    time,
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

const start = parseStart();
const cfg = AIRCRAFT[start.aircraft];
const model = new FlightModel(cfg);
const rig = new CameraRig();
const aircraftRenderer = new AircraftRenderer(gl);
const chunks = new ChunkManager(gl, start.latLon);
const osm = new OsmManager(gl, start.latLon);
const ground = new GroundProbe(() => chunks.origin);
const camWorld: CameraWorld = {
  pos: model.pos, // shared reference: rebase zeroes the model position in place
  latLon: start.latLon,
  alt: start.alt ?? 1500,
  velocity: model.vel,
};

let simTime = start.time ?? new Date();
let sun = sunPosition(simTime, start.latLon);
const sunDir = vec3.clone(sun.dir);
let lut = buildLUT(paletteAt(sun.elevationDeg));
const flashLut = new Uint8Array(256 * 3).fill(255);
let lastSunUpdate = 0;

// Q40: a fresh runway tile invalidates nearby terrain so flattening is applied
osm.onTileReady = (tile, detail, runways) => {
  if (detail === 'full' && runways > 0) chunks.invalidateNear(tileCenter(tile), 2500, 12);
};

type SimState = 'loading' | 'flying' | 'paused' | 'crashed';
let state: SimState = 'loading';
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
  controls.throttle = 0;
  model.crashed = false;
  model.crashReason = '';
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sim = {
    renderer, chunks, osm, font, vectors, model, rig, ground, controls, settings, audio, sunDir, camWorld,
    get state() { return state; },
    get simTime() { return simTime; },
    respawn,
  };
}

const camActions: [Action, CameraMode][] = [
  ['camCockpit', 'cockpit'], ['camOrbit', 'orbit'], ['camChase', 'chase'],
  ['camFlyby', 'flyby'], ['camTower', 'tower'], ['camTarget', 'target'],
];

let last = performance.now();
let fpsAvg = 60;
let lastUrlUpdate = 0;
let prevGear = true;
let prevFlaps = false;
let prevTouchdown = 0;
const proj = mat4.create();
const crashView = mat4.create();
const crashCamPos = vec3.create();

function frame(now: number): void {
  requestAnimationFrame(frame); // scheduled first: a bad frame must not kill the loop
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dt > 0) fpsAvg += (1 / dt - fpsAvg) * 0.05;

  renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  mat4.perspective(proj, (60 * Math.PI) / 180, renderer.width / renderer.height, 0.5, 200000);
  font.setScreenSize(renderer.width, renderer.height);
  vectors.setScreenSize(renderer.width, renderer.height);

  const flight: FlightControls = controls.update(dt, input, settings, canvas.clientWidth, canvas.clientHeight);

  if (controls.justPressed('mute')) {
    settings.sound = !settings.sound;
    audio.setMuted(!settings.sound);
    saveSettings(settings);
  }
  for (const [action, mode] of camActions) {
    if (controls.justPressed(action) && spawned && state !== 'crashed') rig.setMode(mode, model);
  }
  if (controls.justPressed('pause') && spawned && state !== 'crashed') {
    state = state === 'paused' ? 'flying' : 'paused';
  }
  if (state === 'crashed') {
    if (controls.justPressed('restart')) respawn();
    if (controls.justPressed('newPoint')) {
      window.location.hash = '';
      window.location.reload();
    }
  }

  if (state === 'flying' && spawned) {
    model.update(dt, flight, (p) => ground.probe(p));
    simTime = new Date(simTime.getTime() + dt * 1000);
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
  if (!spawned && chunks.nearReady(camWorld.latLon, 3000) && ground.ready) {
    spawn();
    state = 'flying';
  }

  const anchor = towerAnchor(camWorld.latLon);
  const [te, tn] = latLonToEnu(chunks.origin, anchor.lat, anchor.lon, 0);
  vec3.set(towerPos, te, (ground.heightAt(anchor.lon, anchor.lat) ?? 0) + 2, -tn);

  let view: mat4;
  let camPos: vec3;
  if (state === 'crashed') {
    const t = (now - crashTime) / 1000;
    const a = t * 0.3;
    vec3.set(crashCamPos, crashPos[0] + Math.cos(a) * 90, crashPos[1] + 35, crashPos[2] + Math.sin(a) * 90);
    mat4.lookAt(crashView, crashCamPos, crashPos, vec3.fromValues(0, 1, 0));
    view = crashView;
    camPos = crashCamPos;
  } else {
    rig.update(model, state === 'paused' ? 0 : dt, input, towerPos);
    view = rig.view;
    camPos = rig.pos;
  }

  chunks.update(camWorld, view, proj, now);
  osm.update(camWorld, view, proj, now, chunks.origin);

  if (now - lastSunUpdate > 1000) {
    lastSunUpdate = now;
    sun = sunPosition(simTime, camWorld.latLon);
    vec3.copy(sunDir, sun.dir);
    lut = buildLUT(paletteAt(sun.elevationDeg));
  }
  const flashing = state === 'crashed' && now - crashTime < 150;
  renderer.beginFrame(flashing ? flashLut : lut);
  renderer.drawSky(view, proj, camPos, sunDir);
  chunks.draw(renderer, view, proj, camPos, sunDir, 15000, 55000);
  osm.draw(renderer, view, proj, camPos, sunDir, 15000, 55000);
  if (rig.mode !== 'cockpit' && state !== 'crashed' && spawned) {
    aircraftRenderer.draw(renderer, model, view, proj, camPos, sunDir);
  }

  renderer.beginOverlay();
  const u = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const pad = 8 * u;
  if (spawned && state !== 'crashed') {
    drawHud(font, vectors, renderer.width, renderer.height, u, {
      model, controls: flight, camera: rig.mode, units: settings.units, now: now / 1000, soundOn: settings.sound,
    });
  }
  if (!spawned) {
    const msg = 'LOADING TERRAIN + OSM...';
    font.text(msg, (renderer.width - font.measure(msg, u * 2)) / 2, renderer.height / 2, u * 2, HUD_AMBER);
  }
  if (state === 'paused') {
    const msg = 'PAUSED';
    font.text(msg, (renderer.width - font.measure(msg, u * 3)) / 2, renderer.height * 0.4, u * 3, HUD_AMBER);
    const sub = 'ESC RESUME';
    font.text(sub, (renderer.width - font.measure(sub, u)) / 2, renderer.height * 0.4 + 40 * u, u, HUD_GREEN);
  }
  if (state === 'crashed' && now - crashTime > 1000) {
    const msg = `CRASH: ${model.crashReason}`;
    font.text(msg, (renderer.width - font.measure(msg, u * 2)) / 2, renderer.height * 0.35, u * 2, HUD_AMBER);
    const sub = 'R RESTART   N NEW POINT';
    font.text(sub, (renderer.width - font.measure(sub, u)) / 2, renderer.height * 0.35 + 32 * u, u, HUD_GREEN);
  }
  if (import.meta.env.DEV) {
    const st = chunks.stats;
    const os = osm.stats;
    font.text(
      `FPS ${Math.round(fpsAvg)}  DRAW ${st.drawCalls + os.drawCalls}  BUF ${st.gpuBuffers}  OSM ERR ${os.errors}  ${state.toUpperCase()}`,
      pad, renderer.height - pad - 16 * u, u, HUD_GREEN,
    );
  }
  const attr = '© OpenStreetMap contributors';
  font.text(attr, renderer.width - font.measure(attr, u) - pad, renderer.height - pad - 16 * u, u, HUD_GREEN);
  font.flush();
  vectors.flush();
  renderer.resolve();

  if (spawned && state === 'flying' && now - lastUrlUpdate > 1000) {
    lastUrlUpdate = now;
    const ll = camWorld.latLon;
    history.replaceState(
      null, '',
      `#${ll.lat.toFixed(5)},${ll.lon.toFixed(5)},${Math.round(model.pos[1])},${Math.round(model.headingDeg)},${cfg.id},${Math.floor(simTime.getTime() / 1000)}`,
    );
  }
}

requestAnimationFrame(frame);