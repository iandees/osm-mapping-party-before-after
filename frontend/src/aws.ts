import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

/**
 * Send a render request to SQS using a SigV4-signed request (aws4fetch). The
 * message body is the bare job id, which the EventBridge Pipe injects as the
 * JOB_ID container env var; the render task fetches full parameters back from the
 * Worker's /internal endpoint.
 */
export async function enqueueRenderJob(env: Env, jobId: string): Promise<void> {
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: "sqs",
  });

  const body = new URLSearchParams({
    Action: "SendMessage",
    Version: "2012-11-05",
    MessageBody: jobId,
  });

  const res = await client.fetch(env.SQS_QUEUE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SQS SendMessage failed (${res.status}): ${text}`);
  }
}
