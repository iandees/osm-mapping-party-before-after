#!/bin/bash
# Opt-in integration test for the incremental delta->append render path, using the
# production openstreetmap-carto v6 FLEX backend (same osm2pgsql invocation make.sh
# uses). Proves that a slim create + a chain of derive-changes/append deltas
# (including a delete) yields the SAME database as a single full create at the
# final timestamp.
#
# Requires: osm2pgsql (flex), osmium, psql, and a Postgres where we can create
# databases. The carto v6 submodule must be checked out (openstreetmap-carto-flex.lua,
# functions.sql, common-values.sql). Run inside the render Docker image:
#   bash render/test_incremental.sh
set -o errexit -o nounset -o pipefail

# Resolve fixture + carto paths before cd'ing into the scratch dir.
HERE="$(dirname "$(realpath "$0")")"
OPL="$HERE/test_incremental.opl"
CARTO="$HERE/../openstreetmap-carto"
FLEX="$CARTO/openstreetmap-carto-flex.lua"
for f in "$OPL" "$FLEX" "$CARTO/functions.sql" "$CARTO/common-values.sql"; do
  [ -s "$f" ] || { echo "missing required file: $f"; exit 1; }
done

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"

# Build the history file. osmium time-filter needs history sorted by (type, id,
# version) to honour deletions — sort defensively so the fixture's line order
# can't silently break the delete assertion below.
osmium cat --overwrite -o unsorted.osh.pbf "$OPL"
osmium sort --overwrite -o hist.osh.pbf unsorted.osh.pbf

# Snapshots at three times.
osmium time-filter --overwrite -o t0.osm.pbf hist.osh.pbf 2019-06-01T00:00:00Z  # only n1
osmium time-filter --overwrite -o t1.osm.pbf hist.osh.pbf 2020-06-01T00:00:00Z  # n1 + n2
osmium time-filter --overwrite -o t2.osm.pbf hist.osh.pbf 2021-06-01T00:00:00Z  # only n2 (n1 deleted)

ARGS=(--output flex --style "$FLEX")

setup_db() {
  dropdb --if-exists "$1" >/dev/null 2>&1 || true
  createdb "$1"
  psql -q -d "$1" -c "create extension postgis; create extension hstore;" >/dev/null
  psql -q -d "$1" -f "$CARTO/functions.sql" >/dev/null
  psql -q -d "$1" -f "$CARTO/common-values.sql" >/dev/null
}

count() { psql -d gis -At -c "select count(*) from planet_osm_point;"; }

# --- INCREMENTAL: slim create at t0, then apply deltas ---
setup_db gis
osm2pgsql --create --slim "${ARGS[@]}" -d gis t0.osm.pbf >/dev/null 2>&1
psql -q -d gis -f "$CARTO/indexes.sql" >/dev/null 2>&1 || true
[ "$(count)" = "1" ] || { echo "FAIL: frame0 expected 1 point, got $(count)"; exit 1; }

osmium derive-changes --overwrite t0.osm.pbf t1.osm.pbf -o d1.osc
osm2pgsql --append --slim "${ARGS[@]}" -d gis d1.osc >/dev/null 2>&1
[ "$(count)" = "2" ] || { echo "FAIL: frame1 (create applied) expected 2 points, got $(count)"; exit 1; }

osmium derive-changes --overwrite t1.osm.pbf t2.osm.pbf -o d2.osc
osm2pgsql --append --slim "${ARGS[@]}" -d gis d2.osc >/dev/null 2>&1
[ "$(count)" = "1" ] || { echo "FAIL: frame2 (delete applied) expected 1 point, got $(count)"; exit 1; }

# --- REFERENCE: single full create at the final timestamp ---
setup_db gis_ref
osm2pgsql --create --slim "${ARGS[@]}" -d gis_ref t2.osm.pbf >/dev/null 2>&1
psql -q -d gis_ref -f "$CARTO/indexes.sql" >/dev/null 2>&1 || true

# Every flex output/middle table must match between the append chain and a full create.
sig() {
  psql -At -d "$1" -c "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> 'spatial_ref_sys' order by 1" \
  | while read -r t; do
      [ -z "$t" ] && continue
      echo "$t=$(psql -At -d "$1" -c "select count(*) from \"$t\";")"
    done
}
sig gis > sig_inc.txt
sig gis_ref > sig_ref.txt
if ! diff -q sig_inc.txt sig_ref.txt >/dev/null; then
  echo "FAIL: incremental flex DB != full-create flex DB"; diff sig_inc.txt sig_ref.txt; exit 1
fi

echo "INCREMENTAL FLEX TEST PASSED"
