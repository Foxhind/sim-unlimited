import { mat4, vec3 } from 'gl-matrix';
import unsciiHex from '../assets/fonts/unscii-16.hex?raw';
import uaPatchHex from '../assets/fonts/unscii-16-ua-patch.hex?raw';
import { Renderer, type BaseGround } from './engine/renderer';
import { DEPTH_FAR } from './engine/shaders';
import { FontRenderer, HUD_AMBER, HUD_GREEN, parseHex } from './engine/font';
import { VectorRenderer } from './engine/vector';
import { BASE_LAND, FLASH_LIGHT, LUT_ENTRIES, RAMP, applyFlameColors, applySunColors, buildLUT, lightUniforms, seasonOf, litShare, solarHour, paletteAt, type LightUniforms, type PaletteParams, shadeColour, snowy, sunColour, sunniness } from './engine/palette';
import { NO_RIM, rim, rimFrame, rimLab } from './engine/rim';
import { profiler } from './engine/profiler';
import { Input } from './engine/input';
import { ChunkManager, type CameraWorld } from './world/chunks';
import { OsmManager } from './world/osm-manager';
import { FarOsmManager } from './world/far-osm-manager';
import { farOsmTiles, OPENFREEMAP_ATTRIBUTION } from './world/far-osm';
import { enuToLatLon, latLonToEnu, tileCenter, tileForLatLon, tileKey, type LatLon, type Tile } from './world/geodesy';
import { runwayStart } from './world/runway';
import { getOsmRaw } from './world/tile-cache';
import { OSM_SCHEMA_VERSION } from './world/osm-source';
import { parseOverpass, type OverpassJson } from './world/overpass';
import type { OsmLine } from './world/osm-types';
import { GroundProbe, towerAnchor } from './world/ground';
import { FarElevation } from './world/far-elevation';
import { buildSkyPoints, limitingMagnitude, PLANETS_OFFSET, planetPoints, skyMatrix, toGlMat3 } from './world/sky';
import { moonPosition, sunPosition } from './world/sun';
import { timeForPreset } from './world/time-of-day';
import { WEATHER_ATTRIBUTION, WeatherService, airConditions, type Weather } from './world/weather';
import { CLOUD_RGB, cloudLayers, type CloudInput } from './world/clouds';
import { CloudField } from './world/cloud-field';
import { AIRCRAFT, fitAircraft, type AircraftId } from './flight/aircraft';
import { FlightModel, type FlightControls } from './flight/model';
import { approachSpeed, Autopilot } from './flight/autopilot';
import { cdi, GS_ANTENNA_M, NavDb, offsetLatLon, receive, type Navaid, type NavKind } from './flight/navaids';
import { Air } from './flight/air';
import { Controls, type Action } from './flight/controls';
import { CameraRig, type CameraMode } from './flight/cameras';
import { AircraftRenderer } from './flight/aircraft-renderer';
import { FlightAudio } from './flight/audio';
import { drawHud, type HudMode, type HudNav } from './flight/hud';
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
rig.groundAt = (x, z) => {
  const ll = enuToLatLon(chunks.origin, x, -z, 0);
  return ground.heightAt(ll.lon, ll.lat);
};
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

/** live weather at the aircraft; ?temp=-20 in the URL forces the reported air temperature */
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
/** light uniforms of a palette (frozen water is not drawn as water: no waves, glints or glitter) */
function lightOf(p: PaletteParams): LightUniforms {
  const l = lightUniforms(p, sunnyNow());
  l.direct[1] = moonLight();
  return l;
}
let palette = dayPalette();
let lut = buildLUT(palette);
let light = lightOf(palette);
applySunColors(lut, sun.elevationDeg);
const flashLut = new Uint8Array(LUT_ENTRIES * 4).fill(255);
let lastSunUpdate = 0;
/** stars and planets: J2000 → world directions this frame, and the planets refreshed with the light */
const skyMat = new Float32Array(9);
const planetBuf = planetPoints(simTime);
renderer.setSkyPoints(buildSkyPoints());
renderer.setSkyPoints(planetBuf, PLANETS_OFFSET);
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
  lut = buildLUT(palette);
  light = lightOf(palette);
  applySunColors(lut, sun.elevationDeg);
}

function startLocation(fc: { location: string; customPoint: LatLon | null }): LatLon {
  const af = AIRFIELDS.find((a) => a.icao === fc.location);
  return fc.location === 'custom' && fc.customPoint ? fc.customPoint : af ?? start.latLon;
}

/** radio stations: an ILS onto each reference airfield's runway and a VOR/DME on it, then more as the OSM arrives */
const navDb = new NavDb();
for (const af of AIRFIELDS) {
  navDb.addIls({ name: af.icao, lat: af.rwyLat, lon: af.rwyLon, course: af.hdg, lenM: 2000 });
  navDb.addAirfield({ kind: 'airport', code: af.icao, lat: af.lat, lon: af.lon });
}
/** the airfield a runway belongs to: the nearest known one within 5 km of its middle */
function runwayOwner(pts: [number, number][]): string | undefined {
  const mid = { lat: (pts[0][1] + pts[pts.length - 1][1]) / 2, lon: (pts[0][0] + pts[pts.length - 1][0]) / 2 };
  let best: string | undefined;
  let bestD = 5000;
  const fields = [...AIRFIELDS.map((a) => ({ lat: a.lat, lon: a.lon, code: a.icao as string | undefined, name: a.name as string | undefined })), ...flightMap.airfields()];
  for (const f of fields) {
    const [e, n] = latLonToEnu(mid, f.lat, f.lon, 0);
    const d = Math.hypot(e, n);
    if (d < bestD && (f.code || f.name)) { bestD = d; best = (f.code ?? f.name)!.toUpperCase(); }
  }
  return best;
}

// Q40: a fresh aerodrome/runway tile invalidates nearby terrain so its pad is applied
osm.onTileReady = (tile, runways, coast) => {
  // every long paved runway gets an ILS on each end
  if (runways > 0) {
    void cachedRunwayLines([tile]).then((lines) => {
      for (const l of lines) navDb.addRunway(l.points as [number, number][], l.tags, runwayOwner(l.points as [number, number][]));
    }).catch(() => undefined);
  }
  // the collision surface is built from the tile's own OSM like the mesh: rebuild it too
  ground.refresh(tile);
  // aerodrome pads flatten the terrain and the OSM coastline reshapes the shore: rebuild with the OSM
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

/** where the aircraft is put: the start point, or for a ground start the nearest OSM runway's takeoff end */
const spawnAt = { lat: start.latLon.lat, lon: start.latLon.lon, hdg: start.hdg };
/** a ground start waits (at most RUNWAY_WAIT_MS) for the OSM around the start point to find a runway on it */
let runwaySnap: 'waiting' | 'busy' | 'done' = start.alt === 0 ? 'waiting' : 'done';
let runwaySnapSince = 0;
const RUNWAY_WAIT_MS = 20000;

/**
 * A ground start stands on the detailed (z14) surface, so it waits until the tiles there are drawn
 * in detail — which needs their OSM. When the OSM is late (Overpass down, the OSM API throttling)
 * the coarse parent drawn instead may lie metres above that surface and the aircraft would stand
 * inside it: after DETAIL_WAIT_MS from the runway snap the detailed tiles around the start are
 * drawn without their OSM (the terrain then has no aerodrome pad yet, and neither has the ground
 * probe; both are rebuilt with it when it arrives).
 */
const DETAIL_WAIT_MS = 15000;
let detailWaitSince = 0;
const forcedDetail = new Set<string>();

function startDrawnInDetail(now: number): boolean {
  if (start.alt !== 0) return true;
  const c = tileForLatLon(spawnAt.lat, spawnAt.lon, 14);
  if (chunks.shownDetail.has(`${c.z}/${c.x}/${c.y}`)) return true;
  detailWaitSince ||= now;
  if (now - detailWaitSince > DETAIL_WAIT_MS && !forcedDetail.size) {
    // a z14 tile is drawn only with all its siblings (else their parent covers it): force whole families
    for (const t of tilesAround(spawnAt)) {
      for (let k = 0; k < 4; k++) forcedDetail.add(`14/${(t.x & ~1) + (k & 1)}/${(t.y & ~1) + (k >> 1)}`);
    }
  }
  return false;
}

function tilesAround(ll: LatLon): Tile[] {
  const c = tileForLatLon(ll.lat, ll.lon, 14);
  const out: Tile[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push({ z: 14, x: c.x + dx, y: c.y + dy });
  return out;
}

async function cachedRunwayLines(tiles: Tile[]): Promise<OsmLine[]> {
  const lines: OsmLine[] = [];
  await Promise.all(tiles.map(async (tile) => {
    const raw = await getOsmRaw(`${tileKey('osm', tile, OSM_SCHEMA_VERSION)}/full`).catch(() => undefined);
    if (!raw) return;
    try {
      for (const l of parseOverpass(JSON.parse(raw.json) as OverpassJson).lines) if (l.tags.aeroway === 'runway') lines.push(l);
    } catch {
      // a broken cache entry: no runway from this tile
    }
  }));
  return lines;
}

/** once the OSM tiles around the start have arrived (or failed, or the wait ran out), move the start onto the runway */
function snapToRunway(now: number): void {
  if (runwaySnap !== 'waiting') return;
  runwaySnapSince ||= now;
  const tiles = tilesAround(start.latLon);
  const settled = tiles.every((t) => {
    const st = osm.chunks.get(`${t.z}/${t.x}/${t.y}`)?.status;
    return st === 'ready' || st === 'error';
  });
  if (!settled && now - runwaySnapSince < RUNWAY_WAIT_MS) return;
  runwaySnap = 'busy';
  void cachedRunwayLines(tiles)
    .then((lines) => {
      const rw = runwayStart(lines, start.latLon);
      if (!rw) return;
      Object.assign(spawnAt, rw);
      // the terrain and ground probe load around the aircraft: bring them to the runway before the spawn
      const [e, n] = latLonToEnu(chunks.origin, rw.lat, rw.lon, 0);
      model.pos[0] = e;
      model.pos[2] = -n;
    })
    .catch(() => undefined)
    .finally(() => { runwaySnap = 'done'; });
}

function spawn(): void {
  const groundH = Math.max(0, ground.heightAt(spawnAt.lon, spawnAt.lat) ?? 0);
  const [e, n] = latLonToEnu(chunks.origin, spawnAt.lat, spawnAt.lon, 0);
  if (start.alt === 0) {
    model.spawnGround(vec3.fromValues(e, groundH + cfg.gearHeight, -n), spawnAt.hdg, groundH);
  } else {
    const alt = start.alt ?? groundH + 1500;
    model.spawnAir(vec3.fromValues(e, alt, -n), spawnAt.hdg);
  }
  // an air start begins clean: gear up (the model snaps its actuators to this on the first step), unless it is fixed
  controls.gearFixed = !!cfg.fixedGear;
  controls.gearDown = start.alt === 0 || controls.gearFixed;
  controls.flaps = false;
  prevGear = controls.gearDown;
  prevFlaps = controls.flaps;
  camWorld.alt = model.pos[1];
  rig.setMode('cockpit', model);
  aircraftRenderer.startPropeller(model, start.alt !== 0);
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
    const onRunway = fc.startMode === 'runway';
    let ll = startLocation(fc);
    if (onRunway && af && fc.location !== 'custom') {
      // the start of the takeoff runway, a little in from its end so the gear stands on the pavement
      const H = (af.hdg * Math.PI) / 180;
      const inset = 60;
      ll = {
        lat: af.rwyLat + (inset * Math.cos(H)) / 111320,
        lon: af.rwyLon + (inset * Math.sin(H)) / (111320 * Math.cos((af.rwyLat * Math.PI) / 180)),
      };
    }
    const alt = onRunway ? '0' : '';
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
    renderer, chunks, osm, farOsm, clouds, font, vectors, model, rig, aircraftRenderer, ground, controls, settings, audio, sunDir, moonDir, camWorld, menu, weather, air,
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
/** beyond the ground probe's few kilometres the autopilot still needs the terrain: coarse DEM tiles */
const farElevation = new FarElevation();
autopilot.groundAt = (x, z) => {
  const ll = enuToLatLon(chunks.origin, x, -z, 0);
  return Math.max(0, ground.heightAt(ll.lon, ll.lat) ?? farElevation.heightAt(ll.lon, ll.lat) ?? 0);
};
let apOn = false;
const flightMap = new Minimap();
/** flight map ranges the zoom key steps through */
const FLIGHT_MAP_SPANS_M = [10000, 20000, 40000, 80000];
let mapSpanIdx = 2;
let landingField: (typeof AIRFIELDS)[number] | null = null;
/** the ILS the autoland flies, when it found one */
let landingIls: Navaid | null = null;
let hudMode: HudMode = 'NAV';
/** tuned radios: NAV1 (VOR or ILS) with its selected course, ADF (NDB); null until something is in range */
let nav1: Navaid | null = null;
let adf: Navaid | null = null;
let obs = 0;
let lastNavFeed = 0;
/** the approach condition last frame: the HUD switches to APP when it first becomes true */
let prevApproach = false;
let hudNav: HudNav | undefined;
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

/** where the aircraft is, for the radios */
function ownLatLon(): LatLon {
  return enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], 0);
}

/** tune to the next station of the kinds in range after the current one (nearest first, wrapping) */
function nextStation(cur: Navaid | null, kinds: NavKind[]): Navaid | null {
  const list = navDb.inRange(ownLatLon(), model.pos[1], kinds);
  if (!list.length) return cur;
  const i = cur ? list.findIndex((r) => r.nav.id === cur.id) : -1;
  return list[(i + 1) % list.length].nav;
}

/** a newly tuned NAV1: an ILS brings its course, a VOR starts on the direct course to it */
function tuneNav1(n: Navaid | null): void {
  nav1 = n;
  if (n) obs = n.kind === 'ILS' ? n.course! : Math.round(receive(n, ownLatLon(), model.pos[1]).bearing);
}

/** terrain height under a lat/lon (0 until the ground has loaded there) */
function groundAtLatLon(ll: LatLon): number | undefined {
  const h = ground.heightAt(ll.lon, ll.lat) ?? farElevation.heightAt(ll.lon, ll.lat);
  return h === undefined ? undefined : Math.max(0, h);
}

/** world position of a lat/lon at height h, relative to the aircraft */
function relWorld(ll: LatLon, h: number): [number, number, number] {
  const [e, n] = latLonToEnu(chunks.origin, ll.lat, ll.lon, 0);
  return [e - model.pos[0], h - model.pos[1], -n - model.pos[2]];
}

/** radios, autopilot selectors, HUD mode and map zoom; returns what the HUD shows from the radios */
function updateNav(now: number): HudNav {
  const own = ownLatLon();
  const alt = model.pos[1];
  // feed stations from the aerodromes the flight map has loaded, once a second
  if (now - lastNavFeed > 1000) {
    lastNavFeed = now;
    for (const f of flightMap.airfields()) navDb.addAirfield(f);
    // nothing tuned yet: the nearest ILS close by, else the nearest VOR; the nearest NDB on the ADF
    if (!nav1) {
      const ils = navDb.inRange(own, alt, ['ILS']).find((r) => r.distM < 25000);
      tuneNav1(ils?.nav ?? navDb.inRange(own, alt, ['VOR'])[0]?.nav ?? null);
    }
    adf ??= navDb.inRange(own, alt, ['NDB'])[0]?.nav ?? null;
  }
  if (controls.justPressed('navTune')) tuneNav1(nextStation(nav1, ['VOR', 'ILS']));
  if (controls.justPressed('adfTune')) adf = nextStation(adf, ['NDB']);
  if (controls.justPressed('hudMode')) hudMode = hudMode === 'NAV' ? 'APP' : 'NAV';
  if (controls.justPressed('mapZoom')) mapSpanIdx = (mapSpanIdx + 1) % FLIGHT_MAP_SPANS_M.length;
  if (nav1 && nav1.kind !== 'ILS') obs = (((obs + controls.knob('crsInc') - controls.knob('crsDec')) % 360) + 360) % 360;

  // NAV1 and the approach: the ILS threshold's height comes from the terrain once it has loaded
  let n1: HudNav['nav1'] = null;
  if (nav1) {
    if (nav1.kind === 'ILS' && nav1.elev === undefined) nav1.elev = groundAtLatLon(nav1);
    const rx = receive(nav1, own, alt);
    n1 = { rx, cdi: cdi(rx, obs, own, alt) };
  }
  const groundH = autopilot.groundAt(model.pos[0], model.pos[2]);
  const ra = model.pos[1] - model.cfg.gearHeight - groundH;
  // switch to APP as an ILS approach begins: gear down, localizer received, within 25 km of the threshold
  const approach = !!n1 && n1.rx.nav.kind === 'ILS' && n1.rx.inRange && controls.gearDown && !model.onGround
    && (n1.cdi.thrDistM ?? 1e9) < 25000 && (n1.cdi.thrDistM ?? 0) > -500;
  if (approach && !prevApproach) hudMode = 'APP';
  prevApproach = approach;

  let runway: HudNav['runway'] = null;
  if (nav1?.kind === 'ILS' && hudMode === 'APP') {
    const e = nav1.elev ?? groundH;
    const c = nav1.course!;
    const half = (nav1.widthM ?? 45) / 2;
    const thr = { lat: nav1.lat, lon: nav1.lon };
    const far = offsetLatLon(thr, c, nav1.lenM ?? 2000);
    runway = {
      corners: [
        relWorld(offsetLatLon(thr, c - 90, half), e), relWorld(offsetLatLon(thr, c + 90, half), e),
        relWorld(offsetLatLon(far, c + 90, half), e), relWorld(offsetLatLon(far, c - 90, half), e),
      ],
      aim: relWorld(offsetLatLon(thr, c, GS_ANTENNA_M), e),
    };
  }

  // autopilot selectors (while it holds them, not during autoland) and NAV-mode guidance
  if (controls.justPressed('apNav') && state === 'flying') {
    if (!apOn) { apOn = true; autopilot.engage(model); }
    autopilot.lateral = autopilot.lateral === 'NAV' ? 'HDG' : 'NAV';
  }
  if (apOn && !autopilot.landing) {
    const t = autopilot.targets;
    const metric = settings.units === 'metric';
    t.heading = (((t.heading + controls.knob('hdgInc') - controls.knob('hdgDec')) % 360) + 360) % 360;
    t.altitude = Math.max(0, t.altitude + (controls.knob('altInc') - controls.knob('altDec')) * (metric ? 50 : 30.48));
    t.speed = Math.max(30, t.speed + (controls.knob('spdInc') - controls.knob('spdDec')) * (metric ? 10 / 3.6 : 5 / 1.94384));
  }
  autopilot.nav = n1 && n1.rx.inRange && nav1!.kind !== 'NDB' ? { course: n1.cdi.course, xtkM: n1.cdi.xtkM } : null;

  const adfRx = adf ? { rx: receive(adf, own, alt) } : null;
  return { nav1: n1, adf: adfRx, runway, ra, vapp: approachSpeed(model) };
}

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
  if (!autopilot.landing) landingIls = null;
  let ilsLanding = false;
  if (controls.justPressed('autoland') && state === 'flying' && !model.onGround) {
    // the tuned ILS when it is received, else the nearest one within 80 km
    const own = ownLatLon();
    const tuned = nav1?.kind === 'ILS' && receive(nav1, own, model.pos[1]).inRange ? nav1 : null;
    const ils = tuned ?? navDb.inRange(own, model.pos[1], ['ILS']).find((r) => r.distM < 80000)?.nav ?? null;
    if (ils) {
      tuneNav1(ils);
      landingIls = ils;
      landingField = null;
      const [e, n] = latLonToEnu(chunks.origin, ils.lat, ils.lon, 0);
      autopilot.startLanding(model, e, -n, ils.course!);
      apOn = true;
      hudMode = 'APP';
      ilsLanding = true;
    }
  }
  if (controls.justPressed('autoland') && state === 'flying' && !model.onGround && !ilsLanding) {
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
      hudMode = 'APP';
    }
  }
  const landingAt = landingIls ?? landingField;
  if (apOn && autopilot.landing && landingAt) {
    const [e, n] = latLonToEnu(chunks.origin, landingAt.lat, landingAt.lon, 0);
    autopilot.moveThreshold(e, -n);
    if (autopilot.landing === 'rollout' && model.onGround && model.speed < 1) {
      apOn = false;
      autopilot.stopLanding();
    }
  }
  // stick deflection by the pilot takes over; the autopilot only flies hands-off
  // (touchdown itself: the autopilot only switches final -> rollout on its next update)
  const landingRoll = autopilot.landing === 'rollout' || (autopilot.landing === 'final' && model.onGround);
  if (apOn && (Math.abs(flight.pitch) > 0.25 || Math.abs(flight.roll) > 0.25 || state !== 'flying' || (model.onGround && !landingRoll))) {
    apOn = false;
    autopilot.stopLanding();
  }
  if (spawned && state === 'flying') hudNav = updateNav(now);
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
  if (spawned) aircraftRenderer.spin(model, flight.throttle, state === 'paused' ? 0 : dt);

  camWorld.latLon = enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], model.pos[1]);
  camWorld.alt = model.pos[1];
  if (chunks.rebaseIfNeeded(camWorld)) {
    camWorld.latLon = enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], model.pos[1]);
  }
  ground.update(camWorld.latLon, now);

  // OSM is not a spawn gate: an Overpass outage must not ground the sim (a runway start waits for it a little)
  if (state === 'loading' && !spawned) snapToRunway(now);
  if (state === 'loading' && !spawned && runwaySnap === 'done' && chunks.nearReady(camWorld.latLon, 3000) && ground.ready &&
    startDrawnInDetail(now)) {
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
  chunks.update(camWorld, view, proj, now, (key) => osm.ready(key) || forcedDetail.has(key));
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
  // fast clocks need a finer refresh than the 1 s default or the sky visibly steps
  if (now - lastSunUpdate > (menu.config.timeAccel > 1 && state === 'flying' ? 100 : 1000)) {
    lastSunUpdate = now;
    updateLight();
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
  renderer.litShare = litShare(solarHour(simTime, sunLoc.lon));
  renderer.time = now / 1000;
  renderer.originLat = chunks.origin.lat;
  renderer.season = seasonOf(simTime);
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
  farOsm.draw(renderer, view, proj, camPos, lightsOn, 3 * u, FOG_START_M, FOG_END_M);
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
      model, controls: flight, camera: rig.mode, units: settings.units, now: now / 1000, soundOn: settings.sound,
      autopilot: apOn ? { ...autopilot.targets, mode: autopilot.landing ?? undefined, lateral: autopilot.lateral } : null,
      hudMode, nav: hudNav, fovYDeg: 60,
      weather: { data: weatherInForce(), tempC: weather.tempC },
    });
    // simple north-up minimap, bottom-left: terrain, reference airfields, own aircraft with heading
    const mapSize = Math.round(Math.min(renderer.width, renderer.height) * 0.22);
    const mapY = renderer.height - 68 * u - mapSize; // above the HUD throttle line at h - 60u
    const own = enuToLatLon(chunks.origin, model.pos[0], -model.pos[2], 0);
    flightMap.lang = settings.lang;
    const span = FLIGHT_MAP_SPANS_M[mapSpanIdx];
    flightMap.follow(own, span);
    flightMap.draw(vectors, font, pad, mapY, mapSize, u, own, model.headingDeg);
    const tuned = new Set([nav1?.id, adf?.id, landingIls?.id].filter((x): x is string => !!x));
    flightMap.drawNav(vectors, font, pad, mapY, mapSize, u, navDb.all(), tuned, own);
    font.text(`N  ${span / 1000} KM`, pad, mapY - 18 * u, u, HUD_GREEN);
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
  const attr = `© OpenStreetMap contributors · ${OPENFREEMAP_ATTRIBUTION} · ${WEATHER_ATTRIBUTION}`;
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
    // on the ground the link is a ground start (alt 0), not an air start at ground level
    history.replaceState(
      null, '',
      `#${ll.lat.toFixed(5)},${ll.lon.toFixed(5)},${model.onGround ? 0 : Math.round(model.pos[1])},${Math.round(model.headingDeg)},${cfg.id},${Math.floor(simTime.getTime() / 1000)},${cfg.insigniaId ?? ''},${cfg.loadoutId ?? ''}`,
    );
  }
  profiler.frameEnd();
}

requestAnimationFrame(frame);
