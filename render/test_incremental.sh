#!/bin/bash
# Opt-in integration test for the incremental delta->append render path.
# Requires: osmium, osm2pgsql, psql, and a Postgres where we can create db 'gis'.
# Run inside the render Docker image (or a local env with those tools):
#   bash render/test_incremental.sh
set -o errexit -o nounset -o pipefail

# Resolve the fixture path before cd'ing into the scratch dir.
OPL="$(dirname "$(realpath "$0")")/test_incremental.opl"

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

dropdb --if-exists gis
createdb gis
psql -d gis -c "create extension postgis;" -c "create extension hstore;"

ARGS=(-G --hstore -d gis)

count() { psql -d gis -At -c "select count(*) from planet_osm_point;"; }

# Frame 0: full slim create -> expect 1 point (n1).
osm2pgsql --create --slim "${ARGS[@]}" t0.osm.pbf
[ "$(count)" = "1" ] || { echo "FAIL: frame0 expected 1 point, got $(count)"; exit 1; }

# Frame 1: delta t0->t1 adds n2 -> expect 2 points (create applied).
osmium derive-changes --overwrite t0.osm.pbf t1.osm.pbf -o d1.osc
osm2pgsql --append --slim "${ARGS[@]}" d1.osc
[ "$(count)" = "2" ] || { echo "FAIL: frame1 expected 2 points, got $(count)"; exit 1; }

# Frame 2: delta t1->t2 deletes n1 -> expect 1 point (delete applied).
osmium derive-changes --overwrite t1.osm.pbf t2.osm.pbf -o d2.osc
osm2pgsql --append --slim "${ARGS[@]}" d2.osc
[ "$(count)" = "1" ] || { echo "FAIL: frame2 expected 1 point, got $(count)"; exit 1; }

# The surviving point must be n2, not n1 (proves the right object was deleted).
OSM_ID=$(psql -d gis -At -c "select osm_id from planet_osm_point;")
[ "$OSM_ID" = "2" ] || { echo "FAIL: frame2 expected surviving osm_id 2, got $OSM_ID"; exit 1; }

echo "INCREMENTAL TEST PASSED"
