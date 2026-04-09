// Transaction confirmation poller.
//
// After txSubmitter sends a tx to rippled, the tx is "submitted" but not
// yet validated (it hasn't made it into a closed ledger). This job polls
// the `tx` command until the tx is either:
//   (a) validated on-ledger → update row, fan out webhook events
//   (b) LastLedgerSequence expired without a result → mark failed, invalidate sequencer
//
// The job lives on TX_CONFIRM_QUEUE and uses BullMQ's retry with fixed
// backoff (~4s between polls, matching XRPL ledger close time). BullMQ's
// `attempts` count gives us a natural upper bound on poll attempts; once
// attempts are exhausted the job fails and the row is left in 'submitted'
// state. A separate reconciliation job (deferred) would catch orphans.
//
// Sprint 3 webhook fan-out: when a tx validates (success OR failure), we
// look up every active webhook_endpoints row for the client that
// subscribes to the matching event type, INSERT a webhook_deliveries row
// per subscriber, and enqueue them on the webhook-delivery queue. The
// delivery worker handles retries independently from this job.

import { and, db, eq, schema, sql } from '@railforge/db';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import {
  TX_CONFIRM_QUEUE,
  type TxConfirmJobData,
  enqueueWebhookDelivery,
  getSequencer,
  getXrplPool,
} from '../queues.ts';

/**
 * Thrown when we've polled and the tx isn't validated yet, but the
 * LastLedgerSequence horizon hasn't been crossed. BullMQ catches this
 * and retries the job per the queue's backoff policy.
 */
class TxNotYetValidated extends Error {
  constructor(txHash: string) {
    super(`Transaction ${txHash} not yet validated`);
    this.name = 'TxNotYetValidated';
  }
}

/**
 * Process a single confirmation-poll job. Exported for unit tests.
 */
export async function processTxConfirmJob(job: Job<TxConfirmJobData>): Promise<void> {
  const { txId, txHash, lastLedger } = job.data;
  const log = logger.child({ job: 'tx-confirm', txId, txHash });

  const pool = await getXrplPool();
  const client = pool.getClient();

  // 1. Ask rippled for the tx. A "txnNotFound" response means either
  // (a) the tx is still propagating — retry, or (b) it expired without
  // landing in any ledger. We disambiguate via the current ledger index.
  let txResponse: {
    result: { validated?: boolean; ledger_index?: number; meta?: unknown };
  };
  try {
    txResponse = (await client.request({
      command: 'tx',
      transaction: txHash,
    })) as typeof txResponse;
  } catch (err) {
    // `tx` throws "txnNotFound" as an error in xrpl.js. Check if the
    // LastLedgerSequence horizon has passed before deciding what to do.
    const ledger = await client.request({ command: 'ledger_current' });
    const currentLedger = ledger.result.ledger_current_index;

    if (currentLedger > lastLedger) {
      // Expired without landing. Mark failed and drop the sequence cache —
      // the unconsumed Sequence is still valid on-ledger, but the cache
      // may now be stale from our perspective.
      log.warn({ currentLedger, lastLedger }, 'tx expired without validation');
      const row = await db
        .select({ sourceAddress: schema.transactions.sourceAddress })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, txId))
        .limit(1);
      if (row[0]) {
        const sequencer = await getSequencer();
        await sequencer.invalidate(row[0].sourceAddress);
      }
      await db
        .update(schema.transactions)
        .set({
          status: 'failed',
          resultCode: 'LAST_LEDGER_EXPIRED',
          errorMessage: 'Transaction expired before validation',
        })
        .where(eq(schema.transactions.id, txId));
      return; // done — do NOT throw, or BullMQ will retry a dead job
    }

    // Not expired yet — still propagating. Let BullMQ retry.
    log.debug({ err, currentLedger, lastLedger }, 'tx not yet found, will retry');
    throw new TxNotYetValidated(txHash);
  }

  // 2. Tx exists but may not be validated yet.
  if (!txResponse.result.validated) {
    log.debug({ txHash }, 'tx found but not yet validated');
    throw new TxNotYetValidated(txHash);
  }

  // 3. Validated. Update the DB row and (TODO Sprint 3) enqueue webhook.
  const ledgerIndex = txResponse.result.ledger_index;
  // The tx meta's TransactionResult is the definitive result code.
  const meta = txResponse.result.meta as { TransactionResult?: string } | undefined;
  const resultCode = meta?.TransactionResult ?? 'unknown';
  const isSuccess = resultCode === 'tesSUCCESS';

  await db
    .update(schema.transactions)
    .set({
      status: isSuccess ? 'validated' : 'failed',
      resultCode,
      ledgerIndex: ledgerIndex ?? null,
      confirmedAt: new Date(),
      ...(isSuccess ? {} : { errorMessage: `validated with ${resultCode}` }),
    })
    .where(eq(schema.transactions.id, txId));

  log.info({ ledgerIndex, resultCode }, 'tx validated');

  // 4. If this was a funding payment for a newly-created account, flip
  // accounts.is_funded=true and set the reserve_balance from the tx amount.
  //
  // We use a single UPDATE with a WHERE on the indexed funding_tx_id
  // column — Postgres uses idx_accounts_funding_tx so this stays cheap
  // even at high tx volume. The UPDATE returns the affected row count;
  // 0 means this tx wasn't a funding tx (most txs aren't).
  //
  // We only flip on tesSUCCESS. A failed funding payment leaves the
  // account row with is_funded=false; the orphan-account reconciler
  // (deferred) will eventually surface it for manual review.
  //
  // Reserve balance: read it from the tx meta. The Payment Amount is
  // either a string (XRP drops) or an object (issued currency). For
  // funding payments we know it's XRP — but we still defensively
  // type-check before parsing.
  if (isSuccess) {
    const txMeta = txResponse.result as {
      Amount?: string | { value: string };
      meta?: { TransactionResult?: string };
    };
    // The tx command response puts top-level fields next to `meta`.
    // xrpl.js's typing is loose here so we narrow at the boundary.
    const amount = typeof txMeta.Amount === 'string' ? txMeta.Amount : null;
    if (amount) {
      const updated = await db
        .update(schema.accounts)
        .set({
          isFunded: true,
          reserveBalance: amount,
        })
        .where(eq(schema.accounts.fundingTxId, txId))
        .returning({ id: schema.accounts.id });
      if (updated.length > 0) {
        log.info({ accountId: updated[0]?.id, reserveBalance: amount }, 'account funded by tx');
      }
    }
  }

  // 5. Webhook fan-out (Sprint 3).
  //
  // Look up every active webhook_endpoints subscription for this client
  // whose `events` array contains the matching event type, INSERT a
  // webhook_deliveries row for each, then enqueue them on the delivery
  // queue. The delivery worker handles retries.
  //
  // We MUST do this AFTER the transactions UPDATE so subscribers can
  // immediately query GET /v1/payments/:id and see the validated state.
  //
  // The events array overlap is checked with Postgres `&&` (array
  // overlap operator). Drizzle doesn't ship a typed helper for it, so
  // we use sql template raw — still parameterized via `${...}`.
  //
  // Failure isolation: webhook fan-out is best-effort. If the SELECT or
  // INSERT throws, we LOG and continue rather than throwing — the tx is
  // already validated and the row is updated, retrying the whole
  // confirmation job over a webhook glitch would re-fire any successful
  // deliveries from earlier attempts. A future reconciler can sweep
  // webhook_deliveries that never made it onto the queue.
  try {
    await fanOutWebhooks(txId, isSuccess ? 'transaction.validated' : 'transaction.failed', {
      transaction_id: txId,
      tx_hash: txHash,
      ledger_index: ledgerIndex ?? null,
      result_code: resultCode,
      status: isSuccess ? 'validated' : 'failed',
    });
  } catch (err) {
    log.error({ err }, 'webhook fan-out failed (non-fatal)');
  }
}

/**
 * Look up subscribers + create webhook_deliveries rows + enqueue jobs.
 *
 * Resolves the client by joining transactions → webhook_endpoints on
 * client_id. We do NOT pass clientId in via job data because doing so
 * would require backfilling every existing TxConfirmJobData on rolling
 * deploys — joining via the transactions row keeps the job payload
 * minimal and the source-of-truth in Postgres.
 */
async function fanOutWebhooks(
  txId: string,
  eventType: 'transaction.validated' | 'transaction.failed',
  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is a free-form JSON shape
  payload: Record<string, any>,
): Promise<void> {
  // Look up subscribers via a single SELECT JOINed through the
  // transactions row. The events array overlap (`&&`) is the standard
  // Postgres way to ask "any element matches".
  const subscribers = await db
    .select({
      endpointId: schema.webhookEndpoints.id,
    })
    .from(schema.webhookEndpoints)
    .innerJoin(
      schema.transactions,
      eq(schema.webhookEndpoints.clientId, schema.transactions.clientId),
    )
    .where(
      and(
        eq(schema.transactions.id, txId),
        eq(schema.webhookEndpoints.isActive, true),
        sql`${schema.webhookEndpoints.events} && ARRAY[${eventType}]::text[]`,
      ),
    );

  if (subscribers.length === 0) return;

  // Insert one delivery row per subscriber, returning the new ids so we
  // can enqueue corresponding jobs. Single INSERT for all rows so the
  // round-trip cost stays O(1) per fan-out, not O(N).
  const inserted = await db
    .insert(schema.webhookDeliveries)
    .values(
      subscribers.map((s) => ({
        endpointId: s.endpointId,
        eventType,
        payload,
        status: 'pending',
      })),
    )
    .returning({
      id: schema.webhookDeliveries.id,
      endpointId: schema.webhookDeliveries.endpointId,
    });

  // Enqueue all delivery jobs in parallel — Redis enqueue is cheap and
  // BullMQ doesn't care about ordering across deliveries.
  await Promise.all(
    inserted.map((row) =>
      enqueueWebhookDelivery({
        deliveryId: row.id,
        endpointId: row.endpointId,
      }),
    ),
  );
}

/**
 * Wire the worker into BullMQ. Called from apps/worker/src/index.ts at boot.
 */
export function startTxConfirmWorker(redis: Redis): Worker<TxConfirmJobData> {
  return new Worker<TxConfirmJobData>(TX_CONFIRM_QUEUE, processTxConfirmJob, {
    connection: redis,
    concurrency: 5, // polling is cheap and safe to parallelize across different txs
  });
}

// Re-exported so tests can `expect.toThrow(TxNotYetValidated)`.
export { TxNotYetValidated };
