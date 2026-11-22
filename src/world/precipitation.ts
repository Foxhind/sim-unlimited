/**
 * Rain and snow (Q48): what the weather's precipitation does to the view and the air. Pure numbers:
 * how far one sees, how many particles fall round the camera and how fast, where the precipitation
 * stops (the cloud base), how rough the air of a storm is. The particles are drawn by
 * Renderer.drawPrecip, the lightning comes from lightning.ts.
 */
import { vec3 } from 'gl-matrix';
import type { PrecipKind } from './weather';

/** the distance fog of clear weather, m: where it starts and where the haze is complete */
export const FOG_CLEAR = { start: 15000, end: 55000 } as const;
/** the fog ends this many times further than the visibility (a reported 24 km is the clear 55 km) */
const FOG_PER_VISIBILITY = 2.3;
const FOG_END_MIN = 1200;
/** precipitation thins out over this height above the cloud base, m */
const FADE_ABOVE_BASE_M = 300;
/** with no cloud layer drawn, precipitation falls from this high above the ground, m */
const CEILING_NO_CLOUD_M = 3000;

interface Falling {
  precipKind?: PrecipKind;
  precipMmH?: number;
  thunder?: boolean;
}

/** how far one sees through rain or snow of `mmH` mm/h, m (snow hides far more than rain of the same water) */
export function precipVisibilityM(kind: PrecipKind, mmH: number): number {
  if (kind === 'none' || !(mmH > 0)) return Infinity;
  return kind === 'snow' ? 4000 * mmH ** -0.7 : 16000 * mmH ** -0.6;
}

/** the distance fog for a visibility in metres (undefined: clear weather) */
export function fogRange(visibilityM: number | undefined): { start: number; end: number } {
  if (visibilityM === undefined || Number.isNaN(visibilityM)) return { ...FOG_CLEAR };
  const end = Math.max(FOG_END_MIN, Math.min(FOG_CLEAR.end, visibilityM * FOG_PER_VISIBILITY));
  return { start: (end * FOG_CLEAR.start) / FOG_CLEAR.end, end };
}

/**
 * How much of the precipitation reaches a camera at `camAlt` m MSL, 0..1: all of it below the base
 * of the lowest cloud layer, none FADE_ABOVE_BASE_M above it (one flies out of the rain into or
 * over the cloud). With no layer drawn it falls from CEILING_NO_CLOUD_M above the ground.
 */
export function precipAltitudeFactor(camAlt: number, lowestBase: number | undefined, groundElevation: number): number {
  const ceiling = lowestBase ?? groundElevation + CEILING_NO_CLOUD_M;
  return Math.max(0, Math.min(1, 1 - (camAlt - ceiling) / FADE_ABOVE_BASE_M));
}

/**
 * The particles round the camera: how many, the side of the cube they wrap in (m), how fast they
 * fall (m/s) and the exposure that draws their streak (s of motion against the camera).
 */
export function precipParticles(kind: PrecipKind, mmH: number): { count: number; box: number; fall: number; exposure: number } {
  if (kind === 'none' || !(mmH > 0)) return { count: 0, box: 1, fall: 0, exposure: 0 };
  const n = (per: number, least: number): number => Math.round(Math.max(least, Math.min(4000, per * Math.sqrt(mmH))));
  return kind === 'snow'
    ? { count: n(1400, 500), box: 24, fall: 1.5, exposure: 1 / 120 }
    : { count: n(1400, 600), box: 36, fall: 9, exposure: 1 / 40 };
}

/** extra roughness of the air, m/s (Air sigma): a thunderstorm shakes hard, heavy rain a little */
export function stormTurbulence(w: Falling): number {
  if (w.thunder) return 3;
  return w.precipKind === 'rain' ? Math.min(0.6, Math.max(0, w.precipMmH ?? 0) / 20) : 0;
}

/** how dark the weather makes the day, 0..1: the light is scaled by 1 − GLOOM_LIGHT × gloom */
export function gloom(w: Falling): number {
  if (w.thunder) return 1;
  return w.precipKind && w.precipKind !== 'none' ? Math.min(0.6, Math.max(0, w.precipMmH ?? 0) / 10) : 0;
}
export const GLOOM_LIGHT = 0.3;
/** the share of windows lit by day under a thunderstorm: a few, as people turn the lights on */
export const STORM_DAY_LIT = 0.1;

/**
 * How the particles move past the camera, m/s in world axes (x east, y up, z = -north): they fall
 * and go downwind, and a camera that flies through the air adds its own motion. A backdrop camera
 * (the menu's orbit, the circling view of a wreck) sweeps at well over 100 m/s without being
 * anywhere in the air: it passes no velocity, or the rain would fly sideways against its sweep.
 */
export function precipDrift(
  wind: readonly [number, number], fall: number, camVel?: ArrayLike<number>,
): [number, number, number] {
  return [wind[0] - (camVel?.[0] ?? 0), -fall - (camVel?.[1] ?? 0), -wind[1] - (camVel?.[2] ?? 0)];
}

/**
 * The camera's velocity from its positions frame to frame (the views differ: cockpit, chase,
 * tower, so the aircraft's velocity is not the camera's). The world re-centres its origin now and
 * then, moving every position at once: a step no camera could fly is taken for that and the last
 * velocity is kept.
 */
export class CameraMotion {
  readonly vel = vec3.create();
  private readonly last = vec3.create();
  private seen = false;

  update(pos: ArrayLike<number>, dt: number): void {
    if (!(dt > 0)) return;
    if (this.seen) {
      const dx = pos[0] - this.last[0], dy = pos[1] - this.last[1], dz = pos[2] - this.last[2];
      if (Math.hypot(dx, dy, dz) <= 600 * dt + 50) vec3.set(this.vel, dx / dt, dy / dt, dz / dt);
    }
    vec3.set(this.last, pos[0], pos[1], pos[2]);
    this.seen = true;
  }
}
