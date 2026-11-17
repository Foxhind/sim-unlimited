import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Air, newAirSample, type AirConditions } from '../src/flight/air';
import { atmosphere } from '../src/flight/atmosphere';
import { Autopilot } from '../src/flight/autopilot';
import { F117, SU27, aircraftMesh, PART_IDS } from '../src/flight/aircraft';
import { collideAircraft, hitSpheres } from '../src/flight/collision';
import { damageLine } from '../src/flight/hud';
import { FlightModel, PHYSICS_STEP, attitudeQuat, type FlightControls, type GroundContact } from '../src/flight/model';
import { airConditions, parseWeather } from '../src/world/weather';

const idle: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, gearDown: false, flaps: false, brakes: false, speedbrake: false,
};
type Probe = (p: vec3) => GroundContact;

function run(m: FlightModel, seconds: number, c: Partial<FlightControls> | ((t: number) => Partial<FlightControls>) = {}, air?: Air, probe?: Probe, each?: (t: number) => void): void {
  const steps = Math.round(seconds / PHYSICS_STEP);
  for (let i = 0; i < steps && !m.crashed; i++) {
    const t = i * PHYSICS_STEP;
    m.update(PHYSICS_STEP, { ...idle, ...(typeof c === 'function' ? c(t) : c) }, probe, air);
    each?.(t);
  }
}

const WEST_10: AirConditions = { elevation: 0, tempC: 15, windFromDeg: 270, windMs: 10, gustMs: 10, lat: 50 };

describe('air: temperature, pressure and wind by height', () => {
  it('without weather it is the calm standard atmosphere', () => {
    const s = new Air().sample(newAirSample(), 3000, 3000, 200, PHYSICS_STEP);
    const isa = atmosphere(3000);
    expect(s.density).toBeCloseTo(isa.density, 6);
    expect(s.temperature).toBeCloseTo(isa.temperature, 6);
    expect(vec3.length(s.wind)).toBe(0);
  });

  it('a hot day thins the air and raises the speed of sound; surface pressure scales the column', () => {
    const hot = new Air({ ...WEST_10, tempC: 40, windMs: 0, gustMs: 0 }).sample(newAirSample(), 0, 0);
    const cold = new Air({ ...WEST_10, tempC: -30, windMs: 0, gustMs: 0 }).sample(newAirSample(), 0, 0);
    expect(hot.density).toBeLessThan(1.225 * 0.93);
    expect(cold.density).toBeGreaterThan(1.225 * 1.15);
    expect(hot.speedOfSound).toBeGreaterThan(cold.speedOfSound + 35);
    const low = new Air({ ...WEST_10, pressureHpa: 980 }).sample(newAirSample(), 2000, 2000);
    expect(low.pressure / atmosphere(2000).pressure).toBeCloseTo(98000 / 101325, 4);
  });

  it('takes the temperature at flight level from the levels aloft, not from a fixed lapse rate', () => {
    // an inversion: warmer at 1.5 km than on the ground
    const air = new Air({ ...WEST_10, tempC: -5, levels: [{ alt: 1500, tempC: 3, windFromDeg: 300, windMs: 20 }, { alt: 5500, tempC: -22, windFromDeg: 320, windMs: 35 }] });
    const s = newAirSample();
    expect(air.sample(s, 1500, 1500).temperature - 273.15).toBeCloseTo(3, 5);
    expect(air.sample(s, 3500, 3500).temperature - 273.15).toBeCloseTo(-9.5, 5);
    // above the highest level: that level's offset from standard is kept
    const top = air.sample(s, 9000, 9000).temperature;
    expect(top - atmosphere(9000).temperature).toBeCloseTo(-22 + 273.15 - atmosphere(5500).temperature, 5);
  });

  it('wind blows from its bearing, dies toward the ground and follows the levels aloft', () => {
    const air = new Air({ ...WEST_10, levels: [{ alt: 3000, tempC: -5, windFromDeg: 0, windMs: 30 }] });
    const s = newAirSample();
    air.sample(s, 10, 10);
    expect(s.wind[0]).toBeCloseTo(10, 5); // from the west: the air moves east
    expect(s.wind[2]).toBeCloseTo(0, 5);
    expect(air.sample(s, 1, 1).wind[0]).toBeLessThan(7.5);
    air.sample(s, 3000, 3000);
    expect(s.wind[0]).toBeCloseTo(0, 5);
    expect(s.wind[2]).toBeCloseTo(30, 5); // from the north: the air moves south (+z)
    // synthesised profile when there is nothing aloft: stronger and veered with height
    const [e, n] = new Air(WEST_10).meanWind(1510, 1500);
    expect(Math.hypot(e, n)).toBeGreaterThan(18);
    expect(n).toBeLessThan(-5);
  });

  it('gusts: zero-mean, sized by the gust spread, repeatable, rougher near the ground', () => {
    const rms = (agl: number): number => {
      const air = new Air({ ...WEST_10, gustMs: 19 });
      const s = newAirSample();
      let sum = 0, mean = 0;
      const n = 120 * 120;
      for (let i = 0; i < n; i++) {
        air.sample(s, agl + 10, agl, 100, PHYSICS_STEP);
        const [e] = air.meanWind(agl + 10, agl);
        sum += (s.wind[0] - e) ** 2;
        mean += s.wind[0] - e;
      }
      expect(Math.abs(mean / n)).toBeLessThan(1.2);
      return Math.sqrt(sum / n);
    };
    const low = rms(100);
    expect(low).toBeGreaterThan(1.5);
    expect(low).toBeLessThan(5);
    expect(rms(100)).toBe(low);
    expect(rms(3000)).toBeLessThan(low * 0.6);
  });

  it('weather service data becomes air conditions; a forced temperature shifts the column', () => {
    const w = parseWeather({
      elevation: 578,
      current: {
        time: '2026-11-13T14:00', temperature_2m: 6.7, surface_pressure: 944.2, cloud_cover: 10,
        wind_speed_10m: 1.66, wind_direction_10m: 123, wind_gusts_10m: 3.2,
        temperature_850hPa: -0.7, wind_speed_850hPa: 0.9, wind_direction_850hPa: 225, geopotential_height_850hPa: 1429,
        temperature_500hPa: -21.2, wind_speed_500hPa: 8.75, wind_direction_500hPa: 310, geopotential_height_500hPa: 5502,
      },
    }, { lat: 47.26, lon: 11.34 })!;
    expect(w.elevation).toBe(578);
    expect(w.levels).toEqual([
      { alt: 1429, tempC: -0.7, windFromDeg: 225, windMs: 0.9 },
      { alt: 5502, tempC: -21.2, windFromDeg: 310, windMs: 8.75 },
    ]);
    const c = airConditions(w);
    expect(c).toMatchObject({ elevation: 578, tempC: 6.7, pressureHpa: 944.2, windMs: 1.66, lat: 47.26 });
    const air = new Air(c);
    expect(air.sample(newAirSample(), 5502, 4900).temperature - 273.15).toBeCloseTo(-21.2, 5);
    expect(airConditions(w, -20).tempC).toBe(-20);
    expect(airConditions(w, -20).levels![0].tempC).toBeCloseTo(-0.7 - 26.7, 5);
    expect(airConditions({ ...w, elevation: undefined }, undefined, 432).elevation).toBe(432);
  });
});

describe('flight through moving air', () => {
  it('a steady wind carries the aircraft: airspeed stays, ground speed and track change', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0); // heading north
    const air = new Air({ ...WEST_10, windMs: 20, gustMs: 20, levels: [{ alt: 3000, tempC: -4.5, windFromDeg: 270, windMs: 20 }] });
    const ap = new Autopilot();
    ap.engage(m);
    const base = { ...idle, throttle: 0.6 };
    for (let t = 0; t < 60; t += PHYSICS_STEP) m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, base), undefined, air);
    expect(m.crashed).toBe(false);
    expect(Math.abs(m.airspeed - 175)).toBeLessThan(4); // the autopilot holds speed through the air
    expect(m.vel[0]).toBeGreaterThan(15); // and is carried east with it (side force is small, so it takes a while)
    expect(m.vel[0]).toBeLessThan(22);
    expect(m.pos[0]).toBeGreaterThan(600);
    expect(Math.abs(m.betaDeg)).toBeLessThan(1); // no sideslip: the air moves, the aircraft with it
    expect(m.trackDeg).toBeGreaterThan(4);
    expect(m.trackDeg).toBeLessThan(10);
    expect(Math.abs(m.headingDeg > 180 ? m.headingDeg - 360 : m.headingDeg)).toBeLessThan(2);
    expect(m.wind[0]).toBeCloseTo(20, 1);
  });

  it('thin hot air: longer takeoff roll than on a cold day', () => {
    const roll = (tempC: number): number => {
      const m = new FlightModel(F117);
      m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
      const air = new Air({ ...WEST_10, tempC, windMs: 0, gustMs: 0 });
      let rotated = false;
      for (let t = 0; t < 90 && m.pos[1] < 15; t += PHYSICS_STEP) {
        if (m.airspeed > 95) rotated = true;
        m.update(PHYSICS_STEP, { ...idle, gearDown: true, throttle: 1, pitch: rotated ? 0.4 : 0 }, undefined, air);
      }
      expect(m.crashed).toBe(false);
      expect(m.pos[1]).toBeGreaterThanOrEqual(15);
      return -m.pos[2];
    };
    const cold = roll(-25);
    const hot = roll(40);
    expect(hot).toBeGreaterThan(cold * 1.25);
  });

  it('a headwind shortens the takeoff run and reads on the airspeed while standing', () => {
    const m = new FlightModel(SU27);
    m.spawnGround(vec3.fromValues(0, 0, 0), 0, 0);
    const air = new Air({ ...WEST_10, windFromDeg: 0, windMs: 15, gustMs: 15 });
    run(m, 3, { gearDown: true, brakes: true }, air);
    expect(m.speed).toBeLessThan(0.5); // parked: the wheels hold it
    expect(m.airspeed).toBeGreaterThan(10);
    expect(Math.abs(m.headingDeg > 180 ? m.headingDeg - 360 : m.headingDeg)).toBeLessThan(1);
  });

  it('turbulence shakes the aircraft but the fly-by-wire keeps it upright', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 600, 0), 0);
    const air = new Air({ ...WEST_10, windMs: 12, gustMs: 24 });
    let gMin = 9, gMax = -9, bankMax = 0;
    run(m, 30, { throttle: 0.5 }, air, undefined, () => {
      gMin = Math.min(gMin, m.gLoad);
      gMax = Math.max(gMax, m.gLoad);
      bankMax = Math.max(bankMax, Math.abs(m.bankDeg));
    });
    expect(m.crashed).toBe(false);
    expect(gMax - gMin).toBeGreaterThan(0.3); // it is felt
    expect(gMax).toBeLessThan(3);
    expect(bankMax).toBeLessThan(25);
    expect(m.damage).toHaveLength(0);
  });

  it('autoland in a gusty crosswind crabs down the centreline and stops on the runway', () => {
    for (const cfg of [SU27, F117]) {
      const m = new FlightModel(cfg);
      m.spawnAir(vec3.fromValues(1500, 500, 16000), 0); // 16 km south of the threshold, runway heading north
      const air = new Air({ ...WEST_10, windMs: 9, gustMs: 14 }); // from the left, across the runway
      const ap = new Autopilot();
      ap.startLanding(m, 0, 0, 0);
      let maxCross = 0, crab = 0;
      for (let t = 0; t < 1500; t += PHYSICS_STEP) {
        m.update(PHYSICS_STEP, ap.update(PHYSICS_STEP, m, { ...idle, gearDown: true, throttle: 0.6 }), undefined, air);
        if (m.crashed) break;
        if (ap.landing === 'final' && m.pos[2] < 3000 && m.pos[2] > 1000) crab = m.headingDeg > 180 ? m.headingDeg - 360 : m.headingDeg;
        if (ap.landing === 'rollout') maxCross = Math.max(maxCross, Math.abs(m.pos[0]));
        if (ap.landing === 'rollout' && m.speed < 1) break;
      }
      expect(m.crashed, `${cfg.id} ${m.crashReason}`).toBe(false);
      expect(m.onGround).toBe(true);
      expect(m.speed).toBeLessThan(2);
      expect(maxCross).toBeLessThan(70);
      expect(crab).toBeLessThan(-2); // nose into the wind from the west
      expect(m.touchdownSink).toBeLessThan(3);
    }
  });
});

describe('stall, spin and the fly-by-wire limits', () => {
  it('the limiter holds the angle of attack below the stall on both aircraft', () => {
    for (const cfg of [SU27, F117]) {
      const m = new FlightModel(cfg);
      m.spawnAir(vec3.fromValues(0, 4000, 0), 0);
      let aMax = 0;
      // firm pull short of the override, held until the speed has bled well down
      run(m, 6, { pitch: 0.8, throttle: 0.5 }, undefined, undefined, () => { aMax = Math.max(aMax, m.alphaDeg); });
      expect(aMax).toBeGreaterThan(cfg.fbw.alphaLimit - 3);
      expect(aMax).toBeLessThan(cfg.stallAlpha + 1);
      expect(m.damage).toHaveLength(0);
    }
  });

  it('the stick asks for load factor: half stick on the Su-27 is ~5 g at speed, never past the limit', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 2000, 0), 0);
    vec3.scale(m.vel, m.vel, 300 / m.speed);
    let gMax = 0;
    run(m, 2.5, { pitch: 0.5, throttle: 1 }, undefined, undefined, () => { gMax = Math.max(gMax, m.gLoad); });
    expect(m.gLoad).toBeGreaterThan(4.3);
    expect(m.gLoad).toBeLessThan(5.7);
    const f = new FlightModel(SU27);
    f.spawnAir(vec3.fromValues(0, 2000, 0), 0);
    vec3.scale(f.vel, f.vel, 300 / f.speed);
    run(f, 3, { pitch: 1, throttle: 1 }, undefined, undefined, () => { gMax = Math.max(gMax, f.gLoad); });
    expect(gMax).toBeGreaterThan(8);
    expect(gMax).toBeLessThan(10.5);
    expect(f.damage).toHaveLength(0);
  });

  it('Su-27 pulled through the limiter pitches far past the stall (cobra) and comes back when released', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 6000, 0), 0);
    let aMax = 0;
    run(m, 4, { pitch: 1 }, undefined, undefined, () => { aMax = Math.max(aMax, m.alphaDeg); });
    expect(aMax).toBeGreaterThan(45);
    expect(m.stall).toBe(true);
    expect(m.airspeed).toBeLessThan(140); // the airframe is a speed brake up there
    run(m, 12, { throttle: 0.6 });
    expect(Math.abs(m.alphaDeg)).toBeLessThan(12);
    expect(m.stall).toBe(false);
    expect(m.spin).toBe(false);
    // the F-117's computers cannot be overridden
    const f = new FlightModel(F117);
    f.spawnAir(vec3.fromValues(0, 6000, 0), 0);
    let fMax = 0;
    run(f, 6, { pitch: 1 }, undefined, undefined, () => { fMax = Math.max(fMax, f.alphaDeg); });
    expect(fMax).toBeLessThan(F117.stallAlpha);
  });

  const flatSpin = (cfg: typeof SU27): FlightModel => {
    const m = new FlightModel(cfg);
    m.spawnAir(vec3.fromValues(0, 11000, 0), 0);
    attitudeQuat(m.quat, -5, 0, 0);
    vec3.set(m.vel, 0, -60, -8); // falling almost straight down, nose near the horizon
    vec3.set(m.omega, 0, 2, 0); // turning left, a turn every three seconds
    return m;
  };

  it('Su-27 flat spin: keeps turning hands-off, nose up, sinking fast', () => {
    const m = flatSpin(SU27);
    run(m, 30);
    expect(m.spin).toBe(true);
    expect(m.omega[1]).toBeGreaterThan(0.8);
    expect(Math.abs(m.alphaDeg)).toBeGreaterThan(45);
    expect(m.verticalSpeed).toBeLessThan(-60);
    expect(m.airspeed).toBeLessThan(130);
    expect(m.damage).toHaveLength(0);
  });

  it('Su-27 flat spin: stick into the spin and opposite rudder break it within 15 s', () => {
    const m = flatSpin(SU27);
    run(m, 30);
    // turning left: stick left (with the spin), right rudder (against it)
    let out = -1;
    run(m, 25, { roll: -1, yaw: 1 }, undefined, undefined, (t) => {
      if (out < 0 && Math.abs(m.alphaDeg) < 15 && Math.abs(m.omega[1]) < 0.4) out = t;
    });
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(15);
    // then fly it out of the dive
    run(m, 25, { pitch: 0.5, throttle: 0.6 });
    expect(m.crashed).toBe(false);
    expect(m.stall).toBe(false);
    expect(m.verticalSpeed).toBeGreaterThan(-20);
  });

  it('F-117 has no flat spin: the same upset becomes a steep, nose-down spin that the same technique recovers', () => {
    const m = flatSpin(F117);
    let pitchSum = 0, n = 0;
    run(m, 30, {}, undefined, undefined, (t) => {
      if (t > 15) { pitchSum += m.pitchDeg; n++; }
    });
    expect(pitchSum / n).toBeLessThan(-20); // nose well below the horizon: steep, not flat
    expect(m.omega[1]).toBeLessThan(1.2); // and slower than it started
    let out = -1;
    run(m, 40, { roll: -1, yaw: 1 }, undefined, undefined, (t) => {
      if (out < 0 && Math.abs(m.alphaDeg) < 10 && m.airspeed > 150) out = t;
    });
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(35);
  });
});

describe('structure: overload, flutter, strikes, collisions', () => {
  it('a wing lets go when its load passes the ultimate, not at the limit load factor', () => {
    // thrown into the airflow at 25 deg angle of attack at 300 m/s near the ground: ~20 g for an instant
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 1500, 0), 0);
    attitudeQuat(m.quat, 25, 0, 0);
    vec3.set(m.vel, 0, 0, -300);
    run(m, 0.5, {});
    const causes = m.damage.map((d) => `${d.part}:${d.cause}`);
    expect(causes).toContain('wingL:overload');
    expect(causes).toContain('wingR:overload');
    expect(m.isLost('wingL')).toBe(true);
    expect(m.debris.length).toBeGreaterThanOrEqual(2);
  });

  it('diving past the never-exceed speed flutters the tail off, fin first', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    attitudeQuat(m.quat, -50, 0, 0);
    vec3.set(m.vel, 0, -398, -334); // 520 m/s down a 50 degree dive in full afterburner
    let at = -1;
    let easMax = 0;
    run(m, 4, { throttle: 1, pitch: -0.2 }, undefined, undefined, (t) => {
      easMax = Math.max(easMax, m.eas);
      if (at < 0 && m.damage.length > 0) at = t;
    });
    expect(easMax).toBeGreaterThan(SU27.vne * 1.1);
    expect(at).toBeGreaterThan(1);
    expect(m.damage[0]).toMatchObject({ part: 'finL', cause: 'flutter' });
  });

  it('with a wing gone the aircraft rolls toward it; at speed the pilot can still hold it', () => {
    const free = new FlightModel(SU27);
    free.spawnAir(vec3.fromValues(0, 4000, 0), 0);
    vec3.scale(free.vel, free.vel, 260 / free.speed);
    run(free, 1, { throttle: 0.8 });
    expect(free.detach('wingR', 'collision')).toBe(true);
    expect(free.detach('wingR', 'collision')).toBe(false);
    let rolled = 0;
    run(free, 2, { throttle: 0.8, roll: 1 }, undefined, undefined, () => { rolled = Math.max(rolled, free.bankDeg); });
    expect(rolled).toBeGreaterThan(40); // right wing missing, stick right: over it goes

    const held = new FlightModel(SU27);
    held.spawnAir(vec3.fromValues(0, 4000, 0), 0);
    vec3.scale(held.vel, held.vel, 260 / held.speed);
    run(held, 1, { throttle: 0.8 });
    held.detach('wingR', 'collision');
    let worst = 0;
    run(held, 20, () => ({ throttle: 0.9, roll: Math.max(-1, Math.min(1, -held.bankDeg * 0.05 + held.omega[2] * 0.3)) }), undefined, undefined, (t) => {
      if (t > 3) worst = Math.max(worst, Math.abs(held.bankDeg));
    });
    expect(held.crashed).toBe(false);
    expect(worst).toBeLessThan(30);
    expect(damageLine(held, 'ru')).toBe('ПОТЕРЯНО: ПРАВОЕ КРЫЛО');
    expect(damageLine(held, 'en')).toBe('LOST: RIGHT WING');
    expect(damageLine(new FlightModel(SU27), 'en')).toBe('');
  });

  it('a lost wing takes its mass: the centre of gravity moves to the other side, roll inertia drops, the airframe stays put', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    const pos = vec3.clone(m.pos);
    m.detach('wingL', 'collision');
    expect(m.mass).toBe(SU27.mass - SU27.partMass.wingL!);
    expect(m.cgShift[0]).toBeGreaterThan(0.2); // towards the right wing
    expect(m.inertia[2]).toBeLessThan(SU27.inertia[2] * 0.7);
    // the reference point followed the centre of gravity: the drawing sits where it was
    expect(m.pos[0] - pos[0]).toBeCloseTo(m.cgShift[0], 5);
    expect(m.meshCg[0]).toBeCloseTo(SU27.cg[0] + m.cgShift[0], 5);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    expect(m.mass).toBe(SU27.mass);
    expect([...m.cgShift]).toEqual([0, 0, 0]);
    expect(m.inertia).toEqual(SU27.inertia);
  });

  for (const cfg of [SU27, F117]) {
    it(`${cfg.id}: the body loses the lift the wings carried over onto it, so a wingless fuselage cannot hold height slow`, () => {
      // hands off, full power, 175 m/s: intact it holds or climbs; without wings it sinks (it used to climb)
      const fly = (lose: boolean): number => {
        const m = new FlightModel(cfg);
        m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
        vec3.scale(m.vel, m.vel, 175 / m.speed);
        if (lose) {
          m.detach('wingL', 'overload');
          m.detach('wingR', 'overload');
        }
        run(m, 20, { throttle: 1, gearDown: false });
        return m.pos[1];
      };
      expect(fly(true)).toBeLessThan(Math.min(3000, fly(false)) - 150);
    });
  }

  it('the pilot cannot hold a wingless Su-27 level at 120 m/s, but can at 220 m/s', () => {
    const level = (v: number): number => {
      const m = new FlightModel(SU27);
      m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
      vec3.scale(m.vel, m.vel, v / m.speed);
      m.detach('wingL', 'overload');
      m.detach('wingR', 'overload');
      let ip = 0;
      const cl = (x: number): number => Math.max(-1, Math.min(1, x));
      run(m, 30, () => {
        const dh = m.pos[1] - 3000;
        ip = cl(ip - 0.0005 * dh * PHYSICS_STEP);
        return { gearDown: false, pitch: cl(-0.004 * dh - 0.03 * m.vel[1] + ip), roll: cl(-m.bankDeg / 20), throttle: cl(0.6 + 0.05 * (v - m.airspeed)) };
      });
      return m.pos[1];
    };
    expect(level(120)).toBeLessThan(2600);
    expect(Math.abs(level(220) - 3000)).toBeLessThan(100);
  });

  it('clipping a building with a wingtip tears the wing off and slews the aircraft; the fuselage flies on', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 60, 0), 0);
    vec3.scale(m.vel, m.vel, 150 / m.speed);
    // a wall whose edge is 5 m right of the flight path: only the right wing reaches it
    const wall: Probe = (p) => ({ height: 0, water: false, building: p[0] > 5 && p[2] < -300 && p[2] > -340 });
    const v0 = m.speed;
    run(m, 3, { throttle: 0.6 }, undefined, wall);
    expect(m.crashed).toBe(false);
    expect(m.damage).toHaveLength(1);
    expect(m.damage[0]).toMatchObject({ part: 'wingR', cause: 'strike' });
    expect(m.speed).toBeLessThan(v0);
    // straight into it: no survivors
    const c = new FlightModel(SU27);
    c.spawnAir(vec3.fromValues(8, 60, 0), 0);
    run(c, 3, { throttle: 0.6 }, undefined, wall);
    expect(c.crashReason).toBe('BUILDING STRIKE');
  });

  it('dragging a wingtip over rising ground loses the wing; nose first is fatal', () => {
    const m = new FlightModel(F117);
    m.spawnAir(vec3.fromValues(0, 30, 0), 0);
    // a bank running along the right side, higher than the wingtip
    const bank: Probe = (p) => ({ height: p[0] > 5 ? 34 : 0, water: false, building: false });
    run(m, 1, { throttle: 0.6 }, undefined, bank);
    expect(m.damage[0]).toMatchObject({ part: 'wingR', cause: 'strike' });
    const n = new FlightModel(F117);
    n.spawnAir(vec3.fromValues(0, 30, 0), 0);
    const cliff: Probe = (p) => ({ height: p[2] < -211 ? 200 : 0, water: false, building: false });
    run(n, 2, { throttle: 0.6 }, undefined, cliff);
    expect(n.crashed).toBe(true);
    expect(n.crashReason).toBe('TERRAIN IMPACT');
  });

  it('two aircraft: a wingtip touch costs each a wing, a fuselage hit destroys both', () => {
    const pair = (dx: number, dy: number): [FlightModel, FlightModel] => {
      const a = new FlightModel(SU27);
      const b = new FlightModel(SU27);
      a.spawnAir(vec3.fromValues(0, 3000, 0), 0);
      b.spawnAir(vec3.fromValues(dx, 3000 + dy, -2000), 180); // head-on, 2 km apart, 350 m/s closing
      return [a, b];
    };
    const fly = (a: FlightModel, b: FlightModel): ReturnType<typeof collideAircraft> => {
      for (let t = 0; t < 8; t += PHYSICS_STEP) {
        a.update(PHYSICS_STEP, { ...idle, throttle: 0.5 });
        b.update(PHYSICS_STEP, { ...idle, throttle: 0.5 });
        const hit = collideAircraft(a, b, PHYSICS_STEP);
        if (hit) return hit;
      }
      return null;
    };
    // head-on and 13.5 m to the side: each has the other on its right, so the right wingtips meet
    const [a, b] = pair(13.5, 0);
    const hit = fly(a, b);
    expect(hit).toEqual({ a: 'wingR', b: 'wingR' });
    expect(a.crashed || b.crashed).toBe(false);
    expect(a.isLost('wingR') && b.isLost('wingR')).toBe(true);
    expect(a.damage[0].cause).toBe('collision');

    const [c, d] = pair(0.5, 0.3);
    expect(fly(c, d)).toEqual({ a: null, b: null });
    expect(c.crashReason).toBe('MIDAIR COLLISION');
    expect(d.crashed).toBe(true);

    const [e, f] = pair(40, 0);
    expect(fly(e, f)).toBeNull();
    expect(e.damage.length + f.damage.length).toBe(0);
  });

  it('collision spheres and mesh part tags cover every separable part', () => {
    for (const cfg of [SU27, F117]) {
      const { spheres, bound } = hitSpheres(cfg);
      expect(bound).toBeGreaterThan(10);
      expect(bound).toBeLessThan(18);
      const mesh = aircraftMesh(cfg.id);
      expect(mesh.parts.length).toBe(mesh.ramps.length);
      for (const p of cfg.parts) {
        expect(spheres.filter((s) => s.part === p.id)).toHaveLength(2);
        const tag = PART_IDS.indexOf(p.id) + 1;
        expect(mesh.parts.filter((t) => t === tag).length).toBeGreaterThanOrEqual(3);
        expect(cfg.surfaces.some((s) => s.part === p.id)).toBe(true);
      }
      expect(mesh.parts.filter((t) => t === 0).length).toBeGreaterThan(mesh.parts.length / 2);
    }
  });

  it('a step costs well under a tenth of a millisecond', () => {
    const m = new FlightModel(SU27);
    m.spawnAir(vec3.fromValues(0, 3000, 0), 0);
    const air = new Air({ ...WEST_10, gustMs: 16 });
    run(m, 5, { throttle: 0.6 }, air); // warm up
    const t0 = performance.now();
    const n = 120 * 60;
    for (let i = 0; i < n; i++) m.update(PHYSICS_STEP, { ...idle, throttle: 0.6 }, undefined, air);
    const perStep = (performance.now() - t0) / n;
    expect(perStep).toBeLessThan(0.1);
  });
});
