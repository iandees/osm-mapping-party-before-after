import { generateToken } from "./auth";
import { FARGATE_HOURLY_USD } from "./cost";

// SQL fragment computing the frozen Fargate compute cost for a job reaching a
// terminal state: MAX(0, finished - started) hours × the hourly rate. Bind order
// is (finishedNow, coalesceFallbackNow, hourlyRate). started_at may be NULL for a
// job that failed before it ever ran → cost 0.
const COST_SQL = "MAX(0, ? - COALESCE(started_at, ?)) / 3600.0 * ?";

export type JobStatus = "scheduled" | "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  email: string;
  name: string | null; // optional human label for the area (may be reverse-geocoded)
  bbox: string;
  time_before: string;
  time_after: string;
  zoom: number;
  output_px: number;
  num_frames: number;
  scale_bar: boolean;
  status: JobStatus;
  error: string | null;
  progress: string | null;
  result_key: string | null; // full R2 object key of the finished GIF
  cost_usd: number | null; // frozen Fargate compute-cost estimate, set at terminal state
  created_at: number;
  scheduled_for: number | null; // when a future job should be dispatched; NULL if immediate
  queued_at: number | null; // when the job was dispatched to the queue; drives the reaper clock
  started_at: number | null;
  finished_at: number | null;
}

export interface NewJob {
  email: string;
  name?: string | null;
  bbox: string;
  time_before: string;
  time_after: string;
  zoom: number;
  output_px: number;
  num_frames: number;
  scale_bar: boolean;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---- Login tokens -------------------------------------------------------

/** Create a single-use login token for `email`, returning the opaque token string. */
export async function createLoginToken(
  db: D1Database,
  email: string,
  ttlSeconds: number,
  now = nowSeconds(),
): Promise<string> {
  const token = generateToken();
  await db
    .prepare("INSERT INTO login_tokens (token, email, expires_at) VALUES (?, ?, ?)")
    .bind(token, email, now + ttlSeconds)
    .run();
  return token;
}

/**
 * Atomically consume a login token. Returns the associated email if the token is
 * valid, unexpired, and unused; otherwise null. Reuse is impossible because the
 * UPDATE only matches rows where `used_at IS NULL`.
 */
export async function consumeLoginToken(
  db: D1Database,
  token: string,
  now = nowSeconds(),
): Promise<string | null> {
  const row = await db
    .prepare(
      "UPDATE login_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at >= ? RETURNING email",
    )
    .bind(now, token, now)
    .first<{ email: string }>();
  return row?.email ?? null;
}

// ---- Jobs ---------------------------------------------------------------

/**
 * Insert a job. Pass `scheduledFor` (epoch seconds) to defer it: if it is in the
 * future (> now), the job is created `scheduled` and held for the dispatcher;
 * otherwise it is created `queued` and ready to enqueue immediately. `queued_at`
 * is stamped now for immediate jobs (uniform reaper clock) and left NULL for
 * scheduled ones (stamped when they are later dispatched).
 */
export async function createJob(
  db: D1Database,
  job: NewJob,
  now = nowSeconds(),
  scheduledFor: number | null = null,
): Promise<Job> {
  const id = crypto.randomUUID();
  const scheduled = scheduledFor != null && scheduledFor > now;
  const status: JobStatus = scheduled ? "scheduled" : "queued";
  await db
    .prepare(
      `INSERT INTO jobs
        (id, email, name, bbox, time_before, time_after, zoom, output_px, num_frames, scale_bar, status, created_at, scheduled_for, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      job.email,
      job.name ?? null,
      job.bbox,
      job.time_before,
      job.time_after,
      job.zoom,
      job.output_px,
      job.num_frames,
      job.scale_bar ? 1 : 0,
      status,
      now,
      scheduled ? scheduledFor : null,
      scheduled ? null : now,
    )
    .run();
  const created = await getJob(db, id);
  if (!created) throw new Error("failed to create job");
  return created;
}

export async function getJob(db: D1Database, id: string): Promise<Job | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
}

/**
 * Count non-terminal jobs (scheduled, queued, or running) for an email, for rate
 * limiting. Scheduled jobs count too: they are in-flight from the user's view and
 * this prevents scheduling a flood of future renders.
 */
export async function countActiveJobsByEmail(
  db: D1Database,
  email: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE email = ? AND status IN ('scheduled','queued','running')",
    )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Scheduled jobs whose dispatch time has arrived, oldest first, for the dispatcher. */
export async function getDueScheduledJobs(
  db: D1Database,
  now = nowSeconds(),
  limit = 50,
): Promise<Job[]> {
  const res = await db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'scheduled' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT ?",
    )
    .bind(now, limit)
    .all<Job>();
  return res.results ?? [];
}

/**
 * scheduled -> queued, stamping `queued_at` (the reaper clock). Atomic: only one
 * caller can win the transition, so overlapping dispatcher ticks can't double-enqueue.
 * Returns true if the transition applied.
 */
export async function markJobQueued(
  db: D1Database,
  id: string,
  now = nowSeconds(),
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE jobs SET status = 'queued', queued_at = ? WHERE id = ? AND status = 'scheduled'",
    )
    .bind(now, id)
    .run();
  return res.meta.changes > 0;
}

/** Update the free-text progress message (no status change). */
export async function updateJobProgress(
  db: D1Database,
  id: string,
  message: string,
): Promise<void> {
  await db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").bind(message, id).run();
}

/** Recent finished jobs across all users, for the public gallery. */
export async function getRecentDoneJobs(db: D1Database, limit: number): Promise<Job[]> {
  const res = await db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'done' AND result_key IS NOT NULL ORDER BY finished_at DESC LIMIT ?",
    )
    .bind(limit)
    .all<Job>();
  return res.results ?? [];
}

/** Recent finished jobs NOT owned by `email`, for the signed-in "others" gallery. */
export async function getRecentDoneJobsExcludingEmail(
  db: D1Database,
  email: string,
  limit: number,
): Promise<Job[]> {
  const res = await db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'done' AND result_key IS NOT NULL AND email != ? ORDER BY finished_at DESC LIMIT ?",
    )
    .bind(email, limit)
    .all<Job>();
  return res.results ?? [];
}

/**
 * All of one user's jobs regardless of status, newest first — for the signed-in
 * user's "Your maps" gallery, which shows in-progress and failed jobs too.
 */
export async function getJobsByEmail(
  db: D1Database,
  email: string,
  limit: number,
): Promise<Job[]> {
  const res = await db
    .prepare("SELECT * FROM jobs WHERE email = ? ORDER BY created_at DESC LIMIT ?")
    .bind(email, limit)
    .all<Job>();
  return res.results ?? [];
}

/**
 * Hard-delete a job the caller owns. Ownership is enforced in SQL (the email must
 * match), so there is no fetch-then-check race. Returns the deleted row (including
 * its `result_key`, so the caller can remove the R2 object) or null if no job with
 * that id belongs to `email`.
 */
export async function deleteJob(
  db: D1Database,
  id: string,
  email: string,
): Promise<Job | null> {
  return db
    .prepare("DELETE FROM jobs WHERE id = ? AND email = ? RETURNING *")
    .bind(id, email)
    .first<Job>();
}

/** queued -> running. Returns true if the transition applied. */
export async function markJobRunning(
  db: D1Database,
  id: string,
  now = nowSeconds(),
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
    )
    .bind(now, id)
    .run();
  return res.meta.changes > 0;
}

/** running -> done. Returns true if the transition applied. */
export async function markJobDone(
  db: D1Database,
  id: string,
  resultKey: string,
  now = nowSeconds(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'done', result_key = ?, finished_at = ?, cost_usd = ${COST_SQL} ` +
        "WHERE id = ? AND status = 'running'",
    )
    .bind(resultKey, now, now, now, FARGATE_HOURLY_USD, id)
    .run();
  return res.meta.changes > 0;
}

/**
 * Fail any jobs stuck in queued/running past `timeoutSeconds`, measured from when
 * the job was dispatched to the queue (`queued_at`, falling back to `created_at`),
 * NOT from creation — a job scheduled days out only starts its clock when it is
 * dispatched. `scheduled` jobs are excluded (they aren't in the queue yet). Catches
 * infra failures and render crashes that never call back; returns the affected jobs
 * so the caller can notify them.
 */
export async function failStuckJobs(
  db: D1Database,
  timeoutSeconds: number,
  now = nowSeconds(),
): Promise<{ id: string; email: string }[]> {
  const cutoff = now - timeoutSeconds;
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'Render timed out', finished_at = ?, cost_usd = ${COST_SQL} ` +
        "WHERE status IN ('queued','running') AND COALESCE(queued_at, created_at) < ? RETURNING id, email",
    )
    .bind(now, now, now, FARGATE_HOURLY_USD, cutoff)
    .all<{ id: string; email: string }>();
  return res.results ?? [];
}

/** queued|running -> failed. Returns true if the transition applied. */
export async function markJobFailed(
  db: D1Database,
  id: string,
  error: string,
  now = nowSeconds(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, cost_usd = ${COST_SQL} ` +
        "WHERE id = ? AND status IN ('queued','running')",
    )
    .bind(error, now, now, now, FARGATE_HOURLY_USD, id)
    .run();
  return res.meta.changes > 0;
}
