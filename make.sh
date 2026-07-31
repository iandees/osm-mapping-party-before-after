#! /bin/bash
set -o errexit -o nounset -o pipefail

if [ $# -ge 1 ] && [ "$1" = "-h" ] ; then
	cat <<-END
	Usage: $0 INPUT.osh.pbf BEFORETIME AFTERTIME BBOX [MIN_ZOOM] [MAX_ZOOM] [NUM_FRAMES] [SCALE_BAR] [STYLE]

	BEFORETIME & AFTERTIME are ISO-8601 timestamps
	BBOX is a comma-separated long/lat bounding box (left,bottom,right,top) and can be found via http://bboxfinder.com/
	MIN_ZOOM and MAX_ZOOM are optional zoom levels (default: 6 and 12)
	NUM_FRAMES is the number of frames to generate for the GIF (default: 2)
	SCALE_BAR is 1 to draw a scale bar in the lower-left of each frame, 0 to omit it (default: 0)
	STYLE is "carto" (default) or "americana"
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
SCALE_BAR=${8:-0}
STYLE=${9:-carto}

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
  # Americana would ideally use the "smart" strategy here for relation-complete
  # (not just way-complete) extraction, mitigating the route-relation
  # completeness gap found in the spike (a shield-eligible relation extending
  # outside the bbox can otherwise lose its route classification). Verified at
  # implementation time: osmium-tool's --with-history mode only supports the
  # default "complete_ways" strategy — both --strategy=smart and
  # --strategy=simple are rejected outright ("the '<name>' strategy is not
  # supported for history files"), so there is no stricter strategy available
  # for history extracts. Extraction is therefore identical for both styles.
  osmium extract --with-history --overwrite -o "$NEWFILE" --bbox "$BBOX_COMMA" "$INPUT_FILE"
  mv "$NEWFILE" "$PBF_FILE"
fi

if [ "$STYLE" = "carto" ] && [ ! -s "$ROOT/openstreetmap-carto/node_modules/.bin/carto" ] ; then
  cd "$ROOT/openstreetmap-carto"
  echo "Installing carto into $ROOT/openstreetmap-carto/node_modules with npm..."
  npm init -y
  npm install carto -q
fi

if [ "$STYLE" = "carto" ] && [ ! -s "$ROOT/openstreetmap-carto/project.xml" ] ; then
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
  if [ "$STYLE" = "carto" ] ; then
    # openstreetmap-carto v6 (flex backend) needs helper functions and the
    # carto_pois whitelist table loaded once into the database.
    psql -d gis -f "$ROOT/openstreetmap-carto/functions.sql"
    psql -d gis -f "$ROOT/openstreetmap-carto/common-values.sql"
  fi
  if [ "$STYLE" = "americana" ] ; then
    # Several OpenMapTiles layers hard-require static reference datasets that
    # osmium/imposm never produce from OSM data itself (see the Dockerfile for
    # what/why each is needed and where it's from). Load them once (same
    # lifetime as the rest of the "gis" database), using the same ogr2ogr
    # invocations upstream openmaptiles' import-data image uses — except
    # clipped to this job's bbox (with a fixed margin) rather than imported
    # planet-wide: water_polygons.shp alone is >1GB and lake_centerline.geojson
    # >200MB unclipped, dwarfing the actual per-frame OSM extract for a job
    # that's typically a city block or two, and costing minutes per job
    # otherwise (found via local end-to-end timing). Natural Earth's own
    # source is EPSG:4326; water_polygons/lake_centerline's is EPSG:3857
    # (matching each dataset's own ogr2ogr -s_srs above), so both a lon/lat
    # and a Web-Mercator clip box are computed.
    read -r CLIP4326_XMIN CLIP4326_YMIN CLIP4326_XMAX CLIP4326_YMAX \
            CLIP3857_XMIN CLIP3857_YMIN CLIP3857_XMAX CLIP3857_YMAX <<PYOUT
$(python3 - <<PYEOF
import math
left, bottom, right, top = map(float, "$BBOX_SPACE".split())
margin = 2.0  # degrees — generous enough that a lake centerline, country
              # grid cell, or admin boundary segment straddling the
              # requested bbox isn't truncated right at its edge
left = max(left - margin, -180.0)
right = min(right + margin, 180.0)
bottom = max(bottom - margin, -85.0511)
top = min(top + margin, 85.0511)

def merc(lon, lat):
    x = lon * 20037508.34 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    return x, y * 20037508.34 / 180.0

x0, y0 = merc(left, bottom)
x1, y1 = merc(right, top)
print(left, bottom, right, top, x0, y0, x1, y1)
PYEOF
)
PYOUT
    echo "Importing Natural Earth reference data..."
    PGCLIENTENCODING=UTF8 ogr2ogr -progress -f Postgresql -s_srs EPSG:4326 -t_srs EPSG:3857 \
      -clipsrc "$CLIP4326_XMIN" "$CLIP4326_YMIN" "$CLIP4326_XMAX" "$CLIP4326_YMAX" \
      PG:"dbname=gis" \
      -lco GEOMETRY_NAME=geometry -lco OVERWRITE=YES -lco DIM=2 -nlt GEOMETRY -overwrite \
      "$ROOT/render/americana/openmaptiles-build/natural_earth_vector.sqlite"
    echo "Importing water polygons reference data..."
    PGCLIENTENCODING=UTF8 ogr2ogr -progress -f Postgresql -s_srs EPSG:3857 -t_srs EPSG:3857 \
      -clipsrc "$CLIP3857_XMIN" "$CLIP3857_YMIN" "$CLIP3857_XMAX" "$CLIP3857_YMAX" \
      -lco OVERWRITE=YES -lco GEOMETRY_NAME=geometry -overwrite \
      -nln osm_ocean_polygon -nlt geometry --config PG_USE_COPY YES \
      PG:"dbname=gis" \
      "$ROOT/render/americana/openmaptiles-build/water_polygons/water_polygons.shp"
    echo "Importing lake centerline reference data..."
    PGCLIENTENCODING=UTF8 ogr2ogr -progress -f Postgresql -s_srs EPSG:3857 -t_srs EPSG:3857 \
      -clipsrc "$CLIP3857_XMIN" "$CLIP3857_YMIN" "$CLIP3857_XMAX" "$CLIP3857_YMAX" \
      PG:"dbname=gis" \
      -lco OVERWRITE=YES -overwrite -nln lake_centerline \
      "$ROOT/render/americana/openmaptiles-build/lake_centerline.geojson"
    # The building layer's aggregation function also needs a static
    # "country_osm_grid" table (see the Dockerfile for what/why) — a plain
    # pg_dump SQL file, loaded directly. Left unclipped: at ~87MB uncompressed
    # of coarse per-country polygons (vs. water_polygons/lake_centerline's
    # hundreds of MB of fine detail), a full load costs seconds not minutes,
    # and building.sql's own use of it already bounds work per grid cell via
    # ST_Intersects against the (bbox-sized) building table.
    echo "Importing country_osm_grid reference data..."
    gunzip -c "$ROOT/render/americana/openmaptiles-build/country_osm_grid.sql.gz" \
      | psql -d gis -v ON_ERROR_STOP=1 -q
  fi
fi

if [ "$STYLE" = "carto" ] && [ ! -e "$ROOT/openstreetmap-carto/data/.external-data-done" ] ; then
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

# Americana: imposm3 import target + a martin instance serving it, running
# for the rest of this job (not restarted per-frame — schema/function setup
# happens once after frame 0). Never a persistent service beyond this job's
# lifetime.
#
# martin queries plain tables live on every request, so those layers stay
# valid as later frames' `imposm diff` mutates the same tables — but several
# OpenMapTiles layers (verified: 75 materialized views in the public schema
# after frame 0's SQL corpus, e.g. the zoom-generalized "_gen_zN" views most
# of this script's default MIN_ZOOM..MAX_ZOOM range of 6..12 falls within)
# are materialized views: a point-in-time snapshot taken once when frame 0's
# run_first.sql/parallel/*.sql/run_last.sql created them, NOT re-evaluated on
# read. Without an explicit refresh, every frame after the first would render
# those layers identically to frame 0 regardless of what `imposm diff` just
# changed — a silent, total failure of the actual before/after feature for
# any layer backed by a matview. See the `refresh_matviews` call below (after
# every `imposm diff`) for the fix; verified directly against a scratch
# materialized view and one real OpenMapTiles matview (osm_poi_stop_centroid)
# that plain `REFRESH MATERIALIZED VIEW` does NOT happen automatically on the
# underlying table changing, and does correctly pick up the change once run.
IMPOSM_CACHE_DIR="$ROOT/.imposm-cache"
# Verified at implementation time: imposm3 and martin need DIFFERENT
# connection-string schemes for the same "gis" database — imposm3 (a
# separate Go tool, not libpq) only accepts "postgis://" ("unsupported
# database type: postgresql" otherwise); martin (Rust) only accepts the
# standard libpq "postgresql://"/"postgres://" URI schemes ("Unrecognizable
# connection strings" for "postgis://", confirmed by martin logging that
# exact error and then never actually serving tiles, which is what caused
# capture.mjs's tile fetches, and thus its Puppeteer page render, to hang
# until timeout in local testing).
IMPOSM_CONNECTION="postgis://postgres@localhost/gis"
MARTIN_CONNECTION="postgresql://postgres@localhost/gis"
MARTIN_PID=""

start_martin_if_needed() {
  if [ -z "$MARTIN_PID" ] ; then
    echo "Starting martin..."
    # --cache-size 0 disables martin's own tile cache (default 256MB, per
    # `martin --help`/its own startup log line "Initializing tile cache with
    # maximum size 256 MB"). There's no legitimate reuse to cache in this
    # per-job, per-frame-changing workload — every frame's `imposm diff`
    # mutates the same tables martin serves from, so a cached tile from frame
    # N would otherwise keep being served for frame N+1's identical-looking
    # request (same z/x/y), compounding the matview-staleness risk above with
    # a second, independent staleness source.
    martin --cache-size 0 --listen-addresses 127.0.0.1:3000 "$MARTIN_CONNECTION" &
    MARTIN_PID=$!
    MARTIN_READY=0
    for _ in $(seq 1 30) ; do
      if curl -sf http://127.0.0.1:3000/catalog > /dev/null 2>&1 ; then
        MARTIN_READY=1
        break
      fi
      sleep 1
    done
    # Not swallowed: a martin that never comes up (e.g. the connection-string
    # scheme mismatch found during implementation — see IMPOSM_CONNECTION vs
    # MARTIN_CONNECTION above) previously left capture.mjs fetching tiles from
    # a dead server, hanging until Puppeteer's own timeout and looking exactly
    # like a Puppeteer bug rather than a martin startup failure.
    [ "$MARTIN_READY" = 1 ] || { echo "martin failed to become ready" >&2 ; exit 1 ; }
  fi
}
stop_martin() {
  if [ -n "$MARTIN_PID" ] ; then
    kill "$MARTIN_PID" 2>/dev/null || true
    wait "$MARTIN_PID" 2>/dev/null || true
    MARTIN_PID=""
  fi
}
trap stop_martin EXIT

# Materialized views created by frame 0's SQL corpus (run_first.sql,
# parallel/*.sql, run_last.sql) are a point-in-time snapshot, not re-evaluated
# on read — every later frame's `imposm diff` mutates the underlying tables
# but leaves any matview stale until explicitly refreshed. Two passes: the
# first refresh can fail for a matview whose own source is another matview
# that hasn't been refreshed yet in this pass (dependency ordering isn't
# known ahead of time across the ~75 matviews this schema creates); the
# second pass, run after every matview has had one refresh attempt, picks up
# whatever the first pass's ordering missed. ON_ERROR_STOP=0 on the outer
# psql invocation is intentional here — the inner EXCEPTION WHEN OTHERS
# already handles per-view failures (an expected, transient ordering issue on
# pass 1), so the outer command must not abort the whole script over it.
refresh_matviews() {
  for pass in 1 2 ; do
    psql -d gis -v ON_ERROR_STOP=0 -c "
      DO \$\$
      DECLARE r RECORD;
      BEGIN
        FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' LOOP
          BEGIN
            EXECUTE format('REFRESH MATERIALIZED VIEW %I', r.matviewname);
          EXCEPTION WHEN OTHERS THEN
            -- dependency not ready yet this pass; the second pass (or this
            -- same pass's later iterations) picks it up.
            NULL;
          END;
        END LOOP;
      END \$\$;
    "
  done
}

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

  echo "Importing data for $TIME..."
  if [ "$STYLE" = "americana" ] ; then
    MAPPING="$ROOT/render/americana/openmaptiles-build/mapping.yaml"
    SQLDIR="$ROOT/render/americana/openmaptiles-build/sql"
    SQLTOOLSDIR="$ROOT/render/americana/openmaptiles-build/sql-tools"
    if [ "$FRAME_IDX" -eq 0 ] ; then
      imposm import -mapping "$MAPPING" -read "$SNAP" -write -diff \
        -overwritecache -deployproduction \
        -cachedir "$IMPOSM_CACHE_DIR" -connection "$IMPOSM_CONNECTION"
      # zzz_language.sql (below) also calls the standard Postgres contrib
      # unaccent() function; postgis/hstore are created unconditionally
      # above, but unaccent is Americana-only so it's created here instead.
      psql -d gis -v ON_ERROR_STOP=1 -c "create extension if not exists unaccent;"
      # openmaptiles-tools' own SQL_TOOLS_DIR (postgis-vt-util.sql, the hstore
      # delete_empty_keys() helper, language/label-grid functions, etc) must be
      # loaded before the generated tileset SQL, which calls these functions
      # without defining them — see the Dockerfile's openmaptiles_build stage.
      # zzz_language.sql (in that same dir) in turn calls the osml10n Postgres
      # extension, which isn't built for this image's Postgres version — load
      # our stub replacements first (see that file for why).
      psql -d gis -v ON_ERROR_STOP=1 -f "$ROOT/render/americana/sql/osml10n-stub.sql"
      for f in "$SQLTOOLSDIR"/*.sql ; do
        psql -d gis -v ON_ERROR_STOP=1 -f "$f"
      done
      psql -d gis -v ON_ERROR_STOP=1 -f "$SQLDIR/run_first.sql"
      for f in "$SQLDIR"/parallel/*.sql ; do
        psql -d gis -v ON_ERROR_STOP=1 -f "$f"
      done
      psql -d gis -v ON_ERROR_STOP=1 -f "$SQLDIR/run_last.sql"
      start_martin_if_needed
    else
      DELTA=$(mktemp -p "$ROOT" tmp.delta.XXXXXX.osc)
      osmium derive-changes --overwrite "$PREV_SNAP" "$SNAP" -o "$DELTA"
      gzip -c "$DELTA" > "$DELTA.gz"
      imposm diff -mapping "$MAPPING" \
        -cachedir "$IMPOSM_CACHE_DIR" -connection "$IMPOSM_CONNECTION" "$DELTA.gz"
      refresh_matviews
      rm -f "$DELTA" "$DELTA.gz" "$PREV_SNAP"
    fi
  else
    cd "$ROOT/openstreetmap-carto"
    if [ "$FRAME_IDX" -eq 0 ] ; then
      osm2pgsql --create --slim "${OSM2PGSQL_ARGS[@]}" "$SNAP"
      psql -d gis -f indexes.sql
    else
      DELTA=$(mktemp -p "$ROOT" tmp.delta.XXXXXX.osc)
      osmium derive-changes --overwrite "$PREV_SNAP" "$SNAP" -o "$DELTA"
      osm2pgsql --append --slim "${OSM2PGSQL_ARGS[@]}" "$DELTA"
      rm -f "$DELTA" "$PREV_SNAP"
    fi
    cd "$ROOT"
  fi
  touch "$ROOT/.$PREFIX.$TIME.$BBOX_COMMA.generated"
  PREV_SNAP="$SNAP"
  FRAME_IDX=$((FRAME_IDX + 1))

  for ZOOM in $(seq "$MIN_ZOOM" "$MAX_ZOOM") ; do
    if [ "$ROOT/.$PREFIX.$TIME.$BBOX_COMMA.generated" -nt "$PREFIX.$TIME.$BBOX_COMMA.z${ZOOM}.png" ] ; then
      echo "Generating zoom ${ZOOM} at time ${TIME}"
      GENERATED="$PREFIX.$TIME.$BBOX_COMMA.z${ZOOM}.png"
      if [ "$STYLE" = "americana" ] ; then
        node "$ROOT/render/americana/capture.mjs" "$BBOX_COMMA" "$ZOOM" "http://127.0.0.1:3000/getmvt" "$GENERATED" || break
      else
        nik4.py openstreetmap-carto/project.xml "$GENERATED" -b $BBOX_SPACE -z "$ZOOM" || break
      fi
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
      # Optional scale bar (GitHub issue #23): a small ruler + "N km"/"N m" label
      # drawn directly onto the map (no backing box), sized smaller than the
      # timestamp/attribution text so it reads as a secondary annotation. Placed
      # in the map's own bottom-left corner — above the band added below, so it
      # never collides with the timestamp.
      if [ "$SCALE_BAR" = "1" ] ; then
        SCALE_PT=$(( PT * 65 / 100 ))
        [ "$SCALE_PT" -lt 8 ] && SCALE_PT=8
        read -r BAR_PX SCALE_LABEL <<PYOUT
$(python3 - <<PYEOF
import math
left, bottom, right, top = map(float, "$BBOX_SPACE".split())
zoom = $ZOOM
img_w = $IMG_W
lat = (bottom + top) / 2.0
mpp = 156543.03392804097 * math.cos(math.radians(lat)) / (2 ** zoom)
max_bar_px = min(img_w * 0.2, 110)
candidates = sorted(set(s * (10 ** exp) for exp in range(-1, 7) for s in (1, 2, 5) if s * (10 ** exp) >= 1))
target_m = max_bar_px * mpp
chosen = candidates[0]
for c in candidates:
    if c <= target_m:
        chosen = c
    else:
        break
bar_px = max(1, round(chosen / mpp))
if chosen >= 1000:
    label = f"{chosen / 1000:g} km"
else:
    label = f"{chosen:g} m"
print(f"{bar_px} {label}")
PYEOF
)
PYOUT
        # Too small to be legible (degenerate sub-~150px-wide frame) — skip.
        if [ "$BAR_PX" -ge 20 ] ; then
          TICK_H=$(( SCALE_PT * 45 / 100 ))
          TICK_L=$OFF
          TICK_R=$(( OFF + BAR_PX ))
          TICK_BOTTOM=$(( IMG_H - OFF ))
          TICK_TOP=$(( TICK_BOTTOM - TICK_H ))
          LINE_Y=$(( (TICK_TOP + TICK_BOTTOM) / 2 ))
          LABEL_X=$(( OFF + BAR_PX + OFF ))
          SCALE_BAR_OUT="$(mktemp tmp.XXXXXX.scalebar.png)"
          gm convert "$GENERATED" \
                     -fill black -draw "line ${TICK_L},${LINE_Y} ${TICK_R},${LINE_Y}" \
                     -draw "line ${TICK_L},${TICK_TOP} ${TICK_L},${TICK_BOTTOM}" \
                     -draw "line ${TICK_R},${TICK_TOP} ${TICK_R},${TICK_BOTTOM}" \
                     -font "$OVERLAY_FONT" -pointsize "$SCALE_PT" \
                     -gravity southwest -draw "text ${LABEL_X},${OFF} '${SCALE_LABEL}'" \
                     "$SCALE_BAR_OUT"
          mv "$SCALE_BAR_OUT" "$GENERATED"
        fi
      fi
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

  # Generate an MP4 from the GIF (GitHub issue #26) — same content/timing as
  # the GIF but far smaller. Best-effort: a missing/broken ffmpeg logs a
  # warning and leaves NEW_MP4 absent rather than failing the whole render,
  # since the GIF is still delivered on its own.
  NEW_MP4="progress.$PREFIX.$TIME_BEFORE.$TIME_AFTER.$BBOX_COMMA.z${ZOOM}.mp4"
  if [ "$NEW_GIF" -nt "$NEW_MP4" ] ; then
    # `pad` (not `scale`) forces the even width/height that libx264's
    # yuv420p requires, without resampling a single pixel of the actual
    # frame — it only ever adds a <=1px black border. The delivered video is
    # therefore always exactly the size the user requested (or +1px).
    if ! ffmpeg -nostdin -hide_banner -loglevel error -y -i "$NEW_GIF" \
        -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black" \
        -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p -movflags +faststart \
        "$NEW_MP4" ; then
      echo "ffmpeg failed to encode MP4 for zoom $ZOOM; continuing with GIF only" >&2
      rm -f "$NEW_MP4"
    fi
  fi
done
