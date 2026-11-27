#!/usr/bin/env bash
# Publishes built archives from tiles/data/out to S3 as build <N>: s3://$BUCKET/tiles/<N>/ gets each
# <region>.pmtiles + <region>.aerodromes.json + <region>.places.json and an index.json listing them. N is one more than the
# highest build already in the bucket, so a build's files never change: a page that read an archive's
# header keeps reading the same bytes, and the files are cached as immutable.
#   BUCKET=<bucket> PUBLIC_URL=<url the bucket is read at> tiles/publish.sh [region ...]
# Regions default to every archive in tiles/data/out/index.json. The aws CLI takes its credentials,
# region and endpoint the usual way (AWS_PROFILE, AWS_REGION, AWS_ENDPOINT_URL, ~/.aws/config).
# Prints the manifest URL for VITE_PMTILES_URL.
# A build is finished once its index.json is written. If the last build in the bucket has none (an upload
# failed midway), running the script again continues that build: files already there with the same size
# (and, when recorded, the same local mtime) are skipped. BUILD=<n> picks the build to write to by hand;
# BUILD=new always starts a new one.
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
  for f in "$OUT/$r.pmtiles" "$OUT/$r.aerodromes.json" "$OUT/$r.places.json"; do
    [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
  done
done

# The endpoint answers InternalError now and then; the CLI's default (legacy, 3 attempts) gives up too soon
export AWS_RETRY_MODE=${AWS_RETRY_MODE:-standard} AWS_MAX_ATTEMPTS=${AWS_MAX_ATTEMPTS:-10}

exists() { aws s3api head-object --bucket "$BUCKET" --key "$1" >/dev/null 2>&1; }
last=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix tiles/ --delimiter / \
  --query 'CommonPrefixes[].Prefix' --output text \
  | tr '\t' '\n' | sed -n 's#^tiles/\([0-9][0-9]*\)/$#\1#p' | sort -n | tail -1)
case ${BUILD:-} in
  '') if [ -n "$last" ] && ! exists "tiles/$last/index.json"; then build=$last; resume=1
      else build=$(( ${last:-0} + 1 )); resume=0; fi ;;
  new) build=$(( ${last:-0} + 1 )); resume=0 ;;
  *[!0-9]*) echo "BUILD must be a number or 'new'" >&2; exit 1 ;;
  *) build=$BUILD; resume=1
     if exists "tiles/$build/index.json"; then
       echo "build $build is finished (has index.json), its files are immutable" >&2; exit 1
     fi ;;
esac
dest="s3://$BUCKET/tiles/$build"
if [ "$resume" = 1 ]; then echo "build $build (unfinished, continuing) -> $dest" >&2
else echo "build $build -> $dest" >&2; fi

# Progress goes to stderr (stdout carries only the manifest URL): a [k/n] line per file with the share of
# all bytes sent so far, and the aws CLI's own byte counter while a file uploads, when stderr is a terminal.
if [ -t 2 ]; then quiet=(); else quiet=(--only-show-errors); fi
human() { awk -v b="$1" 'BEGIN { split("B KiB MiB GiB TiB", u); i = 1
  while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'; }
files=()
total=0
for r in "${regions[@]}"; do
  for f in "$OUT/$r.pmtiles" "$OUT/$r.aerodromes.json" "$OUT/$r.places.json"; do
    files+=("$f")
    total=$(( total + $(wc -c < "$f") ))
  done
done
sent=0
k=0
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
# "<size> <srcmtime or None>" of the object, or "none" when there is no such object
remote() { aws s3api head-object --bucket "$BUCKET" --key "$1" \
  --query '[ContentLength, Metadata.srcmtime]' --output text 2>/dev/null | tr '\t' ' ' || echo none; }
upload() { # <file> <content type>
  local f=$1 size mt key got try
  key="tiles/$build/${f##*/}"
  size=$(( $(wc -c < "$f") ))
  mt=$(mtime "$f")
  k=$(( k + 1 ))
  if [ "$resume" = 1 ]; then
    got=$(remote "$key")
    # objects from before the mtime was recorded carry None: their size is all there is to go by
    if [ "$got" = "$size $mt" ] || [ "$got" = "$size None" ]; then
      printf '[%d/%d] %s (%s) already there, skipped\n' "$k" "${#files[@]}" "${f##*/}" "$(human "$size")" >&2
      sent=$(( sent + size ))
      return
    fi
  fi
  printf '[%d/%d] %s (%s), %s of %s sent\n' "$k" "${#files[@]}" "${f##*/}" "$(human "$size")" \
    "$(human "$sent")" "$(human "$total")" >&2
  for try in 1 2 3; do
    aws s3 cp "$f" "$dest/${f##*/}" ${quiet[@]+"${quiet[@]}"} --metadata "srcmtime=$mt" \
      --content-type "$2" --cache-control "$IMMUTABLE" >&2 || true
    # aws s3 cp has exited 0 against this endpoint with a multipart upload left unfinished and no object
    # written, so the object's size in the bucket is what says the file is there
    got=$(remote "$key")
    [ "${got%% *}" = "$size" ] && break
    echo "upload of $f did not land (try $try of 3): s3://$BUCKET/$key is ${got%% *} bytes, expected $size" >&2
    [ "$try" = 3 ] && { echo "run the same command again to continue build $build" >&2; exit 1; }
    sleep $(( try * 10 ))
  done
  sent=$(( sent + size ))
}

names=()
for r in "${regions[@]}"; do
  upload "$OUT/$r.pmtiles" application/octet-stream
  upload "$OUT/$r.aerodromes.json" application/json
  upload "$OUT/$r.places.json" application/json
  names+=("\"$r.pmtiles\"")
done
echo "uploaded $(human "$total") in ${#files[@]} files" >&2
# the manifest goes last: it never lists an archive that is not there yet
(IFS=,; echo "[${names[*]}]") | aws s3 cp - "$dest/index.json" --only-show-errors \
  --content-type application/json --cache-control "$IMMUTABLE"

echo "$PUBLIC_URL/tiles/$build/index.json"
