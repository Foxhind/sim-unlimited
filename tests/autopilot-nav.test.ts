import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Autopilot } from '../src/flight/autopilot';
import { F117, SU27 } from '../src/flight/aircraft';
import { FlightModel, PHYSICS_STEP, type FlightControls } from '../src/flight/model';

const base: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0.6, gearDown: false, flaps: false, brakes: false, speedbrake: false,
};

describe('autopilot NAV mode', () => {
  for (const cfg of [F117, SU27]) {
    it(`${cfg.name}: intercepts and holds a course from 5 km off it`, () => {
      // course 030 through the world origin; start 5 km right of it, heading 060 (away from it)
      const C = 30;
      const Cr = (C * Math.PI) / 180;
      const right = [Math.cos(Cr), Math.sin(Cr)];
      const m = new FlightModel(cfg);
      m.spawnAir(vec3.fromValues(right[0] * 5000, 2500, right[1] * 5000), 60);
      const ap = new Autopilot();
      ap.engage(m);
      ap.lateral = 'NAV';
      const xtk = (): number => m.pos[0] * right[0] + m.pos[2] * right[1];
      let maxLate = 0;
      const steps = Math.round(300 / PHYSICS_STEP);
      for (let i = 0; i < steps; i++) {
        ap.nav = { course: C, xtkM: xtk() };
        m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, base));
        if (i * PHYSICS_STEP > 220) maxLate = Math.max(maxLate, Math.abs(xtk()));
      }
      expect(maxLate).toBeLessThan(150);
      expect(Math.abs(((m.trackDeg - C + 540) % 360) - 180)).toBeLessThan(4);
      expect(Math.abs(m.pos[1] - 2500)).toBeLessThan(60);
    });
  }
});
