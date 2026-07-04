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
                                        │ downscale → upload GIF → R2
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

## Environment specifics

- **AWS:** account via CLI profile `openaddresses`, region `us-east-1`.
- **Cloudflare:** account `abb981ba94fd6c090352b253fe594676`; site served at
  `https://beforeafter.mapki.com`; email sent from `ian@mapki.com` (Email Service
  on the `mapki.com` verified domain).
- **Geofabrik:** the render task logs in to the internal server with an **OSM
  username and password** (via the bundled `oauth_cookie_client.py`) — not a token.
- **Access:** open to anyone; the only gate is proving control of an email address.
- **Result retention:** none — result GIFs stay in R2 indefinitely.

### Cost notes (kept low by design)

- Fargate/Batch has **no idle cost** — tasks only run during a render.
- **Use public subnets** with `AssignPublicIp: ENABLED` (already set) so tasks
  reach the internet **without a NAT gateway** (a NAT would add ~$32/mo of idle
  cost — the main thing to avoid here).
- The S3 region cache expires after `RegionCacheRetentionDays` (30) since history
  extracts are large; results in R2 have no expiry per requirements.

## Deploy

1. **AWS stack** (creates ECR, queue, Batch, etc.):
   ```bash
   aws --profile openaddresses --region us-east-1 cloudformation deploy \
     --template-file infra/template.yaml \
     --stack-name osm-before-after --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       Subnets=subnet-a,subnet-b SecurityGroupId=sg-xxxx \
       WorkerBaseUrl=https://beforeafter.mapki.com \
       R2Endpoint=https://abb981ba94fd6c090352b253fe594676.r2.cloudflarestorage.com \
       R2Bucket=osm-before-after-results \
       GeofabrikUser=<osm-username> GeofabrikPassword=<osm-password> \
       R2AccessKeyId=... R2SecretAccessKey=... CallbackSecret=<random>
   ```
   Use **public** subnets (see cost notes). Note the outputs: `EcrRepositoryUri`,
   `QueueUrl`, `WorkerAccessKeyId`, `WorkerSecretAccessKey`.

2. **Render image** — build the existing Dockerfile and push to the ECR repo:
   ```bash
   docker build -t "$ECR_URI:latest" .
   aws --profile openaddresses ecr get-login-password \
     | docker login --username AWS --password-stdin "$ECR_URI"
   docker push "$ECR_URI:latest"
   ```

3. **Cloudflare** — in `frontend/`:
   - `wrangler d1 create osm-before-after` → put the id in `wrangler.toml`.
   - `wrangler d1 migrations apply osm-before-after`.
   - `wrangler r2 bucket create osm-before-after-results`.
   - `SQS_QUEUE_URL` in `wrangler.toml` = stack `QueueUrl` (other vars are set).
   - `wrangler secret put` for `SECRET_KEY`, `AWS_ACCESS_KEY_ID`,
     `AWS_SECRET_ACCESS_KEY` (stack outputs), and `CALLBACK_SECRET` (same value
     passed to the stack).
   - Bind a custom domain route for `beforeafter.mapki.com`; `wrangler deploy`.

Cloudflare Email Service requires the verified `mapki.com` sending domain and the
Workers Paid plan for arbitrary recipients.

## Data freshness

Geofabrik internal history files are regenerated ~daily. On each job the render
task checks the cached file's newest timestamp (`osmium fileinfo`) and re-downloads
from Geofabrik when it lacks data as recent as the requested *after* time, so a
stale cache never silently drops recent edits. The system does **not** apply OSM
replication diffs to "catch up" a file — it relies on Geofabrik's daily rebuild. A
request whose *after* time is within the last day may therefore render against
data up to ~24h old (logged as a warning); it will not fail.

## Output size

The user picks an **output image size** (longest side, `SIZE_MIN`–`SIZE_MAX` px,
default `SIZE_DEFAULT`), not a zoom. From the drawn bbox and that size the frontend
previews — and the server authoritatively computes (`suggestedZoom`) — the integer
Web-Mercator zoom whose render is at least that many pixels on its longer side. A
single GIF is rendered at that zoom, then the render task downscales it to the
requested size (`gm convert -resize`). This keeps GIF dimensions/file size bounded
and, because the derived zoom follows a bounded target, keeps the intermediate
render bounded too (no OOM guard needed). `MAX_BBOX_AREA` still caps bbox area to
bound data-extraction cost.

## Notes

- Region selection uses the smallest Geofabrik region whose bounding box covers the
  request; `osmium extract` then clips to the exact bbox, so over-selection is safe.
- Region history files are cached in S3 (`RegionCacheRetentionDays` lifecycle) to
  avoid re-downloading from Geofabrik.
- Each render is an isolated Fargate task with its own Postgres, so jobs run
  concurrently up to the Batch compute environment's `MaxvCpus`.
- Fargate ephemeral storage caps at 200 GiB (`EphemeralStorageGiB`); very large
  regions may need a different compute type.

## CI/CD

GitHub Actions builds, tests, and deploys — no maintainer machine required.

- `.github/workflows/frontend.yml` — on PRs touching `frontend/**`, runs
  `npm run typecheck` + `npm test`. On merge to `web-frontend`, applies D1
  migrations (`--remote`) then `wrangler deploy`.
- `.github/workflows/render-image.yml` — on PRs touching backend files
  (`Dockerfile`, `render/**`, `make.sh`, `entrypoint-new.sh`, `docker_run.sh`,
  the carto submodule), builds the amd64 image (no push). On merge to
  `web-frontend`, pushes `:latest` + `:<sha>` to ECR. Batch's job definition
  uses `:latest`, and Fargate resolves the tag at task launch, so the push is
  the deploy — no stack update needed.

### AWS access (OIDC — no stored keys)

`infra/template.yaml` creates an IAM role (`osm-before-after-github-deploy`)
that GitHub Actions assumes via OIDC. Trust is scoped to this repo on the
`web-frontend` branch; permissions are limited to pushing to the render ECR
repo. Re-run `infra/deploy.sh` once to create it, then copy the
`GitHubDeployRoleArn` output into the GitHub secret below. If the AWS account
already has a GitHub OIDC provider, set `GITHUB_OIDC_PROVIDER_ARN` in
`frontend/.deploy.secrets` before deploying (find it with
`aws iam list-open-id-connect-providers`).

### Required GitHub configuration

Repo → Settings → Secrets and variables → Actions:

Secrets:
- `AWS_DEPLOY_ROLE_ARN` — the stack's `GitHubDeployRoleArn` output.
- `CLOUDFLARE_API_TOKEN` — scoped API token with:
  - Account · Workers Scripts · Edit
  - Account · D1 · Edit (for migrations)
  - Zone · Workers Routes · Edit (on the `mapki.com` zone, for the custom domain)
  - Account · Account Settings · Read

Variables:
- `CLOUDFLARE_ACCOUNT_ID` — `abb981ba94fd6c090352b253fe594676`.
