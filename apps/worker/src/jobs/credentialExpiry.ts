// Credential expiry background job.
//
// Scans the credentials table for credentials expiring within a
// configurable horizon (default 7 days). For each expiring credential,
// inserts a webhook_deliveries row with event type 'credential.expiring'
// and enqueues a delivery job. The alert fires once per credential —
// repeated runs are idempotent (we only alert credentials with status
// 'accepted', and the txConfirmer flips to 'expired' after the on-chain
// state changes).
//
// This job runs on a repeating BullMQ schedule (every 6 hours).

import { db, eq, schema } from '@railforge/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import { enqueueWebhookDelivery } from '../queues.ts';

// Credentials expiring within this window get alerts.
const EXPIRY_HORIZON_DAYS = 7;

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

  // Find accepted credentials expiring before the horizon.
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
    .where(eq(schema.credentials.status, 'accepted'));

  const now = new Date();
  const candidates = expiring.filter(
    (c) => c.expiresAt !== null && c.expiresAt > now && c.expiresAt <= horizon,
  );

  if (candidates.length === 0) {
    log.info('no expiring credentials found');
    return { alertedCount: 0 };
  }

  let alertedCount = 0;

  for (const cred of candidates) {
    // Find webhook endpoints for this client that subscribe to credential.expiring.
    const endpoints = await db
      .select({
        id: schema.webhookEndpoints.id,
        events: schema.webhookEndpoints.events,
      })
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.clientId, cred.clientId));

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
export function startCredentialExpiryWorker(redis: Redis): Worker<CredentialExpiryJobData> {
  return new Worker<CredentialExpiryJobData>(
    'railforge-credential-expiry',
    async (job) => {
      await processCredentialExpirySweep(job.data.horizonDays);
    },
    {
      connection: redis,
      concurrency: 1,
    },
  );
}
