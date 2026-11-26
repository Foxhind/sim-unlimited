#!/usr/bin/env bash
# Publishes built archives from tiles/data/out to S3 as build <N>: s3://$BUCKET/tiles/<N>/ gets each
# <region>.pmtiles + <region>.aerodromes.json and an index.json listing them. N is one more than the
# highest build already in the bucket, so a build's files never change: a page that read an archive's
# header keeps reading the same bytes, and the files are cached as immutable.
#   BUCKET=<bucket> PUBLIC_URL=<url the bucket is read at> tiles/publish.sh [region ...]
# Regions default to every archive in tiles/data/out/index.json. The aws CLI takes its credentials,
# region and endpoint the usual way (AWS_PROFILE, AWS_REGION, AWS_ENDPOINT_URL, ~/.aws/config).
# Prints the manifest URL for VITE_PMTILES_URL.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BUCKET:?set BUCKET to the bucket name}"
: "${PUBLIC_URL:?set PUBLIC_URL to the URL the bucket is publicly read at}"
PUBLIC_URL=${PUBLIC_URL%/}
OUT=tiles/data/out
IMMUTABLE='public, max-age=31536000, immutable'

if [ $# -gt 0 ]; then
  regions=("$@")
else
  regions=()
  while IFS= read -r r; do regions+=("$r"); done < <(tr -d '[]"' < "$OUT/index.json" | tr ',' '\n' | sed 's/\.pmtiles$//')
fi
for r in "${regions[@]}"; do
  for f in "$OUT/$r.pmtiles" "$OUT/$r.aerodromes.json"; do
    [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
  done
done

last=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix tiles/ --delimiter / \
  --query 'CommonPrefixes[].Prefix' --output text \
  | tr '\t' '\n' | sed -n 's#^tiles/\([0-9][0-9]*\)/$#\1#p' | sort -n | tail -1)
build=$(( ${last:-0} + 1 ))
dest="s3://$BUCKET/tiles/$build"
echo "build $build -> $dest" >&2

names=()
for r in "${regions[@]}"; do
  aws s3 cp "$OUT/$r.pmtiles" "$dest/$r.pmtiles" --only-show-errors \
    --content-type application/octet-stream --cache-control "$IMMUTABLE"
  aws s3 cp "$OUT/$r.aerodromes.json" "$dest/$r.aerodromes.json" --only-show-errors \
    --content-type application/json --cache-control "$IMMUTABLE"
  names+=("\"$r.pmtiles\"")
done
# the manifest goes last: it never lists an archive that is not there yet
(IFS=,; echo "[${names[*]}]") | aws s3 cp - "$dest/index.json" --only-show-errors \
  --content-type application/json --cache-control "$IMMUTABLE"

echo "$PUBLIC_URL/tiles/$build/index.json"
