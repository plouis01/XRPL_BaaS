// Transaction submission worker.
//
// Picks jobs off TX_SUBMIT_QUEUE, fills in the pipeline-supplied fields
// (Sequence via the sequencer, LastLedgerSequence via the pool, Fee via
// DEFAULT_FEE_DROPS), signs via the Signer, submits via rippled, and
// updates the transactions row with tx_hash / status / result code.
//
// On tesSUCCESS the job enqueues a confirmation-polling follow-up on
// TX_CONFIRM_QUEUE. On sequence-related engine failures (tefPAST_SEQ,
// terPRE_SEQ) the sequencer cache is invalidated — closes PLAN.md §9.2 #3.
//
// CRITICAL rules (enforced in this file):
//   - Never bypass the sequencer. getNextSequence() is the only source.
//   - Never log signed blobs or wallet material. We log tx_hash (public) only.
//   - Never PERSIST signed blobs to the DB either — the hash is enough to
//     reconstruct the on-ledger state, the blob is signature material.
//   - LastLedgerSequence is MANDATORY on every submitted tx.

import { and, db, eq, schema } from '@railforge/db';
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
 * Note: terQUEUED is intentionally NOT in this set. terQUEUED means rippled
 * has accepted the tx into its own queue for a future ledger — the Sequence
 * is correct, the tx is valid, the cache is right. Treating it as a sequence
 * error would over-invalidate the cache and cause unnecessary ledger fetches.
 *
 * Source: https://xrpl.org/transaction-results.html
 */
const SEQUENCE_ERROR_CODES = new Set([
  'tefPAST_SEQ', // tx Sequence is in the past
  'terPRE_SEQ', // tx Sequence is in the future (gap)
  'telCAN_NOT_QUEUE', // local queue rejected it
]);

/**
 * Process a single tx-submit job. Exported so unit tests can call it
 * directly with a mocked BullMQ Job, without spinning up a real Worker.
 */
export async function processTxSubmitJob(job: Job<TxSubmitJobData>): Promise<void> {
  const { txId, sourceAddress, txJson } = job.data;
  const log = logger.child({ job: 'tx-submit', txId, sourceAddress });

  // REVIEW.md HIGH-08 — double-submit guard.
  //
  // Failure mode this prevents: the worker's submit() reaches rippled but
  // the response TCP connection drops. The old code called markFailed() +
  // threw, which BullMQ turns into a retry. On retry, we'd re-sign with a
  // fresh Sequence and emit a SECOND on-chain tx — for a funding Payment
  // that's a double-fund; for an MPT Payment, a double-send.
  //
  // Fix: conditionally claim the row under `status='queued'`. If the row
  // is already in a post-queued state (submitted/failed/validated, or has
  // a non-null tx_hash from a prior attempt), this retry must NOT re-sign
  // and re-submit. We treat it as a no-op and let the confirmer pick up
  // the existing tx_hash if any.
  const claimed = await db
    .update(schema.transactions)
    .set({ status: 'submitting' })
    .where(and(eq(schema.transactions.id, txId), eq(schema.transactions.status, 'queued')))
    .returning({
      id: schema.transactions.id,
      txHash: schema.transactions.txHash,
    });
  if (claimed.length === 0) {
    log.warn('tx row already claimed or submitted — skipping to prevent double-submit');
    return;
  }

  // 1. Grab shared singletons (BullMQ runs one worker per process — safe).
  const [pool, sequencer] = await Promise.all([getXrplPool(), getSequencer()]);
  const signer = getSigner();

  // 2. Lazy-load the signing key from accounts.master_key_ref. The signer
  // is in-process state and doesn't survive worker restarts, so on a cold
  // boot the first job for any address will land here with hasKey=false.
  // We look up the persisted ref (DevSigner: seed; HsmSigner: key handle),
  // call loadKey, then re-check.
  //
  // CRITICAL: this MUST happen before we touch the sequencer. A mis-enqueued
  // job would otherwise consume a Sequence number and leave the cache
  // advanced — a subtle denial-of-service for that account.
  if (!(await signer.hasKey(sourceAddress))) {
    const rows = await db
      .select({ masterKeyRef: schema.accounts.masterKeyRef })
      .from(schema.accounts)
      .where(eq(schema.accounts.address, sourceAddress))
      .limit(1);

    const ref = rows[0]?.masterKeyRef;
    if (ref) {
      try {
        await signer.loadKey(sourceAddress, ref);
      } catch (err) {
        // SignerError is sanitized — safe to log the message. Never log `ref`.
        log.error({ err }, 'signer.loadKey failed');
      }
    }
  }

  // 3. Final guard. If we still have no key after the lazy load, mark
  // the row failed and bail without touching the sequencer.
  if (!(await signer.hasKey(sourceAddress))) {
    log.error('signer missing key for source address');
    await markFailed(txId, 'SIGNER_NO_KEY', 'No signing key available for source address');
    return;
  }

  // 4. Fetch the next Sequence. Throws SequenceLockTimeout on contention —
  // we let that propagate so BullMQ retries with backoff.
  const sequence = await sequencer.getNextSequence(sourceAddress);

  // 5. Fetch current ledger_index and set LastLedgerSequence.
  //
  // Once getNextSequence() returns, the cache has been advanced by 1. If
  // ANYTHING between here and successful submit() throws, we MUST invalidate
  // the cache — otherwise the next job for this address will use a Sequence
  // that's one ahead of the on-ledger state and rippled will reject it as
  // terPRE_SEQ. The same defensive pattern is repeated for sign() and the
  // network call below.
  const client = pool.getClient();
  let lastLedger: number;
  try {
    const ledgerResponse = await client.request({ command: 'ledger_current' });
    const currentLedger = ledgerResponse.result.ledger_current_index;
    lastLedger = currentLedger + LAST_LEDGER_OFFSET;
  } catch (err) {
    log.error({ err }, 'ledger_current failed; rolling back sequence cache');
    await sequencer.invalidate(sourceAddress);
    await markFailed(txId, 'NETWORK_ERROR', 'Failed to fetch current ledger from rippled');
    throw err; // let BullMQ retry
  }

  // 6. Fill in the tx. The builder already set TransactionType/Account/etc.
  // Only pipeline-supplied fields are written here.
  const fullTx = {
    ...txJson,
    Sequence: sequence,
    LastLedgerSequence: lastLedger,
    Fee: txJson.Fee ?? DEFAULT_FEE_DROPS,
  };

  // 7. Sign. The Signer returns ONLY { tx_blob, hash } — see signer.ts
  // for the security contract. If sign() throws, the Sequence was already
  // consumed by the cache but no tx hit the wire — invalidate so the next
  // call re-reads from the ledger.
  let signed: Awaited<ReturnType<typeof signer.sign>>;
  try {
    signed = await signer.sign(sourceAddress, fullTx);
  } catch (err) {
    log.error({ err }, 'sign failed; rolling back sequence cache');
    await sequencer.invalidate(sourceAddress);
    await markFailed(txId, 'SIGN_FAILED', 'Signing failed before reaching rippled');
    throw err; // let BullMQ retry
  }

  // 8. Submit. Note: we do NOT log signed.tx_blob. The hash is public and
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

  // 9. Update the transactions row. The DB is the source of truth for
  // tx state; the queue is ephemeral.
  //
  // We persist tx_hash but NOT tx_blob. The hash is enough to look up the
  // tx on-ledger via rippled's `tx` command, and the blob is signature
  // material that has no business sitting in our DB long-term.
  const isAccepted = engineResult === 'tesSUCCESS';
  const isSequenceError = SEQUENCE_ERROR_CODES.has(engineResult);

  await db
    .update(schema.transactions)
    .set({
      txHash: signed.hash,
      status: isAccepted ? 'submitted' : 'failed',
      resultCode: engineResult,
      feeDrops: fullTx.Fee,
      submittedAt: new Date(),
      ...(isAccepted ? {} : { errorMessage: `submit rejected: ${engineResult}` }),
    })
    .where(eq(schema.transactions.id, txId));

  log.info({ engineResult, txHash: signed.hash }, 'tx submitted');

  // 10. On sequence errors, drop the cache so the next tx for this address
  // re-reads the ledger state. Closes PLAN.md §9.2 #3.
  if (isSequenceError) {
    await sequencer.invalidate(sourceAddress);
  }

  // 11. On success, enqueue confirmation polling.
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
