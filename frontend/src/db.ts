import { generateToken } from "./auth";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  email: string;
  bbox: string;
  time_before: string;
  time_after: string;
  min_zoom: number;
  max_zoom: number;
  num_frames: number;
  status: JobStatus;
  error: string | null;
  result_key: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface NewJob {
  email: string;
  bbox: string;
  time_before: string;
  time_after: string;
  min_zoom: number;
  max_zoom: number;
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
        (id, email, bbox, time_before, time_after, min_zoom, max_zoom, num_frames, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .bind(
      id,
      job.email,
      job.bbox,
      job.time_before,
      job.time_after,
      job.min_zoom,
      job.max_zoom,
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
