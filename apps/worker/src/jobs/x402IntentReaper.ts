// x402 intent reaper. SPRINT_10_PLAN.md §3 + §8.
//
// Recurring janitor: DELETE FROM x402_intents WHERE expires_at < now() -
// interval '1 hour' AND consumed_at IS NULL.
//
// We keep CONSUMED rows for forensic / audit use even after expiry — the
// partial unique index on consuming_tx_hash plus the (payee, tag) lookup
// index are both well-bounded by the request volume, and consumed rows
// are what would matter most if we ever had to investigate a dispute.
//
// Stale UNCONSUMED rows are pure garbage: a 402 was minted, the client
// never paid, the 5-minute TTL passed, and the partial unique index on
// consuming_tx_hash won't fire because consumed_at stays NULL. They sit
// around growing the (payee, tag) index without contributing anything.
// The 1-hour grace window past `expires_at` is paranoia — gives an
// operator a window to inspect a freshly-expired intent before it
// disappears.
//
// Schedule: every 5 minutes (see worker/index.ts), one row per call is
// not adversarial — the partial idx_x402_intents_expires_at scan is cheap.

import { and, db, isNull, lt, schema, sql } from '@railforge/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';

const REAPER_GRACE_HOURS = 1;

export interface X402IntentReaperJobData {
  /** Override for the grace window in hours. Test-only. */
  graceHours?: number;
}

/**
 * Run one sweep. Returns the number of rows deleted so the BullMQ
 * job result and the test can both observe it.
 */
export async function processX402IntentReaperSweep(
  graceHours: number = REAPER_GRACE_HOURS,
): Promise<{ deletedCount: number }> {
  const log = logger.child({ job: 'x402IntentReaper', graceHours });

  // Lower bound: anything that expired more than `graceHours` ago is
  // eligible for deletion if it never got consumed. Computed in JS so
  // the test can wind a clock back; the live SQL evaluates the same
  // condition under a real `now()`.
  const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000);

  // Single DELETE; returning the id count gives us a metric for the log
  // line without needing a separate SELECT.
  const result = await db
    .delete(schema.x402Intents)
    .where(and(lt(schema.x402Intents.expiresAt, cutoff), isNull(schema.x402Intents.consumedAt)))
    .returning({ id: schema.x402Intents.id });

  const deletedCount = result.length;
  if (deletedCount > 0) {
    log.info({ deletedCount }, 'x402 intent reaper deleted stale rows');
  } else {
    log.debug('x402 intent reaper found nothing to delete');
  }
  return { deletedCount };
}

// Touch sql so the import isn't unused — the helper is available for any
// future SQL-driven extensions of this reaper (e.g. metric collection
// alongside the DELETE) without churning the import line.
void sql;

export const X402_INTENT_REAPER_QUEUE = 'railforge-x402-intent-reaper';

export function startX402IntentReaperWorker(redis: Redis): Worker<X402IntentReaperJobData> {
  return new Worker<X402IntentReaperJobData>(
    X402_INTENT_REAPER_QUEUE,
    async (job) => {
      await processX402IntentReaperSweep(job.data.graceHours);
    },
    {
      connection: redis,
      concurrency: 1,
    },
  );
}
