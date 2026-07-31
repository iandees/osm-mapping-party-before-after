# ---- Americana: pre-generate OpenMapTiles build artifacts from a pinned
# commit (the one validated end-to-end in the feasibility spike). Only the
# generated output is copied into the final image, not this whole stage.
# Several OpenMapTiles layers (boundary/place, water, water_name) hard-require
# static reference datasets that osmium/imposm never produce from OSM data
# itself: Natural Earth (country/state boundaries), a water polygons extract
# (ocean fill), and an OSM lake-centerline extract (used for lake name label
# placement). Upstream openmaptiles loads all three from this same
# "import-data" image (pinned to the same 7.2 version as openmaptiles-tools
# and openmaptiles_build below) via ogr2ogr at Postgres-import time (see
# make.sh); only the raw files themselves are copied out here.
FROM openmaptiles/import-data:7.2 AS reference_data_build

# The OpenMapTiles building layer's aggregation function (update_building.sql,
# from the pinned commit below) also hard-requires a "country_osm_grid" table
# — per-country grid polygons used to bound the ST_ClusterDBSCAN aggregation
# to a manageable area (openmaptiles/openmaptiles#1044). Unlike Natural Earth,
# openmaptiles-tools has no bundled copy or generator for this table; it's a
# long-standing static community artifact (originally circulated for
# imposm/osm2pgsql building-aggregation setups) mirrored in the OSMNames
# project. Pinned to a specific commit (not `master`, the only unpinned
# dependency in this whole chain otherwise) with a checksum verified against
# what was actually fetched at pin time — the file hasn't changed since 2019,
# but there's no other integrity guarantee on a raw GitHub URL. This is its
# own build stage (rather than a RUN in the final stage, where it lived
# before) specifically so this ~87MB download's Docker layer cache doesn't
# get invalidated by every source-tree change further down (that layer sat
# after `COPY . ${HOME}`, forcing a re-download on every rebuild regardless
# of whether this file's own dependencies changed).
FROM curlimages/curl:8.11.1 AS country_grid_build
ARG COUNTRY_OSM_GRID_COMMIT=ccede88ad1fee7528467e669889c0e539566d86f
ARG COUNTRY_OSM_GRID_SHA256=5291fc51b4dd2abb00aed97a51d33eec9ee6584c45d3903c12c8abf6228d828a
RUN curl -fsSL -o /tmp/country_osm_grid.sql \
      "https://raw.githubusercontent.com/OSMNames/OSMNames/${COUNTRY_OSM_GRID_COMMIT}/data/sql/country_osm_grid.sql" \
 && echo "${COUNTRY_OSM_GRID_SHA256}  /tmp/country_osm_grid.sql" | sha256sum -c - \
 && gzip -9 /tmp/country_osm_grid.sql

# browser-entry.js used to fetch style.json/shields.json live from
# americanamap.org on every single frame render. Unlike everything else in
# this pipeline (which pins exact versions/commits/checksums — even
# country_osm_grid.sql above gets a pinned commit + checksum), that was a
# live, unversioned dependency: an upstream outage or breaking schema change
# would break every future render with no rollback, and it made historic
# renders non-reproducible (a "2015" render used whatever today's style
# happened to be, not any particular pinned version). Fetch and pin them here
# at image-build time instead. Unlike country_osm_grid.sql there is no
# commit-pinned mirror to fetch instead — these are server-rendered outputs,
# not files tracked in a git repo — so this can only pin by
# checksum-at-fetch-time, not by commit too. That's still enough: any future
# upstream change now requires deliberately re-fetching and bumping the
# checksum ARGs below (a loud, reviewed build failure) instead of silently
# being picked up by every future render. Scoped narrowly to just these two
# JSON files, which define the actual style/shield logic — the sprite sheet
# and font/glyph URLs referenced *inside* style.json are left as live
# references to americanamap.org's CDN, a much smaller, more acceptable
# residual risk since sprites/glyphs are simple binary assets that change far
# less often than style/shield logic.
FROM curlimages/curl:8.11.1 AS americana_style_build
ARG AMERICANA_STYLE_SHA256=4df2fa443587642fd9dc428072062d5f7cd1f34a7dfb324b59437ede98a05943
ARG AMERICANA_SHIELDS_SHA256=aaf72a3113739377b88ad7cfd7d85cd3c22881e3955a85f8b8416a76869a2fcc
RUN curl -fsSL -o /tmp/style.json https://americanamap.org/style.json \
 && echo "${AMERICANA_STYLE_SHA256}  /tmp/style.json" | sha256sum -c - \
 && curl -fsSL -o /tmp/shields.json https://americanamap.org/shields.json \
 && echo "${AMERICANA_SHIELDS_SHA256}  /tmp/shields.json" | sha256sum -c -

FROM openmaptiles/openmaptiles-tools:7.2 AS openmaptiles_build
ARG OPENMAPTILES_COMMIT=6c11838d38030148832c039c2ea367274db86a87
RUN git clone https://github.com/openmaptiles/openmaptiles.git /omt \
 && cd /omt && git checkout "$OPENMAPTILES_COMMIT"
WORKDIR /omt
RUN mkdir -p /build/sql /build/sql-tools \
 && generate-imposm3 openmaptiles.yaml > /build/mapping.yaml \
 && generate-sql openmaptiles.yaml --dir /build/sql \
 && generate-sqltomvt openmaptiles.yaml --key --postgis-ver 3.3.4 \
      --function --fname=getmvt >> /build/sql/run_last.sql \
 && cp /usr/src/app/sql/*.sql /build/sql-tools/
# /usr/src/app/sql is openmaptiles-tools' own SQL_TOOLS_DIR (postgis-vt-util.sql,
# a hstore delete_empty_keys() helper, language/label-grid functions, etc) — the
# generated tileset SQL above (run_first.sql, parallel/*.sql) calls these
# functions but doesn't define them. openmaptiles-tools' own `import-sql`
# script always loads SQL_TOOLS_DIR before SQL_DIR for exactly this reason;
# make.sh's Americana import path does the same (loads sql-tools/*.sql before
# run_first.sql, frame 0 only).

FROM postgis/postgis:18-3.6 AS development_build

RUN apt-get update --quiet \
&& apt-get install --quiet -y --no-install-recommends \
 ca-certificates gnupg lsb-release locales \
 wget curl \
 git-core unzip \
 netcat-openbsd \
&& locale-gen $LANG && update-locale LANG=$LANG

# Use Postgres 16, not this image's default 18, for the server itself (the
# PGDG apt repo this base image already has configured serves every
# supported major version side by side, so this doesn't change the Debian
# release or any other package). Verified at Americana implementation time:
# PostgreSQL 17+ forces CREATE/REFRESH MATERIALIZED VIEW to run its
# populating query with search_path hard-restricted to "pg_catalog,
# pg_temp" (a real, documented security hardening, not a bug — see the
# CREATE MATERIALIZED VIEW docs). OpenMapTiles' generated SQL
# (run_first.sql/parallel/*.sql, pinned to the commit above) calls its own
# helper functions (zres, get_basic_names, LabelGrid, etc.) unqualified from
# inside the very materialized views it creates — written against
# openmaptiles-tools' own reference stack (openmaptiles/postgis:7.2,
# PostgreSQL 14), which predates this restriction. Every one of those
# matviews fails ("function ... does not exist") under PG17/18 unless each
# call site is individually schema-qualified or each function individually
# ALTER'd to pin its own search_path — impractical across the vendored SQL.
# PG16 is the newest version without this restriction, so the vendored SQL
# runs unmodified. Carto's osm2pgsql-based import doesn't create
# materialized views and is unaffected either way (verified: STYLE=carto
# end-to-end still passes with PG16). The 18 packages stay installed
# (unused) rather than being purged, to avoid disturbing anything else in
# this base image that assumes their presence.
RUN apt-get install --quiet -y --no-install-recommends \
 postgresql-16 postgresql-16-postgis-3 postgresql-16-postgis-3-scripts \
&& apt-get clean autoclean \
&& apt-get autoremove --yes \
&& rm -rf /var/lib/{apt,dpkg,cache,log}/
ENV PG_MAJOR=16
ENV PATH="/usr/lib/postgresql/16/bin:${PATH}"

# Get packages
RUN apt-get update --quiet \
&& apt-get install --quiet -y --no-install-recommends \
 make \
 ffmpeg \
 fonts-hanazono \
 fonts-noto-cjk \
 fonts-noto-hinted \
 fonts-noto-unhinted \
 fonts-unifont \
 gdal-bin \
 graphicsmagick \
 liblua5.3-dev \
 libosmium2-dev \
 libprotozero-dev \
 lua5.3 \
 mapnik-utils \
 # npm intentionally omitted here — Debian's npm/nodejs pair conflicts with
 # the NodeSource nodejs install below and gets autoremoved otherwise.
 osm2pgsql \
 osmctools \
 osmium-tool \
 python-is-python3 \
 python3-mapnik \
 python3-lxml \
 python3-psycopg2 \
 python3-shapely \
 python3-pip \
 sudo \
 vim \
&& apt-get clean autoclean \
&& apt-get autoremove --yes \
&& rm -rf /var/lib/{apt,dpkg,cache,log}/

# ---- Americana toolchain: imposm3 (raw-OSM import) + martin (tile server) ----
COPY --from=openmaptiles_build /usr/local/bin/imposm /usr/local/bin/imposm
COPY --from=ghcr.io/maplibre/martin:1.13.0 /usr/local/bin/martin /usr/local/bin/martin

# Node.js 22 (Debian's bundled nodejs is older than what maplibre-gl/Puppeteer
# need — matches the version validated in the feasibility spike) + the system
# libraries Puppeteer's bundled Chromium needs to launch headless
# (https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux — verify
# this exact package list against this image's Debian release; some lib
# names change between Debian releases, e.g. the libasound2/libasound2t64
# split, so `apt-get install` failures here are a naming issue to fix, not a
# sign the approach is wrong). Also pulls in the runtime shared libraries
# the imposm3 and martin binaries (copied in above from other images) need
# but that this postgis-based image doesn't otherwise install:
# libleveldb1d (imposm3) and libuv1t64 (martin — trixie's libuv1 is named
# with the "t64" 64-bit-time_t suffix, there is no plain "libuv1" package).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
&& apt-get install --quiet -y --no-install-recommends nodejs \
&& apt-get install --quiet -y --no-install-recommends \
 ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
 libcairo2 libcups2 libdbus-1-3 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
 libleveldb1d libnspr4 libnss3 libpango-1.0-0 libuv1t64 libx11-6 \
 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxss1 xdg-utils \
&& apt-get clean autoclean \
&& apt-get autoremove --yes \
&& rm -rf /var/lib/{apt,dpkg,cache,log}/

RUN wget --quiet https://downloads.sourceforge.net/gs-fonts/ghostscript-fonts-std-8.11.tar.gz \
&& tar xf ghostscript-fonts-std-8.11.tar.gz \
&& mkdir -p /usr/share/fonts/type1/ \
&& mv fonts/ /usr/share/fonts/type1/gsfonts

# Install python libraries

RUN pip install --break-system-packages pyyaml nik4 requests notebook jupyterlab ipywidgets boto3

# Install carto for stylesheet
RUN npm install -g carto@1.2.0

ENV HOME=/home/postgres

# Make sure the contents of our repo are in ${HOME}
COPY . ${HOME}

COPY --from=openmaptiles_build /build ${HOME}/render/americana/openmaptiles-build
COPY --from=reference_data_build /import/natural_earth/natural_earth_vector.sqlite ${HOME}/render/americana/openmaptiles-build/natural_earth_vector.sqlite
COPY --from=reference_data_build /import/water_polygons/ ${HOME}/render/americana/openmaptiles-build/water_polygons/
COPY --from=reference_data_build /import/lake_centerline/lake_centerline.geojson ${HOME}/render/americana/openmaptiles-build/lake_centerline.geojson
COPY --from=country_grid_build /tmp/country_osm_grid.sql.gz ${HOME}/render/americana/openmaptiles-build/country_osm_grid.sql.gz
COPY --from=americana_style_build /tmp/style.json ${HOME}/render/americana/style/style.json
COPY --from=americana_style_build /tmp/shields.json ${HOME}/render/americana/style/shields.json

ENV PUPPETEER_CACHE_DIR=${HOME}/.cache/puppeteer
RUN cd ${HOME}/render/americana && npm ci && npm run build

RUN usermod -u 1000 postgres
RUN chown -R 1000 ${HOME}
USER postgres

RUN mkdir -p ${HOME}/openstreetmap-carto/data
RUN mkdir -p ${HOME}/output
RUN mkdir -p ${HOME}/pgdata
WORKDIR ${HOME}

RUN git clone https://github.com/geofabrik/sendfile_osm_oauth_protector

RUN chmod +x ${HOME}/render/entrypoint.sh ${HOME}/render/render_job.py

# Default entrypoint is the notebook (unchanged). The AWS Batch job definition
# overrides the command to run render/entrypoint.sh for headless rendering.
ENTRYPOINT ["./entrypoint-new.sh"]
