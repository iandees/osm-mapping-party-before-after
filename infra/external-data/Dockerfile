# Image for the scheduled water-polygon build (see README.md): build.sh then publish.py.
FROM debian:trixie-slim

RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      ca-certificates curl osmcoastline osmium-tool gdal-bin zip python3 python3-boto3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY build.sh publish.py run.sh ./
COPY placeholders ./placeholders
ENTRYPOINT ["/app/run.sh"]
