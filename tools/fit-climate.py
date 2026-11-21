"""
The climate formula of the sim (src/engine/palette.ts CLIMATE), fitted to observed daily means.

  python3 tools/fit-climate.py fetch   # daily temperature_2m_mean 2014..2023 for POINTS from the
                                       # Open-Meteo Historical Weather API (ERA5), folded into one
                                       # value per day of the year → tests/fixtures/climate-normals.json
  python3 tools/fit-climate.py fit     # least squares (numpy, scipy) of
      T = a + b·cos φ − L·h − c·k·sin φ·cos(2π(d − d0)/365),  k = 1 north, k_s south
"""
import datetime, json, math, sys, time, urllib.request

FIXTURE = 'tests/fixtures/climate-normals.json'
POINTS = [
    ('Singapore', 1.35, 103.82),
    ('Quito', -0.18, -78.47),
    ('Nairobi', -1.29, 36.82),
    ('Manaus', -3.12, -60.02),
    ('Bogota', 4.71, -74.07),
    ('Lagos', 6.45, 3.39),
    ('Darwin', -12.46, 130.84),
    ('Lima', -12.05, -77.04),
    ('La Paz', -16.5, -68.15),
    ('Mumbai', 19.08, 72.88),
    ('Mexico City', 19.43, -99.13),
    ('Alice Springs', -23.7, 133.88),
    ('Riyadh', 24.71, 46.68),
    ('Lhasa', 29.65, 91.17),
    ('Cairo', 30.04, 31.24),
    ('Shanghai', 31.23, 121.47),
    ('Perth', -31.95, 115.86),
    ('Santiago', -33.45, -70.67),
    ('Sydney', -33.87, 151.21),
    ('Cape Town', -33.92, 18.42),
    ('Buenos Aires', -34.6, -58.38),
    ('Los Angeles', 34.05, -118.24),
    ('Tokyo', 35.68, 139.69),
    ('Denver', 39.74, -104.99),
    ('Beijing', 39.9, 116.4),
    ('Madrid', 40.42, -3.7),
    ('New York', 40.71, -74.0),
    ('Rome', 41.9, 12.5),
    ('Almaty', 43.24, 76.95),
    ('Christchurch', -43.53, 172.64),
    ('Jungfraujoch', 46.55, 7.98),
    ('Innsbruck', 47.26, 11.39),
    ('Ulaanbaatar', 47.92, 106.92),
    ('Paris', 48.86, 2.35),
    ('Vancouver', 49.28, -123.12),
    ('Winnipeg', 49.9, -97.14),
    ('London', 51.5, -0.12),
    ('Ushuaia', -54.8, -68.3),
    ('Moscow', 55.75, 37.62),
    ('Stockholm', 59.33, 18.07),
    ('Helsinki', 60.17, 24.94),
    ('Anchorage', 61.22, -149.9),
    ('Yakutsk', 62.03, 129.73),
    ('Reykjavik', 64.15, -21.94),
    ('Nuuk', 64.18, -51.72),
    ('Murmansk', 68.97, 33.08),
    ('Norilsk', 69.35, 88.2),
    ('Tromso', 69.65, 18.96),
    ('Utqiagvik', 71.29, -156.79),
    ('Summit Greenland', 72.58, -38.46),
    ('McMurdo', -77.85, 166.67),
    ('Vostok', -78.46, 106.84),
    ('Longyearbyen', 78.22, 15.65),
    ('Alert', 82.5, -62.35),
    ('South Pole', -89.99, 0.0),
]


def fetch():
    out = []
    for name, lat, lon in POINTS:
        url = ('https://archive-api.open-meteo.com/v1/archive?latitude=%s&longitude=%s'
               '&start_date=2014-01-01&end_date=2023-12-31&daily=temperature_2m_mean&timezone=GMT' % (lat, lon))
        while True:
            try:
                d = json.load(urllib.request.urlopen(url, timeout=60))
                break
            except Exception as e:  # minutely request limit: wait and try again
                print(name, e, file=sys.stderr)
                time.sleep(65)
        sums, cnt = [0.0] * 365, [0] * 365
        for t, v in zip(d['daily']['time'], d['daily']['temperature_2m_mean']):
            day = datetime.date.fromisoformat(t)
            if v is None or (day.month == 2 and day.day == 29):
                continue
            k = day.replace(year=2023).timetuple().tm_yday - 1
            sums[k] += v
            cnt[k] += 1
        out.append({'name': name, 'lat': lat, 'lon': lon, 'elev': d['elevation'], 'years': min(cnt),
                    't': [round(s / c, 1) for s, c in zip(sums, cnt)]})
        time.sleep(8)
    meta = {'source': 'Open-Meteo Historical Weather API (ERA5 reanalysis), daily temperature_2m_mean, '
                      '2014-01-01..2023-12-31, GMT days; t[k]: mean of day-of-year k (0 = 1 Jan, 29 Feb dropped), °C',
            'points': out}
    json.dump(meta, open(FIXTURE, 'w'), separators=(',', ':'))


def fit():
    import numpy as np
    from scipy.optimize import least_squares
    pts = json.load(open(FIXTURE))['points']
    phi = np.radians([p['lat'] for p in pts])[:, None]
    h = np.array([p['elev'] for p in pts], float)[:, None]
    T = np.array([p['t'] for p in pts])
    day = np.arange(365)[None, :]
    k = lambda ks: np.where(phi < 0, ks, 1.0)
    f = lambda p: p[0] + p[1] * np.cos(phi) - p[2] * h - p[3] * k(p[5]) * np.sin(phi) * np.cos(2 * math.pi * (day - p[4]) / 365)
    r = least_squares(lambda p: (f(p) - T).ravel(), [-25, 52, 0.0065, 14, 17, 0.7])
    e = f(r.x) - T
    names = ['T_POLE', 'T_AMP', 'LAPSE', 'SEASON_AMP', 'COLDEST_DAY', 'SEASON_SOUTH']
    print('  '.join('%s %.4g' % nv for nv in zip(names, r.x)))
    print('RMSE %.2f °C, median point %.2f °C' % (np.sqrt((e ** 2).mean()), np.median(np.sqrt((e ** 2).mean(1)))))


if __name__ == '__main__':
    {'fetch': fetch, 'fit': fit}[sys.argv[1] if len(sys.argv) > 1 else 'fit']()
