/**
 * How a turning propeller is drawn. Slowly (the engine starting) its blades are the model's own polygons,
 * turned about the hub; faster they smear into ghosts that fade, and from DISC_RPM on they are a
 * see-through disc in the blades' colours, with the sun's glints on the arcs where the blade faces, at
 * their angle there, mirror the sun to the eye.
 *
 * Mesh axes: x right, y up, z aft (forward is -z).
 */
import type { vec3 } from 'gl-matrix';

/** what the model draws its propeller with (AircraftConfig.prop) */
export interface PropDef {
  /** the hub on the thrust line, mesh coordinates */
  hub: number[];
  /** tip radius, m */
  radius: number;
  /** geometric pitch, m: how far one turn screws forward; the blade angle is atan(pitch / (2 pi r)) */
  pitch: number;
}

/** below this the blades are drawn as they are */
export const BLADES_RPM = 250;
/** from here on only the disc */
export const DISC_RPM = 1100;
/** the disc's opacity, full blur (two thin blades sweep ~10% of it; a little more reads better on screen) */
export const DISC_OPACITY = 0.3;
/** ghost blades: copies of the blades smeared over the last frame's turn */
export const GHOSTS = 3;
/** how sharp the glint is: a narrow arc (a satin paint, the blade faces flat) */
const GLINT_SHINE = 160;
/** a cell glints no more than this share of the sun's light (the blades cover only part of the disc) */
export const GLINT_GAIN = 0.5;
/** inertia of the engine and propeller, s */
export const SPIN_TAU = 0.7;

/**
 * The O-200's rpm: ~700 at idle, 2750 at full throttle and cruise; on a fixed-pitch propeller the airstream
 * turns it faster too. `n` is the spooled throttle 0..1, `speed` the airspeed m/s.
 */
export function pistonRpm(n: number, speed: number): number {
  return Math.min(3000, 700 + 1750 * n + 6 * speed);
}

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** 0: the blades are drawn, 1: only the disc; between both, the blades fading out as the disc fades in */
export function blurOf(rpm: number): number {
  return smooth((rpm - BLADES_RPM) / (DISC_RPM - BLADES_RPM));
}

/**
 * Opacity of each ghost copy: where they all overlap (turning slowly) they add up to 1 - blur, so the
 * blades fade out from fully drawn without a jump.
 */
export function ghostOpacity(blur: number): number {
  return 1 - Math.pow(Math.max(0, blur), 1 / GHOSTS);
}

/**
 * Per vertex 1 where its triangle is a blade: every corner close to the propeller plane, and the triangle
 * reaching far out (the spinner and the cowling face around the hub stay within 0.45 of the radius).
 */
export function propVertices(vertices: Float32Array, prop: PropDef): Uint8Array {
  const n = vertices.length / 6;
  const out = new Uint8Array(n);
  const [hx, hy, hz] = prop.hub;
  const band = 0.05 * prop.radius;
  for (let t = 0; t + 2 < n; t += 3) {
    let near = true;
    let far = 0;
    for (let k = 0; k < 3; k++) {
      const o = (t + k) * 6;
      if (Math.abs(vertices[o + 2] - hz) > band) near = false;
      far = Math.max(far, Math.hypot(vertices[o] - hx, vertices[o + 1] - hy));
    }
    if (near && far > 0.6 * prop.radius) out[t] = out[t + 1] = out[t + 2] = 1;
  }
  return out;
}

/** The propeller turns clockwise seen from the cockpit: in mesh axes, a negative angle about +z. */
export const SPIN_SENSE = -1;

/**
 * Brightness 0..1 of the sun's glint off the blades passing (r, phi) on the disc (phi from +x toward +y,
 * about the hub), for `toSun` and `toEye` unit vectors in mesh axes.
 * A blade there has its chord at the angle beta to the disc, its leading edge forward: its faces' normal
 * is n = cos(beta) forward - sin(beta) t (t: the way it moves). A face glints where it mirrors the sun to the
 * eye: the half vector along n, with the sun and the eye on the same side of it.
 */
export function glintAt(prop: PropDef, r: number, phi: number, toSun: vec3 | number[], toEye: vec3 | number[]): number {
  const beta = Math.atan2(prop.pitch, 2 * Math.PI * r);
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  // moving the way of SPIN_SENSE: t = SPIN_SENSE x d/dphi (cos phi, sin phi, 0)
  const tx = -Math.sin(phi) * SPIN_SENSE;
  const ty = Math.cos(phi) * SPIN_SENSE;
  // forward is -z
  const nx = -sb * tx;
  const ny = -sb * ty;
  const nz = -cb;
  const ls = toSun[0] * nx + toSun[1] * ny + toSun[2] * nz;
  const le = toEye[0] * nx + toEye[1] * ny + toEye[2] * nz;
  if (ls * le <= 0) return 0;
  const hx = toSun[0] + toEye[0], hy = toSun[1] + toEye[1], hz = toSun[2] + toEye[2];
  const hl = Math.hypot(hx, hy, hz);
  if (hl < 1e-6) return 0;
  const c = Math.abs(hx * nx + hy * ny + hz * nz) / hl;
  return Math.pow(c, GLINT_SHINE);
}
