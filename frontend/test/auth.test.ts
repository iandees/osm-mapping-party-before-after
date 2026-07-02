import { describe, it, expect } from "vitest";
import {
  generateToken,
  signSession,
  verifySession,
} from "../src/auth";

const SECRET = "test-secret-key";

describe("generateToken", () => {
  it("produces unique url-safe tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("session cookies", () => {
  it("round-trips a valid session", async () => {
    const cookie = await signSession("user@example.com", SECRET);
    const payload = await verifySession(cookie, SECRET);
    expect(payload?.email).toBe("user@example.com");
  });

  it("rejects a tampered payload", async () => {
    const cookie = await signSession("user@example.com", SECRET);
    const [body, sig] = cookie.split(".");
    // Flip the payload but keep the old signature.
    const forged = await signSession("attacker@example.com", "other");
    const forgedBody = forged.split(".")[0];
    const tampered = `${forgedBody}.${sig}`;
    expect(await verifySession(tampered, SECRET)).toBeNull();
    expect(body).not.toEqual(forgedBody);
  });

  it("rejects a wrong secret", async () => {
    const cookie = await signSession("user@example.com", SECRET);
    expect(await verifySession(cookie, "wrong-secret")).toBeNull();
  });

  it("rejects an expired session", async () => {
    const now = 1_000_000;
    const cookie = await signSession("user@example.com", SECRET, 100, now);
    // Verify well after expiry.
    expect(await verifySession(cookie, SECRET, now + 200)).toBeNull();
    // Still valid before expiry.
    expect((await verifySession(cookie, SECRET, now + 50))?.email).toBe(
      "user@example.com",
    );
  });

  it("rejects malformed cookies", async () => {
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("", SECRET)).toBeNull();
    expect(await verifySession("nodot", SECRET)).toBeNull();
    expect(await verifySession(".onlysig", SECRET)).toBeNull();
  });
});
