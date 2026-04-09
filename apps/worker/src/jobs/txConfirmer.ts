// Transaction confirmation poller.
//
// After txSubmitter sends a tx to rippled, the tx is "submitted" but not
// yet validated (it hasn't made it into a closed ledger). This job polls
// the `tx` command until the tx is either:
//   (a) validated on-ledger → update row, enqueue webhook
//   (b) LastLedgerSequence expired without a result → mark failed, invalidate sequencer
//
// The job lives on TX_CONFIRM_QUEUE and uses BullMQ's retry with fixed
// backoff (~4s between polls, matching XRPL ledger close time). BullMQ's
// `attempts` count gives us a natural upper bound on poll attempts; once
// attempts are exhausted the job fails and the row is left in 'submitted'
// state. A separate reconciliation job (deferred) would catch orphans.

import { db, eq, schema } from "@railforge/db";
import { type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "../logger.ts";
import {
  TX_CONFIRM_QUEUE,
  type TxConfirmJobData,
  getSequencer,
  getXrplPool,
} from "../queues.ts";

/**
 * Thrown when we've polled and the tx isn't validated yet, but the
 * LastLedgerSequence horizon hasn't been crossed. BullMQ catches this
 * and retries the job per the queue's backoff policy.
 */
class TxNotYetValidated extends Error {
  constructor(txHash: string) {
    super(`Transaction ${txHash} not yet validated`);
    this.name = "TxNotYetValidated";
  }
}

/**
 * Process a single confirmation-poll job. Exported for unit tests.
 */
export async function processTxConfirmJob(
  job: Job<TxConfirmJobData>,
): Promise<void> {
  const { txId, txHash, lastLedger } = job.data;
  const log = logger.child({ job: "tx-confirm", txId, txHash });

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
      command: "tx",
      transaction: txHash,
    })) as typeof txResponse;
  } catch (err) {
    // `tx` throws "txnNotFound" as an error in xrpl.js. Check if the
    // LastLedgerSequence horizon has passed before deciding what to do.
    const ledger = await client.request({ command: "ledger_current" });
    const currentLedger = ledger.result.ledger_current_index;

    if (currentLedger > lastLedger) {
      // Expired without landing. Mark failed and drop the sequence cache —
      // the unconsumed Sequence is still valid on-ledger, but the cache
      // may now be stale from our perspective.
      log.warn({ currentLedger, lastLedger }, "tx expired without validation");
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
          status: "failed",
          resultCode: "LAST_LEDGER_EXPIRED",
          errorMessage: "Transaction expired before validation",
        })
        .where(eq(schema.transactions.id, txId));
      return; // done — do NOT throw, or BullMQ will retry a dead job
    }

    // Not expired yet — still propagating. Let BullMQ retry.
    log.debug(
      { err, currentLedger, lastLedger },
      "tx not yet found, will retry",
    );
    throw new TxNotYetValidated(txHash);
  }

  // 2. Tx exists but may not be validated yet.
  if (!txResponse.result.validated) {
    log.debug({ txHash }, "tx found but not yet validated");
    throw new TxNotYetValidated(txHash);
  }

  // 3. Validated. Update the DB row and (TODO Sprint 3) enqueue webhook.
  const ledgerIndex = txResponse.result.ledger_index;
  // The tx meta's TransactionResult is the definitive result code.
  const meta = txResponse.result.meta as
    | { TransactionResult?: string }
    | undefined;
  const resultCode = meta?.TransactionResult ?? "unknown";
  const isSuccess = resultCode === "tesSUCCESS";

  await db
    .update(schema.transactions)
    .set({
      status: isSuccess ? "validated" : "failed",
      resultCode,
      ledgerIndex: ledgerIndex ?? null,
      confirmedAt: new Date(),
      ...(isSuccess ? {} : { errorMessage: `validated with ${resultCode}` }),
    })
    .where(eq(schema.transactions.id, txId));

  log.info({ ledgerIndex, resultCode }, "tx validated");

  // TODO Sprint 3: enqueue webhook delivery via WEBHOOK_DELIVERY_QUEUE.
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
