#!/usr/bin/env bash
# Launch a one-shot EC2 instance that runs build.sh and uploads the results to a
# *staging* prefix in the region-cache bucket, then terminates itself.
#
#   ./launch.sh                full build from the planet (large instance, ~90 min)
#   SMOKE=1 ./launch.sh        same pipeline on a tiny Geofabrik extract (minutes)
#   MODE=icesheet ./launch.sh  just the Antarctic icesheet files (small instance, minutes)
#
# No IAM role is needed: this script presigns S3 PUT URLs for exactly the files
# the build produces and hands them to the instance. Promote staging -> live only
# after checking the build (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
AWS="uv run --quiet --with awscli aws --profile ${AWS_PROFILE:-openaddresses} --region us-east-1"
BUCKET=${BUCKET:-osm-before-after-region-cache-847904970422}

MODE=${MODE:-planet}
SCRIPT=build.sh

if [ "$MODE" = icesheet ]; then
  SCRIPT=build-icesheet.sh
  PREFIX=external-data-icesheet
  INSTANCE_TYPE=${INSTANCE_TYPE:-t3.large}
  VOLUME_GB=${VOLUME_GB:-30}
  PLANET_URL=
  ALLOW_ERRORS=${ALLOW_ERRORS:-0}
elif [ "${SMOKE:-0}" = 1 ]; then
  PREFIX=external-data-smoke
  INSTANCE_TYPE=${INSTANCE_TYPE:-t3.medium}
  VOLUME_GB=${VOLUME_GB:-20}
  PLANET_URL=${PLANET_URL:-https://download.geofabrik.de/europe/monaco-latest.osm.pbf}
  ALLOW_ERRORS=1  # a partial extract has incomplete coastline rings
else
  PREFIX=external-data-staging
  INSTANCE_TYPE=${INSTANCE_TYPE:-m6i.2xlarge}
  # planet (~95GB) + filtered coastline + outputs, with headroom
  VOLUME_GB=${VOLUME_GB:-300}
  PLANET_URL=${PLANET_URL:-https://osm-pds.s3.amazonaws.com/planet-latest.osm.pbf}
  ALLOW_ERRORS=0
fi

# Same tag the CloudFormation stack uses (infra/deploy.sh), for cost tracking.
TAGS='[{"Key":"Project","Value":"OSM Mapping Party"},{"Key":"Name","Value":"osm-before-after-external-data-build"}]'

if [ "$MODE" = icesheet ]; then
  FILES=(
    antarctica-icesheet-polygons-3857.zip antarctica-icesheet-polygons-3857.zip.lastmod
    antarctica-icesheet-outlines-3857.zip antarctica-icesheet-outlines-3857.zip.lastmod
    icesheet-info.json build.log
  )
else
  FILES=(
    water-polygons-split-3857.zip water-polygons-split-3857.zip.lastmod
    simplified-water-polygons-split-3857.zip simplified-water-polygons-split-3857.zip.lastmod
    manifest.json coastline-problems.geojson build.log
  )
  # Fail here, not an hour into an EC2 run, if the input can't be fetched.
  curl -fsSI -o /dev/null "$PLANET_URL" || { echo "cannot fetch $PLANET_URL" >&2; exit 1; }
fi

# The instance fetches the scripts as a tarball (too big to embed in user-data).
SRC=$(mktemp)
tar czf "$SRC" -C "$HERE" build.sh build-icesheet.sh setup-icesheet.sh problems.py
$AWS s3 cp --only-show-errors "$SRC" "s3://$BUCKET/$PREFIX/src.tgz"
rm -f "$SRC"

# 12h-valid presigned PUT URLs, one per output file.
URLS=$(uv run --quiet --with boto3 python3 - "$BUCKET" "$PREFIX" "${FILES[@]}" <<'PY'
import sys, boto3
from botocore.config import Config
bucket, prefix, *files = sys.argv[1:]
s3 = boto3.Session(profile_name="openaddresses").client(
    "s3", region_name="us-east-1", config=Config(signature_version="s3v4"))
for f in files:
    print(f, s3.generate_presigned_url(
        "put_object", Params={"Bucket": bucket, "Key": f"{prefix}/{f}"}, ExpiresIn=43200))
print("src.tgz", s3.generate_presigned_url(
    "get_object", Params={"Bucket": bucket, "Key": f"{prefix}/src.tgz"}, ExpiresIn=43200))
PY
)
SRC_URL=$(echo "$URLS" | awk '$1=="src.tgz"{print $2}')
URLS=$(echo "$URLS" | grep -v '^src.tgz ')


USER_DATA=$(mktemp)
trap 'rm -f "$USER_DATA"' EXIT
cat > "$USER_DATA" <<UD
#!/bin/bash
# Always upload the log and power off (=> terminate), whatever happens.
finish() {
  url=\$(awk '\$1=="build.log"{print \$2}' /root/upload-urls)
  curl -fsS -X PUT -T /var/log/build.log "\$url" || true
  shutdown -h now
}
trap finish EXIT
exec > >(tee /var/log/build.log /dev/console) 2>&1
mkdir -p /root/src
curl -fsS '$SRC_URL' | tar xz -C /root/src
cat > /root/upload-urls <<'URLS'
$URLS
URLS
PLANET_URL='$PLANET_URL' ALLOW_ERRORS=$ALLOW_ERRORS UPLOAD_URLS=/root/upload-urls timeout 10h bash /root/src/$SCRIPT
UD
[ "$(wc -c < "$USER_DATA")" -lt 16000 ] || { echo "user-data too large" >&2; exit 1; }

AMI=$($AWS ssm get-parameter --name /aws/service/debian/release/13/latest/amd64 --query Parameter.Value --output text)
echo "Launching $INSTANCE_TYPE ($AMI), ${VOLUME_GB}GB, $SCRIPT, results: s3://$BUCKET/$PREFIX/"
$AWS ec2 run-instances \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
  --instance-initiated-shutdown-behavior terminate \
  --metadata-options HttpTokens=required \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --user-data "file://$USER_DATA" \
  --tag-specifications "[{\"ResourceType\":\"instance\",\"Tags\":$TAGS},{\"ResourceType\":\"volume\",\"Tags\":$TAGS}]" \
  --query 'Instances[0].InstanceId' --output text
