#!/bin/bash
# Build openstreetmap-carto's coastline water-polygon shapefile zips from OSM data.
#
# Normally these are downloaded from osmdata.openstreetmap.de (see
# openstreetmap-carto/external-data.yml). This rebuilds the two water zips so they
# can be seeded into the S3 cache (see README.md) when that host is unavailable.
# Runs as root on Debian 13 (trixie); launch.sh runs it on an EC2 instance.
#
# Inputs (env):
#   PLANET_URL          planet PBF to read (default: AWS open-data copy, us-east-1)
#   WORK                scratch dir, needs ~3x the planet size free (default /var/build)
#   SIMPLIFY_TOLERANCE  Douglas-Peucker tolerance in metres for the low-zoom file
#   ALLOW_ERRORS        1 to accept osmcoastline errors (only for partial-extract
#                       smoke tests, whose coastline rings are incomplete)
#   UPLOAD_URLS         optional file of "<filename> <presigned PUT url>" lines
set -o errexit -o nounset -o pipefail

PLANET_URL=${PLANET_URL:-https://osm-pds.s3.amazonaws.com/planet-latest.osm.pbf}
WORK=${WORK:-/var/build}
# ~1px at zoom 9, the last zoom carto draws simplified_water_polygons at (maxzoom: 9).
SIMPLIFY_TOLERANCE=${SIMPLIFY_TOLERANCE:-300}
ALLOW_ERRORS=${ALLOW_ERRORS:-0}
UPLOAD_URLS=${UPLOAD_URLS:-}
OUT="$WORK/out"

# The scheduled-build image (Dockerfile) already has the tools; launch.sh's bare
# Debian instance does not.
if ! command -v osmcoastline >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl osmcoastline osmium-tool gdal-bin zip
fi

mkdir -p "$WORK" "$OUT"
cd "$WORK"

echo "Downloading $PLANET_URL"
curl -fsSL --retry 5 --retry-delay 10 -o planet.osm.pbf "$PLANET_URL"

DATA_TS=$(osmium fileinfo -g header.option.osmosis_replication_timestamp planet.osm.pbf)
[ -n "$DATA_TS" ] || { echo "no replication timestamp in planet header" >&2; exit 1; }
# get-external-data.py stores this as the table's last_modified; any string works,
# but an HTTP-date is what the real download would have sent.
LASTMOD=$(date -u -d "$DATA_TS" '+%a, %d %b %Y %H:%M:%S GMT')
echo "Planet data timestamp: $DATA_TS"

echo "Filtering coastline ways"
rm -f coastline.osm.pbf
osmcoastline_filter -o coastline.osm.pbf planet.osm.pbf
rm planet.osm.pbf

# Split water polygons in Web Mercator. osmcoastline's exit code is 2 whenever its
# "errors" count is nonzero, but that count includes rings it repaired by closing a
# sub-metre gap in the data (the planet normally has one or two). Those are fine as
# long as nothing was left unconnected, so gate on the details in its log instead:
# every error must be a closed ring, no unconnected nodes, and warnings within
# osmcoastline's own limit (500). Anything else aborts, so we never cache a bad build.
echo "Building water polygons"
set +o errexit
osmcoastline -v -f -o coastline.db --srs=3857 --output-polygons=water --max-points=1000 \
  coastline.osm.pbf 2>&1 | tee osmcoastline.log
rc=${PIPESTATUS[0]}
set -o errexit
echo "osmcoastline exit code: $rc"
if [ "$rc" -ne 0 ] && [ "$ALLOW_ERRORS" != 1 ]; then
  fixed=$(sed -En 's/.*Closed ([0-9]+) rings\. This left ([0-9]+) nodes.*/\1/p' osmcoastline.log)
  unconnected=$(sed -En 's/.*Closed ([0-9]+) rings\. This left ([0-9]+) nodes.*/\2/p' osmcoastline.log)
  errors=$(sed -En 's/^There were ([0-9]+) errors\./\1/p' osmcoastline.log)
  warnings=$(sed -En 's/^There were ([0-9]+) warnings\./\1/p' osmcoastline.log)
  if [ -n "$fixed" ] && [ "$errors" = "$fixed" ] && [ "$unconnected" = 0 ] && [ "${warnings:-501}" -le 500 ]; then
    echo "accepting exit $rc: $fixed ring(s) repaired, $unconnected unconnected, $warnings warnings"
  else
    echo "osmcoastline reported real errors (exit $rc, errors=$errors fixed=$fixed unconnected=$unconnected warnings=$warnings); not publishing" >&2
    exit 1
  fi
fi

package() {  # package NAME LAYER_FILE DESCRIPTION [ogr2ogr args...]
  local name=$1 layer=$2 desc=$3; shift 3
  local dir="$OUT/$name"
  mkdir -p "$dir"
  ogr2ogr -f "ESRI Shapefile" -lco ENCODING=UTF-8 -nln "$layer" "$@" \
    "$dir/$layer.shp" coastline.db water_polygons
  local count
  count=$(ogrinfo -so -al "$dir/$layer.shp" | sed -n 's/^Feature Count: //p')
  cat > "$dir/README.txt" <<README
Built with infra/external-data/build.sh from OpenStreetMap natural=coastline data
using OSMCoastline ($(osmcoastline --version | head -1)); not the osmdata.openstreetmap.de build.

$name: $desc
$layer.shp: $count Polygon features, Mercator projection (EPSG: 3857)

Date of the data used is $DATA_TS

This data is Copyright OpenStreetMap contributors. It is available under the
Open Database License (ODbL). See https://www.openstreetmap.org/copyright
README
  (cd "$OUT" && zip -qr "$name.zip" "$name")
  printf '%s' "$LASTMOD" > "$OUT/$name.zip.lastmod"
  rm -rf "$dir"
}

package water-polygons-split-3857 water_polygons "coastline water polygons, split into a grid"
package simplified-water-polygons-split-3857 simplified_water_polygons \
  "coastline water polygons, simplified (tolerance ${SIMPLIFY_TOLERANCE}m) for low zooms" \
  -simplify "$SIMPLIFY_TOLERANCE"

cat > "$OUT/manifest.json" <<MANIFEST
{
  "built_at": "$(date -u +%FT%TZ)",
  "planet_url": "$PLANET_URL",
  "planet_data_timestamp": "$DATA_TS",
  "osmcoastline_exit_code": $rc,
  "osmcoastline_version": "$(osmcoastline --version | head -1)",
  "simplify_tolerance_m": $SIMPLIFY_TOLERANCE,
  "sha256": {
$(cd "$OUT" && sha256sum *.zip | awk '{printf "%s    \"%s\": \"%s\"", (n++ ? ",\n" : ""), $2, $1}')
  }
}
MANIFEST
cat "$OUT/manifest.json"
ls -l "$OUT"

if [ -n "$UPLOAD_URLS" ]; then
  while read -r file url; do
    [ -e "$OUT/$file" ] || continue
    echo "Uploading $file"
    curl -fsS --retry 3 -X PUT -T "$OUT/$file" "$url"
  done < "$UPLOAD_URLS"
fi
echo "Build complete"
