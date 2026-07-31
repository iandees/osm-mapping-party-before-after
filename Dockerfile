# ---- Americana: pre-generate OpenMapTiles build artifacts from a pinned
# commit (the one validated end-to-end in the feasibility spike). Only the
# generated output is copied into the final image, not this whole stage.
FROM openmaptiles/openmaptiles-tools:7.2 AS openmaptiles_build
ARG OPENMAPTILES_COMMIT=6c11838d38030148832c039c2ea367274db86a87
RUN git clone https://github.com/openmaptiles/openmaptiles.git /omt \
 && cd /omt && git checkout "$OPENMAPTILES_COMMIT"
WORKDIR /omt
RUN mkdir -p /build/sql \
 && generate-imposm3 openmaptiles.yaml > /build/mapping.yaml \
 && generate-sql openmaptiles.yaml --dir /build/sql \
 && generate-sqltomvt openmaptiles.yaml --key --postgis-ver 3.3.4 \
      --function --fname=getmvt >> /build/sql/run_last.sql

FROM postgis/postgis:18-3.6 AS development_build

RUN apt-get update --quiet \
&& apt-get install --quiet -y --no-install-recommends \
 ca-certificates gnupg lsb-release locales \
 wget curl \
 git-core unzip \
 netcat-openbsd \
&& locale-gen $LANG && update-locale LANG=$LANG


# Get packages
RUN apt-get update --quiet \
&& apt-get install --quiet -y --no-install-recommends \
 make \
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
