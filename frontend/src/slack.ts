import type { Job } from "./db";
import type { Env } from "./env";

export type SlackEvent = "done" | "failed";

// Slack mrkdwn only needs these three characters escaped.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MAX_ERROR_CHARS = 300;

/** Build the incoming-webhook payload for a finished job. The requester's email is deliberately left out. */
export function renderSlackMessage(job: Job, event: SlackEvent, baseUrl: string): { text: string } {
  const url = `${baseUrl}/jobs/${job.id}`;
  const label = esc(job.name || job.bbox);
  const details = `${esc(job.bbox)} · ${esc(job.time_before)} → ${esc(job.time_after)} · ${job.num_frames} frames`;
  if (event === "done") {
    return { text: `:white_check_mark: Map ready: <${url}|${label}>\n${details}` };
  }
  const error = esc((job.error ?? "unknown error").slice(0, MAX_ERROR_CHARS));
  // The job id is what you start from to trace a failure (D1 row -> Batch job -> CloudWatch log).
  const ran =
    job.started_at != null && job.finished_at != null
      ? ` · ran ${Math.max(0, job.finished_at - job.started_at)}s`
      : " · never started";
  return {
    text: `:x: Map failed: <${url}|${label}>\n${details}${ran}\nError: ${error}\nJob ID: \`${job.id}\``,
  };
}

/**
 * Post a job's outcome to Slack. A no-op when SLACK_WEBHOOK_URL isn't configured, and
 * never throws — a Slack outage must not break the render callback or the reaper.
 */
export async function notifySlack(env: Env, job: Job, event: SlackEvent): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;
  if (event === "done" && env.SLACK_NOTIFY_SUCCESS === "false") return; // failures-only channel
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(renderSlackMessage(job, event, env.PUBLIC_BASE_URL)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`slack webhook returned ${res.status}`);
  } catch (e) {
    console.error("slack notification failed", e);
  }
}
