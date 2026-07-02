import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import {
  createJob,
  createLoginToken,
  consumeLoginToken,
  countActiveJobsByEmail,
  getJob,
  markJobDone,
  markJobFailed,
  markJobRunning,
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

  it("transitions to failed from queued or running", async () => {
    const job = await createJob(DB, sampleJob, 1000);
    expect(await markJobFailed(DB, job.id, "boom", 1200)).toBe(true);
    expect((await getJob(DB, job.id))?.status).toBe("failed");
    // Terminal: cannot re-run.
    expect(await markJobRunning(DB, job.id, 1300)).toBe(false);
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
