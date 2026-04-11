// Webhook delivery worker.
//
// Pulls jobs off WEBHOOK_DELIVERY_QUEUE, fetches the delivery + endpoint
// from Postgres, computes HMAC-SHA256(secret, body) → header, POSTs to
// the endpoint URL, and updates the webhook_deliveries row.
//
// Retry policy lives in @railforge/jobs (5 attempts, exponential backoff
// 5s/10s/20s/40s/80s — see PLAN.md §4.4). The worker indicates "retry me"
// by THROWING. Returning normally marks the BullMQ job as done — that's
// what we do on both success (2xx) AND non-retryable failure (4xx that's
// not 429), since BullMQ will not retry a fulfilled promise.
//
// Status mapping on the webhook_deliveries row:
//   - 2xx                          → status='delivered', responseCode set
//   - 4xx (not 429)                → status='failed' immediately, attempts++
//   - 5xx, 429, network error      → throw → BullMQ retries
//   - last attempt of any failure  → status='failed', attempts++
//
// CRITICAL: never log the secret, never log the request body verbatim
// at info level (it could contain account addresses/PII). The HMAC
// signature itself is fine to log — it's a hash, not the secret.

import { createHmac } from 'node:crypto';
import { db, eq, schema } from '@railforge/db';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import { WEBHOOK_DELIVERY_QUEUE, type WebhookDeliveryJobData } from '../queues.ts';
import { SsrfBlockedError, resolveAndValidateHostname } from '../ssrfGuard.ts';

// Caps how long we wait on a single delivery POST before giving up and
// retrying. Long enough that a slow webhook receiver won't fail every
// time, short enough that one bad subscriber can't stall the queue.
const DELIVERY_TIMEOUT_MS = 10_000;

const SIGNATURE_HEADER = 'X-RailForge-Signature';

/**
 * Thrown by processWebhookDeliveryJob when the failure is transient and
 * BullMQ should retry. Distinct error type so unit tests can match on it.
 */
export class WebhookDeliveryRetryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryRetryable';
  }
}

/**
 * Compute the X-RailForge-Signature header value for a payload.
 *
 * Format: hex-encoded HMAC-SHA256 of the JSON body using the endpoint's
 * shared secret. The receiver verifies by repeating the computation with
 * the same secret and constant-time-comparing the hex strings.
 *
 * Exported so unit tests can call it directly without spinning up the
 * delivery pipeline.
 */
export function signWebhookPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Process a single webhook delivery job. Exported so unit tests can call
 * it directly with a mocked BullMQ Job.
 *
 * Pre-conditions: the deliveryId row already exists in webhook_deliveries
 * (created by whatever fan-out path enqueued this job).
 */
export async function processWebhookDeliveryJob(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { deliveryId, endpointId } = job.data;
  const log = logger.child({
    job: 'webhook-delivery',
    deliveryId,
    endpointId,
    attempt: job.attemptsMade + 1,
  });

  // 1. Fetch the delivery row + endpoint in two SELECTs. We could JOIN,
  // but two SELECTs are cheaper to mock and the query planner handles
  // both via indexed PK lookups.
  const deliveryRows = await db
    .select({
      id: schema.webhookDeliveries.id,
      eventType: schema.webhookDeliveries.eventType,
      payload: schema.webhookDeliveries.payload,
      status: schema.webhookDeliveries.status,
    })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, deliveryId))
    .limit(1);
  const delivery = deliveryRows[0];
  if (!delivery) {
    // Row vanished — nothing to deliver. Don't throw (no retry would help).
    log.warn('webhook delivery row not found, dropping job');
    return;
  }
  // If the row was already marked delivered (e.g. duplicate enqueue),
  // skip without re-POSTing. Idempotent on the receiving side too.
  if (delivery.status === 'delivered') {
    log.info('webhook delivery already marked delivered, skipping');
    return;
  }

  const endpointRows = await db
    .select({
      id: schema.webhookEndpoints.id,
      url: schema.webhookEndpoints.url,
      secret: schema.webhookEndpoints.secret,
      isActive: schema.webhookEndpoints.isActive,
    })
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, endpointId))
    .limit(1);
  const endpoint = endpointRows[0];
  if (!endpoint) {
    log.warn('webhook endpoint not found, marking failed');
    await markFailed(deliveryId, 0, job.attemptsMade + 1);
    return;
  }
  if (!endpoint.isActive) {
    log.info('webhook endpoint is inactive, dropping');
    await markFailed(deliveryId, 0, job.attemptsMade + 1);
    return;
  }

  // 2. SSRF guard (#18): resolve the hostname NOW and validate the
  // resolved IP against private/reserved ranges. This catches DNS
  // rebinding attacks where a public-looking hostname (which passed
  // the registration-time regex in webhook.service.ts) resolves to
  // an internal target like 169.254.169.254 (cloud metadata) or
  // 10.0.0.1 (internal LAN) at delivery time. A small race window
  // between this lookup and undici's internal lookup remains; see
  // the comment in ssrfGuard.ts for the residual-risk discussion.
  //
  // Failure modes:
  //   - SsrfBlockedError → mark failed permanently, do NOT retry
  //     (the target is unsafe and retrying won't fix that)
  //   - DNS resolve failure → treat as transient network error,
  //     let the existing retry path handle it
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint.url);
  } catch {
    log.warn({ url: endpoint.url }, 'webhook endpoint has an invalid URL, marking failed');
    await markFailed(deliveryId, 0, job.attemptsMade + 1);
    return;
  }
  try {
    await resolveAndValidateHostname(parsedUrl.hostname);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // Target resolved to a private/reserved IP. This is never going
      // to become safe — mark failed permanently, do NOT throw (we
      // don't want BullMQ to retry a blocked target).
      log.warn(
        { hostname: err.hostname, resolvedIp: err.resolvedIp },
        'webhook delivery blocked by SSRF guard',
      );
      await markFailed(deliveryId, 0, job.attemptsMade + 1);
      return;
    }
    // DNS resolution failure (NXDOMAIN, resolver timeout, etc.) —
    // treat as a transient network error and let the retry logic
    // below handle the last-attempt case.
    log.warn(
      {
        err: err instanceof Error ? err.message : 'unknown',
        hostname: parsedUrl.hostname,
      },
      'webhook delivery dns lookup failed',
    );
    await bumpAttempt(deliveryId, job.attemptsMade + 1);
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await markFailed(deliveryId, 0, job.attemptsMade + 1);
      return;
    }
    throw new WebhookDeliveryRetryable('webhook delivery dns lookup failed');
  }

  // 3. Build the body + signature. We sign the canonical JSON we send
  // on the wire — the receiver MUST hash exactly what they receive in
  // the body, NOT a re-serialization of the parsed JSON. This is the
  // standard pitfall and the reason we serialize once and hold onto
  // the string.
  const body = JSON.stringify({
    id: delivery.id,
    type: delivery.eventType,
    data: delivery.payload,
  });
  const signature = signWebhookPayload(endpoint.secret, body);

  // 4. POST. We use AbortSignal.timeout to bound the wait — a slow
  // subscriber must not stall the worker concurrency slot indefinitely.
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signature,
        'User-Agent': 'RailForge-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      // Disable automatic redirects. A 3xx to an attacker-controlled
      // URL would bypass the SSRF guard we just applied to the initial
      // hostname. We fall through to the isRetryable check below and
      // mark the delivery failed on a 3xx — clients should configure
      // their webhook URL to be the canonical endpoint.
      redirect: 'manual',
    });
  } catch (err) {
    // Network failure or timeout. ALWAYS retry transient network errors.
    // (Last-attempt handling is below.)
    log.warn(
      { err: err instanceof Error ? err.message : 'unknown' },
      'webhook delivery network error',
    );
    await bumpAttempt(deliveryId, job.attemptsMade + 1);
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await markFailed(deliveryId, 0, job.attemptsMade + 1);
      return; // BullMQ will mark the job failed on its own
    }
    throw new WebhookDeliveryRetryable('webhook delivery network error');
  }

  const status = response.status;

  // 4. Map the HTTP status to a delivery outcome.
  if (status >= 200 && status < 300) {
    await markDelivered(deliveryId, status, job.attemptsMade + 1);
    log.info({ status }, 'webhook delivered');
    return;
  }

  // 429 Too Many Requests is retryable. So is anything 5xx.
  const isRetryable = status === 429 || status >= 500;
  if (isRetryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1)) {
    log.warn({ status }, 'webhook delivery retryable failure');
    await bumpAttempt(deliveryId, job.attemptsMade + 1, status);
    throw new WebhookDeliveryRetryable(`webhook delivery returned ${status}`);
  }

  // Non-retryable (4xx that's not 429), or last attempt of a retryable failure.
  log.warn({ status }, 'webhook delivery failed permanently');
  await markFailed(deliveryId, status, job.attemptsMade + 1);
}

// ─────────────────────────────────────────────────────────────────────────
// db helpers — extracted so the call sites read top-to-bottom
// ─────────────────────────────────────────────────────────────────────────

async function markDelivered(deliveryId: string, status: number, attempts: number): Promise<void> {
  await db
    .update(schema.webhookDeliveries)
    .set({
      status: 'delivered',
      attempts,
      lastAttemptAt: new Date(),
      responseCode: status,
    })
    .where(eq(schema.webhookDeliveries.id, deliveryId));
}

async function markFailed(deliveryId: string, status: number, attempts: number): Promise<void> {
  await db
    .update(schema.webhookDeliveries)
    .set({
      status: 'failed',
      attempts,
      lastAttemptAt: new Date(),
      responseCode: status || null,
    })
    .where(eq(schema.webhookDeliveries.id, deliveryId));
}

async function bumpAttempt(deliveryId: string, attempts: number, status?: number): Promise<void> {
  await db
    .update(schema.webhookDeliveries)
    .set({
      attempts,
      lastAttemptAt: new Date(),
      ...(status !== undefined ? { responseCode: status } : {}),
    })
    .where(eq(schema.webhookDeliveries.id, deliveryId));
}

/**
 * Wire the worker into BullMQ. Called from apps/worker/src/index.ts at boot.
 */
export function startWebhookDeliveryWorker(redis: Redis): Worker<WebhookDeliveryJobData> {
  return new Worker<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE, processWebhookDeliveryJob, {
    connection: redis,
    // Webhook delivery is network-bound and safe to parallelize across
    // different deliveries. Same number as txConfirmer.
    concurrency: 5,
  });
}
