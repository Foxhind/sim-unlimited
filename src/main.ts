import { vec3 } from 'gl-matrix';
import unsciiHex from '../assets/fonts/unscii-16.hex?raw';
import uaPatchHex from '../assets/fonts/unscii-16-ua-patch.hex?raw';
import { Renderer } from './engine/renderer';
import { FontRenderer, HUD_AMBER, HUD_GREEN, parseHex } from './engine/font';
import { buildLUT, paletteAt } from './engine/palette';
import { FreeCamera } from './engine/camera';
import { Input } from './engine/input';
import { ChunkManager, type CameraWorld } from './world/chunks';
import { enuToLatLon, type LatLon } from './world/geodesy';

function parseStart(): { latLon: LatLon; alt: number; hdg: number } {
  const fallback = { latLon: { lat: 47.26, lon: 11.35 }, alt: 1500, hdg: 0 };
  const hash = window.location.hash.slice(1);
  if (!hash) return fallback;
  const parts = hash.split(',').map(Number);
  if (parts.length < 2 || parts.some((v) => !Number.isFinite(v))) return fallback;
  const [lat, lon, alt, hdg] = parts;
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return fallback;
  return {
    latLon: { lat, lon },
    alt: Number.isFinite(alt) ? Math.max(10, alt) : fallback.alt,
    hdg: Number.isFinite(hdg) ? hdg : 0,
  };
}

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const gl = renderer.gl;

const font = new FontRenderer(gl, parseHex(unsciiHex + '\n' + uaPatchHex));
const camera = new FreeCamera();
const input = new Input(canvas);
const start = parseStart();
camera.pos[1] = start.alt;
camera.yaw = (start.hdg * Math.PI) / 180;
camera.pitch = -0.15;

const chunks = new ChunkManager(gl, start.latLon);
const camWorld: CameraWorld = {
  pos: camera.pos,
  latLon: start.latLon,
  alt: start.alt,
  velocity: vec3.create(),
};

// M0/M1: fixed clear-day sun; real solar position arrives with the flight model (Q17)
const sunDir = vec3.normalize(vec3.create(), vec3.fromValues(0.35, 0.8, 0.45));
const lut = buildLUT(paletteAt(45));

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sim = { renderer, camera, chunks, font, sunDir, lut, camWorld };
}

let last = performance.now();
let fpsAvg = 60;
let prevPos = vec3.clone(camera.pos);
let loaded = false;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dt > 0) fpsAvg += (1 / dt - fpsAvg) * 0.05;

  renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  camera.setAspect(renderer.width, renderer.height);
  font.setScreenSize(renderer.width, renderer.height);

  if (loaded) camera.update(dt, input);
  vec3.scale(camWorld.velocity, vec3.sub(vec3.create(), camera.pos, prevPos), dt > 0 ? 1 / dt : 0);
  vec3.copy(prevPos, camera.pos);
  camWorld.latLon = enuToLatLon(chunks.origin, camera.pos[0], -camera.pos[2], camera.pos[1]);
  camWorld.alt = camera.pos[1];
  if (chunks.rebaseIfNeeded(camWorld)) {
    camWorld.latLon = enuToLatLon(chunks.origin, camera.pos[0], -camera.pos[2], camera.pos[1]);
    vec3.copy(prevPos, camera.pos);
  }

  chunks.update(camWorld, camera.view, camera.proj, now);
  if (!loaded && chunks.nearReady(camWorld.latLon, 3000)) loaded = true;

  renderer.beginFrame(lut);
  renderer.drawSky(camera.view, camera.proj, camera.pos, sunDir);
  chunks.draw(renderer, camera.view, camera.proj, camera.pos, sunDir, 15000, 55000);

  renderer.beginOverlay();
  const s = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const pad = 8 * s;
  const st = chunks.stats;
  font.text('SIM-UNLIMITED  M1', pad, pad, s, HUD_AMBER);
  font.text(
    `FPS ${Math.round(fpsAvg)}  ALT ${Math.round(camera.pos[1])} M\n` +
      `LAT ${camWorld.latLon.lat.toFixed(4)}  LON ${camWorld.latLon.lon.toFixed(4)}\n` +
      `CHUNKS ${st.chunks}  PEND ${st.pending}  DRAW ${st.drawCalls}  BUF ${st.gpuBuffers}`,
    pad,
    pad + 20 * s,
    s,
    HUD_GREEN,
  );
  if (!loaded) {
    const msg = 'LOADING TERRAIN...';
    font.text(msg, (renderer.width - font.measure(msg, s * 2)) / 2, renderer.height / 2, s * 2, HUD_AMBER);
  }
  font.text(
    'WASD MOVE  ARROWS/DRAG LOOK\nR/F UP/DOWN  SHIFT BOOST',
    pad,
    renderer.height - pad - 32 * s,
    s,
    HUD_GREEN,
  );
  const attr = '© OpenStreetMap contributors';
  font.text(attr, renderer.width - font.measure(attr, s) - pad, renderer.height - pad - 16 * s, s, HUD_GREEN);
  font.flush();
  renderer.resolve();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);