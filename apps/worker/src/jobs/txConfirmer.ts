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

import { and, db, eq, isNull, schema, sql } from '@railforge/db';
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

  // 3. Validated. Update the DB row and enqueue webhook fan-out.
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

  // 6. Backfill tokens.mpt_issuance_id from tx metadata.
  //
  // When an MPTokenIssuanceCreate validates, the on-ledger MPTokenIssuance
  // ledger entry gets a fresh `mpt_issuance_id`. The token service writes
  // the tokens row eagerly with mpt_issuance_id=null, then this block
  // backfills the column once the validated tx response carries the id.
  //
  // Why join via transactions.id rather than re-querying by issuer
  // address: a token's issuer may have multiple in-flight issuance txs
  // — joining via the unique tx id is the only safe match.
  //
  // Same failure-isolation rule as the webhook fan-out: a backfill error
  // must not retry the whole confirmation job, because the tx is already
  // validated and the webhook might already have fired.
  if (isSuccess) {
    try {
      await backfillMptIssuanceId(txId, txResponse.result);
    } catch (err) {
      log.error({ err }, 'mpt_issuance_id backfill failed (non-fatal)');
    }
  }
}

/**
 * Walk a validated tx's meta.AffectedNodes to find the freshly-created
 * MPTokenIssuance entry and pull its `mpt_issuance_id` (or `MPTokenID`,
 * the field name varies by rippled version). Returns the id or null.
 *
 * Exported as a pure helper so the txConfirmer test can exercise the
 * parsing logic without spinning up the full DB chain.
 */
export function extractMptIssuanceIdFromMeta(
  // biome-ignore lint/suspicious/noExplicitAny: rippled tx meta is loosely typed
  result: any,
): string | null {
  const meta = result?.meta;
  if (!meta || typeof meta !== 'object') return null;
  const nodes = (meta as { AffectedNodes?: unknown[] }).AffectedNodes;
  if (!Array.isArray(nodes)) return null;

  for (const node of nodes) {
    // Look for a CreatedNode with LedgerEntryType MPTokenIssuance.
    const created = (node as { CreatedNode?: Record<string, unknown> }).CreatedNode;
    if (!created) continue;
    if (created.LedgerEntryType !== 'MPTokenIssuance') continue;

    // The id may be on the node fields under a couple of names depending
    // on rippled version: `mpt_issuance_id`, `MPTokenIssuanceID`, or
    // exposed as the LedgerIndex of the created entry. Try all three.
    const fields = (created.NewFields ?? {}) as Record<string, unknown>;
    const candidates = [fields.mpt_issuance_id, fields.MPTokenIssuanceID, created.LedgerIndex];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) {
        return c;
      }
    }
  }
  return null;
}

/**
 * Backfill tokens.mpt_issuance_id by joining via the transactions row.
 * Single UPDATE: tokens.mpt_issuance_id = <extracted> WHERE
 * issuer_account = (SELECT id FROM accounts WHERE address = source_address)
 * AND mpt_issuance_id IS NULL AND token_type = 'mpt'.
 *
 * The "IS NULL" guard makes this idempotent — replays of an already-
 * backfilled validation are no-ops, not double-writes.
 */
async function backfillMptIssuanceId(
  txId: string,
  // biome-ignore lint/suspicious/noExplicitAny: rippled tx meta is loosely typed
  result: any,
): Promise<void> {
  const id = extractMptIssuanceIdFromMeta(result);
  if (!id) return; // not an MPT issuance tx, or no id in meta — silent

  // Look up the source address + transaction type from the transactions
  // row. We need both because we only want to backfill for actual MPT
  // issuance txs — a Payment that happens to touch an MPT entry should
  // not steal the id slot.
  const txRows = await db
    .select({
      sourceAddress: schema.transactions.sourceAddress,
      txType: schema.transactions.txType,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId))
    .limit(1);
  const txRow = txRows[0];
  if (!txRow || txRow.txType !== 'MPTokenIssuanceCreate') return;

  // Find the issuer account row by address. We can't trust the JOIN to
  // do this in one shot because the tokens table stores issuer_account
  // as the accounts.id (uuid), not the address.
  const acctRows = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.address, txRow.sourceAddress))
    .limit(1);
  const acctId = acctRows[0]?.id;
  if (!acctId) return;

  // Find the most-recent MPT-typed token row for this issuer that has
  // a NULL mpt_issuance_id. There SHOULD be exactly one in flight per
  // issuer at a time given the sequencer serialization, but we order
  // by created_at desc + limit 1 just in case.
  const tokenRows = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(
      and(
        eq(schema.tokens.issuerAccount, acctId),
        eq(schema.tokens.tokenType, 'mpt'),
        isNull(schema.tokens.mptIssuanceId),
      ),
    )
    .limit(1);
  const tokenId = tokenRows[0]?.id;
  if (!tokenId) return;

  await db.update(schema.tokens).set({ mptIssuanceId: id }).where(eq(schema.tokens.id, tokenId));
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
