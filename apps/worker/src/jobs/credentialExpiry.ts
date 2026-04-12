// Credential expiry background job.
//
// Scans the credentials table for credentials expiring within a
// configurable horizon (default 7 days). For each expiring credential,
// inserts a webhook_deliveries row with event type 'credential.expiring'
// and enqueues a delivery job.
//
// Dedup (PLAN.md §9.1 #19): each credential carries `last_expiry_alert_at`.
// The sweep only alerts credentials whose marker is NULL or older than
// DEDUP_INTERVAL_HOURS, then stamps the marker in the same DB round so
// concurrent sweeps cannot double-fire.
//
// This job runs on a repeating BullMQ schedule (every 6 hours).

import { and, db, eq, isNull, lte, or, schema } from '@railforge/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import { enqueueWebhookDelivery } from '../queues.ts';

// Credentials expiring within this window get alerts.
const EXPIRY_HORIZON_DAYS = 7;
// Don't re-alert a credential more often than this. 23h keeps safely under
// a daily cron and above the default 6h sweep cadence.
const DEDUP_INTERVAL_HOURS = 23;

export interface CredentialExpiryJobData {
  /** Optional override for the horizon (in days). Used by tests. */
  horizonDays?: number;
}

/**
 * Process a single credential expiry sweep.
 *
 * Exported so unit tests can call it directly.
 */
export async function processCredentialExpirySweep(
  horizonDays: number = EXPIRY_HORIZON_DAYS,
): Promise<{ alertedCount: number }> {
  const log = logger.child({ job: 'credentialExpiry', horizonDays });

  const horizon = new Date();
  horizon.setDate(horizon.getDate() + horizonDays);

  const now = new Date();
  const dedupCutoff = new Date(now.getTime() - DEDUP_INTERVAL_HOURS * 60 * 60 * 1000);

  // Find accepted credentials expiring before the horizon whose last alert
  // marker is either missing or older than the dedup window. Expiry/horizon
  // bounds are still filtered in JS because the schema stores expires_at as
  // a nullable timestamp and we want to keep the query simple.
  const expiring = await db
    .select({
      id: schema.credentials.id,
      clientId: schema.credentials.clientId,
      subjectAddress: schema.credentials.subjectAddress,
      issuerAddress: schema.credentials.issuerAddress,
      credentialType: schema.credentials.credentialType,
      expiresAt: schema.credentials.expiresAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.status, 'accepted'),
        or(
          isNull(schema.credentials.lastExpiryAlertAt),
          lte(schema.credentials.lastExpiryAlertAt, dedupCutoff),
        ),
      ),
    );

  const candidates = expiring.filter(
    (c) => c.expiresAt !== null && c.expiresAt > now && c.expiresAt <= horizon,
  );

  if (candidates.length === 0) {
    log.info('no expiring credentials found');
    return { alertedCount: 0 };
  }

  let alertedCount = 0;

  for (const cred of candidates) {
    // Claim the credential by stamping lastExpiryAlertAt under the same
    // dedup predicate. If another sweep raced us, the WHERE clause matches
    // zero rows and we skip. Postgres's UPDATE ... WHERE is atomic.
    const claim = await db
      .update(schema.credentials)
      .set({ lastExpiryAlertAt: now })
      .where(
        and(
          eq(schema.credentials.id, cred.id),
          or(
            isNull(schema.credentials.lastExpiryAlertAt),
            lte(schema.credentials.lastExpiryAlertAt, dedupCutoff),
          ),
        ),
      )
      .returning({ id: schema.credentials.id });
    if (claim.length === 0) continue;

    // Find webhook endpoints for this client that subscribe to credential.expiring.
    const endpoints = await db
      .select({
        id: schema.webhookEndpoints.id,
        events: schema.webhookEndpoints.events,
      })
      .from(schema.webhookEndpoints)
      .where(
        and(
          eq(schema.webhookEndpoints.clientId, cred.clientId),
          eq(schema.webhookEndpoints.isActive, true),
        ),
      );

    for (const ep of endpoints) {
      if (!ep.events?.includes('credential.expiring')) continue;

      const payload = {
        credential_id: cred.id,
        subject_address: cred.subjectAddress,
        issuer_address: cred.issuerAddress,
        credential_type: cred.credentialType,
        expires_at: cred.expiresAt?.toISOString(),
      };

      const inserted = await db
        .insert(schema.webhookDeliveries)
        .values({
          endpointId: ep.id,
          eventType: 'credential.expiring',
          payload,
          status: 'pending',
          attempts: 0,
        })
        .returning({ id: schema.webhookDeliveries.id });

      const deliveryId = inserted[0]?.id;
      if (!deliveryId) continue;

      await enqueueWebhookDelivery({ deliveryId, endpointId: ep.id });
      alertedCount++;
    }
  }

  log.info({ alertedCount, candidateCount: candidates.length }, 'credential expiry sweep complete');
  return { alertedCount };
}

/**
 * Wire the credential expiry worker into BullMQ.
 */
export const CREDENTIAL_EXPIRY_QUEUE = 'railforge-credential-expiry';

export function startCredentialExpiryWorker(redis: Redis): Worker<CredentialExpiryJobData> {
  return new Worker<CredentialExpiryJobData>(
    CREDENTIAL_EXPIRY_QUEUE,
    async (job) => {
      await processCredentialExpirySweep(job.data.horizonDays);
    },
    {
      connection: redis,
      concurrency: 1,
    },
  );
}
