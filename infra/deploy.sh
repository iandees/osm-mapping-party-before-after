#!/usr/bin/env bash
# Deploy the render backend CloudFormation stack.
# Secrets are read from frontend/.deploy.secrets (gitignored) — none are hardcoded.
#
# Creates (privileged resources to review): 3 IAM roles (Batch execution, Batch
# job, EventBridge Pipe), 1 IAM user (Worker, sqs:SendMessage only) + access key.
# Plus: ECR repo, S3 region-cache bucket, SQS queue + DLQ, Batch Fargate compute
# env/queue/job-def, EventBridge Pipe, Secrets Manager secret.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/frontend/.deploy.secrets"; set +a

uv run --with awscli aws --profile openaddresses --region us-east-1 cloudformation deploy \
  --template-file "$ROOT/infra/template.yaml" \
  --stack-name osm-before-after \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "Subnets=subnet-de35c1f5\,subnet-35d87242\,subnet-b978ade0" \
    "SecurityGroupId=sg-c08193a5" \
    "WorkerBaseUrl=https://beforeafter.mapki.com" \
    "R2Endpoint=https://abb981ba94fd6c090352b253fe594676.r2.cloudflarestorage.com" \
    "R2Bucket=osm-before-after-results" \
    "GeofabrikUser=$GEOFABRIK_USER" \
    "GeofabrikPassword=$GEOFABRIK_PASSWORD" \
    "R2AccessKeyId=$R2_ACCESS_KEY_ID" \
    "R2SecretAccessKey=$R2_SECRET_ACCESS_KEY" \
    "CallbackSecret=$CALLBACK_SECRET"

echo "Stack deployed. Non-sensitive outputs:"
uv run --with awscli aws --profile openaddresses --region us-east-1 \
  cloudformation describe-stacks --stack-name osm-before-after \
  --query "Stacks[0].Outputs[?OutputKey!='WorkerSecretAccessKey'].[OutputKey,OutputValue]" \
  --output table
echo "(WorkerSecretAccessKey is intentionally not printed; it will be piped into wrangler.)"
