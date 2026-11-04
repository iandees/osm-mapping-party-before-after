# Rebuilding and publishing the carto external data

`openstreetmap-carto` imports four shapefile zips from `osmdata.openstreetmap.de`
(`openstreetmap-carto/external-data.yml`). That host has had outages that failed every
render, so we rebuild the files from OpenStreetMap ourselves and publish them at
**https://osmdata.mapki.com/** (R2 bucket `osm-data`, free egress, public).

- `render/render_job.py` downloads the zips from `https://osmdata.mapki.com/download/`
  into `openstreetmap-carto/data/` before each carto render. `make.sh` then imports them
  with `get-external-data.py --no-update`, never touching osmdata. If the mirror is
  unreachable it falls back to downloading from osmdata as carto normally does.
- `build.sh` builds the files; `publish.py` uploads them and generates the web page.

## What is built

| File | How |
|---|---|
| `water-polygons-split-3857.zip` | OSMCoastline on the planet's `natural=coastline` ways, EPSG:3857, `--max-points=1000` |
| `simplified-water-polygons-split-3857.zip` | the same polygons run through `ogr2ogr -simplify 300` (≈1px at z9, the last zoom carto uses this layer). **An approximation** — we don't know how osmdata makes theirs |
| `antarctica-icesheet-{polygons,outlines}-3857.zip` | [icesheet_proc](https://github.com/imagico/icesheet_proc) (GPL-3) on Geofabrik's Antarctica extract: the land polygons minus the mapped non-ice landcover, plus `ice_edge` outlines. See below |

## Scheduled build (monthly)

`infra/template.yaml` defines an EventBridge rule (`ExternalDataSchedule`, default 06:00 UTC on
the 1st) that submits a Batch Fargate job (4 vCPU, 16 GB, 200 GiB ephemeral disk, ~90 minutes,
well under a dollar, ~2 hours with the Antarctic step) running the `Dockerfile` here:
`run.sh` -> `build-icesheet.sh` -> `build.sh` -> `publish.py`.
The image is built and pushed to the `osm-before-after-external-data` ECR repo by
`.github/workflows/external-data-image.yml` on pushes to `web-frontend`.

`publish.py` verifies the zips and rejects a build whose size differs from the published
one by more than 20-25% (`--check-against`), so a bad build fails the job and leaves the
published files alone. Set `ALERT_EMAIL` in `frontend/.deploy.secrets` before running
`infra/deploy.sh` to get an SNS email when the job fails (confirm the subscription from the
email). Run it by hand any time:

```sh
aws batch submit-job --job-name external-data-manual --job-queue <RenderJobQueue> \
  --job-definition osm-before-after-external-data
```

The sections below are the manual path, useful for the first build or debugging.

## Antarctic icesheet

`build-icesheet.sh` builds the two icesheet zips from Geofabrik's small Antarctica extract
(`antarctica-latest.osm.pbf`, which has both the coastline and the landcover), so it takes
about 40 minutes on a small instance, not the planet's hours. It runs OSMCoastline with
`--output-polygons=both --output-lines` (the land/water polygons and coastline lines that
icesheet_proc reads), then icesheet_proc itself.

`setup-icesheet.sh` fetches the upstream script and `osmium_noice.cpp` at a pinned commit
(`be4400f`, 2018 — upstream is unmaintained) and verifies their sha256s, so the GPL-3 code is
never vendored here. It compiles `osmium_noice` with C++17 against current libosmium/GDAL and
applies one patch: GDAL now rejects the `-gt` option upstream passes with `-skipfailures`.

Known quirks: 64 `ice_ice` outline segments lie on the map's world edge (x = ±20037508) where
the antimeridian cuts mapped glaciers; they are upstream behaviour and sit at the edge of the
Mercator world. The ice stops at 85.05°S, the Web Mercator limit. We have not compared the
output with osmdata's own files (their host was down when this was built).

If `build-icesheet.sh`'s output is missing, `publish.py` falls back to the empty placeholders
in `placeholders/` and says so on the page, but it rejects the build if that would replace
real icesheet files that are already published (the size check).

## Build

```sh
SMOKE=1 infra/external-data/launch.sh        # minutes, Monaco extract, t3.medium — checks the pipeline
MODE=icesheet infra/external-data/launch.sh  # just the Antarctic files, t3.large, ~40 min
infra/external-data/launch.sh                # full planet, m6i.2xlarge, ~90 min, under a dollar
```

`launch.sh` presigns S3 PUT URLs (no IAM role needed) and starts a Debian 13 instance in
us-east-1 that runs `build.sh` and **terminates itself**. Instance and volume are tagged
`Project=OSM Mapping Party`, like the CloudFormation stack. The planet comes from the AWS
open-data copy (`s3://osm-pds/planet-latest.osm.pbf`, same region, no transfer cost).

Results land in `s3://<region-cache-bucket>/external-data-staging/` (`external-data-smoke/`
for smoke runs, `external-data-icesheet/` for icesheet runs) along with `build.log` and `manifest.json` (planet timestamp, tool
version, osmcoastline exit code, sha256s). osmcoastline exits 2 when it repaired a
sub-metre gap in the coastline (normal; the planet has had one). The build accepts that
only if nothing was left unconnected and warnings are within osmcoastline's limit;
otherwise it aborts, uploading only the log.

## Coastline problems

osmcoastline lists everything it had to work around (gaps it closed, ways that never join up,
crossings, reversed rings) in the `error_points` and `error_lines` layers of `coastline.db`.
`build.sh` runs `problems.py export` to turn them into `coastline-problems.geojson`
(EPSG:4326; each feature has its type, the OSM node or way when there is one, a location
and a bbox). `publish.py` uploads that file and a generated `coastline-problems.html`
(summary, map and a list with OSM, iD and JOSM links) to the bucket root and links to it from
the main page, so mappers can fix the data at the source. A gap is reported once with its length, a place name (Nominatim), the ways touching each end and who last edited them, and the live OSM API is asked whether it has been edited since the planet snapshot (a coastline way now joining the ends is flagged *probably already fixed*). Those lookups are best effort and capped; a failed export or lookup never fails the build.

## Publish

Check `manifest.json` and the build log first, then upload to R2:

```sh
aws s3 cp --recursive s3://<region-cache-bucket>/external-data-staging/ ./out
export R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
uv run --with boto3 infra/external-data/publish.py ./out --placeholders infra/external-data/placeholders
```

`publish.py` uploads the zips, then the coastline problem files, `manifest.json`, then `index.html` last (generated from
the manifest: last-update time, sizes, links, how it's built, the ODbL licence), so the page
never links to a missing file. `--dry-run` writes the page locally without uploading.
The bucket is attached to `osmdata.mapki.com` as an R2 custom domain.
