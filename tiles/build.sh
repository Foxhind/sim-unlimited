#!/usr/bin/env bash
# M6 prototype: one archive per .osm.pbf extract in tiles/data/osm, built with tiles/SimProfile.java:
#   tiles/data/out/<region>.pmtiles + <region>.aerodromes.json, and tiles/data/out/index.json listing the
#   archives (the client's default manifest, see src/world/osm-pmtiles.ts).
#   JAVA=<jdk21>/bin/java PLANETILER=<planetiler.jar> HEAP=8g tiles/build.sh [extra planetiler args]
# Defaults: the first JDK 21 under tiles/data/jdk, tiles/data/bin/planetiler.jar.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${JAVA:-}" ]; then
  for j in tiles/data/jdk/jdk-21*/Contents/Home/bin/java tiles/data/jdk/jdk-21*/bin/java; do
    if [ -x "$j" ]; then JAVA=$j; break; fi
  done
fi
: "${JAVA:?no JDK 21 under tiles/data/jdk: set JAVA}"
PLANETILER=${PLANETILER:-tiles/data/bin/planetiler.jar}
OUT=tiles/data/out
mkdir -p "$OUT" tiles/data/tmp

names=()
for pbf in tiles/data/osm/*.osm.pbf; do
  name=$(basename "$pbf" .osm.pbf)
  name=${name%-latest}
  "$JAVA" -Xmx${HEAP:-8g} -cp "$PLANETILER" tiles/SimProfile.java \
    --osm="$pbf" --output="$OUT/$name.pmtiles" --tmpdir=tiles/data/tmp \
    --minzoom=14 --maxzoom=14 "$@"
  names+=("\"$name.pmtiles\"")
done
(IFS=,; echo "[${names[*]}]") > "$OUT/index.json"
cat "$OUT/index.json"
