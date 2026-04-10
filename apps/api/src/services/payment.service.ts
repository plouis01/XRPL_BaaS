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
}

export async function sendPayment(input: SendPaymentInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'payment',
    op: 'send',
    clientId: input.clientId,
    source: input.source,
  });

  const source = await requireFundedSource(input.clientId, input.source)();

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

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType,
      sourceAddress: source.address,
      status: 'queued',
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

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'EscrowCreate',
      sourceAddress: source.address,
      status: 'queued',
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
