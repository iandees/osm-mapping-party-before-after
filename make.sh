#! /bin/bash
set -o errexit -o nounset -o pipefail

if [ $# -ge 1 ] && [ "$1" = "-h" ] ; then
	cat <<-END
	Usage: $0 INPUT.osh.pbf BEFORETIME AFTERTIME BBOX [MIN_ZOOM] [MAX_ZOOM] [NUM_FRAMES]

	BEFORETIME & AFTERTIME are ISO-8601 timestamps
	BBOX is a comma-separated long/lat bounding box (left,bottom,right,top) and can be found via http://bboxfinder.com/
	MIN_ZOOM and MAX_ZOOM are optional zoom levels (default: 6 and 12)
	NUM_FRAMES is the number of frames to generate for the GIF (default: 2)
	END
	exit 0
fi

INPUT_FILE=$(realpath "${1:?Arg 1 should be the path to the pbf file}")
TIME_BEFORE=${2:?Arg 2 should be the ISO timestamp for the before time}
TIME_AFTER=${3:?Arg 3 should be the ISO timestamp for the after time}
BBOX=${4:-"world"}
BBOX_COMMA="${BBOX// /,}"
BBOX_SPACE="${BBOX//,/ }"
MIN_ZOOM=${5:-6}
MAX_ZOOM=${6:-12}
NUM_FRAMES=${7:-2}

# for planet-latest.osm.obf we calculate the "planet" part
PREFIX=$(basename "$INPUT_FILE")
PREFIX=${PREFIX%%.osh.pbf}
PREFIX=${PREFIX%%-latest}
PREFIX=${PREFIX%%-internal}
PREFIX=${PREFIX//-/_}

ROOT="$(realpath "$(dirname "$0")")"
cd "$ROOT" || exit

PBF_FILE="$(realpath "$PREFIX.$BBOX.osh.pbf")"
if [ "$INPUT_FILE" -nt "$PBF_FILE" ] ; then
  echo "Extracting the OSM history for just this bounding box $BBOX"
  NEWFILE=$(mktemp -p . "tmp.extract.${PREFIX}.XXXXXX.osm.pbf")
  osmium extract --with-history --overwrite -o "$NEWFILE" --bbox "$BBOX_COMMA" "$INPUT_FILE"
  mv "$NEWFILE" "$PBF_FILE"
fi

if [ ! -s "$ROOT/openstreetmap-carto/node_modules/.bin/carto" ] ; then
  cd "$ROOT/openstreetmap-carto"
  echo "Installing carto into $ROOT/openstreetmap-carto/node_modules with npm..."
  npm init -y
  npm install carto -q
fi

if [ ! -s "$ROOT/openstreetmap-carto/project.xml" ] ; then
  cd "$ROOT"
  if [ ! -e "$ROOT/openstreetmap-carto" ] ; then
    git submodule update
  fi
  cd "$ROOT/openstreetmap-carto"
  if [ ! -s project.xml ] || [ project.mml -nt project.xml ] ; then
    TMP=$(mktemp -p . tmp.project.XXXXXX.xml)
    # No -a/API pin: let carto use its bundled mapnik-reference, which knows the
    # mapnik 4.x CartoCSS properties (line-pattern-cap, etc.) that carto v6 uses.
    ./node_modules/.bin/carto project.mml > "$TMP"
    mv "$TMP" project.xml
  fi
fi

if [ "$(psql -At -c "select count(*) from pg_database where datname = 'gis';")" = "0" ] ; then
  echo "Creating gis database..."
  createdb gis
  psql -d gis -c "create extension postgis;"
  psql -d gis -c "create extension hstore;"
  # JIT hurts map-rendering queries; openstreetmap-carto recommends disabling it.
  psql -d gis -c "alter system set jit = off;" -c "select pg_reload_conf();"
  # openstreetmap-carto v6 (flex backend) needs helper functions and the
  # carto_pois whitelist table loaded once into the database.
  psql -d gis -f "$ROOT/openstreetmap-carto/functions.sql"
  psql -d gis -f "$ROOT/openstreetmap-carto/common-values.sql"
fi

if [ ! -e "$ROOT/openstreetmap-carto/data/.external-data-done" ] ; then
  cd "$ROOT/openstreetmap-carto/"
  echo "Downloading external datasets..."
  ./scripts/get-external-data.py
  touch data/.external-data-done
  cd "$ROOT"
fi

# Function to generate ISO-8601 timestamps between two times
generate_timestamps() {
 local start_time=$1
 local end_time=$2
 local num_stops=$3
 python3 - <<END
import datetime
from dateutil import parser
start_time = parser.isoparse("$start_time")
end_time = parser.isoparse("$end_time")
delta = (end_time - start_time) / ($num_stops - 1)
timestamps = [start_time + i * delta for i in range($num_stops)]
for ts in timestamps:
    # Floor to minute resolution: frame spacing over long spans doesn't divide
    # evenly into whole seconds, so the last frame can land a few microseconds
    # short of end_time (e.g. 11:17:59.999997 instead of 11:18:00). Minute
    # granularity is coarse enough that this drift never crosses a minute
    # boundary, unlike truncating only to whole seconds.
    ts = ts.replace(second=0, microsecond=0)
    print(ts.isoformat().replace("+00:00", "Z"))
END
}

# Generate timestamps
TIMESTAMPS=$(generate_timestamps "$TIME_BEFORE" "$TIME_AFTER" "$NUM_FRAMES")

# Shared osm2pgsql args — MUST be identical for --create and --append or append
# breaks. openstreetmap-carto v6 uses the flex output backend (single lua style).
OSM2PGSQL_ARGS=(--output flex --style openstreetmap-carto-flex.lua -d gis)

# Process each timestamp. Frame 0 is a full slim create; later frames apply only
# the OsmChange delta from the previous frame's snapshot (osmium derive-changes),
# so per-frame DB cost scales with the delta, not the whole region. Because append
# is not idempotent, the DB is built in a single pass (no cross-run resume); the
# .generated sentinel is now only the render gate.
FRAME_IDX=0
PREV_SNAP=""
FIRST_TIME=""
for TIME in $TIMESTAMPS; do
  [ -z "$FIRST_TIME" ] && FIRST_TIME="$TIME"
  SNAP="$(realpath "${PREFIX}.$TIME.$BBOX_COMMA.osm.pbf")"
  echo "Extracting data for $TIME..."
  NEWFILE=$(mktemp -p . tmp.time.XXXXXX.osm.pbf)
  osmium time-filter --overwrite -o "$NEWFILE" "$PBF_FILE" "$TIME"
  mv "$NEWFILE" "$SNAP"

  cd "$ROOT/openstreetmap-carto"
  echo "Importing data for $TIME..."
  if [ "$FRAME_IDX" -eq 0 ] ; then
    osm2pgsql --create --slim "${OSM2PGSQL_ARGS[@]}" "$SNAP"
    psql -d gis -f indexes.sql
  else
    DELTA=$(mktemp -p "$ROOT" tmp.delta.XXXXXX.osc)
    osmium derive-changes --overwrite "$PREV_SNAP" "$SNAP" -o "$DELTA"
    osm2pgsql --append --slim "${OSM2PGSQL_ARGS[@]}" "$DELTA"
    rm -f "$DELTA" "$PREV_SNAP"
  fi
  touch "$ROOT/.$PREFIX.$TIME.$BBOX_COMMA.generated"
  PREV_SNAP="$SNAP"
  FRAME_IDX=$((FRAME_IDX + 1))

  cd "$ROOT"
  for ZOOM in $(seq "$MIN_ZOOM" "$MAX_ZOOM") ; do
    if [ "$ROOT/.$PREFIX.$TIME.$BBOX_COMMA.generated" -nt "$PREFIX.$TIME.$BBOX_COMMA.z${ZOOM}.png" ] ; then
      echo "Generating zoom ${ZOOM} at time ${TIME}"
      GENERATED="$PREFIX.$TIME.$BBOX_COMMA.z${ZOOM}.png"
      nik4.py openstreetmap-carto/project.xml "$GENERATED" -b $BBOX_SPACE -z "$ZOOM" || break
      # Bake a white band with a timestamp (bottom-left) and the ODbL attribution
      # (bottom-right) onto the bottom of the frame.
      OVERLAY_FONT=/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf
      ATTR_TEXT='Data © OpenStreetMap contributors, ODbL'
      BASE_PT=20
      IMG_W=$(gm identify -format '%w' "$GENERATED")
      IMG_H=$(gm identify -format '%h' "$GENERATED")
      # The two labels sit at opposite corners, so on a narrow frame a fixed point
      # size makes them collide. Measure each label's rendered width at the base
      # size (render to a throwaway PNG and read its width back; GraphicsMagick's
      # `info:` coder is unreliable, but `gm identify` is what the rest of the
      # script already uses) and, when the two ends plus corner margins won't fit
      # across the frame, shrink the font by exactly that ratio so they just clear.
      MARGIN=24   # left margin (6) + right margin (6) + gap between ends (12)
      TS_MEASURE="$(mktemp tmp.XXXXXX.measure.png)"
      gm convert -font "$OVERLAY_FONT" -pointsize "$BASE_PT" "label:${TIME}" "$TS_MEASURE"
      TS_W=$(gm identify -format '%w' "$TS_MEASURE")
      gm convert -font "$OVERLAY_FONT" -pointsize "$BASE_PT" "label:${ATTR_TEXT}" "$TS_MEASURE"
      ATTR_W=$(gm identify -format '%w' "$TS_MEASURE")
      rm "$TS_MEASURE"
      PT=$BASE_PT
      if [ "$((TS_W + ATTR_W + MARGIN))" -gt "$IMG_W" ] ; then
        # Floor at 7pt so the legally-required attribution stays legible; on a
        # degenerate sub-~200px frame the two ends may still touch, but that map
        # is unusably tiny anyway.
        PT=$(( BASE_PT * (IMG_W - MARGIN) / (TS_W + ATTR_W) ))
        [ "$PT" -lt 7 ] && PT=7
      fi
      # Band height and the text's corner inset both track the point size
      # (34px band / 7px inset at the base size of 20).
      BAND=$(( PT * 34 / BASE_PT ))
      OFF=$(( PT * 7 / BASE_PT ))
      # GraphicsMagick has no -splice and its bare `-extent -0-30` is a no-op here
      # (it silently leaves the canvas unchanged), so compute the target size and
      # extend the canvas explicitly with north gravity to keep the map flush top.
      NEW_PADDED="$(mktemp tmp.XXXXXX.padded.png)"
      gm convert "$GENERATED" -background white -gravity north -extent "${IMG_W}x$((IMG_H + BAND))" "$NEW_PADDED"
      # The overlay is legally required (ODbL), so these steps are NOT
      # `|| break`-swallowed: a font/render failure fails the whole job (via
      # `set -o errexit`) rather than silently shipping a frame with no attribution.
      NEW_ATTRIBUTION="$(mktemp tmp.XXXXXX.attribution.png)"
      gm convert "$NEW_PADDED" -font "$OVERLAY_FONT" -pointsize "$PT" -fill black \
                               -gravity southwest -draw "text ${OFF},${OFF} '${TIME}'" \
                               -gravity southeast -draw "text ${OFF},${OFF} '${ATTR_TEXT}'" \
                               "$NEW_ATTRIBUTION"
      mv "$NEW_ATTRIBUTION" "$GENERATED"
      rm "$NEW_PADDED"
    fi
  done
done
LAST_TIME="$TIME"

cd "$ROOT"
for ZOOM in $(seq "$MIN_ZOOM" "$MAX_ZOOM") ; do
  # Generate comparison images of start and end times for each zoom level.
  # Use the actual first/last generated frame timestamps (FIRST_TIME/LAST_TIME),
  # not the raw TIME_BEFORE/TIME_AFTER args: frame timestamps are derived from
  # those args via floating-point interpolation and can drift by a rounding
  # step, so re-deriving the filename from the raw args can silently miss the
  # frame that was actually rendered (see generate_timestamps above).
  NEW_PNG="progress.$PREFIX.$TIME_BEFORE.$TIME_AFTER.$BBOX_COMMA.z${ZOOM}.png"
  BEFORE="$PREFIX.$FIRST_TIME.$BBOX_COMMA.z${ZOOM}.png"
  AFTER="$PREFIX.$LAST_TIME.$BBOX_COMMA.z${ZOOM}.png"
  if [ ! -s "$BEFORE" ] || [ ! -s "$AFTER" ] ; then
    continue
  fi
  echo "Generating comparison image for zoom $ZOOM"

  if [ "$BEFORE" -nt "$NEW_PNG" ] || [ "$AFTER" -nt "$NEW_PNG" ] ; then
    TMP="$(mktemp tmp.XXXXXX.png)"
    gm montage -geometry +0+0 "$BEFORE" "$AFTER" "$TMP"
    gm convert "$TMP" -background white -label "Data © OpenStreetMap contributors, ODbL" -gravity center -append "$NEW_PNG"
    rm "$TMP"
  fi

  if [ "$BEFORE" -nt "$NEW_PNG" ] || [ "$AFTER" -nt "$NEW_PNG" ] ; then
    gm montage -geometry +0+0 "$BEFORE" "$AFTER" "$NEW_PNG"
  fi

  # Generate a GIF using the frames
  NEW_GIF="progress.$PREFIX.$TIME_BEFORE.$TIME_AFTER.$BBOX_COMMA.z${ZOOM}.gif"
	if [ "$BEFORE" -nt "$NEW_GIF" ] || [ "$AFTER" -nt "$NEW_GIF" ] ; then
    gm convert -delay 50 "$PREFIX".*."$BBOX_COMMA".z"$ZOOM".png "$NEW_GIF"
  fi
done
