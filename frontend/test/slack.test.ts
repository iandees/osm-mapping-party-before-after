import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/db";
import type { Env } from "../src/env";
import { notifySlack, renderSlackMessage } from "../src/slack";

const job = {
  id: "job-1",
  email: "secret@example.com",
  name: "Hyde Park <test>",
  bbox: "-0.2,51.4,0.0,51.6",
  time_before: "2020-01-01T00:00",
  time_after: "2024-01-01T00:00",
  num_frames: 2,
  started_at: 1000,
  finished_at: 1042,
  error: "boom & <bust>",
} as unknown as Job;

const env = (url?: string) =>
  ({ PUBLIC_BASE_URL: "https://app.example.com", SLACK_WEBHOOK_URL: url }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("renderSlackMessage", () => {
  it("links the job, escapes mrkdwn characters, and omits the email on success", () => {
    const { text } = renderSlackMessage(job, "done", "https://app.example.com");
    expect(text).toContain("<https://app.example.com/jobs/job-1|Hyde Park &lt;test&gt;>");
    expect(text).toContain("2 frames");
    expect(text).not.toContain("secret@example.com");
    expect(text).not.toContain("Error:");
  });

  it("includes the escaped, truncated error on failure", () => {
    const { text } = renderSlackMessage({ ...job, error: "x".repeat(500) } as Job, "failed", "https://app.example.com");
    expect(text).toContain(":x: Map failed");
    expect(text).toContain("Error: " + "x".repeat(300));
    expect(text).not.toContain("x".repeat(301));
    expect(renderSlackMessage(job, "failed", "https://a").text).toContain("boom &amp; &lt;bust&gt;");
  });

  it("gives the job id and run time on failure, and notes a job that never started", () => {
    const text = renderSlackMessage(job, "failed", "https://a").text;
    expect(text).toContain("ran 42s");
    expect(text).toContain("Job ID: `job-1`");
    expect(renderSlackMessage({ ...job, started_at: null } as Job, "failed", "https://a").text).toContain("never started");
  });

  it("falls back to the bbox when the job has no name", () => {
    const { text } = renderSlackMessage({ ...job, name: null } as Job, "done", "https://a");
    expect(text).toContain("|-0.2,51.4,0.0,51.6>");
  });
});

describe("notifySlack", () => {
  it("does nothing when no webhook is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await notifySlack(env(undefined), job, "done");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips successes but still posts failures when SLACK_NOTIFY_SUCCESS is false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const e = { ...env("https://hooks.slack.test/abc"), SLACK_NOTIFY_SUCCESS: "false" } as Env;
    await notifySlack(e, job, "done");
    expect(fetchSpy).not.toHaveBeenCalled();
    await notifySlack(e, job, "failed");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("posts JSON to the webhook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await notifySlack(env("https://hooks.slack.test/abc"), job, "done");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(JSON.parse((init as RequestInit).body as string).text).toContain("Map ready");
  });

  it("swallows network errors and non-2xx responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await expect(notifySlack(env("https://hooks.slack.test/abc"), job, "failed")).resolves.toBeUndefined();
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(notifySlack(env("https://hooks.slack.test/abc"), job, "failed")).resolves.toBeUndefined();
  });
});
