# sim-unlimited

<picture>
  <source srcset="docs/icon-xdr.png" media="(dynamic-range: high)" />
  <img src="public/icon.svg" width="128" height="128" alt="sim-unlimited icon: a fighter climbing across a setting sun over the sea" />
</picture>

A browser flight simulator whose world is the real Earth, built on the fly from OpenStreetMap data and
an elevation model. Take off anywhere and fly anywhere: tiles stream in and out as you fly, with no
loading screens.

The look is early-90s flight sims: flat-shaded polygons without textures, stepped lighting and haze,
a vector HUD. It renders at the screen's native resolution on a custom WebGL2 engine (no Three.js).

Aircraft: Cessna 150, F-16, Su-27, F-117, An-225. Also: an autopilot with autoland, NAV/ADF
radios, time of day with sun, moon and stars, real or preset weather (clouds, rain, snow,
thunderstorms).

On an HDR screen (XDR on Apple displays) the simulator renders in extended range: the sun, aircraft
lights, exhaust flames and city lights shine brighter than white. It is on by default (Settings → XDR)
and falls back to SDR when the browser lacks HDR canvas support or the screen is not in HDR mode;
the setting then says which.

## Requirements

- A desktop browser with WebGL2 (recent Chrome, Edge, Firefox or Safari)
- Node.js 20+ and npm

## Running

```bash
npm install
```

```bash
VITE_OSM_SOURCE=overpass npm run dev
```

Then open http://localhost:5173.

### Where the map data comes from

`VITE_OSM_SOURCE` picks the OpenStreetMap source:

| Value | Source |
|---|---|
| `pmtiles` (default) | Locally built PMTiles archives served by the dev server from `tiles/data/out` (see below) |
| `overpass` | The public [Overpass API](https://overpass-api.de), through a dev-server proxy |
| `osm-api` | The OSM API 0.6, near tiles only |
| `auto` | Overpass first, the OSM API when Overpass is unreachable |

The public Overpass and OSM API servers are shared community resources with usage limits. Use them
for light development only, and point `OVERPASS_TARGET` at your own Overpass instance for anything heavier.

`VITE_PMTILES_URL` overrides the PMTiles manifest URL.

### Building your own tiles

`tiles/build.sh` turns `.osm.pbf` extracts (for example from [Geofabrik](https://download.geofabrik.de))
into PMTiles with [Planetiler](https://github.com/onthegomap/planetiler) and `tiles/SimProfile.java`.
It needs JDK 21 and `planetiler.jar`. Put the extracts in `tiles/data/osm/`, then run:

```bash
JAVA=/path/to/jdk21/bin/java PLANETILER=/path/to/planetiler.jar tiles/build.sh
```

Output goes to `tiles/data/out/` (git-ignored), which `npm run dev` serves at `/tiles`.

### Publishing tiles

`tiles/publish.sh [region ...]` uploads archives from `tiles/data/out/` (all of them by default) to S3 as a
numbered build: `tiles/<N>/` with each `<region>.pmtiles`, `<region>.aerodromes.json` and an `index.json`.
`N` is one more than the highest build already in the bucket, so a published build never changes and is
served as immutable. `BUCKET` and `PUBLIC_URL` (where the bucket is publicly read) are required; the
`aws` CLI takes credentials, region and endpoint the usual way (`AWS_PROFILE`, `AWS_REGION`,
`AWS_ENDPOINT_URL`). The script prints the manifest URL to build the client with:

```bash
BUCKET=my-sim-tiles PUBLIC_URL=https://my-sim-tiles.s3.eu-central-1.amazonaws.com \
  AWS_REGION=eu-central-1 tiles/publish.sh israel-and-palestine
```

```bash
VITE_PMTILES_URL=https://my-sim-tiles.s3.eu-central-1.amazonaws.com/tiles/1/index.json npm run build
```

The bucket must allow public reads of `tiles/*`, answer single `Range` requests with 206, and have a CORS
rule that allows `GET` with the `Range` header from the site's origin.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with the simulator and the dev tools |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run typecheck` | TypeScript check only |
| `npm test` | Vitest suite; the time budgets (`tests/perf.test.ts`) run on their own after the rest |

Dev-only pages: `relief.html` (relief inspector), `inspector.html` (terrain inspector), `areas.html`
(area styles), `rim.html` (rim light lab).

## Controls

| Keys | Action |
|---|---|
| Arrows | Stick |
| A / Z | Throttle |
| Q / E | Rudder |
| G, F, B, X | Gear, flaps, brakes, speed brake |
| F1–F6 | Cameras |
| P, U, L | Autopilot, NAV/HDG, autoland |
| K | Map |
| Esc | Pause menu |

Keys can be rebound in Settings.

## Repository layout

```
src/engine   WebGL2 renderer, shaders, font, input
src/flight   Flight model, aircraft, autopilot, HUD, audio
src/world    Terrain, OSM meshing, sky, weather, tile streaming
src/workers  Web workers for terrain and OSM tiles
src/ui       Menus, settings, i18n (EN/RU/UK), minimap
src/tools    Dev inspectors
tools/       Blender build/rig scripts for the aircraft, data generators
tiles/       PMTiles build profile and script
assets/      Aircraft .blend sources, Unscii font
public/      App icon: icon.svg is the source, the PNGs are rendered from it
docs/        Design spec (TZ.md, in Russian), design notes, the README's XDR icon
tests/       Vitest tests and fixtures
```

## Data and credits

At runtime the simulator uses these third-party services and data. Their attributions are also
shown in the app.

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the
  [ODbL](https://opendatacommons.org/licenses/odbl/). The test fixtures in `tests/fixtures/` are extracts
  of OSM data under the same licence.
- Elevation: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (Mapzen Terrarium format).
- Distant map: [OpenFreeMap](https://openfreemap.org), © [OpenMapTiles](https://openmaptiles.org).
- Weather: [Open-Meteo.com](https://open-meteo.com), CC BY 4.0.
- Star catalog: generated from [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3-Clause),
  Hipparcos data.
- Font: [Unscii](http://viznut.fi/unscii/) 16 by viznut (public domain), with a patch adding Ukrainian glyphs.

The aircraft models are original low-poly models built from the scripts in `tools/`. They are not
affiliated with or endorsed by any aircraft manufacturer.

## License

Code: [MIT](LICENSE). Data from the sources above keeps its own licence.
