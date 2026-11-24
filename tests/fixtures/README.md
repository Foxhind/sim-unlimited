`surface-14-*.json` (Fethiye 14/9517/6397, Innsbruck 14/8710/5744): map data © OpenStreetMap contributors, ODbL; extracted from the local PMTiles + DEM by a node script running the workers' own loaders (`PmtilesOsm` on the dev server's `tiles/index.json`, `loadTileDem`, `loadPads`/`applyPads`, `fetchRoadDem`): the tile's OSM without buildings, its lattice and borders after the pads, the pads, and the raw DEM at the road network's samples.

`surface-14-9516-6398-shore.json` and `surface-14-9517-6398-mouth.json` (Fethiye's shore and the river mouth east of it): the same, but only the ways and areas within 400 m and 250 m of a point (each file's `source` names it), every coastline kept.

Their raw DEM (`roadDem`) was taken again on 2026-11-24 at the samples of the network with the urban paths (footways, cycleways, steps: `isUrbanPath`), the rest of each file as it was.

`surface-14-9514-6399-hills.json` (the hills west of Fethiye): the same, with no ways (its coastlines only), for its relief.
