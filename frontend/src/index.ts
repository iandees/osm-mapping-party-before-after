import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./env";
import {
  DEFAULT_LOGIN_TTL_SECONDS,
  DEFAULT_SESSION_TTL_SECONDS,
  SESSION_COOKIE,
  requireSession,
  signSession,
  verifySession,
} from "./auth";
import {
  consumeLoginToken,
  countActiveJobsByEmail,
  createJob,
  createLoginToken,
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
} from "./db";
import { DEFAULT_MAX_FUTURE_HORIZON_DAYS, isValidEmail, validateJobInput } from "./validation";
import { enqueueRenderJob } from "./aws";
import { sendFailureEmail, sendLoginEmail, sendResultEmail } from "./email";
import { aboutPage, checkEmailPage, formPage, jobPage, loginPage } from "./templates";

type Vars = { email: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.get("/health", (c) => c.text("ok"));

app.get("/about", (c) => c.html(aboutPage()));

// ---- Home: login page or job form -------------------------------------
app.get("/", async (c) => {
  const session = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SECRET_KEY);
  if (!session) {
    const recent = await getRecentDoneJobs(c.env.DB, 12);
    return c.html(loginPage(undefined, recent));
  }
  const [mine, others] = await Promise.all([
    getJobsByEmail(c.env.DB, session.email, 12),
    getRecentDoneJobsExcludingEmail(c.env.DB, session.email, 12),
  ]);
  const horizon = Number(c.env.MAX_FUTURE_HORIZON_DAYS) || DEFAULT_MAX_FUTURE_HORIZON_DAYS;
  return c.html(formPage(session.email, mine, others, undefined, horizon));
});

// ---- Magic-link login -------------------------------------------------
app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = form.email;
  if (!isValidEmail(email)) return c.html(loginPage("Please enter a valid email address."), 400);

  const token = await createLoginToken(c.env.DB, email, DEFAULT_LOGIN_TTL_SECONDS);
  const link = `${c.env.PUBLIC_BASE_URL}/verify/${token}`;
  // Best-effort send; don't reveal delivery failures to avoid enumeration.
  try {
    await sendLoginEmail(c.env, email, link);
  } catch (e) {
    console.error("login email failed", e);
  }
  return c.html(checkEmailPage(email));
});

app.get("/verify/:token", async (c) => {
  const email = await consumeLoginToken(c.env.DB, c.req.param("token"));
  if (!email) return c.html(loginPage("That sign-in link is invalid or expired."), 400);

  const cookie = await signSession(email, c.env.SECRET_KEY);
  setCookie(c, SESSION_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: DEFAULT_SESSION_TTL_SECONDS,
  });
  return c.redirect("/", 302);
});

app.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/", 302);
});

// ---- Job submission (auth required) -----------------------------------
app.post("/submit", requireSession(), async (c) => {
  const email = c.get("email");
  const [mine, others] = await Promise.all([
    getJobsByEmail(c.env.DB, email, 12),
    getRecentDoneJobsExcludingEmail(c.env.DB, email, 12),
  ]);
  const form = await c.req.parseBody();
  const maxArea = Number(c.env.MAX_BBOX_AREA) || 1.0;
  const now = Math.floor(Date.now() / 1000);
  const horizon = Number(c.env.MAX_FUTURE_HORIZON_DAYS) || DEFAULT_MAX_FUTURE_HORIZON_DAYS;
  const result = validateJobInput(form as Record<string, unknown>, maxArea, now, horizon);
  if (!result.ok) return c.html(formPage(email, mine, others, result.errors.join("; "), horizon), 400);

  const cap = Number(c.env.MAX_ACTIVE_JOBS_PER_EMAIL) || 3;
  if ((await countActiveJobsByEmail(c.env.DB, email)) >= cap) {
    return c.html(
      formPage(email, mine, others, `You already have ${cap} jobs in progress. Please wait for them to finish.`, horizon),
      429,
    );
  }

  // If the end-time is still in the future, defer the job: dispatch it once
  // time_after + buffer has passed (see the scheduled cron handler below).
  const buffer = Number(c.env.DISPATCH_BUFFER_SECONDS) || 600;
  const afterEpoch = Math.floor(Date.parse(result.value.time_after) / 1000);
  const scheduledFor = afterEpoch + buffer;
  const scheduled = scheduledFor > now;

  const job = await createJob(c.env.DB, { email, ...result.value }, now, scheduled ? scheduledFor : null);
  if (scheduled) {
    // Held for the dispatcher — nothing to enqueue yet. The job page shows the
    // scheduled state and polls until it dispatches.
    return c.redirect(`/jobs/${job.id}`, 302);
  }
  try {
    await enqueueRenderJob(c.env, job.id);
  } catch (e) {
    console.error("enqueue failed", e);
    await markJobFailed(c.env.DB, job.id, "Could not queue the render. Please try again.");
    return c.html(formPage(email, mine, others, "Could not queue the render. Please try again.", horizon), 502);
  }
  return c.redirect(`/jobs/${job.id}`, 302);
});

// ---- Job status / result ----------------------------------------------
app.get("/jobs/:id", async (c) => {
  const job = await getJob(c.env.DB, c.req.param("id"));
  if (!job) return c.notFound();
  const session = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SECRET_KEY);
  return c.html(jobPage(job, session?.email === job.email));
});

// ---- Delete a render (owner only) -------------------------------------
app.post("/jobs/:id/delete", requireSession(), async (c) => {
  const email = c.get("email");
  // Ownership is enforced in SQL; a missing or non-owned job returns null.
  const deleted = await deleteJob(c.env.DB, c.req.param("id"), email);
  if (!deleted) return c.notFound();
  if (deleted.result_key) {
    try {
      await c.env.RESULTS.delete(deleted.result_key);
    } catch (e) {
      // The row is already gone; a dangling R2 object is harmless (nothing links it).
      console.error("R2 delete failed", e);
    }
  }
  return c.redirect("/", 302);
});

app.get("/jobs/:id/status", async (c) => {
  const job = await getJob(c.env.DB, c.req.param("id") ?? "");
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json({
    status: job.status,
    error: job.error,
    progress: job.progress,
    result_key: job.result_key,
  });
});

// ---- Internal callbacks from the render task --------------------------
function checkCallbackAuth(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const provided = c.req.header("x-callback-secret");
  return !!provided && provided === c.env.CALLBACK_SECRET;
}

app.get("/internal/jobs/:id", async (c) => {
  if (!checkCallbackAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const job = await getJob(c.env.DB, c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json({
    id: job.id,
    bbox: job.bbox,
    time_before: job.time_before,
    time_after: job.time_after,
    zoom: job.zoom,
    output_px: job.output_px,
    num_frames: job.num_frames,
    scale_bar: !!job.scale_bar,
  });
});

app.post("/internal/jobs/:id", async (c) => {
  if (!checkCallbackAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const body = await c.req.json<{ status: string; resultKey?: string; error?: string; message?: string }>();

  // Any callback may carry a progress message.
  if (body.message) await updateJobProgress(c.env.DB, id, body.message);

  if (body.status === "progress") {
    return c.json({ ok: true }); // message-only update, already applied
  }
  if (body.status === "running") {
    await markJobRunning(c.env.DB, id);
    return c.json({ ok: true });
  }
  if (body.status === "failed") {
    const applied = await markJobFailed(c.env.DB, id, body.error ?? "render failed");
    if (applied) {
      const job = await getJob(c.env.DB, id);
      if (job) {
        try {
          await sendFailureEmail(c.env, job.email, `${c.env.PUBLIC_BASE_URL}/jobs/${id}`);
        } catch (e) {
          console.error("failure email failed", e);
        }
      }
    }
    return c.json({ ok: true });
  }
  if (body.status === "done") {
    if (!body.resultKey) return c.json({ error: "resultKey required" }, 400);
    const applied = await markJobDone(c.env.DB, id, body.resultKey);
    if (applied) {
      const job = await getJob(c.env.DB, id);
      if (job) {
        try {
          await sendResultEmail(c.env, job.email, `${c.env.PUBLIC_BASE_URL}/jobs/${id}`);
        } catch (e) {
          console.error("result email failed", e);
        }
      }
    }
    return c.json({ ok: true });
  }
  return c.json({ error: "unknown status" }, 400);
});

// ---- Serve result media from R2 ---------------------------------------
app.get("/r/*", async (c) => {
  const key = c.req.path.slice("/r/".length);
  const obj = await c.env.RESULTS.get(key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "image/gif",
      "cache-control": "public, max-age=86400",
    },
  });
});

// Scheduled reaper: fail jobs stuck past the timeout (infra failures, load-time
// crashes, or anything that never calls back) and notify the requester.
async function reapStuckJobs(env: Env): Promise<void> {
  const timeout = Number(env.STUCK_JOB_TIMEOUT_SECONDS) || 2700;
  const failed = await failStuckJobs(env.DB, timeout);
  for (const j of failed) {
    try {
      await sendFailureEmail(env, j.email, `${env.PUBLIC_BASE_URL}/jobs/${j.id}`);
    } catch (e) {
      console.error("reaper failure email failed", e);
    }
  }
  if (failed.length) console.log(`reaped ${failed.length} stuck job(s)`);
}

// Scheduled-job dispatcher: enqueue any deferred jobs whose dispatch time has
// arrived. The scheduled->queued transition is claimed atomically first so
// overlapping ticks can't double-enqueue; if the enqueue then fails, the job is
// failed immediately (and the requester emailed) rather than left dangling.
export async function dispatchDueJobs(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = await getDueScheduledJobs(env.DB, now);
  let dispatched = 0;
  for (const job of due) {
    if (!(await markJobQueued(env.DB, job.id, now))) continue; // lost the race
    try {
      await enqueueRenderJob(env, job.id);
      dispatched++;
    } catch (e) {
      console.error("dispatch enqueue failed", e);
      await markJobFailed(env.DB, job.id, "Could not queue the scheduled render.");
      try {
        await sendFailureEmail(env, job.email, `${env.PUBLIC_BASE_URL}/jobs/${job.id}`);
      } catch (e2) {
        console.error("dispatch failure email failed", e2);
      }
    }
  }
  if (dispatched) console.log(`dispatched ${dispatched} scheduled job(s)`);
}

// Named export for tests; default export is the Worker handler (fetch + scheduled).
export { app };
export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(Promise.all([reapStuckJobs(env), dispatchDueJobs(env)]));
  },
};
