import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Autopilot, Pid } from '../src/flight/autopilot';
import { F117, SU27, type AircraftConfig } from '../src/flight/aircraft';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';

const base: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0.6, gearDown: false, flaps: false, brakes: false, speedbrake: false,
};

function fly(cfg: AircraftConfig, startAlt: number, targetAlt: number, speed: number, seconds: number, frame = PHYSICS_STEP) {
  const m = new FlightModel(cfg);
  m.spawnAir(vec3.fromValues(0, startAlt, 0), 90);
  vec3.scale(m.vel, m.vel, speed / m.speed);
  const ap = new Autopilot();
  ap.engage(m);
  ap.targets.altitude = targetAlt;
  ap.targets.speed = speed;
  const trace: { t: number; alt: number; pitch: number; spd: number; hdg: number }[] = [];
  const steps = Math.round(seconds / frame);
  const every = Math.round(1 / frame);
  for (let i = 0; i < steps; i++) {
    const c = ap.update(frame, m, base);
    m.update(frame, c);
    if (i % every === 0) trace.push({ t: i * frame, alt: m.pos[1], pitch: m.pitchDeg, spd: m.speed, hdg: m.headingDeg });
  }
  return { m, trace };
}

describe('Pid', () => {
  it('drives a first-order plant to the setpoint without windup after saturation', () => {
    const pid = new Pid(1, 0.5, 0, -1, 1);
    let y = 0;
    for (let i = 0; i < 4000; i++) y += (pid.step(10, y, 0.01) * 2 - y * 0.2) * 0.01;
    expect(y).toBeGreaterThan(0);
    // setpoint flips: output must leave saturation promptly (integral was clamped)
    let out = 1;
    for (let i = 0; i < 200 && out > 0; i++) out = pid.step(-10, y, 0.01);
    expect(out).toBeLessThanOrEqual(0);
  });
});

describe('autopilot altitude / speed / heading hold', () => {
  for (const [cfg, alt, spd] of [[SU27, 6000, 230], [SU27, 1500, 180], [F117, 3000, 190]] as const) {
    it(`${cfg.name}: holds ${alt} m steadily after a 250 m offset (no hunting)`, () => {
      const { m, trace } = fly(cfg, alt - 250, alt, spd, 240);
      if (process.env.AP_LOG) console.log(cfg.id, trace.filter((_, i) => i % 15 === 0).map((p) => `${p.t.toFixed(0)}s alt ${p.alt.toFixed(0)} pit ${p.pitch.toFixed(1)} v ${p.spd.toFixed(0)}`).join(' | '));
      expect(m.crashed).toBe(false);
      const tail = trace.filter((p) => p.t > 150);
      const alts = tail.map((p) => p.alt);
      expect(Math.max(...alts) - Math.min(...alts)).toBeLessThan(12); // peak-to-peak
      expect(Math.abs(alts[alts.length - 1] - alt)).toBeLessThan(10);
      for (const p of trace) expect(Math.abs(p.pitch)).toBeLessThan(14); // never the +-30 deg swings
      const speeds = tail.map((p) => p.spd);
      expect(Math.max(...speeds) - Math.min(...speeds)).toBeLessThan(8);
      expect(Math.abs(tail[tail.length - 1].hdg - 90)).toBeLessThan(2);
    });
  }

  it('is just as steady at a 60 Hz render-frame cadence (as used in the sim loop)', () => {
    const { m, trace } = fly(SU27, 5750, 6000, 230, 240, 1 / 60);
    expect(m.crashed).toBe(false);
    const alts = trace.filter((p) => p.t > 150).map((p) => p.alt);
    expect(Math.max(...alts) - Math.min(...alts)).toBeLessThan(12);
    for (const p of trace) expect(Math.abs(p.pitch)).toBeLessThan(14);
  });
});

describe('autoland (intercept, 3 deg glide, flare, rollout)', () => {
  // start poses in the runway frame: metres before the threshold, metres right of the centreline, heading offset
  const scenarios = [
    { cfg: SU27, rwy: 0, back: 14000, right: 2500, dh: -30 },
    { cfg: SU27, rwy: 0, back: 18000, right: -4000, dh: 20 },
    { cfg: F117, rwy: 0, back: 20000, right: 3000, dh: -20 },
    { cfg: SU27, rwy: 15, back: 22000, right: 5000, dh: 30 }, // Dalaman-like heading, wide entry
    { cfg: SU27, rwy: 260, back: 16000, right: -2500, dh: 10 }, // Innsbruck-like heading
    { cfg: F117, rwy: 260, back: 25000, right: 3500, dh: -40 },
    // arrivals from the side / past the field: need a pattern (offset leg, base turn), not a straight-in
    { cfg: SU27, rwy: 15, back: 8500, right: 12000, dh: 45 }, // the live Dalaman case
    { cfg: SU27, rwy: 260, back: -3000, right: 2000, dh: 90 }, // overhead, past the threshold
    { cfg: F117, rwy: 15, back: -6000, right: -1500, dh: 180 }, // past the field, flying the reciprocal
  ];
  for (const s of scenarios) {
    it(`${s.cfg.name} rwy ${s.rwy}: ${s.back} m back, ${s.right} m right lands and stops on the runway`, () => {
      const H = (s.rwy * Math.PI) / 180;
      const ux = Math.sin(H), uz = -Math.cos(H);
      const rx = Math.cos(H), rz = Math.sin(H);
      const x0 = -ux * s.back + rx * s.right;
      const z0 = -uz * s.back + rz * s.right;
      const m = new FlightModel(s.cfg);
      m.spawnAir(vec3.fromValues(x0, 500, z0), s.rwy + s.dh);
      const ap = new Autopilot();
      ap.startLanding(m, 0, 0, s.rwy);
      let touchSink = 0;
      let maxCross = 0;
      let touchAlong = 0;
      for (let t = 0; t < 1800; t += PHYSICS_STEP) {
        const c = ap.update(PHYSICS_STEP, m, { ...base, gearDown: true });
        m.update(PHYSICS_STEP, c);
        if (m.crashed) break;
        const along = m.pos[0] * ux + m.pos[2] * uz;
        const cross = m.pos[0] * rx + m.pos[2] * rz;
        if (m.onGround && touchSink === 0) {
          touchSink = m.touchdownSink;
          touchAlong = along;
        }
        if (ap.landing === 'rollout') maxCross = Math.max(maxCross, Math.abs(cross));
        if (ap.landing === 'rollout' && m.speed < 1) break;
      }
      expect(m.crashed, m.crashReason).toBe(false);
      expect(m.onGround).toBe(true);
      expect(m.speed).toBeLessThan(2);
      expect(touchSink).toBeLessThan(2.5);
      expect(maxCross).toBeLessThan(70); // runway is ~45 m wide; allow a little shoulder
      expect(touchAlong).toBeGreaterThan(0); // not short of the threshold
      if (process.env.AL_LOG) console.log('TD', s.cfg.id, s.rwy, 'along', touchAlong.toFixed(0), 'sink', touchSink.toFixed(2));
      expect(touchAlong).toBeLessThan(2000);
    });
  }
});
