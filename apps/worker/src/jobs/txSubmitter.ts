// Transaction submission worker.
//
// Picks jobs off TX_SUBMIT_QUEUE, fills in the pipeline-supplied fields
// (Sequence via the sequencer, LastLedgerSequence via the pool, Fee via
// DEFAULT_FEE_DROPS), signs via the Signer, submits via rippled, and
// updates the transactions row with tx_hash / tx_blob / status / result.
//
// On tesSUCCESS the job enqueues a confirmation-polling follow-up on
// TX_CONFIRM_QUEUE. On sequence-related engine failures (tefPAST_SEQ,
// terPRE_SEQ) the sequencer cache is invalidated — closes PLAN.md §9.2 #3.
//
// CRITICAL rules (enforced in this file):
//   - Never bypass the sequencer. getNextSequence() is the only source.
//   - Never log signed blobs or wallet material. We log tx_hash (public) only.
//   - LastLedgerSequence is MANDATORY on every submitted tx.

import { db, eq, schema } from '@railforge/db';
import { DEFAULT_FEE_DROPS, LAST_LEDGER_OFFSET } from '@railforge/xrpl-core';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import {
  TX_SUBMIT_QUEUE,
  type TxSubmitJobData,
  getSequencer,
  getSigner,
  getTxConfirmQueue,
  getXrplPool,
} from '../queues.ts';

/**
 * XRPL engine result codes that indicate a sequence-number problem.
 * When we see one of these, the sequencer cache for the source address
 * MUST be invalidated so the next call re-reads from the ledger.
 *
 * Source: https://xrpl.org/transaction-results.html
 */
const SEQUENCE_ERROR_CODES = new Set([
  'tefPAST_SEQ', // tx Sequence is in the past
  'terPRE_SEQ', // tx Sequence is in the future (gap)
  'terQUEUED', // queued — not an error but implies our cache may be stale
  'telCAN_NOT_QUEUE', // local queue rejected it
]);

/**
 * Process a single tx-submit job. Exported so unit tests can call it
 * directly with a mocked BullMQ Job, without spinning up a real Worker.
 */
export async function processTxSubmitJob(job: Job<TxSubmitJobData>): Promise<void> {
  const { txId, sourceAddress, txJson } = job.data;
  const log = logger.child({ job: 'tx-submit', txId, sourceAddress });

  // 1. Grab shared singletons (BullMQ runs one worker per process — safe).
  const [pool, sequencer] = await Promise.all([getXrplPool(), getSequencer()]);
  const signer = getSigner();

  // 2. Sanity-check the signer has a key before we touch the sequencer.
  // Without this check, a mis-enqueued job would consume a Sequence number
  // and leave the cache advanced — a subtle denial-of-service.
  if (!(await signer.hasKey(sourceAddress))) {
    log.error('signer missing key for source address');
    await markFailed(txId, 'SIGNER_NO_KEY', 'No signing key available for source address');
    return;
  }

  // 3. Fetch the next Sequence. Throws SequenceLockTimeout on contention —
  // we let that propagate so BullMQ retries with backoff.
  const sequence = await sequencer.getNextSequence(sourceAddress);

  // 4. Fetch current ledger_index and set LastLedgerSequence.
  const client = pool.getClient();
  const ledgerResponse = await client.request({ command: 'ledger_current' });
  const currentLedger = ledgerResponse.result.ledger_current_index;
  const lastLedger = currentLedger + LAST_LEDGER_OFFSET;

  // 5. Fill in the tx. The builder already set TransactionType/Account/etc.
  // Only pipeline-supplied fields are written here.
  const fullTx = {
    ...txJson,
    Sequence: sequence,
    LastLedgerSequence: lastLedger,
    Fee: txJson.Fee ?? DEFAULT_FEE_DROPS,
  };

  // 6. Sign. The Signer returns ONLY { tx_blob, hash } — see signer.ts
  // for the security contract.
  const signed = await signer.sign(sourceAddress, fullTx);

  // 7. Submit. Note: we do NOT log signed.tx_blob. The hash is public and
  // fine to log; the blob contains the signature and MUST NOT leak.
  let submitResponse: Awaited<ReturnType<typeof client.request>>;
  try {
    submitResponse = await client.request({
      command: 'submit',
      tx_blob: signed.tx_blob,
    });
  } catch (err) {
    // Network-level failure. Invalidate the sequence cache because we
    // don't know if rippled actually consumed the Sequence or not — the
    // next call will re-read from the ledger and be correct either way.
    log.error({ err }, 'submit failed at network layer');
    await sequencer.invalidate(sourceAddress);
    await markFailed(txId, 'NETWORK_ERROR', 'Failed to reach rippled');
    throw err; // let BullMQ retry
  }

  // BullMQ types the submit response loosely — narrow it ourselves.
  const result = (submitResponse as { result: { engine_result: string } }).result;
  const engineResult = result.engine_result;

  // 8. Update the transactions row. The DB is the source of truth for
  // tx state; the queue is ephemeral.
  const isAccepted = engineResult === 'tesSUCCESS';
  const isSequenceError = SEQUENCE_ERROR_CODES.has(engineResult);

  await db
    .update(schema.transactions)
    .set({
      txBlob: signed.tx_blob,
      txHash: signed.hash,
      status: isAccepted ? 'submitted' : 'failed',
      resultCode: engineResult,
      feeDrops: fullTx.Fee,
      submittedAt: new Date(),
      ...(isAccepted ? {} : { errorMessage: `submit rejected: ${engineResult}` }),
    })
    .where(eq(schema.transactions.id, txId));

  log.info({ engineResult, txHash: signed.hash }, 'tx submitted');

  // 9. On sequence errors, drop the cache so the next tx for this address
  // re-reads the ledger state. Closes PLAN.md §9.2 #3.
  if (isSequenceError) {
    await sequencer.invalidate(sourceAddress);
  }

  // 10. On success, enqueue confirmation polling.
  if (isAccepted) {
    const confirmQueue = getTxConfirmQueue();
    await confirmQueue.add(
      'confirm',
      {
        txId,
        txHash: signed.hash,
        lastLedger,
      },
      {
        // First poll after ~4s (XRPL ledger close time).
        delay: 4000,
      },
    );
  }
}

/**
 * Marks a transaction row as failed with a short error code + message.
 * Used for pre-submit failures (bad signer key, validation error) where
 * we never even touched the network.
 */
async function markFailed(txId: string, code: string, message: string): Promise<void> {
  await db
    .update(schema.transactions)
    .set({
      status: 'failed',
      resultCode: code,
      errorMessage: message,
      submittedAt: new Date(),
    })
    .where(eq(schema.transactions.id, txId));
}

/**
 * Wire the worker into BullMQ. Called from apps/worker/src/index.ts at boot.
 * Returns the Worker instance so the bootstrap can `await worker.close()`
 * on shutdown.
 */
export function startTxSubmitWorker(redis: Redis): Worker<TxSubmitJobData> {
  return new Worker<TxSubmitJobData>(TX_SUBMIT_QUEUE, processTxSubmitJob, {
    connection: redis,
    concurrency: 1, // XRPL submission is intentionally serialized per-process
  });
}
