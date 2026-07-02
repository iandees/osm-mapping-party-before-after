# Web app: on-demand before/after GIFs

A thin always-on frontend (Cloudflare Worker) lets users log in by email magic
link, draw a bounding box, pick before/after times, and request a GIF. Requests
are handed to a scale-to-zero render backend on AWS Batch (Fargate) that wraps the
existing `make.sh` pipeline, uploads results to R2, and emails a link.

```
Browser ─ Cloudflare Worker (Hono) ─ D1 (jobs) , R2 (results)
              │ login → magic link (Cloudflare Email Service)
              │ verify → session cookie
              │ submit → SQS SendMessage (signed, scoped IAM user)
              ▼
           SQS ─ EventBridge Pipe ─ Batch SubmitJob (Fargate task)
                                        │ render (make.sh + task-local Postgres)
                                        │ region history cached in S3
                                        │ upload GIF(s) → R2
                                        ▼
                          callback → Worker /internal/* (shared secret)
                                        │ mark done + email result link
```

## Layout

- `frontend/` — Cloudflare Worker (TypeScript + Hono). `npm test`, `npm run dev`,
  `npm run deploy`.
- `render/` — headless render entrypoint (`entrypoint.sh` → `render_job.py`) and
  Geofabrik region selection (`region.py`). Baked into the existing Docker image.
- `infra/template.yaml` — CloudFormation for SQS, the EventBridge Pipe, Batch on
  Fargate, ECR, the S3 region cache, Secrets Manager, and the Worker's scoped SQS
  IAM user.

## Deploy

1. **AWS stack** (creates ECR, queue, Batch, etc.):
   ```bash
   aws cloudformation deploy --template-file infra/template.yaml \
     --stack-name osm-before-after --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       Subnets=subnet-a,subnet-b SecurityGroupId=sg-xxxx \
       WorkerBaseUrl=https://<worker-host> \
       R2Endpoint=https://<acct>.r2.cloudflarestorage.com R2Bucket=osm-before-after-results \
       GeofabrikUser=... GeofabrikPassword=... \
       R2AccessKeyId=... R2SecretAccessKey=... CallbackSecret=<random>
   ```
   Note the outputs: `EcrRepositoryUri`, `QueueUrl`, `WorkerAccessKeyId`,
   `WorkerSecretAccessKey`.

2. **Render image** — build the existing Dockerfile and push to the ECR repo:
   ```bash
   docker build -t "$ECR_URI:latest" .
   aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR_URI"
   docker push "$ECR_URI:latest"
   ```

3. **Cloudflare** — in `frontend/`:
   - `wrangler d1 create osm-before-after` → put the id in `wrangler.toml`.
   - `wrangler d1 migrations apply osm-before-after`.
   - `wrangler r2 bucket create osm-before-after-results`.
   - Set vars in `wrangler.toml` (`PUBLIC_BASE_URL`, `MAIL_FROM`, `AWS_REGION`,
     `SQS_QUEUE_URL` = stack `QueueUrl`).
   - `wrangler secret put` for `SECRET_KEY`, `AWS_ACCESS_KEY_ID`,
     `AWS_SECRET_ACCESS_KEY` (stack outputs), and `CALLBACK_SECRET` (same value
     passed to the stack).
   - `wrangler deploy`.

Cloudflare Email Service requires a verified sending domain and the Workers Paid
plan for arbitrary recipients.

## Notes

- Region selection uses the smallest Geofabrik region whose bounding box covers the
  request; `osmium extract` then clips to the exact bbox, so over-selection is safe.
- Region history files are cached in S3 (`RegionCacheRetentionDays` lifecycle) to
  avoid re-downloading from Geofabrik.
- Each render is an isolated Fargate task with its own Postgres, so jobs run
  concurrently up to the Batch compute environment's `MaxvCpus`.
- Fargate ephemeral storage caps at 200 GiB (`EphemeralStorageGiB`); very large
  regions may need a different compute type.
