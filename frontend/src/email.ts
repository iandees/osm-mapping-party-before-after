import type { Env } from "./env";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderLoginEmail(link: string): RenderedEmail {
  return {
    subject: "Your OSM before/after sign-in link",
    text:
      `Click to sign in and create a before/after map:\n\n${link}\n\n` +
      `This link expires soon and can be used once. If you didn't request it, ignore this email.`,
    html:
      `<p>Click to sign in and create a before/after map:</p>` +
      `<p><a href="${esc(link)}">${esc(link)}</a></p>` +
      `<p>This link expires soon and can be used once. If you didn't request it, ignore this email.</p>`,
  };
}

export function renderResultEmail(resultUrl: string): RenderedEmail {
  return {
    subject: "Your OSM before/after map is ready",
    text: `Your animated before/after map is ready:\n\n${resultUrl}\n`,
    html:
      `<p>Your animated before/after map is ready:</p>` +
      `<p><a href="${esc(resultUrl)}">${esc(resultUrl)}</a></p>`,
  };
}

async function send(env: Env, to: string, email: RenderedEmail): Promise<void> {
  await env.EMAIL.send({
    to,
    from: env.MAIL_FROM,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

export async function sendLoginEmail(env: Env, to: string, link: string): Promise<void> {
  await send(env, to, renderLoginEmail(link));
}

export async function sendResultEmail(env: Env, to: string, resultUrl: string): Promise<void> {
  await send(env, to, renderResultEmail(resultUrl));
}
