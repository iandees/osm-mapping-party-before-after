import { generateToken } from "./auth";

export type JobStatus = "queued" | "running" | "done" | "failed";

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
  status: JobStatus;
  error: string | null;
  progress: string | null;
  result_key: string | null; // full R2 object key of the finished GIF
  created_at: number;
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

export async function createJob(
  db: D1Database,
  job: NewJob,
  now = nowSeconds(),
): Promise<Job> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO jobs
        (id, email, name, bbox, time_before, time_after, zoom, output_px, num_frames, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
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
      now,
    )
    .run();
  const created = await getJob(db, id);
  if (!created) throw new Error("failed to create job");
  return created;
}

export async function getJob(db: D1Database, id: string): Promise<Job | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
}

/** Count non-terminal jobs (queued or running) for an email, for rate limiting. */
export async function countActiveJobsByEmail(
  db: D1Database,
  email: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE email = ? AND status IN ('queued','running')",
    )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
      "UPDATE jobs SET status = 'done', result_key = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(resultKey, now, id)
    .run();
  return res.meta.changes > 0;
}

/**
 * Fail any jobs stuck in queued/running past `timeoutSeconds` (measured from
 * creation). Catches infra failures and render crashes that never call back.
 * Returns the affected jobs so the caller can notify them.
 */
export async function failStuckJobs(
  db: D1Database,
  timeoutSeconds: number,
  now = nowSeconds(),
): Promise<{ id: string; email: string }[]> {
  const cutoff = now - timeoutSeconds;
  const res = await db
    .prepare(
      "UPDATE jobs SET status = 'failed', error = 'Render timed out', finished_at = ? " +
        "WHERE status IN ('queued','running') AND created_at < ? RETURNING id, email",
    )
    .bind(now, cutoff)
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
      "UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')",
    )
    .bind(error, now, id)
    .run();
  return res.meta.changes > 0;
}
