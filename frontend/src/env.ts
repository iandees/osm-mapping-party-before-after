// Cloudflare Email Service binding shape (public beta, 2026).
// See https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  to: string | EmailAddress | (string | EmailAddress)[];
  from: string | EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  cc?: string | EmailAddress | (string | EmailAddress)[];
  bcc?: string | EmailAddress | (string | EmailAddress)[];
  replyTo?: string | EmailAddress;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailBinding {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface Env {
  // Bindings
  DB: D1Database;
  RESULTS: R2Bucket;
  EMAIL: EmailBinding;

  // Secrets (wrangler secret put)
  SECRET_KEY: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  CALLBACK_SECRET: string;

  // Vars
  PUBLIC_BASE_URL: string;
  MAIL_FROM: string;
  AWS_REGION: string;
  SQS_QUEUE_URL: string;
  MAX_BBOX_AREA: string;
  MAX_ACTIVE_JOBS_PER_EMAIL: string;
  STUCK_JOB_TIMEOUT_SECONDS: string;
}
