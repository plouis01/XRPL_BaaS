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
// state. The orphan-reconciler worker (jobs/orphanReconciler.ts) catches
// these rows on its scheduled sweep.
//
// Sprint 3 webhook fan-out: when a tx validates (success OR failure), we
// look up every active webhook_endpoints row for the client that
// subscribes to the matching event type, INSERT a webhook_deliveries row
// per subscriber, and enqueue them on the webhook-delivery queue. The
// delivery worker handles retries independently from this job.

import { and, db, desc, eq, isNull, schema, sql } from '@railforge/db';
import { getJobsRedis } from '@railforge/jobs';
import type { Logger } from '@railforge/logger';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { decodeAccountID } from 'xrpl';
import { logger } from '../logger.ts';
import {
  TX_CONFIRM_QUEUE,
  type TxConfirmJobData,
  type TxConfirmerEventType,
  enqueueWebhookDelivery,
  getSequencer,
  getXrplPool,
} from '../queues.ts';

/**
 * Refund the API-side spend-policy Redis counter on a terminal tx failure.
 *
 * REVIEW.md MED-04: the counter only ever INCR'd in the API's
 * enforceSpendPolicy path. A client deliberately submitting failing txs
 * (bad destination, tecNO_DST, malformed MPT issuance) could pin the
 * daily budget at zero against legit traffic for up to 24h. Refunding on
 * the terminal-failed transitions below gives the budget back.
 *
 * Key pattern + best-effort semantics mirror apps/api/src/services/
 * spendPolicy.service.ts refundSpendCounter — this is the worker-side
 * mirror (no shared package yet; it's ~15 lines, not worth carving out).
 * If the key names drift, the bug is silent — keep them synced.
 */
async function refundSpendCounterBestEffort(txId: string, log: Logger): Promise<void> {
  let row: { clientId: string; amountDrops: string | null } | undefined;
  try {
    const rows = await db
      .select({
        clientId: schema.transactions.clientId,
        amountDrops: schema.transactions.amountDrops,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txId))
      .limit(1);
    row = rows[0];
  } catch (err) {
    log.warn({ err }, 'spend-policy refund: failed to fetch tx amount (non-fatal)');
    return;
  }
  if (!row || !row.amountDrops) return;
  let amount: bigint;
  try {
    amount = BigInt(row.amountDrops);
  } catch {
    return;
  }
  if (amount <= 0n) return;

  try {
    const redis = getJobsRedis();
    const key = `railforge:spendpolicy:daily:${row.clientId}`;
    const exists = await redis.exists(key);
    if (exists === 0) return;
    await redis.decrby(key, amount.toString());
  } catch (err) {
    log.warn({ err }, 'spend-policy refund: Redis decrby failed (non-fatal)');
  }
}

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
      // REVIEW.md MED-04: release the client's daily spend budget for
      // this expired tx. Best-effort — no retry on refund failure.
      await refundSpendCounterBestEffort(txId, log);
      // Partner to the acceptCredential TOCTOU fix: if this expired tx
      // was a CredentialAccept, revert the credential row out of the
      // 'accepting' intermediate state back to 'pending' so the subject
      // can retry. Best-effort — do not retry the whole job on failure.
      try {
        await applyCredentialAcceptOutcome(txId, false, log);
      } catch (err) {
        log.error({ err }, 'credential accept outcome failed (non-fatal)');
      }
      // Partner to the #22 domain-mutation fix: drop any staged domain
      // change on expiry so the DB reflects the unchanged on-chain state.
      try {
        await applyDomainMutationOutcome(txId, false, log);
      } catch (err) {
        log.error({ err }, 'domain mutation outcome failed (non-fatal)');
      }
      // REVIEW.md C-1 partner: clear delegations.pending_revocation on
      // expiry so the delegate row stays 'active' (matching the unchanged
      // on-ledger signer list). Best-effort.
      try {
        await applyDelegationRevocationOutcome(txId, false, log);
      } catch (err) {
        log.error({ err }, 'delegation revocation outcome failed (non-fatal)');
      }
      // REVIEW.md C-3 partner: if this expired tx was a CredentialDelete,
      // revert the credential row from 'revoking' back to its prior
      // status so the caller can retry.
      try {
        await applyCredentialRevokeOutcome(txId, false, log);
      } catch (err) {
        log.error({ err }, 'credential revoke outcome failed (non-fatal)');
      }
      // VISION.md agent launcher: if this expired tx was a grantPermission
      // for an agent provisioning, mark the agents row 'failed' so it's
      // visible for operator review instead of stuck at 'pending'.
      try {
        await applyAgentGrantOutcome(txId, false, log);
      } catch (err) {
        log.error({ err }, 'agent grant outcome failed (non-fatal)');
      }
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

  // REVIEW.md MED-04: on-ledger failure (validated-with-non-tesSUCCESS)
  // is the second terminal-failed path. Refund the spend counter here too
  // so tec-coded failures don't pin the daily budget.
  if (!isSuccess) {
    await refundSpendCounterBestEffort(txId, log);
  }

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
  // (jobs/orphanReconciler.ts) surfaces it for manual review.
  //
  // Reserve balance: read it from the tx meta. The Payment Amount is
  // either a string (XRP drops) or an object (issued currency). For
  // funding payments we know it's XRP — but we still defensively
  // type-check before parsing.
  if (isSuccess) {
    const amount = extractFundingAmount(txResponse.result);
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

  // Partner to the acceptCredential TOCTOU fix: flip the credential row
  // out of the 'accepting' intermediate state. tesSUCCESS → 'accepted',
  // any failure → back to 'pending' so the subject can retry. Best-effort
  // like the webhook and MPT backfill — a hiccup here must not retry the
  // whole confirmation job, which would re-fire side effects above.
  try {
    await applyCredentialAcceptOutcome(txId, isSuccess, log);
  } catch (err) {
    log.error({ err }, 'credential accept outcome failed (non-fatal)');
  }

  // Partner to the #22 optimistic-domain-update fix: commit or drop the
  // staged domain mutation based on the on-chain outcome. Same
  // best-effort isolation as the helpers above.
  try {
    await applyDomainMutationOutcome(txId, isSuccess, log);
  } catch (err) {
    log.error({ err }, 'domain mutation outcome failed (non-fatal)');
  }

  // REVIEW.md C-1 partner: finalize delegation revocation. tesSUCCESS
  // flips status='revoked' + revokedAt=now and clears pendingRevocation.
  // Any failure drops pendingRevocation only so the delegation stays
  // 'active' — matching the unchanged on-ledger signer list.
  try {
    await applyDelegationRevocationOutcome(txId, isSuccess, log);
  } catch (err) {
    log.error({ err }, 'delegation revocation outcome failed (non-fatal)');
  }

  // REVIEW.md C-3 partner: finalize credential revocation. tesSUCCESS
  // flips credentials.status to 'revoked'. Any failure reverts to the
  // prior status (usually 'accepted') so the caller can retry.
  try {
    await applyCredentialRevokeOutcome(txId, isSuccess, log);
  } catch (err) {
    log.error({ err }, 'credential revoke outcome failed (non-fatal)');
  }

  // VISION.md agent launcher: finalize agent provisioning. tesSUCCESS
  // flips agents.status pending → active so the row starts rejecting
  // revocationCheck skips; any failure flips to 'failed' for operator
  // review (the delegate key has no on-ledger signing authority).
  try {
    await applyAgentGrantOutcome(txId, isSuccess, log);
  } catch (err) {
    log.error({ err }, 'agent grant outcome failed (non-fatal)');
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
/**
 * Extract the delivered XRP amount (in drops) from a rippled `tx` response,
 * handling both API v1 and v2 shapes. Returns a string (drops) when the
 * Payment delivered XRP, or null when the shape is unknown / the tx
 * delivered an issued-currency or MPT amount (those can't fund accounts).
 *
 * Field precedence (most authoritative first):
 *   1. meta.delivered_amount — populated in v1 + v2 for validated Payments.
 *      This is the DEFINITIVE delivered amount (partial payments count here).
 *   2. tx_json.DeliverMax    — v2 renamed the submitted-amount field from
 *      Amount to DeliverMax (xrpl.js v4.6 default api_version).
 *   3. tx_json.Amount        — v2 fallback (some tx types still carry Amount).
 *   4. result.Amount         — v1 inline shape (api_version=1 or omitted).
 *
 * Exported as a pure helper so unit tests can cover every shape without
 * spinning up the full confirmation job.
 */
export function extractFundingAmount(
  // biome-ignore lint/suspicious/noExplicitAny: rippled `tx` result is loosely typed
  result: any,
): string | null {
  if (!result || typeof result !== 'object') return null;
  const raw = result as {
    Amount?: unknown;
    tx_json?: { DeliverMax?: unknown; Amount?: unknown };
    meta?: { delivered_amount?: unknown };
  };
  const value =
    raw.meta?.delivered_amount ?? raw.tx_json?.DeliverMax ?? raw.tx_json?.Amount ?? raw.Amount;
  return typeof value === 'string' ? value : null;
}

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

    // Prefer an id the meta surfaces directly — future-proofs against any
    // rippled version that starts populating this field.
    const fields = (created.NewFields ?? {}) as Record<string, unknown>;
    const candidates = [fields.mpt_issuance_id, fields.MPTokenIssuanceID];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }

    // Current rippled (and xrpl.js v4.6 api v2) do NOT include
    // mpt_issuance_id in the CreatedNode.NewFields. Derive it from the
    // well-defined spec: the MPT issuance id is a 24-byte value composed
    // of the creating tx's Sequence (4 bytes, big-endian) concatenated
    // with the Issuer account id (20 bytes, raw decoded). This matches
    // what rippled returns from `account_objects type=mpt_issuance` — we
    // cross-checked against a live testnet MPT: Sequence 16777881 + issuer
    // rs37MdXJ... → 010002991759FFA931B36B53EB53C7E748A79AD62AE8E103.
    //
    // REVIEW.md LOW-06 guard retained: we never fall back to LedgerIndex
    // (256-bit entry hash — NOT the issuance id). If we can't derive, we
    // return null so the operator notices rather than writing garbage.
    const seq = typeof fields.Sequence === 'number' ? fields.Sequence : null;
    const issuer = typeof fields.Issuer === 'string' ? fields.Issuer : null;
    if (seq !== null && issuer !== null) {
      try {
        const accountIdHex = Buffer.from(decodeAccountID(issuer)).toString('hex').toUpperCase();
        if (accountIdHex.length === 40) {
          const seqHex = seq.toString(16).padStart(8, '0').toUpperCase();
          return seqHex + accountIdHex;
        }
      } catch {
        // fall through to null — never poison the column
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
  // a NULL mpt_issuance_id. The ORDER BY is load-bearing: without it an
  // older orphaned NULL row (e.g. an earlier attempt that failed before
  // backfill or never got its confirmation event) could win the match
  // and silently steal the id slot from the tx actually being confirmed.
  // The sequencer serializes per-issuer so the newest NULL row always
  // corresponds to the currently-confirming tx.
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
    .orderBy(desc(schema.tokens.createdAt))
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
  // REVIEW.md MED-14: typed against the shared @railforge/jobs union so
  // extending that const automatically propagates here. Drift-proof by
  // construction — a new event type flows in without a manual edit.
  eventType: TxConfirmerEventType,
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

/**
 * Flip a credentials row out of the 'accepting' intermediate state that
 * acceptCredential left it in. Partner to the TOCTOU fix in
 * credential.service.ts: the service takes the pending → accepting
 * transition inside the same DB transaction that enqueues the
 * CredentialAccept tx, and this helper closes the loop when rippled
 * validates (or expires) that tx.
 *
 * tesSUCCESS → 'accepted' (+ acceptedAt=now)
 * any failure/expiry → 'pending' (so the subject can retry)
 *
 * Idempotency: the UPDATE only matches rows still in 'accepting', so a
 * replayed confirmation after a successful first pass is a silent no-op
 * rather than overwriting a status that a later action moved on from.
 *
 * Exported so the unit test can drive it directly.
 */
export async function applyCredentialAcceptOutcome(
  txId: string,
  isSuccess: boolean,
  log: Logger,
): Promise<void> {
  const rows = await db
    .select({
      txType: schema.transactions.txType,
      requestBody: schema.transactions.requestBody,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId))
    .limit(1);

  const row = rows[0];
  if (!row || row.txType !== 'CredentialAccept') return;

  const body = row.requestBody as { credentialId?: unknown } | null;
  const credentialId = typeof body?.credentialId === 'string' ? body.credentialId : null;
  if (!credentialId) return;

  const setValues = isSuccess
    ? { status: 'accepted', acceptedAt: new Date() }
    : { status: 'pending' };

  const updated = await db
    .update(schema.credentials)
    .set(setValues)
    .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.status, 'accepting')))
    .returning({ id: schema.credentials.id });

  if (updated.length === 0) {
    log.debug(
      { credentialId, isSuccess },
      'credential already transitioned out of accepting (noop)',
    );
    return;
  }

  log.info(
    { credentialId, newStatus: isSuccess ? 'accepted' : 'pending' },
    'credential accept outcome applied',
  );
}

/**
 * Partner to the #22 optimistic-domain-update fix. updateDomain stages
 * a new accepted_credentials list into `pending_accepted_credentials`,
 * and deleteDomain sets `pending_deletion=true` — neither touches the
 * committed column. This helper finalizes the mutation once rippled
 * validates (or expires) the tx:
 *
 *   success + op='updateDomain' → move staging into acceptedCredentials,
 *                                 clear staging, bump updatedAt
 *   success + op='deleteDomain' → stamp deletedAt, clear pendingDeletion
 *   failure  + op='updateDomain' → clear pendingAcceptedCredentials
 *   failure  + op='deleteDomain' → clear pendingDeletion
 *
 * The staged change is dropped on failure so the DB row matches the
 * unchanged on-ledger state. Exported for direct unit testing.
 *
 * Same failure-isolation contract as the other best-effort helpers —
 * callers wrap in try/catch and continue on error.
 */
export async function applyDomainMutationOutcome(
  txId: string,
  isSuccess: boolean,
  log: Logger,
): Promise<void> {
  const rows = await db
    .select({
      txType: schema.transactions.txType,
      requestBody: schema.transactions.requestBody,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId))
    .limit(1);

  const row = rows[0];
  if (!row) return;
  if (row.txType !== 'PermissionedDomainSet' && row.txType !== 'PermissionedDomainDelete') {
    return;
  }

  const body = row.requestBody as {
    op?: unknown;
    domainDbId?: unknown;
  } | null;
  const op = typeof body?.op === 'string' ? body.op : null;
  const domainDbId = typeof body?.domainDbId === 'string' ? body.domainDbId : null;
  // createDomain does not stage anything (it inserts committed state up
  // front), so it needs no rollback handling. Only update/delete.
  if (!domainDbId || (op !== 'updateDomain' && op !== 'deleteDomain')) return;

  if (op === 'updateDomain') {
    if (isSuccess) {
      // Commit the staged credentials: pull them from the row atomically
      // via a single UPDATE that copies the jsonb column into its
      // committed sibling, then nulls the staging slot.
      await db
        .update(schema.domains)
        .set({
          acceptedCredentials: sql`${schema.domains.pendingAcceptedCredentials}`,
          pendingAcceptedCredentials: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.domains.id, domainDbId),
            sql`${schema.domains.pendingAcceptedCredentials} IS NOT NULL`,
          ),
        );
      log.info({ domainDbId }, 'domain update committed from staging');
    } else {
      await db
        .update(schema.domains)
        .set({ pendingAcceptedCredentials: null })
        .where(eq(schema.domains.id, domainDbId));
      log.info({ domainDbId }, 'domain update staging cleared (failure)');
    }
    return;
  }

  // op === 'deleteDomain'
  if (isSuccess) {
    await db
      .update(schema.domains)
      .set({
        deletedAt: new Date(),
        pendingDeletion: false,
      })
      .where(eq(schema.domains.id, domainDbId));
    log.info({ domainDbId }, 'domain deletion committed from staging');
  } else {
    await db
      .update(schema.domains)
      .set({ pendingDeletion: false })
      .where(eq(schema.domains.id, domainDbId));
    log.info({ domainDbId }, 'domain deletion staging cleared (failure)');
  }
}

/**
 * Partner to the REVIEW.md C-1 fix. `revokePermission` stages
 * `pendingRevocation=true` on the delegations row and enqueues a
 * SignerListSet tx; this helper finalizes the DB state once rippled
 * validates (or expires) that tx.
 *
 *   tesSUCCESS → status='revoked', revokedAt=now, pendingRevocation=false
 *   failure/expiry → pendingRevocation=false (status stays 'active')
 *
 * Both branches are guarded by `pendingRevocation=true` so replays of a
 * confirmation job are silent no-ops rather than overwrites. Only rows
 * the service actually staged are touched — other SignerListSet txs
 * (e.g. grantPermission) skip this helper because their requestBody has
 * `op='grantPermission'`, not `op='revokePermission'`.
 */
export async function applyDelegationRevocationOutcome(
  txId: string,
  isSuccess: boolean,
  log: Logger,
): Promise<void> {
  const rows = await db
    .select({
      txType: schema.transactions.txType,
      requestBody: schema.transactions.requestBody,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId))
    .limit(1);

  const row = rows[0];
  if (!row || row.txType !== 'SignerListSet') return;

  const body = row.requestBody as {
    op?: unknown;
    delegationId?: unknown;
  } | null;
  const op = typeof body?.op === 'string' ? body.op : null;
  const delegationId = typeof body?.delegationId === 'string' ? body.delegationId : null;
  // Only finalize revokePermission txs. grantPermission and other
  // SignerListSet paths don't stage anything here.
  if (op !== 'revokePermission' || !delegationId) return;

  const setValues = isSuccess
    ? { status: 'revoked', revokedAt: new Date(), pendingRevocation: false }
    : { pendingRevocation: false };

  const updated = await db
    .update(schema.delegations)
    .set(setValues)
    .where(
      and(eq(schema.delegations.id, delegationId), eq(schema.delegations.pendingRevocation, true)),
    )
    .returning({ id: schema.delegations.id });

  if (updated.length === 0) {
    log.debug(
      { delegationId, isSuccess },
      'delegation already transitioned out of pending_revocation (noop)',
    );
    return;
  }

  log.info(
    { delegationId, newStatus: isSuccess ? 'revoked' : 'active' },
    'delegation revocation outcome applied',
  );
}

/**
 * Partner to the VISION.md agent launcher. `provisionAgent` inserts an
 * `agents` row with status='pending' and hands off to permission.service
 * which enqueues a SignerListSet tx (requestBody.op='grantPermission').
 * This helper finalizes the DB state once rippled validates (or expires)
 * that tx.
 *
 *   tesSUCCESS → agents.status='active'
 *   failure/expiry → agents.status='failed' so the row is visible for
 *     operator review rather than silently stuck at 'pending' forever.
 *     The delegate key pair is already persisted in the accounts table,
 *     but without the on-ledger signer-list entry it has no signing
 *     authority — the agent row should not claim to be 'active'.
 *
 * Both branches are guarded by status='pending' so replays of a
 * confirmation job are silent no-ops rather than overwrites.
 *
 * Only grantPermission-originated SignerListSet txs are touched. Direct
 * grantPermission callers (non-agent-launcher use of the permission API)
 * won't have an agents row — the UPDATE then matches zero rows, which is
 * the intended behavior: a permission.service grant without a paired
 * agent row is a standalone delegation, not an agent vault.
 */
export async function applyAgentGrantOutcome(
  txId: string,
  isSuccess: boolean,
  log: Logger,
): Promise<void> {
  const rows = await db
    .select({
      txType: schema.transactions.txType,
      requestBody: schema.transactions.requestBody,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId))
    .limit(1);

  const row = rows[0];
  if (!row || row.txType !== 'SignerListSet') return;

  const body = row.requestBody as {
    op?: unknown;
    delegate?: unknown;
  } | null;
  const op = typeof body?.op === 'string' ? body.op : null;
  const delegateAddress = typeof body?.delegate === 'string' ? body.delegate : null;
  // Only finalize grantPermission txs. revokePermission has its own helper
  // above; any other SignerListSet path (configureSigners from
  // account.service, for example) skips both.
  if (op !== 'grantPermission' || !delegateAddress) return;

  // Match the agents row by agent_address — the column is UNIQUE and was
  // populated at provisioning time. Matching via delegation_id instead
  // would require an additional SELECT because the requestBody carries
  // the delegate address, not the delegation FK.
  const newStatus = isSuccess ? 'active' : 'failed';
  const updated = await db
    .update(schema.agents)
    .set({ status: newStatus })
    .where(
      and(eq(schema.agents.agentAddress, delegateAddress), eq(schema.agents.status, 'pending')),
    )
    .returning({ id: schema.agents.id });

  if (updated.length === 0) {
    // Two known-safe causes:
    //   - already-transitioned: a duplicate confirmer run after the row
    //     was flipped on a prior pass (row.status !== 'pending' anymore)
    //   - standalone grantPermission: a non-agent code path called
    //     permission.service directly without inserting an `agents` row
    //
    // The second case is contractual today (only provisionAgent calls
    // grantPermission with this requestBody.op). If a future call site
    // breaks that invariant, this warn is the one breadcrumb that
    // explains why a pending agent never flipped — silent debug logs
    // would make the bug effectively invisible.
    log.warn(
      { delegateAddress, isSuccess, txId },
      'agent grant outcome: no pending agents row matched — already transitioned, or a non-agent grantPermission call site exists (verify provisionAgent invariant)',
    );
    return;
  }

  log.info({ agentId: updated[0]?.id, newStatus, delegateAddress }, 'agent grant outcome applied');
}

/**
 * Partner to the REVIEW.md C-3 fix. `revokeCredential` stages
 * `status='revoking'` on the credentials row and enqueues a
 * CredentialDelete tx; this helper finalizes the DB state once rippled
 * validates (or expires) that tx.
 *
 *   tesSUCCESS → status='revoked'
 *   failure/expiry → revert to the priorStatus captured in the tx's
 *     requestBody (typically 'accepted' since revoke is normally called
 *     on an accepted credential)
 *
 * Both branches are guarded by `status='revoking'` so replays of a
 * confirmation are silent no-ops.
 *
 * Only CredentialDelete txs where `requestBody.op='revokeCredential'`
 * are touched — this skips any CredentialDelete that came from a
 * different code path (e.g. future client-initiated direct deletes).
 */
export async function applyCredentialRevokeOutcome(
  txId: string,
  isSuccess: boolean,
  log: Logger,
): Promise<void> {
  const rows = await db
    .select({
      txType: schema.transactions.txType,
      requestBody: schema.transactions.requestBody,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId))
    .limit(1);

  const row = rows[0];
  if (!row || row.txType !== 'CredentialDelete') return;

  const body = row.requestBody as {
    op?: unknown;
    credentialId?: unknown;
    priorStatus?: unknown;
  } | null;
  const op = typeof body?.op === 'string' ? body.op : null;
  const credentialId = typeof body?.credentialId === 'string' ? body.credentialId : null;
  const priorStatus = typeof body?.priorStatus === 'string' ? body.priorStatus : 'accepted';
  if (op !== 'revokeCredential' || !credentialId) return;

  const nextStatus = isSuccess ? 'revoked' : priorStatus;

  const updated = await db
    .update(schema.credentials)
    .set({ status: nextStatus })
    .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.status, 'revoking')))
    .returning({ id: schema.credentials.id });

  if (updated.length === 0) {
    log.debug(
      { credentialId, isSuccess },
      'credential already transitioned out of revoking (noop)',
    );
    return;
  }

  log.info({ credentialId, newStatus: nextStatus }, 'credential revoke outcome applied');
}

// Re-exported so tests can `expect.toThrow(TxNotYetValidated)`.
export { TxNotYetValidated };
