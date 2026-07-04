import { describe, it, expect } from "vitest";
import { FARGATE_HOURLY_USD, estimateCostUsd, formatCostUsd, jobCostUsd } from "../src/cost";
import type { Job } from "../src/db";

const baseJob: Job = {
  id: "j1",
  email: "user@example.com",
  name: null,
  bbox: "-1,50,0,51",
  time_before: "2020-01-01T00:00:00Z",
  time_after: "2024-01-01T00:00:00Z",
  zoom: 13,
  output_px: 800,
  num_frames: 2,
  status: "done",
  error: null,
  progress: null,
  result_key: "jobs/j1/x.gif",
  cost_usd: null,
  created_at: 1000,
  scheduled_for: null,
  queued_at: 1000,
  started_at: 1100,
  finished_at: 1200,
};

describe("estimateCostUsd", () => {
  it("prices one hour at the full hourly rate", () => {
    expect(estimateCostUsd(3600)).toBeCloseTo(FARGATE_HOURLY_USD, 10);
    expect(FARGATE_HOURLY_USD).toBeCloseTo(0.11652, 10);
  });

  it("scales linearly with duration", () => {
    expect(estimateCostUsd(1800)).toBeCloseTo(FARGATE_HOURLY_USD / 2, 10);
  });

  it("clamps zero and negative durations to 0", () => {
    expect(estimateCostUsd(0)).toBe(0);
    expect(estimateCostUsd(-500)).toBe(0);
  });
});

describe("formatCostUsd", () => {
  it("shows 3 decimals under a dollar and marks USD", () => {
    expect(formatCostUsd(0.0083)).toBe("$0.008 USD");
    expect(formatCostUsd(0)).toBe("$0.000 USD");
  });

  it("shows 2 decimals at or above a dollar", () => {
    expect(formatCostUsd(1.5)).toBe("$1.50 USD");
  });
});

describe("jobCostUsd", () => {
  it("returns the frozen cost when present", () => {
    expect(jobCostUsd({ ...baseJob, cost_usd: 0.042 })).toBe(0.042);
  });

  it("returns a live estimate for a running job from started_at to now", () => {
    const job: Job = { ...baseJob, status: "running", cost_usd: null, started_at: 1000, finished_at: null };
    // now - started = 3600s -> one full hour.
    expect(jobCostUsd(job, 4600)).toBeCloseTo(FARGATE_HOURLY_USD, 10);
  });

  it("returns null for a queued job that never started", () => {
    const job: Job = { ...baseJob, status: "queued", cost_usd: null, started_at: null, finished_at: null };
    expect(jobCostUsd(job, 5000)).toBeNull();
  });
});
