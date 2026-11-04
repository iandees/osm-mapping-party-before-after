#!/usr/bin/env bash
# Launch a one-shot EC2 instance that runs build.sh and uploads the results to a
# *staging* prefix in the region-cache bucket, then terminates itself.
#
#   ./launch.sh           full build from the planet (large instance, hours)
#   SMOKE=1 ./launch.sh   same pipeline on a tiny Geofabrik extract (minutes)
#
# No IAM role is needed: this script presigns S3 PUT URLs for exactly the files
# the build produces and hands them to the instance. Promote staging -> live only
# after checking the build (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
AWS="uv run --quiet --with awscli aws --profile ${AWS_PROFILE:-openaddresses} --region us-east-1"
BUCKET=${BUCKET:-osm-before-after-region-cache-847904970422}

if [ "${SMOKE:-0}" = 1 ]; then
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

FILES=(
  water-polygons-split-3857.zip water-polygons-split-3857.zip.lastmod
  simplified-water-polygons-split-3857.zip simplified-water-polygons-split-3857.zip.lastmod
  manifest.json build.log
)

# Fail here, not an hour into an EC2 run, if the input can't be fetched.
curl -fsSI -o /dev/null "$PLANET_URL" || { echo "cannot fetch $PLANET_URL" >&2; exit 1; }

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
PY
)

# The icesheet zips are not rebuilt (we don't know how osmdata makes them); stage
# carto's empty placeholders so the cache is complete. Antarctica renders without ice.
for z in antarctica-icesheet-polygons-3857 antarctica-icesheet-outlines-3857; do
  $AWS s3 cp --only-show-errors "$ROOT/openstreetmap-carto/scripts/empty_files/$z.zip" "s3://$BUCKET/$PREFIX/$z.zip"
  $AWS s3 cp --only-show-errors "$ROOT/openstreetmap-carto/scripts/empty_files/$z.zip.lastmod" "s3://$BUCKET/$PREFIX/$z.zip.lastmod"
done

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
echo '$(base64 < "$HERE/build.sh" | tr -d '\n')' | base64 -d > /root/build.sh
cat > /root/upload-urls <<'URLS'
$URLS
URLS
PLANET_URL='$PLANET_URL' ALLOW_ERRORS=$ALLOW_ERRORS UPLOAD_URLS=/root/upload-urls timeout 10h bash /root/build.sh
UD
[ "$(wc -c < "$USER_DATA")" -lt 16000 ] || { echo "user-data too large" >&2; exit 1; }

AMI=$($AWS ssm get-parameter --name /aws/service/debian/release/13/latest/amd64 --query Parameter.Value --output text)
echo "Launching $INSTANCE_TYPE ($AMI), ${VOLUME_GB}GB, planet: $PLANET_URL, results: s3://$BUCKET/$PREFIX/"
$AWS ec2 run-instances \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
  --instance-initiated-shutdown-behavior terminate \
  --metadata-options HttpTokens=required \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --user-data "file://$USER_DATA" \
  --tag-specifications "[{\"ResourceType\":\"instance\",\"Tags\":$TAGS},{\"ResourceType\":\"volume\",\"Tags\":$TAGS}]" \
  --query 'Instances[0].InstanceId' --output text
