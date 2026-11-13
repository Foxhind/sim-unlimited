/**
 * The air the aircraft flies through: temperature, pressure, density and wind at a given height.
 *
 * Built from the live weather when there is one (surface observation plus pressure-level winds and
 * temperatures aloft), from the standard atmosphere otherwise. Everything the flight model needs is
 * one sample() per physics step: a short table lookup, one pow() and four filtered random numbers.
 *
 * World axes as everywhere else: x east, y up, z = -north.
 */
import { vec3 } from 'gl-matrix';
import { atmosphere, R_AIR } from './atmosphere';

const D2R = Math.PI / 180;
const KELVIN = 273.15;

/** one height of the weather profile */
export interface AirLevel {
  /** metres above mean sea level */
  alt: number;
  tempC: number;
  /** direction the wind blows FROM, degrees true */
  windFromDeg: number;
  windMs: number;
}

/** what the weather service knows; every field of the surface observation is at `elevation` */
export interface AirConditions {
  /** terrain height the observation is for, m MSL */
  elevation: number;
  /** temperature 2 m above the ground */
  tempC: number;
  /** pressure at the ground, hPa (standard atmosphere when absent) */
  pressureHpa?: number;
  /** wind 10 m above the ground */
  windFromDeg: number;
  windMs: number;
  gustMs: number;
  /** winds and temperatures aloft; synthesised from the surface values when absent */
  levels?: AirLevel[];
  /** latitude: decides which way the wind turns with height when there is no data aloft */
  lat?: number;
}

export interface AirSample {
  temperature: number;
  pressure: number;
  density: number;
  speedOfSound: number;
  /** velocity of the air mass, world axes, m/s (mean wind plus turbulence) */
  wind: vec3;
  /** turbulent roll rate of the air about the flight direction, rad/s */
  gustRoll: number;
}

export function newAirSample(): AirSample {
  const a = atmosphere(0);
  return { temperature: a.temperature, pressure: a.pressure, density: a.density, speedOfSound: a.speedOfSound, wind: vec3.create(), gustRoll: 0 };
}

interface Node {
  alt: number;
  temp: number; // K
  e: number; // wind velocity east, m/s
  n: number; // wind velocity north, m/s
}

function node(alt: number, tempC: number, fromDeg: number, ms: number): Node {
  // wind FROM a bearing moves the air toward the opposite one
  return { alt, temp: tempC + KELVIN, e: -ms * Math.sin(fromDeg * D2R), n: -ms * Math.cos(fromDeg * D2R) };
}

/** height of the 10 m wind observation above the ground */
const ANEMOMETER_M = 10;
/** wind grows with height near the ground as (h / 10 m) ^ this (open country) */
const SHEAR_EXP = 0.143;

export class Air {
  private nodes: Node[] = [];
  /** actual surface pressure over the standard one at the same height */
  private pressureRatio = 1;
  private sigma = 0;
  private elevation = 0;
  // turbulence state (Dryden-style first-order filters) and its deterministic noise source
  private tu = 0;
  private tv = 0;
  private tw = 0;
  private tp = 0;
  private seed = 0x2545f491;

  constructor(conditions?: AirConditions) {
    this.set(conditions);
  }

  /** New weather; undefined returns to the calm standard atmosphere. Turbulence state carries over. */
  set(c: AirConditions | undefined): void {
    this.nodes = [];
    this.pressureRatio = 1;
    this.sigma = 0;
    if (!c) return;
    this.elevation = c.elevation;
    const surfaceAlt = c.elevation + ANEMOMETER_M;
    this.nodes.push(node(surfaceAlt, c.tempC, c.windFromDeg, c.windMs));
    const aloft = (c.levels ?? []).filter((l) => l.alt > surfaceAlt + 150).sort((a, b) => a.alt - b.alt);
    if (aloft.length > 0) {
      for (const l of aloft) this.nodes.push(node(l.alt, l.tempC, l.windFromDeg, l.windMs));
    } else {
      // no data aloft: standard lapse rate, wind strengthening through the boundary layer and turning
      // with height (clockwise in the northern hemisphere) toward the free-air flow
      const turn = (c.lat ?? 45) >= 0 ? 1 : -1;
      const lapse = (h: number): number => c.tempC - 0.0065 * h;
      this.nodes.push(node(surfaceAlt + 600, lapse(600), c.windFromDeg + turn * 15, c.windMs * 1.7));
      this.nodes.push(node(surfaceAlt + 1500, lapse(1500), c.windFromDeg + turn * 25, c.windMs * 2.1));
      this.nodes.push(node(surfaceAlt + 9000, lapse(9000), c.windFromDeg + turn * 30, c.windMs * 2.1 + 12));
    }
    if (c.pressureHpa !== undefined && c.pressureHpa > 300) {
      this.pressureRatio = (c.pressureHpa * 100) / atmosphere(c.elevation).pressure;
    }
    // a reported gust is roughly a 3-sigma peak over the mean; a steady wind is still a little rough
    this.sigma = Math.max(0, c.gustMs - c.windMs) / 3 + 0.03 * c.windMs;
  }

  get calm(): boolean {
    return this.nodes.length === 0;
  }

  private gauss(): number {
    // three uniforms: cheap, bounded, close enough to normal for gusts
    let s = 0;
    for (let i = 0; i < 3; i++) {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
      s += (this.seed >>> 8) / 16777216;
    }
    return (s - 1.5) * 2;
  }

  /**
   * Air at altitude `alt` (m MSL), `agl` metres above the ground. `airspeed` and `dt` advance the
   * turbulence (it is frozen in the air mass, so a faster aircraft meets it faster); `span` sets the
   * scale of the rolling gusts. With dt = 0 the turbulence is left as it is.
   */
  sample(out: AirSample, alt: number, agl: number, airspeed = 0, dt = 0, span = 12): AirSample {
    const std = atmosphere(alt);
    const nodes = this.nodes;
    if (nodes.length === 0) {
      out.temperature = std.temperature;
      out.pressure = std.pressure;
      out.density = std.density;
      out.speedOfSound = std.speedOfSound;
      vec3.zero(out.wind);
      out.gustRoll = 0;
      return out;
    }
    let temp: number;
    let e: number;
    let n: number;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (alt <= first.alt) {
      temp = first.temp + 0.0065 * (first.alt - alt);
      // boundary layer: the wind dies toward the ground
      const k = Math.pow(Math.max(1, Math.min(ANEMOMETER_M, agl)) / ANEMOMETER_M, SHEAR_EXP);
      e = first.e * k;
      n = first.n * k;
    } else if (alt >= last.alt) {
      // above the data: keep the top wind, and the top temperature's offset from the standard one
      temp = std.temperature + (last.temp - atmosphere(last.alt).temperature);
      e = last.e;
      n = last.n;
    } else {
      let i = 1;
      while (nodes[i].alt < alt) i++;
      const a = nodes[i - 1];
      const b = nodes[i];
      const t = (alt - a.alt) / (b.alt - a.alt);
      temp = a.temp + (b.temp - a.temp) * t;
      e = a.e + (b.e - a.e) * t;
      n = a.n + (b.n - a.n) * t;
      // the lowest layer follows the power law rather than a straight line
      if (i === 1 && agl < 300) {
        const k = Math.pow(Math.max(1, agl) / ANEMOMETER_M, SHEAR_EXP);
        const blend = Math.min(1, Math.max(0, agl - ANEMOMETER_M) / 290);
        e = first.e * k * (1 - blend) + e * blend;
        n = first.n * k * (1 - blend) + n * blend;
      }
    }
    out.temperature = temp;
    out.pressure = std.pressure * this.pressureRatio;
    out.density = out.pressure / (R_AIR * temp);
    out.speedOfSound = Math.sqrt(1.4 * R_AIR * temp);

    if (dt > 0 && this.sigma > 0) {
      // rough near the ground, smoother in the free air
      const h = Math.max(0, agl);
      const sigma = this.sigma * (h < 300 ? 1 : Math.max(0.3, 1 - (h - 300) / 1700));
      const L = Math.max(40, Math.min(450, h));
      const V = Math.max(15, airspeed);
      const a = Math.min(1, (V / L) * dt);
      const drive = sigma * Math.sqrt(2 * a);
      this.tu += -this.tu * a + drive * this.gauss();
      this.tv += -this.tv * a + drive * this.gauss();
      // vertical gusts are squeezed out close to the ground
      const sw = 0.5 + 0.5 * Math.min(1, h / 150);
      this.tw += -this.tw * a + drive * sw * this.gauss();
      const ap = Math.min(1, ((Math.PI * V) / (4 * span)) * dt);
      const sigmaP = (1.9 * sigma * sw) / Math.sqrt(L * span);
      this.tp += -this.tp * ap + sigmaP * Math.sqrt(2 * ap) * this.gauss();
    } else if (this.sigma === 0) {
      this.tu = this.tv = this.tw = this.tp = 0;
    }
    out.wind[0] = e + this.tu;
    out.wind[1] = this.tw;
    out.wind[2] = -n + this.tv;
    out.gustRoll = this.tp;
    return out;
  }

  /** mean wind at a height, without turbulence: [east, north] m/s */
  meanWind(alt: number, agl: number): [number, number] {
    const s = this.sample(newAirSample(), alt, agl);
    return [s.wind[0] - this.tu, -(s.wind[2] - this.tv)];
  }

  /** ground elevation of the surface observation in use */
  get surfaceElevation(): number {
    return this.elevation;
  }
}

/** still standard atmosphere: the default when no weather is supplied */
export const CALM_AIR = new Air();
