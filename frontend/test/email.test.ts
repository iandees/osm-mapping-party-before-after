import { describe, it, expect, vi } from "vitest";
import {
  renderFailureEmail,
  renderLoginEmail,
  renderResultEmail,
  sendLoginEmail,
  sendResultEmail,
} from "../src/email";
import type { Env } from "../src/env";

describe("email rendering", () => {
  it("includes the login link in both parts", () => {
    const link = "https://app.example.com/verify/tok123";
    const e = renderLoginEmail(link);
    expect(e.text).toContain(link);
    expect(e.html).toContain(link);
    expect(e.subject).toMatch(/sign-in/i);
  });

  it("includes the result url", () => {
    const url = "https://app.example.com/jobs/abc";
    const e = renderResultEmail(url);
    expect(e.text).toContain(url);
    expect(e.html).toContain(url);
  });

  it("renders a failure email with a retry link", () => {
    const url = "https://app.example.com/jobs/abc";
    const e = renderFailureEmail(url);
    expect(e.subject).toMatch(/couldn't be built/i);
    expect(e.html).toContain(url);
    expect(e.text).toContain(url);
  });

  it("escapes html-unsafe characters in links", () => {
    const e = renderLoginEmail("https://x/verify/a&b<c");
    expect(e.html).toContain("a&amp;b&lt;c");
  });
});

describe("sending", () => {
  function fakeEnv(send: ReturnType<typeof vi.fn>): Env {
    return { EMAIL: { send }, MAIL_FROM: "noreply@app.example.com" } as unknown as Env;
  }

  it("sends login email via the binding with from/to", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "1" });
    await sendLoginEmail(fakeEnv(send), "user@example.com", "https://x/verify/t");
    expect(send).toHaveBeenCalledOnce();
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("user@example.com");
    expect(msg.from).toBe("noreply@app.example.com");
    expect(msg.html).toContain("https://x/verify/t");
  });

  it("sends result email via the binding", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "2" });
    await sendResultEmail(fakeEnv(send), "user@example.com", "https://x/jobs/1");
    expect(send.mock.calls[0][0].subject).toMatch(/ready/i);
  });
});
