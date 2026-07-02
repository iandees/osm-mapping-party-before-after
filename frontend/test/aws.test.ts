import { describe, it, expect, vi, afterEach } from "vitest";
import { enqueueRenderJob } from "../src/aws";
import type { Env } from "../src/env";

const env = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_REGION: "us-east-1",
  SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/render-queue",
} as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("enqueueRenderJob", () => {
  it("issues a signed POST carrying the job id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<ok/>", { status: 200 }));

    await enqueueRenderJob(env, "job-123");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const req = fetchSpy.mock.calls[0][0] as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(env.SQS_QUEUE_URL);
    // SigV4 signature must be present.
    expect(req.headers.get("authorization")).toMatch(/AWS4-HMAC-SHA256/);
    const body = await req.text();
    expect(body).toContain("Action=SendMessage");
    expect(body).toContain("MessageBody=job-123");
  });

  it("throws on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("denied", { status: 403 }),
    );
    await expect(enqueueRenderJob(env, "job-123")).rejects.toThrow(/403/);
  });
});
