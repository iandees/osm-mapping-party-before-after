-- Frozen per-job Fargate compute-cost estimate (USD), set when a job reaches a
-- terminal state (done/failed). NULL while queued/running (the UI shows a live
-- estimate for running jobs instead).
ALTER TABLE jobs ADD COLUMN cost_usd REAL;

-- Backfill existing terminal rows. The 0.11652 literal is the frozen
-- FARGATE_HOURLY_USD from src/cost.ts (2 vCPU + 8 GB, us-east-1) at the time this
-- migration was written; keep it in sync if that constant is ever recomputed.
-- Jobs that finished without ever starting (started_at IS NULL) cost 0.
UPDATE jobs
SET cost_usd =
  MAX(0, finished_at - COALESCE(started_at, finished_at)) / 3600.0 * 0.11652
WHERE status IN ('done', 'failed')
  AND finished_at IS NOT NULL
  AND cost_usd IS NULL;
