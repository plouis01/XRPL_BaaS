// Orphan transaction reconciler.
//
// Closes PLAN.md §9.2 G-1.
//
// The bug: services insert a `transactions` row inside a db.transaction
// and THEN call enqueueTxSubmit() outside the transaction. If Redis is
// unavailable at enqueue time (or BullMQ throws for any other reason),
// the DB rows commit but no BullMQ job ever runs them. The transactions
// row sits in status='queued' forever. For accounts/createAccount that
// also leaves an unfunded `accounts` row that the client can't use AND
// can't delete (deleteAccount checks isFunded first).
//
// The fix here is intentionally minimal: a periodic sweep that finds
// stale queued rows past a grace window and marks them as orphaned.
// We do NOT try to re-enqueue and re-submit them — re-running an
// arbitrary tx after an unbounded delay risks double-spend or stale
// fee/sequence races, and the client retry path with a new
// idempotency key is simpler and safer. Cleaning up the orphan state
// is what unblocks the client.
//
// On each orphan we ALSO soft-delete any `accounts` row whose
// fundingTxId matches — a treasury-funded account with a never-enqueued
// funding payment can never be used, and the namespace pollution
// (the unique address slot) blocks retry. Soft-deleting frees the
// client to call createAccount again and get a fresh address.
//
// Schedule: runs every 5 minutes. Grace window: 10 minutes — long
// enough that a normal enqueue (sub-second) is never racing with the
// sweep, short enough that genuine orphans don't sit for hours.

import { and, db, eq, isNull, like, lt, schema } from '@railforge/db';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';

const ORPHAN_RECONCILER_QUEUE = 'railforge-orphan-reconciler';

// Rows in 'queued' state older than this are eligible for orphan
// cleanup. Must be longer than the worst-case enqueue latency under
// normal load (sub-second) but short enough that a stuck client isn't
// wondering why their tx is still pending for hours.
const GRACE_PERIOD_MS = 10 * 60 * 1000;

// Rows in 'submitting' state older than this are eligible for orphan
// cleanup. The HIGH-08 claim-once gate (txSubmitter.ts) flips the row
// queued → submitting before any external call. If the submitter then
// crashes mid-call (Redis blip in sequencer, transient pool error,
// process kill), the row is stranded — the gate refuses to re-claim
// non-'queued' rows, so BullMQ retries no-op and the row never
// progresses. Fix-0 wraps the sequencer call in markFailed, which
// closes the most common path; this sweep is the safety net for
// every other path that could be added later. Longer than the
// 'queued' grace because a normal submit→confirm cycle can legitimately
// sit in 'submitting' for up to ~15s under load.
const SUBMITTING_GRACE_PERIOD_MS = 30 * 60 * 1000;

// Cap each sweep so a backlog can't tie up the worker concurrency slot
// for an unbounded duration. If there's more than this in one sweep,
// the next scheduled run picks up the rest.
const BATCH_SIZE = 100;

const ORPHAN_RESULT_CODE = 'ORPHANED';
const ORPHAN_ERROR_MESSAGE =
  'Transaction was never enqueued — likely a Redis outage at the time of submission. Retry with a new idempotency key.';

export interface OrphanReconcileJobData {
  /** Optional override for the grace window in ms. Used by tests. */
  gracePeriodMs?: number;
}

export interface OrphanReconcileResult {
  orphanedCount: number;
  accountsSoftDeleted: number;
  /**
   * REVIEW.md HIGH-09: count of HSM-mode `accounts` rows soft-deleted
   * because they never got a funding tx (generateInHsm failed permanently,
   * so fundingTxId is NULL and the tx-based sweep can't reach them).
   */
  hsmOrphansSoftDeleted: number;
  /**
   * Count of `transactions` rows stranded in 'submitting' past
   * SUBMITTING_GRACE_PERIOD_MS that this sweep marked 'failed'. Closes
   * the gap left by the HIGH-08 claim-once gate (txSubmitter.ts):
   * BullMQ retries refuse to re-claim non-'queued' rows, so a crash
   * mid-submit would otherwise strand the row indefinitely.
   */
  submittingOrphanedCount: number;
}

/**
 * Run a single orphan reconciliation sweep.
 *
 * Exported so unit tests can drive it directly without spinning up a
 * full BullMQ worker.
 */
export async function processOrphanReconcileSweep(
  gracePeriodMs: number = GRACE_PERIOD_MS,
): Promise<OrphanReconcileResult> {
  const log = logger.child({ job: 'orphanReconciler', gracePeriodMs });
  const cutoff = new Date(Date.now() - gracePeriodMs);

  // Pull a bounded batch of queued rows older than the cutoff. Selecting
  // first (instead of UPDATE...RETURNING) keeps the per-row work
  // independent so a single bad row doesn't roll back the whole sweep,
  // and lets the per-row UPDATE attach a status='queued' guard for
  // idempotency under concurrent sweeps.
  const stale = await db
    .select({
      id: schema.transactions.id,
      txType: schema.transactions.txType,
      sourceAddress: schema.transactions.sourceAddress,
    })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.status, 'queued'), lt(schema.transactions.createdAt, cutoff)))
    .limit(BATCH_SIZE);

  let orphanedCount = 0;
  let accountsSoftDeleted = 0;

  if (stale.length === 0) {
    log.debug('no orphan transactions found');
  }

  for (const row of stale) {
    // Claim the row by flipping status under a status='queued' guard.
    // If a concurrent sweep or a (very late) txSubmitter beat us to it,
    // the WHERE matches zero rows and we skip — no double-mark.
    const claim = await db
      .update(schema.transactions)
      .set({
        status: 'failed',
        resultCode: ORPHAN_RESULT_CODE,
        errorMessage: ORPHAN_ERROR_MESSAGE,
        submittedAt: new Date(),
      })
      .where(and(eq(schema.transactions.id, row.id), eq(schema.transactions.status, 'queued')))
      .returning({ id: schema.transactions.id });

    if (claim.length === 0) {
      log.debug({ txId: row.id }, 'orphan claim lost race, skipping');
      continue;
    }
    orphanedCount++;

    // If this orphan is the funding tx for an `accounts` row, soft-
    // delete that row so the client can retry createAccount with a
    // fresh address. We only touch UNFUNDED accounts (isFunded=false)
    // and NOT-already-soft-deleted ones — a confirmed-funded account
    // sharing this txId would be a database invariant violation we
    // do not want to silently mask.
    const deletedAccounts = await db
      .update(schema.accounts)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.accounts.fundingTxId, row.id), eq(schema.accounts.isFunded, false)))
      .returning({ id: schema.accounts.id });

    if (deletedAccounts.length > 0) {
      accountsSoftDeleted += deletedAccounts.length;
      log.warn(
        {
          txId: row.id,
          txType: row.txType,
          sourceAddress: row.sourceAddress,
          accountIds: deletedAccounts.map((a) => a.id),
        },
        'orphan transaction marked failed and linked accounts soft-deleted',
      );
    } else {
      log.warn(
        {
          txId: row.id,
          txType: row.txType,
          sourceAddress: row.sourceAddress,
        },
        'orphan transaction marked failed',
      );
    }
  }

  // REVIEW.md HIGH-09: HSM pre-funding sweep.
  //
  // In HSM mode the API inserts an `accounts` row with a placeholder
  // address (`pending-<uuid>`) and masterKeyRef='pending' BEFORE the worker
  // generates the keypair. If the ACCOUNT_SETUP job fails permanently, the
  // funding `transactions` row is never created — so fundingTxId is NULL
  // and the tx-based sweep above cannot reach these rows. They accumulate
  // forever, bloating the table and counting against the client's
  // isFunded=false account limits.
  //
  // Fix: sweep for pending-% rows older than the cutoff that never
  // received a funding tx, and soft-delete them. The client can then call
  // createAccount again. Cap per-sweep work the same way as the tx sweep.
  const pendingHsmOrphans = await db
    .update(schema.accounts)
    .set({ deletedAt: new Date() })
    .where(
      and(
        like(schema.accounts.address, 'pending-%'),
        eq(schema.accounts.isFunded, false),
        isNull(schema.accounts.fundingTxId),
        isNull(schema.accounts.deletedAt),
        lt(schema.accounts.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.accounts.id });

  const hsmOrphansSoftDeleted = pendingHsmOrphans.length;
  if (hsmOrphansSoftDeleted > 0) {
    log.warn(
      {
        accountIds: pendingHsmOrphans.map((a) => a.id),
        count: hsmOrphansSoftDeleted,
      },
      'HSM-mode accounts soft-deleted (no funding tx after grace window)',
    );
  }

  // Stranded-'submitting' sweep. The HIGH-08 claim-once gate flips a
  // tx 'queued' → 'submitting' before any external call. Most failure
  // paths from there call markFailed (fix-0 closed the
  // getNextSequence gap). This sweep is the safety net for any future
  // gap or for a hard process kill between the claim and the first
  // external call. We use a longer grace than the 'queued' sweep
  // because a normal submit→confirm cycle can sit in 'submitting' for
  // ~10s under load, and we don't want to race a slow-but-progressing
  // submission. The same per-row claim guard prevents double-marks
  // under concurrent sweeps.
  const submittingCutoff = new Date(Date.now() - SUBMITTING_GRACE_PERIOD_MS);
  const stuckSubmitting = await db
    .select({
      id: schema.transactions.id,
      txType: schema.transactions.txType,
      sourceAddress: schema.transactions.sourceAddress,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.status, 'submitting'),
        lt(schema.transactions.createdAt, submittingCutoff),
      ),
    )
    .limit(BATCH_SIZE);

  let submittingOrphanedCount = 0;
  for (const row of stuckSubmitting) {
    const claim = await db
      .update(schema.transactions)
      .set({
        status: 'failed',
        resultCode: 'STRANDED_SUBMITTING',
        errorMessage:
          'Transaction was claimed by the submitter but never reached rippled — likely a worker crash between claim and submit. Retry with a new idempotency key.',
        submittedAt: new Date(),
      })
      .where(and(eq(schema.transactions.id, row.id), eq(schema.transactions.status, 'submitting')))
      .returning({ id: schema.transactions.id });
    if (claim.length === 0) {
      log.debug({ txId: row.id }, 'stranded-submitting claim lost race, skipping');
      continue;
    }
    submittingOrphanedCount++;
    log.warn(
      {
        txId: row.id,
        txType: row.txType,
        sourceAddress: row.sourceAddress,
      },
      'stranded-submitting transaction marked failed',
    );
  }

  log.info(
    {
      orphanedCount,
      accountsSoftDeleted,
      hsmOrphansSoftDeleted,
      submittingOrphanedCount,
      scannedCount: stale.length,
      scannedSubmittingCount: stuckSubmitting.length,
    },
    'orphan reconciliation sweep complete',
  );
  return {
    orphanedCount,
    accountsSoftDeleted,
    hsmOrphansSoftDeleted,
    submittingOrphanedCount,
  };
}

/**
 * Wire the orphan reconciler worker into BullMQ. Called from
 * apps/worker/src/index.ts at boot.
 *
 * The repeat schedule is registered separately by the bootstrap (see
 * registerOrphanReconcileSchedule below) so this function only owns
 * the consumer side.
 */
export function startOrphanReconcilerWorker(redis: Redis): Worker<OrphanReconcileJobData> {
  return new Worker<OrphanReconcileJobData>(
    ORPHAN_RECONCILER_QUEUE,
    async (job) => {
      await processOrphanReconcileSweep(job.data.gracePeriodMs);
    },
    {
      connection: redis,
      concurrency: 1,
    },
  );
}

export { ORPHAN_RECONCILER_QUEUE };
