// Payment service — send payments, create/finish/cancel escrows.
//
// Sprint 3 scope: XRP, MPT, issued-currency, and cross-currency payments;
// escrow create/finish/cancel. All ops follow the same pattern as
// token.service: resolve source account ownership → build tx → insert
// transactions row → enqueue.
//
// Cross-currency payments: the client supplies a different currency/issuer
// pair for the destination than the source holds. The XRPL Payment builder
// can include `Paths` (auto-filled by rippled when not specified) and
// `SendMax` for partial-path bridging. For Sprint 3 we let rippled
// auto-find paths by omitting `Paths` — clients that need explicit path
// control can pass them in a future API version.
//
// CROSS-TENANT CHECK: every source-account lookup is scoped by clientId.
// The same resolveOwnedAccount helper from account.service would be ideal,
// but to avoid circular imports we duplicate the 5-line query here. Both
// are covered by unit tests for cross-tenant isolation.

import { and, db, eq, isNull, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import {
  buildEscrowCancel,
  buildEscrowCreate,
  buildEscrowFinish,
  buildIssuedCurrencyPayment,
  buildMptPayment,
  buildXrpPayment,
} from '@railforge/xrpl-core';
import { logger } from '../logger.ts';
import { AgentServiceError, authorizeAgentPayment } from './agent.service.ts';
import { dropsToUsdCents, rlusdValueToUsdCents } from './priceOracle.service.ts';
import { enforceSpendPolicy, enforceTokenOpCount } from './spendPolicy.service.ts';

// RLUSD is the only IOU treated as a 1:1-peg amount-cap target. Anything
// else falls through to enforceTokenOpCount (op-count ceiling).
// Currency code may arrive as ASCII "RLUSD" or its 40-char hex form
// (XRPL convention for codes longer than 3 chars). The hex covers
// the dashboard well-known-token picker; the ASCII covers ad-hoc
// callers. Issuer match is loose across networks — if the caller is on
// the wrong network, the on-ledger Payment fails anyway.
const RLUSD_HEX = '524C555344000000000000000000000000000000';
const RLUSD_ISSUERS = new Set([
  'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', // mainnet
  'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', // testnet
]);

function isRlusd(currency: string, issuer: string): boolean {
  const upper = currency.toUpperCase();
  if (upper !== 'RLUSD' && upper !== RLUSD_HEX) return false;
  return RLUSD_ISSUERS.has(issuer);
}

export class PaymentServiceError extends Error {
  constructor(
    public readonly code: 'source_not_found' | 'source_not_funded' | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentServiceError';
  }
}

// ── Internal helper ────────────────────────────────────────────────────────

interface ResolvedSource {
  id: string;
  address: string;
  isFunded: boolean | null;
}

async function resolveSource(clientId: string, address: string): Promise<ResolvedSource | null> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      address: schema.accounts.address,
      isFunded: schema.accounts.isFunded,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.clientId, clientId),
        eq(schema.accounts.address, address),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function requireFundedSource(clientId: string, address: string) {
  return async () => {
    const source = await resolveSource(clientId, address);
    if (!source) {
      throw new PaymentServiceError('source_not_found', 'Source account not found');
    }
    if (!source.isFunded) {
      throw new PaymentServiceError(
        'source_not_funded',
        'Source account is not yet funded — wait for the funding payment to validate',
      );
    }
    return source;
  };
}

// ── Send payment ───────────────────────────────────────────────────────────

export interface SendPaymentInput {
  clientId: string;
  source: string;
  destination: string;
  destinationTag?: number;
  memo?: string;
  // Exactly one of these three groups:
  amountDrops?: string;
  mptIssuanceId?: string;
  value?: string;
  currency?: string;
  issuer?: string;
  /** REVIEW.md HIGH-04: thread into transactions.idempotency_key. */
  idempotencyKey?: string;
  /**
   * VISION.md agent launcher: when non-null, the auth'd API key belongs to
   * an agent. Payment is gated against the agent's allowlist + status
   * (see authorizeAgentPayment) before any tx is enqueued.
   */
  agentId?: string | null;
}

export async function sendPayment(input: SendPaymentInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'payment',
    op: 'send',
    clientId: input.clientId,
    source: input.source,
  });

  const source = await requireFundedSource(input.clientId, input.source)();

  // VISION.md agent launcher: if this API key is bound to an agent, gate
  // the payment against the agent's allowlist + status BEFORE building or
  // enqueueing the tx. Runs after source resolution so a non-owned source
  // still returns source_not_found (cross-tenant check wins) and before
  // spend-policy enforcement so a blocked tx doesn't burn the daily budget.
  if (input.agentId) {
    const assetKey = input.mptIssuanceId
      ? input.mptIssuanceId
      : input.currency && input.issuer
        ? `${input.currency}:${input.issuer}`
        : null;
    try {
      await authorizeAgentPayment({
        clientId: input.clientId,
        agentId: input.agentId,
        sourceAddress: source.address,
        destinationAddress: input.destination,
        assetKey,
      });
    } catch (err) {
      if (err instanceof AgentServiceError) {
        // Translate the subset of AgentServiceError codes the authorize
        // helper throws into PaymentServiceError codes the route map
        // already knows about. Preserving the agent-specific code would
        // require broadening PaymentServiceError; simpler to keep the
        // route mapper's surface narrow and re-classify here.
        if (err.code === 'agent_not_found' || err.code === 'agent_not_active') {
          throw new PaymentServiceError('invalid_input', err.message);
        }
        if (
          err.code === 'source_not_parent' ||
          err.code === 'destination_not_allowlisted' ||
          err.code === 'token_not_allowlisted'
        ) {
          throw new PaymentServiceError('invalid_input', err.message);
        }
      }
      throw err;
    }
  }

  // Pick the right builder based on which amount fields are set.
  // biome-ignore lint/suspicious/noExplicitAny: builder return types vary
  let txJson: any;
  let txType: string;

  if (input.amountDrops) {
    // XRP payment
    txJson = buildXrpPayment({
      account: source.address,
      destination: input.destination,
      amountDrops: input.amountDrops,
      destinationTag: input.destinationTag,
      memo: input.memo,
    });
    txType = 'Payment';
  } else if (input.mptIssuanceId && input.value) {
    // MPT payment
    txJson = buildMptPayment({
      account: source.address,
      destination: input.destination,
      mptIssuanceId: input.mptIssuanceId,
      value: input.value,
      destinationTag: input.destinationTag,
    });
    txType = 'Payment';
  } else if (input.currency && input.issuer && input.value) {
    // Issued-currency payment (including cross-currency — rippled
    // auto-finds paths when Paths is omitted and the currencies differ).
    txJson = buildIssuedCurrencyPayment({
      account: source.address,
      destination: input.destination,
      currency: input.currency,
      issuer: input.issuer,
      value: input.value,
      destinationTag: input.destinationTag,
    });
    txType = 'Payment';
  } else {
    throw new PaymentServiceError(
      'invalid_input',
      'Provide exactly one of: amount_drops (XRP), mpt_issuance_id+value (MPT), or currency+issuer+value (issued currency)',
    );
  }

  // USD-denominated cap enforcement (migration 0019). Three asset paths:
  //   - XRP   → drops × XRP/USD rate (priceOracle, 60s cache) → cents
  //   - RLUSD → value × 100 = cents (1:1 peg, no oracle round-trip)
  //   - other IOU/MPT → no per-asset oracle; falls through to
  //                     enforceTokenOpCount (per-day op-count ceiling).
  let usdCentsForCap: bigint | null = null;
  if (input.amountDrops) {
    usdCentsForCap = await dropsToUsdCents(input.amountDrops);
  } else if (
    input.currency &&
    input.issuer &&
    input.value &&
    isRlusd(input.currency, input.issuer)
  ) {
    usdCentsForCap = rlusdValueToUsdCents(input.value);
  }
  if (usdCentsForCap !== null) {
    await enforceSpendPolicy(input.clientId, usdCentsForCap, input.agentId ?? null);
  } else {
    // MPT, non-RLUSD IOU, or malformed RLUSD value — out of scope for the
    // USD cap. The op-count ceiling still bounds the blast radius.
    await enforceTokenOpCount(input.clientId, input.agentId ?? null);
  }

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType,
      sourceAddress: source.address,
      status: 'queued',
      amountDrops: input.amountDrops ?? null,
      // Stamp the cents amount the spend-policy counter was incremented
      // by, so txConfirmer's refund path can decrement the same counter
      // by the same amount on terminal failure (without re-running the
      // oracle, which may have drifted between submission and refund).
      // NULL when no USD cap was applied (MPT, non-RLUSD IOU).
      amountUsdCents: usdCentsForCap !== null ? usdCentsForCap.toString() : null,
      // VISION.md agent launcher: stamp the originating agent so the
      // dashboard can render per-agent tx history. NULL for client-scoped
      // (non-agent) keys.
      agentId: input.agentId ?? null,
      requestBody: {
        op: 'sendPayment',
        source: input.source,
        destination: input.destination,
        amountDrops: input.amountDrops ?? null,
        mptIssuanceId: input.mptIssuanceId ?? null,
        value: input.value ?? null,
        currency: input.currency ?? null,
        issuer: input.issuer ?? null,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: source.address, txJson });
  log.info({ txId }, 'payment enqueued');
  return { txId };
}

// ── Batch payments (XLS-56 sequential fallback) ────────────────────────────
//
// Pre-amendment fallback per ARCHITECTURE.md §4.6: "Sequential txs with
// application-level rollback." True atomicity requires XLS-56 V1.1 — until
// that lands, this implementation supports the two modes that can be
// faithfully emulated sequentially:
//
//   - UNTIL_FAILURE: enqueue one at a time; stop on the first pre-submission
//     validation error (source unfunded, bad amount shape, spend policy,
//     etc.). Already-enqueued txs stay queued — the caller is expected to
//     poll each returned tx_id and, if desired, issue compensating txs.
//
//   - INDEPENDENT: enqueue every item; report per-item success/error.
//
// ALL_OR_NOTHING and ONLY_ONE cannot be emulated — once a tx is signed and
// submitted there is no rollback primitive. Those modes return 501 at the
// route layer with a message pointing at the amendment.

export interface BatchPaymentItem {
  source: string;
  destination: string;
  destinationTag?: number;
  memo?: string;
  amountDrops?: string;
  mptIssuanceId?: string;
  value?: string;
  currency?: string;
  issuer?: string;
}

export interface SendBatchPaymentsInput {
  clientId: string;
  mode: 'UNTIL_FAILURE' | 'INDEPENDENT';
  payments: BatchPaymentItem[];
  /**
   * REVIEW.md HIGH-04: each item is derived to `${batchKey}:${index}` so
   * items stay uniquely keyed under UNIQUE(client_id, idempotency_key) but
   * a client retrying the whole batch hits the same derived rows.
   */
  idempotencyKey?: string;
}

export interface BatchResultItem {
  index: number;
  txId: string | null;
  status: 'queued' | 'error' | 'skipped';
  errorCode?: string;
  errorMessage?: string;
}

export async function sendBatchPayments(
  input: SendBatchPaymentsInput,
): Promise<{ mode: string; results: BatchResultItem[] }> {
  const log = logger.child({
    service: 'payment',
    op: 'batch',
    clientId: input.clientId,
    mode: input.mode,
    count: input.payments.length,
  });

  const results: BatchResultItem[] = [];
  let stopDueToFailure = false;

  for (let i = 0; i < input.payments.length; i++) {
    const item = input.payments[i];
    if (!item) continue;

    if (stopDueToFailure) {
      results.push({ index: i, txId: null, status: 'skipped' });
      continue;
    }

    try {
      const { txId } = await sendPayment({
        clientId: input.clientId,
        ...item,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${i}` : undefined,
      });
      results.push({ index: i, txId, status: 'queued' });
    } catch (err) {
      if (err instanceof PaymentServiceError) {
        results.push({
          index: i,
          txId: null,
          status: 'error',
          errorCode: err.code,
          errorMessage: err.message,
        });
        if (input.mode === 'UNTIL_FAILURE') stopDueToFailure = true;
      } else {
        // Non-domain error — don't swallow; the route handler's global
        // error path will 500 and roll nothing back. Already-enqueued
        // items stay queued; caller sees the partial results.
        throw err;
      }
    }
  }

  log.info(
    {
      queued: results.filter((r) => r.status === 'queued').length,
      errors: results.filter((r) => r.status === 'error').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    },
    'batch enqueued',
  );

  return { mode: input.mode, results };
}

// ── Get payment status ─────────────────────────────────────────────────────

export interface PaymentStatusView {
  id: string;
  txType: string;
  sourceAddress: string;
  status: string;
  resultCode: string | null;
  txHash: string | null;
  ledgerIndex: number | null;
  feeDrops: string | null;
  createdAt: Date | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
}

export async function getPayment(
  clientId: string,
  txId: string,
): Promise<PaymentStatusView | null> {
  const rows = await db
    .select({
      id: schema.transactions.id,
      txType: schema.transactions.txType,
      sourceAddress: schema.transactions.sourceAddress,
      status: schema.transactions.status,
      resultCode: schema.transactions.resultCode,
      txHash: schema.transactions.txHash,
      ledgerIndex: schema.transactions.ledgerIndex,
      feeDrops: schema.transactions.feeDrops,
      createdAt: schema.transactions.createdAt,
      submittedAt: schema.transactions.submittedAt,
      confirmedAt: schema.transactions.confirmedAt,
    })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.id, txId), eq(schema.transactions.clientId, clientId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return row;
}

// ── Escrow create ──────────────────────────────────────────────────────────

export interface CreateEscrowInput {
  clientId: string;
  source: string;
  destination: string;
  amountDrops: string;
  finishAfter?: number;
  cancelAfter?: number;
  condition?: string;
  destinationTag?: number;
  idempotencyKey?: string;
}

export async function createEscrow(input: CreateEscrowInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'payment',
    op: 'createEscrow',
    clientId: input.clientId,
  });

  const source = await requireFundedSource(input.clientId, input.source)();

  let txJson: ReturnType<typeof buildEscrowCreate>;
  try {
    txJson = buildEscrowCreate({
      account: source.address,
      destination: input.destination,
      amountDrops: input.amountDrops,
      finishAfter: input.finishAfter,
      cancelAfter: input.cancelAfter,
      condition: input.condition,
      destinationTag: input.destinationTag,
    });
  } catch (err) {
    throw new PaymentServiceError(
      'invalid_input',
      err instanceof Error ? err.message : 'invalid escrow parameters',
    );
  }

  // Escrow create is XRP-only at this layer; convert drops → USD cents.
  const escrowUsdCents = await dropsToUsdCents(input.amountDrops);
  await enforceSpendPolicy(input.clientId, escrowUsdCents);

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType: 'EscrowCreate',
      sourceAddress: source.address,
      status: 'queued',
      amountDrops: input.amountDrops,
      amountUsdCents: escrowUsdCents.toString(),
      requestBody: {
        op: 'createEscrow',
        source: input.source,
        destination: input.destination,
        amountDrops: input.amountDrops,
        finishAfter: input.finishAfter ?? null,
        cancelAfter: input.cancelAfter ?? null,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: source.address, txJson });
  log.info({ txId }, 'escrow create enqueued');
  return { txId };
}

// ── Escrow finish ──────────────────────────────────────────────────────────

export interface FinishEscrowInput {
  clientId: string;
  source: string;
  owner: string;
  offerSequence: number;
  condition?: string;
  fulfillment?: string;
  idempotencyKey?: string;
}

export async function finishEscrow(input: FinishEscrowInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'payment',
    op: 'finishEscrow',
    clientId: input.clientId,
  });

  const source = await requireFundedSource(input.clientId, input.source)();

  const txJson = buildEscrowFinish({
    account: source.address,
    owner: input.owner,
    offerSequence: input.offerSequence,
    condition: input.condition,
    fulfillment: input.fulfillment,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType: 'EscrowFinish',
      sourceAddress: source.address,
      status: 'queued',
      requestBody: {
        op: 'finishEscrow',
        owner: input.owner,
        offerSequence: input.offerSequence,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: source.address, txJson });
  log.info({ txId }, 'escrow finish enqueued');
  return { txId };
}

// ── Escrow cancel ──────────────────────────────────────────────────────────

export interface CancelEscrowInput {
  clientId: string;
  source: string;
  owner: string;
  offerSequence: number;
  idempotencyKey?: string;
}

export async function cancelEscrow(input: CancelEscrowInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'payment',
    op: 'cancelEscrow',
    clientId: input.clientId,
  });

  const source = await requireFundedSource(input.clientId, input.source)();

  const txJson = buildEscrowCancel({
    account: source.address,
    owner: input.owner,
    offerSequence: input.offerSequence,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType: 'EscrowCancel',
      sourceAddress: source.address,
      status: 'queued',
      requestBody: {
        op: 'cancelEscrow',
        owner: input.owner,
        offerSequence: input.offerSequence,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: source.address, txJson });
  log.info({ txId }, 'escrow cancel enqueued');
  return { txId };
}
