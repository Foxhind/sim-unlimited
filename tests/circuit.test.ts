import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { F117, SU27, type AircraftConfig } from '../src/flight/aircraft';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';

// M4 acceptance, headless: scripted pilot flies takeoff -> circuit -> landing on flat ground.
// World frame: x east, y up, z = -north. Runway starts at the origin and points north (heading 0).

const BANK = Number(process.env.BANK ?? 45);
const BASE_TURN_E = Number(process.env.BASE_E ?? 3100);
/** roll stick per degree of bank error: the stick commands roll rate, so a human-like pilot is gentle with it */
const ROLL_GAIN = 0.03;
/** pitch stick per m/s of climb-rate error: the stick commands load factor (full aft = the g limit) */
const VS_GAIN = 0.012;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const angDiff = (target: number, cur: number): number => ((target - cur + 540) % 360) - 180;

interface Result {
  crashed: boolean;
  reason: string;
  onGround: boolean;
  speed: number;
  maxAlt: number;
  touchdownSink: number;
  offsetX: number;
  alongZ: number;
  t: number;
}

function flyCircuit(cfg: AircraftConfig, k = 1): Result {
  const m = new FlightModel(cfg);
  m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
  const vApp = cfg.cruiseSpeed * 0.42;
  const vCruise = vApp + 12;
  const controls: FlightControls = {
    pitch: 0, roll: 0, yaw: 0, throttle: 1, gearDown: true, flaps: false, brakes: false, speedbrake: false,
  };
  // rectangular pattern, waypoints as (east, north)
  const wps: [number, number][] = [[0, 7000 * k], [7000 * k, 7000 * k], [7000 * k, -7000 * k]];
  let wp = 0;
  let phase: 'roll' | 'climb' | 'pattern' | 'base' | 'final' | 'rollout' = 'roll';
  let maxAlt = 0;
  let t = 0;
  let touchSink = 0;
  const bearingTo = (e: number, n: number, we: number, wn: number): number =>
    ((Math.atan2(we - e, wn - n) * 180) / Math.PI + 360) % 360;
  const holdHeading = (hdg: number): void => {
    const bankT = clamp(angDiff(hdg, m.headingDeg) * 0.8, -BANK, BANK);
    controls.roll = clamp((bankT - m.bankDeg) * ROLL_GAIN, -1, 1);
    controls.yaw = 0;
  };
  const holdAlt = (alt: number, climbMax: number): void => {
    const vsT = clamp((alt - m.pos[1]) * 0.15, -6, climbMax);
    // the stick commands load factor around 1 g, so climb-rate error maps straight to stick, damped by pitch rate
    controls.pitch = clamp((vsT - m.verticalSpeed) * VS_GAIN - m.omega[0] * 0.3, -0.5, 0.5);
  };
  const holdSpeed = (v: number, base = 0.5): void => {
    controls.throttle = clamp(base + (v - m.speed) * 0.08, 0, 1);
  };
  for (; t < 900; t += PHYSICS_STEP) {
    const north = -m.pos[2];
    const east = m.pos[0];
    const alt = m.pos[1];
    maxAlt = Math.max(maxAlt, alt);
    if (process.env.CIRCUIT_LOG && Math.round(t / PHYSICS_STEP) % 600 === 0) console.log(cfg.id, phase, 'bank', m.bankDeg.toFixed(0), t.toFixed(0), 'N', north.toFixed(0), 'E', east.toFixed(0), 'alt', alt.toFixed(0), 'hdg', m.headingDeg.toFixed(0), 'v', m.speed.toFixed(0));
    switch (phase) {
      case 'roll':
        controls.throttle = 1;
        controls.roll = 0;
        controls.pitch = m.speed > vApp * 1.15 ? 0.6 : 0;
        if (!m.onGround && alt > 15) {
          controls.gearDown = false;
          phase = 'climb';
        }
        break;
      case 'climb':
        controls.throttle = 1;
        holdHeading(0);
        holdAlt(450, 12);
        if (alt > 350) phase = 'pattern';
        break;
      case 'pattern': {
        const [we, wn] = wps[wp];
        holdSpeed(vCruise);
        holdAlt(450, 8);
        holdHeading(bearingTo(east, north, we, wn));
        if (Math.hypot(we - east, wn - north) < 900) wp++;
        if (wp >= wps.length) phase = 'base';
        break;
      }
      case 'base':
        holdSpeed(vCruise);
        holdAlt(420, 4);
        holdHeading(270);
        if (east < BASE_TURN_E * k) phase = 'final';
        break;
      case 'final': {
        controls.gearDown = true;
        controls.flaps = true;
        const dist = Math.max(0, -north + 250);
        if (process.env.CIRCUIT_LOG && Math.round(t / PHYSICS_STEP) % 120 === 0) console.log(cfg.id, 'F', t.toFixed(0), 'N', north.toFixed(0), 'E', east.toFixed(0), 'alt', alt.toFixed(0), 'vs', m.verticalSpeed.toFixed(1), 'v', m.speed.toFixed(0), 'hdg', m.headingDeg.toFixed(0)); // aim point 250 m past the threshold
        const glideAlt = Math.min(450, dist * Math.tan((3 * Math.PI) / 180));
        holdSpeed(vApp, Number(process.env.FINAL_THR ?? 0.1));
        const hdgT = clamp(-east * 0.03, -35, 35);
        const lateral = clamp(angDiff(hdgT, m.headingDeg) * 0.8, -40, 40);
        controls.roll = clamp((lateral - m.bankDeg) * ROLL_GAIN, -1, 1);
        if (alt > 12) holdAlt(glideAlt, 4);
        else {
          controls.throttle = 0;
          const vsT = clamp(-0.6 - (12 - alt) * 0.05, -2, 0);
          controls.pitch = clamp((vsT - m.verticalSpeed) * VS_GAIN * 2 - m.omega[0] * 0.3, -0.3, 0.5);
        }
        if (m.onGround) {
          touchSink = m.touchdownSink;
          phase = 'rollout';
        }
        break;
      }
      case 'rollout':
        controls.throttle = 0;
        controls.brakes = true;
        controls.pitch = 0;
        controls.roll = 0;
        controls.yaw = clamp(-east * 0.01 + angDiff(0, m.headingDeg) * 0.03, -0.5, 0.5);
        break;
    }
    m.update(PHYSICS_STEP, controls);
    if (m.crashed) break;
    if (phase === 'rollout' && m.speed < 1) break;
  }
  return {
    crashed: m.crashed, reason: m.crashReason, onGround: m.onGround, speed: m.speed,
    maxAlt, touchdownSink: touchSink, offsetX: m.pos[0], alongZ: -m.pos[2], t,
  };
}

describe('M4 circuit: takeoff, pattern, landing (flat ground, scripted pilot)', () => {
  for (const [cfg, k] of [[SU27, 1], [F117, Number(process.env.K ?? 1.9)]] as const) {
    it(`${cfg.name} completes the circuit and stops on the ground without crashing`, () => {
      const r = flyCircuit(cfg, k);
      expect(r.crashed, r.reason).toBe(false);
      expect(r.maxAlt).toBeGreaterThan(300);
      expect(r.onGround).toBe(true);
      expect(r.speed).toBeLessThan(2);
      expect(Math.abs(r.offsetX)).toBeLessThan(150);
    });
  }
});
