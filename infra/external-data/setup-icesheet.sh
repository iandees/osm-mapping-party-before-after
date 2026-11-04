#!/bin/bash
# Fetch, verify and compile the pinned icesheet_proc (imagico/icesheet_proc, GPL-3).
#
# Fetched at image-build / run time rather than vendored, so its GPL-3 code never
# enters this repo; the data it produces is still ODbL. The last upstream commit is
# from 2018, so osmium_noice is compiled here against the current libosmium/GDAL.
# Idempotent. Used by the Dockerfile and, on a bare Debian 13 host, by build-icesheet.sh.
set -o errexit -o nounset -o pipefail

DIR=${ICESHEET_PROC_DIR:-/opt/icesheet_proc}
COMMIT=be4400fadac9488f19b8831ed1ef530a16912ef4
BASE=https://raw.githubusercontent.com/imagico/icesheet_proc/$COMMIT

if [ -x "$DIR/osmium_noice" ] && [ -f "$DIR/icesheet_proc.sh" ]; then
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl osmcoastline osmium-tool gdal-bin zip spatialite-bin \
  g++ libosmium2-dev libprotozero-dev libgdal-dev libexpat1-dev libbz2-dev zlib1g-dev

mkdir -p "$DIR"
cd "$DIR"
for f in icesheet_proc.sh osmium_noice.cpp COPYING; do
  curl -fsSL --retry 3 -o "$f" "$BASE/$f"
done
sha256sum -c <<SUMS
c17b34dd68ac845a8ee7d1377648abb4a9da334cb2fd8e0492ca561db1fd5084  icesheet_proc.sh
8077b8ca7df403e14f99df7bed1a22fdcd2d059c57acbbddcb31c3e10c259555  osmium_noice.cpp
8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903  COPYING
SUMS
# Compatibility patch for current GDAL: ogr2ogr rejects "-gt <n>" together with
# -skipfailures ("not allowed"), which upstream's script passes everywhere. -gt only
# sets the transaction size, so dropping it keeps the results the same.
sed -i 's/ -gt 65535//g' icesheet_proc.sh
chmod +x icesheet_proc.sh

# Same flags as upstream's Makefile, but C++17 as current libosmium requires.
g++ -O3 -std=c++17 -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE \
  $(gdal-config --cflags) -o osmium_noice osmium_noice.cpp \
  -rdynamic -lz -lpthread -lexpat -lbz2 -lgdal
echo "built $DIR/osmium_noice from icesheet_proc $COMMIT"
