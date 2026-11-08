import { vec3 } from 'gl-matrix';
import unsciiHex from '../assets/fonts/unscii-16.hex?raw';
import uaPatchHex from '../assets/fonts/unscii-16-ua-patch.hex?raw';
import { Renderer } from './engine/renderer';
import { FontRenderer, HUD_AMBER, HUD_GREEN, parseHex } from './engine/font';
import { buildLUT, paletteAt } from './engine/palette';
import { FreeCamera } from './engine/camera';
import { Input } from './engine/input';
import { createGroundMesh, GROUND_SIZE } from './world/ground';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const gl = renderer.gl;

const font = new FontRenderer(gl, parseHex(unsciiHex + '\n' + uaPatchHex));
const camera = new FreeCamera();
const input = new Input(canvas);
const ground = createGroundMesh(gl);

// M0: fixed clear-day sun; real solar position arrives with the flight model (Q17)
const sunDir = vec3.normalize(vec3.create(), vec3.fromValues(0.35, 0.8, 0.45));
const lut = buildLUT(paletteAt(45));
const groundOffset = vec3.create();

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sim = { renderer, camera, ground, font, sunDir, lut };
}

let last = performance.now();
let fpsAvg = 60;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dt > 0) fpsAvg += (1 / dt - fpsAvg) * 0.05;

  renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  camera.setAspect(renderer.width, renderer.height);
  font.setScreenSize(renderer.width, renderer.height);
  camera.update(dt, input);

  renderer.beginFrame(lut);
  renderer.drawSky(camera.view, camera.proj, camera.pos, sunDir);
  vec3.set(
    groundOffset,
    Math.round(camera.pos[0] / GROUND_SIZE) * GROUND_SIZE,
    0,
    Math.round(camera.pos[2] / GROUND_SIZE) * GROUND_SIZE,
  );
  renderer.drawWorld(ground, groundOffset, camera.view, camera.proj, camera.pos, sunDir, 4000, 14000);

  renderer.beginOverlay();
  const s = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const pad = 8 * s;
  font.text('SIM-UNLIMITED  M0', pad, pad, s, HUD_AMBER);
  font.text(
    `FPS ${Math.round(fpsAvg)}  ALT ${Math.round(camera.pos[1])} M\n` +
      `X ${Math.round(camera.pos[0])}  Z ${Math.round(camera.pos[2])}`,
    pad,
    pad + 20 * s,
    s,
    HUD_GREEN,
  );
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