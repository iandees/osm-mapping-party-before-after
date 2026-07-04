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
GITHUB_OIDC_PROVIDER_ARN="${GITHUB_OIDC_PROVIDER_ARN:-}"

AWS="uv run --with awscli aws --profile openaddresses --region us-east-1"

# A stack left in ROLLBACK_COMPLETE (or a failed initial create) cannot be updated;
# delete the empty shell before recreating.
status=$($AWS cloudformation describe-stacks --stack-name osm-before-after \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)
case "$status" in
  ROLLBACK_COMPLETE|CREATE_FAILED|REVIEW_IN_PROGRESS)
    echo "Stack is $status; deleting empty shell before recreating..."
    $AWS cloudformation delete-stack --stack-name osm-before-after
    $AWS cloudformation wait stack-delete-complete --stack-name osm-before-after
    ;;
esac

$AWS cloudformation deploy \
  --template-file "$ROOT/infra/template.yaml" \
  --stack-name osm-before-after \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags "Project=OSM Mapping Party" \
  --parameter-overrides \
    "Subnets=subnet-de35c1f5,subnet-35d87242,subnet-b978ade0" \
    "SecurityGroupId=sg-c08193a5" \
    "WorkerBaseUrl=https://beforeafter.mapki.com" \
    "R2Endpoint=https://abb981ba94fd6c090352b253fe594676.r2.cloudflarestorage.com" \
    "R2Bucket=osm-before-after-results" \
    "GeofabrikUser=$GEOFABRIK_USER" \
    "GeofabrikPassword=$GEOFABRIK_PASSWORD" \
    "R2AccessKeyId=$R2_ACCESS_KEY_ID" \
    "R2SecretAccessKey=$R2_SECRET_ACCESS_KEY" \
    "CallbackSecret=$CALLBACK_SECRET" \
    "GitHubOidcProviderArn=$GITHUB_OIDC_PROVIDER_ARN"

echo "Stack deployed. Non-sensitive outputs:"
uv run --with awscli aws --profile openaddresses --region us-east-1 \
  cloudformation describe-stacks --stack-name osm-before-after \
  --query "Stacks[0].Outputs[?OutputKey!='WorkerSecretAccessKey'].[OutputKey,OutputValue]" \
  --output table
echo "(WorkerSecretAccessKey is intentionally not printed; it will be piped into wrangler.)"
