import { describe, expect, it } from 'vitest';
import { cdi, ilsFreq, NavDb, ndbFreq, offsetLatLon, receive, vorFreq, type Navaid } from '../src/flight/navaids';

const STN = { lat: 47.26, lon: 11.34 };

function vor(): Navaid {
  return { id: 'v', kind: 'VOR', ident: 'OWI', name: 'LOWI', freq: 113.4, lat: STN.lat, lon: STN.lon, dme: true, rangeM: 200000 };
}

describe('frequencies', () => {
  it('stay in their real bands and are stable', () => {
    for (const k of ['a', 'LOWI', 'LTBS', 'x|y|z']) {
      expect(vorFreq(k)).toBeGreaterThanOrEqual(112);
      expect(vorFreq(k)).toBeLessThanOrEqual(117.95);
      const f = ilsFreq(k);
      expect(f).toBeGreaterThanOrEqual(108.1);
      expect(f).toBeLessThan(112);
      expect(Math.round(f * 10) % 2).toBe(1); // odd tenths are ILS channels
      expect(ndbFreq(k)).toBeGreaterThanOrEqual(200);
      expect(ndbFreq(k)).toBeLessThan(500);
      expect(vorFreq(k)).toBe(vorFreq(k));
    }
  });
});

describe('VOR', () => {
  it('reads bearing, radial and TO/FROM with the needle pointing to the course', () => {
    // aircraft 20 km south of the station, a bit west of the 180 radial
    const own = offsetLatLon(offsetLatLon(STN, 180, 20000), 270, 700);
    const rx = receive(vor(), own, 3000);
    expect(rx.inRange).toBe(true);
    expect(rx.bearing).toBeGreaterThan(0);
    expect(rx.bearing).toBeLessThan(5);
    expect(Math.abs(rx.distM - 20012)).toBeLessThan(80);
    // inbound on course 360: TO, the course line is to the right
    const inbound = cdi(rx, 0, own, 3000);
    expect(inbound.toFrom).toBe('TO');
    expect(inbound.dots).toBeGreaterThan(0.8);
    expect(inbound.xtkM).toBeLessThan(-600); // aircraft left of the course
    // outbound on the 180 radial: FROM, the course line is to the left (we are right of it)
    const outbound = cdi(rx, 180, own, 3000);
    expect(outbound.toFrom).toBe('FROM');
    expect(outbound.dots).toBeLessThan(-0.8);
    expect(outbound.xtkM).toBeGreaterThan(600);
  });

  it('drops out beyond the radio horizon', () => {
    const own = offsetLatLon(STN, 90, 120000);
    expect(receive(vor(), own, 200).inRange).toBe(false);
    expect(receive(vor(), own, 3000).inRange).toBe(true);
  });
});

describe('ILS', () => {
  const db = new NavDb();
  const ils = db.addIls({ name: 'LOWI', lat: STN.lat, lon: STN.lon, course: 260, lenM: 2000 })!;

  it('is centred on the extended centreline on the 3 deg path', () => {
    const own = offsetLatLon(STN, 80, 8000); // 8 km out on the approach side
    const alt = Math.tan((3 * Math.PI) / 180) * (8000 + 300);
    const rx = receive(ils, own, alt);
    expect(rx.inRange).toBe(true);
    const c = cdi(rx, 0, own, alt);
    expect(Math.abs(c.dots)).toBeLessThan(0.05);
    expect(Math.abs(c.gsDots!)).toBeLessThan(0.05);
    expect(Math.abs(c.thrDistM! - 8000)).toBeLessThan(30);
  });

  it('says fly right / fly up when left of and below the path', () => {
    // approach course 260 (heading west-ish): left of it is to the south
    const own = offsetLatLon(offsetLatLon(STN, 80, 8000), 170, 150);
    const c = cdi(receive(ils, own, 200), 0, own, 200);
    expect(c.dots).toBeGreaterThan(0.5);
    expect(c.xtkM).toBeLessThan(-100);
    expect(c.gsDots!).toBeGreaterThan(1);
    const high = cdi(receive(ils, own, 800), 0, own, 800);
    expect(high.gsDots!).toBeLessThan(-1);
  });

  it('is not received from behind the runway', () => {
    const own = offsetLatLon(STN, 260, 10000);
    expect(receive(ils, own, 1000).inRange).toBe(false);
  });

  it('makes one ILS per runway end and no duplicates', () => {
    const d = new NavDb();
    const a = offsetLatLon(STN, 80, 1000);
    const b = offsetLatLon(STN, 260, 1000);
    d.addRunway([[a.lon, a.lat], [b.lon, b.lat]], { ref: '08/26', surface: 'asphalt' }, 'LOWI');
    d.addRunway([[b.lon, b.lat], [a.lon, a.lat]], { ref: '08/26' }, 'LOWI');
    const ils = d.all().filter((n) => n.kind === 'ILS');
    expect(ils).toHaveLength(2);
    expect(ils.map((n) => n.rwy).sort()).toEqual(['08', '26']);
    d.addRunway([[a.lon, a.lat], [STN.lon, STN.lat]], { surface: 'grass' });
    expect(d.all()).toHaveLength(2);
  });

  it('gives airports a VOR/DME and airfields an NDB', () => {
    const d = new NavDb();
    d.addAirfield({ kind: 'airport', code: 'LOWI', lat: STN.lat, lon: STN.lon });
    d.addAirfield({ kind: 'airfield', name: 'Reutte', lat: 47.48, lon: 10.7 });
    d.addAirfield({ kind: 'heliport', name: 'H', lat: 47.1, lon: 11.1 });
    d.addAirfield({ kind: 'airport', code: 'LOWI', lat: STN.lat, lon: STN.lon });
    expect(d.all().map((n) => `${n.kind} ${n.ident}`).sort()).toEqual(['NDB RE', 'VOR OWI']);
  });
});
