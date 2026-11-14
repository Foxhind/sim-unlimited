import { describe, expect, it } from 'vitest';
import { parseMapLink } from '../src/ui/map-links';
import { tileCenter } from '../src/world/geodesy';

const near = (text: string, lat: number, lon: number, zoom?: number) => {
  const p = parseMapLink(text);
  expect(p, text).not.toBeNull();
  expect(p!.lat).toBeCloseTo(lat, 4);
  expect(p!.lon).toBeCloseTo(lon, 4);
  if (zoom === undefined) expect(p!.zoom).toBeUndefined();
  else expect(p!.zoom).toBeCloseTo(zoom, 1);
  return p!;
};

describe('Google Maps', () => {
  it('viewport @lat,lon,zoom', () => {
    expect(near('https://www.google.com/maps/@47.2692124,11.4041024,14z', 47.2692124, 11.4041024, 14).source).toBe('google');
    near('https://www.google.de/maps/@47.26,11.39,15.5z?entry=ttu', 47.26, 11.39, 15.5);
  });
  it('place: the pin !3d!4d wins over the viewport', () => {
    near(
      'https://www.google.com/maps/place/Innsbruck,+Austria/@47.2854,11.2295,11z/data=!3m1!4b1!4m6!3m5!1s0x479d6c!8m2!3d47.2692124!4d11.4041024!16zL20vMGZw?entry=ttu',
      47.2692124, 11.4041024, 11,
    );
  });
  it('3D view in metres gives an approximate zoom', () => {
    const p = near('https://www.google.com/maps/@45.9763,7.6586,2500m/data=!3m1!1e3', 45.9763, 7.6586, Math.log2((40075016.686 * Math.cos((45.9763 * Math.PI) / 180)) / 2500));
    expect(p.zoom!).toBeGreaterThan(13);
  });
  it('query parameters and search paths', () => {
    near('https://maps.google.com/?q=47.26,11.39', 47.26, 11.39);
    near('https://www.google.com/maps/search/?api=1&query=36.1,-112.1', 36.1, -112.1);
    near('https://www.google.com/maps/search/47.26,+11.39', 47.26, 11.39);
    near('https://www.google.com/maps/dir/?api=1&destination=43.35,42.44', 43.35, 42.44);
  });
  it('unwraps the EU consent page', () => {
    near('https://consent.google.com/m?continue=https://www.google.com/maps/@47.26,11.39,12z&gl=AT', 47.26, 11.39, 12);
  });
});

describe('Apple Maps', () => {
  it('ll / coordinate / q with z or span', () => {
    expect(near('https://maps.apple.com/?ll=47.26,11.39&z=13', 47.26, 11.39, 13).source).toBe('apple');
    near('https://maps.apple.com/place?coordinate=45.9763,7.6586&name=Matterhorn', 45.9763, 7.6586);
    near('https://maps.apple.com/?q=36.1,-112.1', 36.1, -112.1);
    near('https://maps.apple.com/?address=Innsbruck&ll=47.26,11.39&spn=0.0439453125,0.1', 47.26, 11.39, 12);
  });
});

describe('Yandex Maps (lon,lat order)', () => {
  it('ll, pt and whatshere', () => {
    expect(near('https://yandex.ru/maps/?ll=11.39%2C47.26&z=13', 47.26, 11.39, 13).source).toBe('yandex');
    near('https://yandex.com/maps/?ll=37.6,55.7&pt=42.44,43.35,pm2rdm~37.6,55.7&z=12', 43.35, 42.44, 12);
    near('https://yandex.ru/maps/213/moscow/?whatshere%5Bpoint%5D=37.617635%2C55.755814&whatshere%5Bzoom%5D=16', 55.755814, 37.617635, 16);
    near('https://yandex.ru/maps/?rtext=55.7,37.6~43.35,42.44&rtt=auto', 43.35, 42.44);
  });
});

describe('OpenStreetMap', () => {
  it('#map= and markers', () => {
    expect(near('https://www.openstreetmap.org/#map=14/47.2692/11.4041', 47.2692, 11.4041, 14).source).toBe('osm');
    near('https://www.openstreetmap.org/?mlat=45.9763&mlon=7.6586#map=13/45.97/7.65', 45.9763, 7.6586, 13);
    near('https://www.openstreetmap.org/?lat=36.1&lon=-112.1&zoom=12', 36.1, -112.1, 12);
    near('openstreetmap.org/#map=10/-3.07/37.35', -3.07, 37.35, 10);
  });
});

describe('plain coordinates', () => {
  it('geo: URI and "lat, lon"', () => {
    near('geo:47.26,11.39?z=14', 47.26, 11.39, 14);
    expect(near('47.26, 11.39', 47.26, 11.39).source).toBe('coords');
    near('-3.0674 37.3556', -3.0674, 37.3556);
  });
});

describe('rejects', () => {
  it('unrelated text, other sites and out-of-range numbers', () => {
    for (const t of ['hello', 'https://example.com/?ll=1,2', 'https://www.google.com/search?q=47,11', '95, 11', '47.26', '']) {
      expect(parseMapLink(t), t).toBeNull();
    }
  });
});

describe('hosts', () => {
  it('only real map domains, and short links are not resolved', () => {
    expect(parseMapLink('https://maps.google.com.evil.example/?q=47,11')).toBeNull();
    expect(parseMapLink('https://yandex.ru.evil.example/maps/?ll=11,47')).toBeNull();
    expect(parseMapLink('https://maps.app.goo.gl/AbCdEf123')).toBeNull();
    expect(parseMapLink('https://yandex.ru/maps/-/CDxQ5Z~a')).toBeNull();
    near('https://www.google.co.uk/maps/@51.5,-0.12,12z', 51.5, -0.12, 12);
    near('https://yandex.com.tr/maps/?ll=29,41&z=10', 41, 29, 10);
  });
});

describe('links of the project', () => {
  it('simulator: point and altitude, on any host', () => {
    const p = near('http://localhost:5173/?temp=-20#61.75958,51.05216,845,93,su27,1794645339', 61.75958, 51.05216);
    expect(p.source).toBe('project');
    expect(p.alt).toBe(845);
    expect(near('https://sim.example.org/index.html#47.26,11.39', 47.26, 11.39).alt).toBeUndefined();
    // air start: the altitude is left out
    expect(near('https://sim.example.org/#47.26,11.39,,180,f117', 47.26, 11.39).alt).toBeUndefined();
  });
  it('relief inspector: point, view width and camera altitude', () => {
    for (const page of ['relief', 'relief.html']) {
      const p = parseMapLink(`http://localhost:5173/${page}#47.26650,11.40138,14.27,1500`)!;
      expect(p.lat).toBeCloseTo(47.2665, 4);
      expect(p.spanM).toBeCloseTo(14270, 0);
      expect(p.alt).toBe(1500);
      // a view three tiles wide: the zoom of those tiles
      expect(p.zoom).toBeCloseTo(Math.log2((40075016.686 * Math.cos((47.2665 * Math.PI) / 180) * 3) / 14270), 3);
    }
  });
  it('tile links of both inspectors: the tile and its centre', () => {
    for (const page of ['inspector.html', 'inspector', 'relief.html']) {
      const tile = { z: 12, x: 2177, y: 1436 };
      const c = tileCenter(tile);
      const p = near(`http://localhost:5173/${page}#12/2177/1436`, c.lat, c.lon, 12);
      expect(p.tile).toEqual(tile);
    }
    expect(parseMapLink('http://localhost:5173/inspector.html#12/5000/1436')).toBeNull(); // no such tile
  });
  it('is not fooled by other pages with a similar hash', () => {
    expect(parseMapLink('https://example.org/docs/page#47.26,11.39')).toBeNull();
    expect(parseMapLink('https://example.org/#section')).toBeNull();
    expect(parseMapLink('http://localhost:5173/#12/2177/1436')).toBeNull();
    expect(parseMapLink('localhost:5173/#47.26,11.39')).toBeNull(); // not pasted as a link
  });
});
