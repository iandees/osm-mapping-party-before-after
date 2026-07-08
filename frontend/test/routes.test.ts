import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { app, dispatchDueJobs } from "../src/index";
import type { Env } from "../src/env";
import { createJob, createLoginToken, getJob, markJobDone, markJobRunning } from "../src/db";

/** Log in as `email` and return the session cookie header value. */
async function sessionCookie(e: Parameters<typeof app.request>[2], email: string): Promise<string> {
  const token = await createLoginToken(env.DB, email, 900);
  const verify = await app.request(`/verify/${token}`, {}, e);
  return (verify.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Create a finished job (with a result_key) owned by `email`. */
async function doneJob(email: string) {
  const job = await createJob(env.DB, {
    email,
    bbox: "-0.2,51.4,0,51.6",
    time_before: "2020-01-01T00:00:00Z",
    time_after: "2024-01-01T00:00:00Z",
    zoom: 12,
    output_px: 400,
    num_frames: 2,
    scale_bar: false,
  });
  await markJobRunning(env.DB, job.id);
  await markJobDone(env.DB, job.id, `jobs/${job.id}/map.gif`);
  return job;
}

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

describe("about", () => {
  it("serves the about page with a link to the source repo", async () => {
    const { env: e } = testEnv();
    const res = await app.request("/about", {}, e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/About this site/i);
    expect(html).toContain("github.com/iandees/osm-mapping-party-before-after");
  });
});

describe("home", () => {
  it("shows the login page when unauthenticated", async () => {
    const { env: e } = testEnv();
    const res = await app.request("/", {}, e);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/sign-in link/i);
  });

  it("shows a public gallery of recent finished maps", async () => {
    const { env: e } = testEnv();
    const job = await createJob(env.DB, {
      email: "someone@example.com",
      bbox: "-0.2,51.4,0,51.6",
      time_before: "2020-01-01T00:00:00Z",
      time_after: "2024-01-01T00:00:00Z",
      zoom: 12,
      output_px: 400,
      num_frames: 2,
      scale_bar: false,
    });
    await markJobRunning(env.DB, job.id);
    await markJobDone(env.DB, job.id, `jobs/${job.id}/map.gif`);

    const html = await (await app.request("/", {}, e)).text();
    expect(html).toContain(`/r/jobs/${job.id}/map.gif`);
    expect(html).toContain(`/jobs/${job.id}`);
  });

  it("shows the frozen compute cost on a finished job page", async () => {
    const { env: e } = testEnv();
    const job = await createJob(env.DB, {
      email: "someone@example.com",
      bbox: "-0.2,51.4,0,51.6",
      time_before: "2020-01-01T00:00:00Z",
      time_after: "2024-01-01T00:00:00Z",
      zoom: 12,
      output_px: 400,
      num_frames: 2,
      scale_bar: false,
    });
    await markJobRunning(env.DB, job.id, 1000);
    await markJobDone(env.DB, job.id, `jobs/${job.id}/map.gif`, 1000 + 3600); // ran one hour

    const html = await (await app.request(`/jobs/${job.id}`, {}, e)).text();
    expect(html).toContain("Estimated compute cost");
    expect(html).toContain("$0.117 USD");
  });

  it("links the bbox to OSM.org and shows a friendly UTC time range", async () => {
    const { env: e } = testEnv();
    const job = await createJob(env.DB, {
      email: "someone@example.com",
      bbox: "-0.2,51.4,0,51.6",
      time_before: "2020-01-01T00:00:00Z",
      time_after: "2024-06-15T14:30:00Z",
      zoom: 12,
      output_px: 400,
      num_frames: 2,
      scale_bar: false,
    });
    await markJobRunning(env.DB, job.id);
    await markJobDone(env.DB, job.id, `jobs/${job.id}/map.gif`);

    const html = await (await app.request(`/jobs/${job.id}`, {}, e)).text();
    // bbox linked to OSM.org with the box outlined (order = minlon,minlat,maxlon,maxlat)
    expect(html).toContain(
      "https://www.openstreetmap.org/?minlon=-0.2&amp;minlat=51.4&amp;maxlon=0&amp;maxlat=51.6&amp;box=yes",
    );
    // friendly UTC range: midnight drops the time, a non-midnight time keeps HH:MM
    expect(html).toContain("1 Jan 2020 → 15 Jun 2024, 14:30 UTC");
    // the raw ISO timestamps are no longer shown
    expect(html).not.toContain("2024-06-15T14:30:00Z");
  });

  it("shows a signed-in user their in-progress maps and others' finished maps", async () => {
    const { env: e } = testEnv();
    const cookie = await sessionCookie(e, "me@example.com");

    // My own in-progress job (running, no result yet).
    const mine = await createJob(env.DB, {
      email: "me@example.com",
      bbox: "-0.2,51.4,0,51.6",
      time_before: "2020-01-01T00:00:00Z",
      time_after: "2024-01-01T00:00:00Z",
      zoom: 12,
      output_px: 400,
      num_frames: 2,
      scale_bar: false,
    });
    await markJobRunning(env.DB, mine.id);
    // Someone else's finished job.
    const theirs = await doneJob("other@example.com");

    const html = await (await app.request("/", { headers: { cookie } }, e)).text();
    expect(html).toContain("Your maps");
    expect(html).toContain(`/jobs/${mine.id}`); // in-progress card is listed
    expect(html).toContain("Maps from others");
    expect(html).toContain(`/r/jobs/${theirs.id}/map.gif`); // others' finished map
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
          name: "Downtown Rochester",
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

    // Job persisted (with its name) and SQS called.
    const job = await getJob(env.DB, jobId);
    expect(job?.status).toBe("queued");
    expect(job?.email).toBe("user@example.com");
    expect(job?.name).toBe("Downtown Rochester");
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

  it("shows an ordered progress checklist on a running job page", async () => {
    const { env: e } = testEnv();
    const job = await createJob(env.DB, {
      email: "user@example.com",
      bbox: "-0.2,51.4,0,51.6",
      time_before: "2020-01-01T00:00:00Z",
      time_after: "2024-01-01T00:00:00Z",
      zoom: 12,
      output_px: 400,
      num_frames: 2,
      scale_bar: false,
    });
    await markJobRunning(env.DB, job.id);

    const html = await (await app.request(`/jobs/${job.id}`, {}, e)).text();
    expect(html).toContain('class="checklist"');
    expect(html).toContain("Extracting frames");
    expect(html).toContain("Uploading your map");
  });
});

describe("scheduled submissions", () => {
  const jobFields = {
    bbox: "-0.2,51.4,0,51.6",
    time_before: "2020-01-01T00:00:00Z",
    time_after: "2024-01-01T00:00:00Z",
    zoom: 12,
    output_px: 400,
    num_frames: 2,
    scale_bar: false,
  };

  it("defers a future-end-time submission instead of enqueuing it", async () => {
    const { env: e } = testEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<ok/>", { status: 200 }));
    const cookie = await sessionCookie(e, "user@example.com");
    // +1 day (well within the future horizon), formatted like a datetime-local input.
    const future = new Date(Date.now() + 1 * 86400 * 1000).toISOString().slice(0, 16);

    const submit = await app.request(
      new Request("https://app.example.com/submit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          bbox: "-0.2,51.4,0.0,51.6",
          time_before: "2020-01-01T00:00",
          time_after: future,
          output_px: "800",
          num_frames: "2",
        }).toString(),
      }),
      {},
      e,
    );
    expect(submit.status).toBe(302);
    const jobId = (submit.headers.get("location") ?? "").split("/").pop()!;

    const job = await getJob(env.DB, jobId);
    expect(job?.status).toBe("scheduled");
    expect(job?.scheduled_for).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // A scheduled job is NOT enqueued to SQS at submit time.
    expect(fetchSpy).not.toHaveBeenCalled();

    const html = await (await app.request(`/jobs/${jobId}`, {}, e)).text();
    expect(html).toMatch(/scheduled/i);
  });

  it("dispatchDueJobs enqueues a due scheduled job and marks it queued", async () => {
    const { env: e } = testEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<ok/>", { status: 200 }));
    // scheduled_for=2000 is far in the past under the real clock → already due.
    const job = await createJob(env.DB, { email: "user@example.com", ...jobFields }, 1000, 2000);
    expect(job.status).toBe("scheduled");

    await dispatchDueJobs(e as unknown as Env);

    const after = await getJob(env.DB, job.id);
    expect(after?.status).toBe("queued");
    expect(after?.queued_at ?? 0).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("dispatchDueJobs leaves a not-yet-due scheduled job alone", async () => {
    const { env: e } = testEnv();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<ok/>", { status: 200 }));
    const job = await createJob(env.DB, { email: "user@example.com", ...jobFields }, 1000, 9_000_000_000);

    await dispatchDueJobs(e as unknown as Env);

    expect((await getJob(env.DB, job.id))?.status).toBe("scheduled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("delete render", () => {
  function delReq(id: string, headers: Record<string, string>) {
    return new Request(`https://app.example.com/jobs/${id}/delete`, { method: "POST", headers });
  }

  it("lets the owner delete their render and removes the R2 object", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { env: e } = testEnv({ RESULTS: { delete: del } });
    const cookie = await sessionCookie(e, "owner@example.com");
    const job = await doneJob("owner@example.com");

    const res = await app.request(delReq(job.id, { cookie }), {}, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await getJob(env.DB, job.id)).toBeNull();
    expect(del).toHaveBeenCalledWith(`jobs/${job.id}/map.gif`);
  });

  it("does not let a non-owner delete someone else's render", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { env: e } = testEnv({ RESULTS: { delete: del } });
    const cookie = await sessionCookie(e, "intruder@example.com");
    const job = await doneJob("owner@example.com");

    const res = await app.request(delReq(job.id, { cookie }), {}, e);
    expect(res.status).toBe(404);
    expect(await getJob(env.DB, job.id)).not.toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("requires a session to delete", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { env: e } = testEnv({ RESULTS: { delete: del } });
    const job = await doneJob("owner@example.com");

    const res = await app.request(delReq(job.id, { accept: "application/json" }), {}, e);
    expect(res.status).toBe(401);
    expect(await getJob(env.DB, job.id)).not.toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("shows a delete control to the owner on the job page but not to others", async () => {
    const { env: e } = testEnv();
    const cookie = await sessionCookie(e, "owner@example.com");
    const job = await doneJob("owner@example.com");

    const asOwner = await (await app.request(`/jobs/${job.id}`, { headers: { cookie } }, e)).text();
    expect(asOwner).toContain(`/jobs/${job.id}/delete`);

    const asAnon = await (await app.request(`/jobs/${job.id}`, {}, e)).text();
    expect(asAnon).not.toContain(`/jobs/${job.id}/delete`);
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

    // A progress-only callback updates the message but not the status.
    await app.request(
      new Request(`https://app.example.com/internal/jobs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-callback-secret": "callback-secret" },
        body: JSON.stringify({ status: "progress", message: "Importing frame 2/2…" }),
      }),
      {},
      e,
    );
    const mid = await getJob(env.DB, id);
    expect(mid?.status).toBe("running");
    expect(mid?.progress).toBe("Importing frame 2/2…");

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

describe("internal job params", () => {
  it("includes the scale_bar flag in the params payload", async () => {
    const { env: e } = testEnv();
    const job = await createJob(
      env.DB,
      {
        email: "someone@example.com",
        bbox: "-0.2,51.4,0,51.6",
        time_before: "2020-01-01T00:00:00Z",
        time_after: "2024-01-01T00:00:00Z",
        zoom: 12,
        output_px: 400,
        num_frames: 2,
        scale_bar: true,
      },
      undefined,
      null,
    );

    const res = await app.request(
      new Request(`https://app.example.com/internal/jobs/${job.id}`, {
        headers: { "x-callback-secret": "callback-secret" },
      }),
      {},
      e,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scale_bar: boolean };
    expect(body.scale_bar).toBe(true);
  });
});
