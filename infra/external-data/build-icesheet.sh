#!/bin/bash
# Build carto's two Antarctic icesheet shapefile zips from OpenStreetMap data.
#
# Uses icesheet_proc (setup-icesheet.sh), which derives the ice from the land polygons
# and the mapped Antarctic landcover. Both come from Geofabrik's small Antarctica
# extract, so this takes minutes (unlike build.sh's planet run). Runs as root on
# Debian 13; output goes to $OUT next to build.sh's.
#
# Inputs (env):
#   ANTARCTICA_URL  OSM extract with the Antarctic coastline and landcover
#   WORK            scratch dir (default /var/build)
#   ALLOW_ERRORS    1 to accept osmcoastline errors
#   UPLOAD_URLS     optional file of "<filename> <presigned PUT url>" lines
set -o errexit -o nounset -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=${WORK:-/var/build}
OUT=${OUT:-$WORK/out}
ANTARCTICA_URL=${ANTARCTICA_URL:-https://download.geofabrik.de/antarctica-latest.osm.pbf}
ALLOW_ERRORS=${ALLOW_ERRORS:-0}
UPLOAD_URLS=${UPLOAD_URLS:-}
export ICESHEET_PROC_DIR=${ICESHEET_PROC_DIR:-/opt/icesheet_proc}

"$HERE/setup-icesheet.sh"

rm -rf "$WORK/icesheet"
mkdir -p "$WORK/icesheet" "$OUT"
cd "$WORK/icesheet"

echo "Downloading $ANTARCTICA_URL"
curl -fsSL --retry 5 --retry-delay 10 -o antarctica.osm.pbf "$ANTARCTICA_URL"
DATA_TS=$(osmium fileinfo -g header.option.osmosis_replication_timestamp antarctica.osm.pbf)
[ -n "$DATA_TS" ] || { echo "no replication timestamp in the extract header" >&2; exit 1; }
LASTMOD=$(date -u -d "$DATA_TS" '+%a, %d %b %Y %H:%M:%S GMT')
echo "Antarctica data timestamp: $DATA_TS"

# icesheet_proc.sh takes land/water polygons and the coastline lines from an
# OSMCoastline database in EPSG:3857 if one is in its working directory.
echo "Building coastline database"
set +o errexit
osmcoastline -v -f -o coastline.db --srs=3857 --output-polygons=both --output-lines \
  --max-points=1000 antarctica.osm.pbf 2>&1 | tee osmcoastline.log
rc=${PIPESTATUS[0]}
set -o errexit
echo "osmcoastline exit code: $rc"
if [ "$rc" -ne 0 ] && [ "$ALLOW_ERRORS" != 1 ]; then
  echo "osmcoastline reported errors on the Antarctica extract; see the log" >&2
  exit 1
fi

echo "Running icesheet_proc"
OSMIUM_NOICE="$ICESHEET_PROC_DIR/osmium_noice" COASTLINE_LAYER=lines \
  bash "$ICESHEET_PROC_DIR/icesheet_proc.sh" antarctica.osm.pbf

package() {  # package KIND   (KIND is polygons or outlines)
  local kind=$1 name="antarctica-icesheet-$1-3857" layer="icesheet_$1"
  local shp="$name/$layer.shp"
  [ -f "$shp" ] || { echo "icesheet_proc produced no $shp" >&2; exit 1; }
  [ -f "$name/$layer.cpg" ] || printf 'UTF-8' > "$name/$layer.cpg"  # carto's config lists it
  local count
  count=$(ogrinfo -so -al "$shp" | sed -n 's/^Feature Count: //p')
  [ "${count:-0}" -gt 0 ] || { echo "$shp has no features" >&2; exit 1; }
  echo "$layer: $count features"
  cat > "$name/README.txt" <<README
Built with infra/external-data/build-icesheet.sh from OpenStreetMap data using
icesheet_proc by Christoph Hormann (GPL-3, https://github.com/imagico/icesheet_proc);
not the osmdata.openstreetmap.de build.

$name: $( [ "$kind" = polygons ] \
  && echo "ice-covered Antarctic areas not explicitly mapped as glacier" \
  || echo "ice edges, with an ice_edge attribute (ice_ocean, ice_land, ice_ice)" )
$layer.shp: $count features, Mercator projection (EPSG: 3857)

Date of the data used is $DATA_TS

This data is Copyright OpenStreetMap contributors. It is available under the
Open Database License (ODbL). See https://www.openstreetmap.org/copyright
README
  zip -qr "$OUT/$name.zip" "$name"
  printf '%s' "$LASTMOD" > "$OUT/$name.zip.lastmod"
  eval "${kind}_count=$count"
}
rm -f "$OUT"/antarctica-icesheet-*
package polygons
package outlines
ogrinfo -so -al antarctica-icesheet-outlines-3857/icesheet_outlines.shp | grep -q "ice_edge" \
  || { echo "outlines lack the ice_edge attribute carto reads" >&2; exit 1; }

cat > "$OUT/icesheet-info.json" <<INFO
{
  "built_at": "$(date -u +%FT%TZ)",
  "antarctica_url": "$ANTARCTICA_URL",
  "antarctica_data_timestamp": "$DATA_TS",
  "icesheet_proc_commit": "be4400fadac9488f19b8831ed1ef530a16912ef4",
  "osmcoastline_exit_code": $rc,
  "polygon_features": $polygons_count,
  "outline_features": $outlines_count
}
INFO
cat "$OUT/icesheet-info.json"
ls -l "$OUT"

if [ -n "$UPLOAD_URLS" ]; then
  while read -r file url; do
    [ -e "$OUT/$file" ] || continue
    echo "Uploading $file"
    curl -fsS --retry 3 -X PUT -T "$OUT/$file" "$url"
  done < "$UPLOAD_URLS"
fi
echo "Icesheet build complete"
