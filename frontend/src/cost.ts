import type { Job } from "./db";

// AWS Fargate on-demand pricing, us-east-1 (Linux/x86), rates as of 2026-07.
// The render task is pinned at 2 vCPU + 8 GB (infra/template.yaml: TaskVcpu / TaskMemory).
//   per-vCPU-hour = $0.04048 ; per-GB-hour = $0.004445
// DERIVATION: hourly = 2·vCPU-rate + 8·GB-rate. If the task's vCPU/memory
// (template.yaml), the region, or AWS's published rates change, RECOMPUTE this
// constant AND update the frozen literal in migrations/0004_cost.sql (which
// backfills historical rows). SQS / EventBridge Pipes / CloudWatch Logs / S3 /
// R2 are sub-cent per job and intentionally excluded — this is a compute-only
// estimate, not the full AWS bill.
export const FARGATE_HOURLY_USD = 2 * 0.04048 + 8 * 0.004445; // = 0.11652 USD/hr

/**
 * Estimated Fargate compute cost, in USD, for a task that ran `durationSeconds`.
 * Negative/zero durations clamp to 0 (a job that never actually ran costs nothing).
 */
export function estimateCostUsd(durationSeconds: number): number {
  return (Math.max(0, durationSeconds) / 3600) * FARGATE_HOURLY_USD;
}

/**
 * The cost figure to show for a job, or null if there is nothing to show yet.
 *
 * Precedence:
 *  - a frozen `cost_usd` (set when the job reached a terminal state) wins;
 *  - otherwise, if the job has started (running), show a live "so far" estimate
 *    from `started_at` to `now`;
 *  - otherwise (queued, never started) there is no cost to show.
 */
export function jobCostUsd(job: Job, now = Math.floor(Date.now() / 1000)): number | null {
  if (job.cost_usd != null) return job.cost_usd;
  if (job.started_at != null) return estimateCostUsd(now - job.started_at);
  return null;
}

/** Human-readable cost, e.g. "$0.008 USD". Sub-dollar values get 3 decimals. */
export function formatCostUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)} USD`;
}
