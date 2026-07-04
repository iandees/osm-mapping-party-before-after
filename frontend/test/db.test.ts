import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import {
  createJob,
  createLoginToken,
  consumeLoginToken,
  countActiveJobsByEmail,
  deleteJob,
  failStuckJobs,
  getDueScheduledJobs,
  getJob,
  getJobsByEmail,
  getRecentDoneJobs,
  getRecentDoneJobsExcludingEmail,
  markJobDone,
  markJobFailed,
  markJobQueued,
  markJobRunning,
  updateJobProgress,
  type NewJob,
} from "../src/db";

const DB = env.DB;

const sampleJob: NewJob = {
  email: "user@example.com",
  bbox: "-1,50,0,51",
  time_before: "2020-01-01T00:00:00Z",
  time_after: "2024-01-01T00:00:00Z",
  zoom: 13,
  output_px: 800,
  num_frames: 2,
};

beforeEach(async () => {
  await DB.exec("DELETE FROM jobs");
  await DB.exec("DELETE FROM login_tokens");
});

describe("login tokens", () => {
  it("consumes a valid token once, returning the email", async () => {
    const token = await createLoginToken(DB, "user@example.com", 900, 1000);
    expect(await consumeLoginToken(DB, token, 1100)).toBe("user@example.com");
    // Reuse is rejected.
    expect(await consumeLoginToken(DB, token, 1100)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createLoginToken(DB, "user@example.com", 900, 1000);
    expect(await consumeLoginToken(DB, token, 2000)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await consumeLoginToken(DB, "does-not-exist", 1000)).toBeNull();
  });
});

describe("job lifecycle", () => {
  it("creates a queued job", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(job.status).toBe("queued");
    expect(job.created_at).toBe(1000);
    expect(await getJob(DB, job.id)).toMatchObject({ id: job.id, status: "queued" });
  });

  it("transitions queued -> running -> done", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(await markJobRunning(DB, job.id, 1100)).toBe(true);
    expect(await markJobDone(DB, job.id, "results/abc.gif", 1200)).toBe(true);
    const done = await getJob(DB, job.id);
    expect(done?.status).toBe("done");
    expect(done?.result_key).toBe("results/abc.gif");
    expect(done?.finished_at).toBe(1200);
  });

  it("cannot mark done a job that is not running", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(await markJobDone(DB, job.id, "k", 1200)).toBe(false); // still queued
  });

  it("freezes a compute cost when a job is marked done", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobRunning(DB, job.id, 1100);
    await markJobDone(DB, job.id, "results/abc.gif", 1100 + 3600); // ran one hour
    const done = await getJob(DB, job.id);
    expect(done?.cost_usd).toBeCloseTo(0.11652, 5);
  });

  it("freezes a compute cost when a running job is marked failed", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobRunning(DB, job.id, 1100);
    await markJobFailed(DB, job.id, "boom", 1100 + 1800); // half an hour
    const failed = await getJob(DB, job.id);
    expect(failed?.cost_usd).toBeCloseTo(0.11652 / 2, 5);
  });

  it("costs a job failed before it ever ran at zero", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobFailed(DB, job.id, "never started", 1200); // no markJobRunning
    const failed = await getJob(DB, job.id);
    expect(failed?.cost_usd).toBe(0);
  });

  it("freezes a compute cost when a stuck job is reaped", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobRunning(DB, job.id, 1100);
    await failStuckJobs(DB, 1, 1100 + 3600); // now well past the timeout
    const reaped = await getJob(DB, job.id);
    expect(reaped?.status).toBe("failed");
    expect(reaped?.cost_usd).toBeCloseTo(0.11652, 5);
  });

  it("deleteJob removes an owned job and returns its row", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobRunning(DB, job.id, 1100);
    await markJobDone(DB, job.id, "results/abc.gif", 1200);
    const deleted = await deleteJob(DB, job.id, sampleJob.email);
    expect(deleted?.id).toBe(job.id);
    expect(deleted?.result_key).toBe("results/abc.gif");
    expect(await getJob(DB, job.id)).toBeNull();
  });

  it("deleteJob refuses a job owned by someone else", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(await deleteJob(DB, job.id, "someone-else@example.com")).toBeNull();
    expect(await getJob(DB, job.id)).not.toBeNull();
  });

  it("deleteJob returns null for an unknown id", async () => {
    expect(await deleteJob(DB, "does-not-exist", sampleJob.email)).toBeNull();
  });

  it("transitions to failed from queued or running", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(await markJobFailed(DB, job.id, "boom", 1200)).toBe(true);
    expect((await getJob(DB, job.id))?.status).toBe("failed");
    // Terminal: cannot re-run.
    expect(await markJobRunning(DB, job.id, 1300)).toBe(false);
  });

  it("reaps only jobs older than the timeout, and returns them", async () => {
    const old = await createJob(DB, sampleJob, 1000);
    const recent = await createJob(DB, sampleJob, 5000);
    // now=6000, timeout=1000 → cutoff 5000; `old` (1000) is stuck, `recent` (5000) is not.
    const failed = await failStuckJobs(DB, 1000, 6000);
    expect(failed.map((f) => f.id)).toEqual([old.id]);
    expect(failed[0].email).toBe(sampleJob.email);
    expect((await getJob(DB, old.id))?.status).toBe("failed");
    expect((await getJob(DB, recent.id))?.status).toBe("queued");
  });

  it("does not reap terminal jobs", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobRunning(DB, job.id, 1000);
    await markJobDone(DB, job.id, "k", 1000);
    const failed = await failStuckJobs(DB, 1000, 999999);
    expect(failed).toHaveLength(0);
    expect((await getJob(DB, job.id))?.status).toBe("done");
  });

  it("updates progress without changing status", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    await markJobRunning(DB, job.id, 1100);
    await updateJobProgress(DB, job.id, "Importing frame 3/24…");
    const j = await getJob(DB, job.id);
    expect(j?.status).toBe("running");
    expect(j?.progress).toBe("Importing frame 3/24…");
  });

  it("lists recent done jobs globally and excluding one email", async () => {
    const a = await createJob(DB, { ...sampleJob, email: "a@x.com" }, 1000);
    const b = await createJob(DB, { ...sampleJob, email: "b@x.com" }, 1000);
    await markJobRunning(DB, a.id, 1100);
    await markJobDone(DB, a.id, "jobs/a/x.gif", 1200);
    await markJobRunning(DB, b.id, 1100);
    await markJobDone(DB, b.id, "jobs/b/x.gif", 1300);

    const recent = await getRecentDoneJobs(DB, 10);
    expect(recent.map((j) => j.id)).toEqual([b.id, a.id]); // newest finished first
    expect(recent.every((j) => j.result_key)).toBe(true);

    // "others" gallery for a@x.com excludes a@x.com's own maps.
    const others = await getRecentDoneJobsExcludingEmail(DB, "a@x.com", 10);
    expect(others.map((j) => j.id)).toEqual([b.id]);
  });

  it("getJobsByEmail returns a user's jobs of any status, newest first", async () => {
    const done = await createJob(DB, { ...sampleJob, email: "a@x.com" }, 1000);
    const running = await createJob(DB, { ...sampleJob, email: "a@x.com" }, 2000);
    const queued = await createJob(DB, { ...sampleJob, email: "a@x.com" }, 3000);
    await createJob(DB, { ...sampleJob, email: "b@x.com" }, 3000); // another user's
    await markJobRunning(DB, done.id, 1100);
    await markJobDone(DB, done.id, "jobs/a/x.gif", 1200);
    await markJobRunning(DB, running.id, 2100);

    const mine = await getJobsByEmail(DB, "a@x.com", 10);
    // Newest created first; includes the in-progress and queued jobs, not b@x.com's.
    expect(mine.map((j) => j.id)).toEqual([queued.id, running.id, done.id]);
    expect(mine.map((j) => j.status)).toEqual(["queued", "running", "done"]);
  });

  it("persists an optional name on a job", async () => {
    const named = await createJob(DB, { ...sampleJob, name: "Downtown Rochester" }, 1000);
    expect((await getJob(DB, named.id))?.name).toBe("Downtown Rochester");
    const unnamed = await createJob(DB, sampleJob, 1000);
    expect((await getJob(DB, unnamed.id))?.name).toBeNull();
  });

  it("counts only active (queued/running) jobs per email", async () => {
    const a = await createJob(DB, sampleJob, 1000);
    await createJob(DB, sampleJob, 1000);
    expect(await countActiveJobsByEmail(DB, sampleJob.email)).toBe(2);
    await markJobRunning(DB, a.id, 1100);
    await markJobDone(DB, a.id, "k", 1200);
    expect(await countActiveJobsByEmail(DB, sampleJob.email)).toBe(1);
  });
});

describe("scheduled jobs", () => {
  it("creates a scheduled job when scheduledFor is in the future", async () => {
    const job = await createJob(DB, sampleJob, 1000, 5000);
    expect(job.status).toBe("scheduled");
    expect(job.scheduled_for).toBe(5000);
    expect(job.queued_at).toBeNull();
  });

  it("creates a queued job when scheduledFor is not in the future", async () => {
    const job = await createJob(DB, sampleJob, 1000, 500); // 500 <= 1000 → run now
    expect(job.status).toBe("queued");
    expect(job.scheduled_for).toBeNull();
    expect(job.queued_at).toBe(1000);
  });

  it("stamps queued_at = now on an immediate (unscheduled) job", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(job.status).toBe("queued");
    expect(job.queued_at).toBe(1000);
    expect(job.scheduled_for).toBeNull();
  });

  it("getDueScheduledJobs returns only due jobs, oldest scheduled_for first", async () => {
    const dueA = await createJob(DB, sampleJob, 1000, 3000);
    const dueB = await createJob(DB, sampleJob, 1000, 2000);
    await createJob(DB, sampleJob, 1000, 9000); // not yet due at now=5000
    const due = await getDueScheduledJobs(DB, 5000);
    expect(due.map((j) => j.id)).toEqual([dueB.id, dueA.id]); // 2000 before 3000
  });

  it("markJobQueued transitions scheduled -> queued exactly once", async () => {
    const job = await createJob(DB, sampleJob, 1000, 2000);
    expect(await markJobQueued(DB, job.id, 5000)).toBe(true);
    const q = await getJob(DB, job.id);
    expect(q?.status).toBe("queued");
    expect(q?.queued_at).toBe(5000);
    // A second (racing) call finds nothing to transition.
    expect(await markJobQueued(DB, job.id, 6000)).toBe(false);
  });

  it("counts scheduled jobs toward the active total", async () => {
    await createJob(DB, sampleJob, 1000, 9000); // scheduled
    await createJob(DB, sampleJob, 1000); // queued
    expect(await countActiveJobsByEmail(DB, sampleJob.email)).toBe(2);
  });

  it("reaper ignores scheduled jobs and clocks from queued_at, not created_at", async () => {
    // Scheduled long ago (old created_at) but dispatched recently → must NOT be reaped.
    const sched = await createJob(DB, sampleJob, 1000, 2000);
    await markJobQueued(DB, sched.id, 100000); // dispatched at 100000
    // A genuinely stuck job dispatched long ago.
    const stuck = await createJob(DB, sampleJob, 1000); // queued_at = 1000
    // now=101000, timeout=1000 → cutoff 100000.
    const failed = await failStuckJobs(DB, 1000, 101000);
    expect(failed.map((f) => f.id)).toEqual([stuck.id]);
    expect((await getJob(DB, sched.id))?.status).toBe("queued");
    expect((await getJob(DB, stuck.id))?.status).toBe("failed");
  });

  it("reaper never touches a still-scheduled job even if created long ago", async () => {
    const sched = await createJob(DB, sampleJob, 1000, 9_000_000_000);
    const failed = await failStuckJobs(DB, 1, 100000);
    expect(failed).toHaveLength(0);
    expect((await getJob(DB, sched.id))?.status).toBe("scheduled");
  });
});
