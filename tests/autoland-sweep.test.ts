import { expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Autopilot } from '../src/flight/autopilot';
import { F117, SU27 } from '../src/flight/aircraft';
import { FlightModel, PHYSICS_STEP } from '../src/flight/model';
// Randomised (seeded) approach geometries: the autolander must put the aircraft on the runway for the
// large majority. Entries that need a turn radius the aircraft does not have (3-4 km off, pointing away)
// are physically infeasible and are the expected few misses.
it('autoland succeeds from >= 90% of randomised entry geometries', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const base = { pitch:0, roll:0, yaw:0, throttle:0.6, gearDown:true, flaps:false, brakes:false, speedbrake:false };
  let ok = 0, n = 0; const bad: string[] = [];
  for (let k = 0; k < 40; k++) {
    const cfg = k % 2 ? F117 : SU27; const rwy = Math.floor(rnd()*360); const back = 12000 + rnd()*18000; const right = (rnd()-0.5)*8000; const dh = (rnd()-0.5)*120;
    const H = rwy*Math.PI/180, ux=Math.sin(H), uz=-Math.cos(H), rx=Math.cos(H), rz=Math.sin(H);
    const m = new FlightModel(cfg); m.spawnAir(vec3.fromValues(-ux*back+rx*right, 500, -uz*back+rz*right), rwy+dh);
    const ap = new Autopilot(); ap.startLanding(m, 0, 0, rwy);
    let maxCross = 0;
    for (let t = 0; t < 1200; t += PHYSICS_STEP) {
      m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, base));
      if (m.crashed) break;
      if (ap.landing === 'rollout') maxCross = Math.max(maxCross, Math.abs(m.pos[0]*rx+m.pos[2]*rz));
      if (ap.landing === 'rollout' && m.speed < 1) break;
    }
    n++; const good = !m.crashed && m.onGround && m.speed < 2 && maxCross < 70; if (good) ok++; else bad.push(`${cfg.id} rwy${rwy} back${back.toFixed(0)} right${right.toFixed(0)} dh${dh.toFixed(0)} ${m.crashed ? m.crashReason : 'cross' + maxCross.toFixed(0) + (m.onGround ? '' : ' airborne')}`);
  }
  expect(ok / n, bad.join('; ')).toBeGreaterThanOrEqual(0.9);
});
