#!/bin/bash
# Entrypoint of the scheduled build image: build the water polygons from the planet,
# then publish them to R2. Any failure (including publish.py's sanity checks) fails
# the Batch job, leaving the previously published files in place.
set -o errexit -o nounset -o pipefail

# Fail now rather than after the ~90 minute build.
: "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"

/app/build.sh
exec python3 /app/publish.py /var/build/out \
  --placeholders /app/placeholders \
  --check-against https://osmdata.mapki.com/manifest.json
