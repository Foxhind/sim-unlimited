import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { distText, eteText, fmaText, navLines, type HudState } from '../src/flight/hud';
import { F117 } from '../src/flight/aircraft';
import { FlightModel } from '../src/flight/model';
import { cdi, NavDb, offsetLatLon, receive } from '../src/flight/navaids';

const THR = { lat: 47.26161, lon: 11.35703 };

function state(over: Partial<HudState>): HudState {
  const model = new FlightModel(F117);
  model.spawnAir(vec3.fromValues(0, 1200, 0), 261);
  return {
    model, controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.5, gearDown: true, flaps: false, brakes: false, speedbrake: false },
    camera: 'cockpit', units: 'metric', now: 0, soundOn: true, ...over,
  };
}

describe('HUD nav text', () => {
  const db = new NavDb();
  const ils = db.addIls({ name: 'LOWI', ...THR, course: 261, lenM: 2000 })!;
  const own = offsetLatLon(THR, 81, 9000);
  const rx = receive(ils, own, 1100);
  const nav = { nav1: { rx, cdi: cdi(rx, 0, own, 1100) }, adf: null, ra: 500, vapp: 100 };

  it('formats distance and time to go', () => {
    expect(distText(12345, 'metric')).toBe('12.3 KM');
    expect(distText(18520, 'imperial')).toBe('10.0 NM');
    expect(eteText(6000, 100)).toBe('1:00');
    expect(eteText(6000, 5)).toBe('');
  });

  it('annunciates the autopilot modes in the chosen units', () => {
    const ap = { altitude: 3048, speed: 102.9, heading: 5 };
    expect(fmaText(state({ autopilot: ap }), 'en')).toBe('AP  SPD 370  HDG 005  ALT 3048');
    expect(fmaText(state({ autopilot: ap, units: 'imperial' }), 'en')).toBe('AP  SPD 200  HDG 005  ALT 10000');
    expect(fmaText(state({ autopilot: { ...ap, lateral: 'NAV' }, nav }), 'en')).toContain(`LOC ${ils.ident}`);
    expect(fmaText(state({ autopilot: { ...ap, mode: 'final' }, nav }), 'en')).toBe(`AP  SPD 370  LOC ${ils.ident}  G/S`);
    expect(fmaText(state({ autopilot: null }), 'en')).toBe('');
  });

  it('lists NAV1 with course, DME and, in APP, the distance to the threshold', () => {
    const lines = navLines(state({ nav, hudMode: 'APP' }), 'en').map((l) => l.text);
    expect(lines[0]).toBe(`NAV1 ILS 26 ${ils.ident} ${ils.freq.toFixed(2)}`);
    expect(lines[1]).toBe('CRS 261');
    expect(lines[2]).toMatch(/^DME 9\.\d KM/);
    expect(lines[3]).toMatch(/^THR 9\.0 KM$/);
    expect(navLines(state({ nav, hudMode: 'NAV' }), 'en')).toHaveLength(3);
  });

  it('flags a tuned station that is not received', () => {
    const far = offsetLatLon(THR, 261, 30000); // behind the runway
    const r = receive(ils, far, 1000);
    const lines = navLines(state({ nav: { ...nav, nav1: { rx: r, cdi: cdi(r, 0, far, 1000) } } }), 'en');
    expect(lines[0].warn).toBe(true);
    expect(lines[1]).toEqual({ text: 'NO SIGNAL', warn: true });
  });
});
