import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";

export const SESSION_COOKIE = "session";
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const DEFAULT_LOGIN_TTL_SECONDS = 60 * 15; // 15 minutes

export interface SessionPayload {
  email: string;
  exp: number; // epoch seconds
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Cryptographically random opaque token (base64url), used for single-use login links. */
export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time comparison of two byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Produce a signed, stateless session cookie value: base64url(payload).base64url(hmac). */
export async function signSession(
  email: string,
  secret: string,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = { email, exp: now + ttlSeconds };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const sig = toBase64Url(await hmac(secret, body));
  return `${body}.${sig}`;
}

/** Verify a session cookie value. Returns the payload, or null if invalid/expired/tampered. */
export async function verifySession(
  value: string | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let expected: Uint8Array;
  let provided: Uint8Array;
  try {
    expected = await hmac(secret, body);
    provided = fromBase64Url(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return null;
  }
  if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < now) return null;
  return payload;
}

/**
 * Hono middleware: requires a valid session cookie. On success sets `email` in the
 * context; otherwise returns 401 (or redirects to "/" for HTML navigations).
 */
export function requireSession(): MiddlewareHandler<{ Bindings: Env; Variables: { email: string } }> {
  return async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    const session = await verifySession(cookie, c.env.SECRET_KEY);
    if (!session) {
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("text/html")) return c.redirect("/", 302);
      return c.json({ error: "authentication required" }, 401);
    }
    c.set("email", session.email);
    return next();
  };
}

export function getSessionEmail(c: Context<{ Variables: { email: string } }>): string {
  return c.get("email");
}
