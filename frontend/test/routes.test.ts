import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/index";
import { createLoginToken, getJob } from "../src/db";

// Build a test env: real D1/R2 bindings from the pool, plus stubbed EMAIL, AWS
// config, and secrets that aren't provided by wrangler vars in tests.
function testEnv(overrides: Record<string, unknown> = {}) {
  const emailSend = vi.fn().mockResolvedValue({ messageId: "x" });
  return {
    env: {
      ...env,
      EMAIL: { send: emailSend },
      SECRET_KEY: "test-secret",
      CALLBACK_SECRET: "callback-secret",
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "us-east-1",
      SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/render",
      PUBLIC_BASE_URL: "https://app.example.com",
      MAIL_FROM: "noreply@app.example.com",
      MAX_BBOX_AREA: "1.0",
      MAX_ACTIVE_JOBS_PER_EMAIL: "3",
      ...overrides,
    } as unknown as Parameters<typeof app.request>[2],
    emailSend,
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM jobs");
  await env.DB.exec("DELETE FROM login_tokens");
});

afterEach(() => vi.restoreAllMocks());

describe("home", () => {
  it("shows the login page when unauthenticated", async () => {
    const { env: e } = testEnv();
    const res = await app.request("/", {}, e);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/sign-in link/i);
  });
});

describe("auth gating", () => {
  it("blocks /submit without a session", async () => {
    const { env: e } = testEnv();
    const res = await app.request(
      "/submit",
      { method: "POST", headers: { accept: "application/json" } },
      e,
    );
    expect(res.status).toBe(401);
  });
});

describe("login flow", () => {
  it("rejects an invalid email", async () => {
    const { env: e } = testEnv();
    const res = await app.request(
      new Request("https://app.example.com/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "nope" }).toString(),
      }),
      {},
      e,
    );
    expect(res.status).toBe(400);
  });

  it("creates a token and sends an email for a valid address", async () => {
    const { env: e, emailSend } = testEnv();
    const res = await app.request(
      new Request("https://app.example.com/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "user@example.com" }).toString(),
      }),
      {},
      e,
    );
    expect(res.status).toBe(200);
    expect(emailSend).toHaveBeenCalledOnce();
    const link = emailSend.mock.calls[0][0].text as string;
    expect(link).toMatch(/\/verify\//);
  });
});

describe("verify + submit", () => {
  it("logs in via token and enqueues a job", async () => {
    const { env: e } = testEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<ok/>", { status: 200 }));

    // Mint a login token and verify it.
    const token = await createLoginToken(env.DB, "user@example.com", 900);
    const verify = await app.request(`/verify/${token}`, {}, e);
    expect(verify.status).toBe(302);
    const setCookie = verify.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/session=/);
    const cookie = setCookie.split(";")[0];

    // Submit a job with the session cookie.
    const submit = await app.request(
      new Request("https://app.example.com/submit", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: new URLSearchParams({
          bbox: "-0.2,51.4,0.0,51.6",
          time_before: "2020-01-01T00:00",
          time_after: "2024-01-01T00:00",
          output_px: "800",
          num_frames: "2",
        }).toString(),
      }),
      {},
      e,
    );
    expect(submit.status).toBe(302);
    const loc = submit.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/jobs\//);
    const jobId = loc.split("/").pop()!;

    // Job persisted and SQS called.
    const job = await getJob(env.DB, jobId);
    expect(job?.status).toBe("queued");
    expect(job?.email).toBe("user@example.com");
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Status endpoint is reachable (not shadowed by the HTML job route).
    const status = await app.request(`/jobs/${jobId}/status`, {}, e);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "queued" });
  });

  it("rejects an invalid job submission", async () => {
    const { env: e } = testEnv();
    const token = await createLoginToken(env.DB, "user@example.com", 900);
    const verify = await app.request(`/verify/${token}`, {}, e);
    const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
    const res = await app.request(
      new Request("https://app.example.com/submit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          bbox: "-10,0,10,10", // too big
          time_before: "2020-01-01T00:00",
          time_after: "2024-01-01T00:00",
          output_px: "800",
          num_frames: "2",
        }).toString(),
      }),
      {},
      e,
    );
    expect(res.status).toBe(400);
  });
});

describe("internal callbacks", () => {
  async function makeJob() {
    const { env: e } = testEnv();
    const token = await createLoginToken(env.DB, "user@example.com", 900);
    const verify = await app.request(`/verify/${token}`, {}, e);
    const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<ok/>", { status: 200 }));
    const submit = await app.request(
      new Request("https://app.example.com/submit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          bbox: "-0.2,51.4,0.0,51.6",
          time_before: "2020-01-01T00:00",
          time_after: "2024-01-01T00:00",
          output_px: "800",
          num_frames: "2",
        }).toString(),
      }),
      {},
      e,
    );
    vi.restoreAllMocks();
    return (submit.headers.get("location") ?? "").split("/").pop()!;
  }

  it("rejects callbacks without the shared secret", async () => {
    const { env: e } = testEnv();
    const id = await makeJob();
    const res = await app.request(
      new Request(`https://app.example.com/internal/jobs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
      {},
      e,
    );
    expect(res.status).toBe(401);
  });

  it("marks running then done and emails the result", async () => {
    const { env: e, emailSend } = testEnv();
    const id = await makeJob();

    const running = await app.request(
      new Request(`https://app.example.com/internal/jobs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-callback-secret": "callback-secret" },
        body: JSON.stringify({ status: "running" }),
      }),
      {},
      e,
    );
    expect(running.status).toBe(200);
    expect((await getJob(env.DB, id))?.status).toBe("running");

    const done = await app.request(
      new Request(`https://app.example.com/internal/jobs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-callback-secret": "callback-secret" },
        body: JSON.stringify({ status: "done", resultKey: `jobs/${id}/` }),
      }),
      {},
      e,
    );
    expect(done.status).toBe(200);
    const job = await getJob(env.DB, id);
    expect(job?.status).toBe("done");
    expect(job?.result_key).toBe(`jobs/${id}/`);
    expect(emailSend).toHaveBeenCalledOnce();
  });
});
