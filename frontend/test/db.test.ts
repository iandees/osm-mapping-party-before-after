import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import {
  createJob,
  createLoginToken,
  consumeLoginToken,
  countActiveJobsByEmail,
  deleteJob,
  failStuckJobs,
  getDoneJobsByEmail,
  getJob,
  getRecentDoneJobs,
  markJobDone,
  markJobFailed,
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

  it("lists recent done jobs (with result_key) globally and per email", async () => {
    const a = await createJob(DB, { ...sampleJob, email: "a@x.com" }, 1000);
    const b = await createJob(DB, { ...sampleJob, email: "b@x.com" }, 1000);
    const pending = await createJob(DB, { ...sampleJob, email: "a@x.com" }, 1000);
    await markJobRunning(DB, a.id, 1100);
    await markJobDone(DB, a.id, "jobs/a/x.gif", 1200);
    await markJobRunning(DB, b.id, 1100);
    await markJobDone(DB, b.id, "jobs/b/x.gif", 1300);

    const recent = await getRecentDoneJobs(DB, 10);
    expect(recent.map((j) => j.id)).toEqual([b.id, a.id]); // newest finished first
    expect(recent.every((j) => j.result_key)).toBe(true);

    const mine = await getDoneJobsByEmail(DB, "a@x.com", 10);
    expect(mine.map((j) => j.id)).toEqual([a.id]); // not b's, not the still-queued one
    expect(pending.status).toBe("queued");
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
