// DEX service — XRPL native DEX (orderbook + AMM).
//
// Operations:
//   createOffer  — OfferCreate (place order on DEX)
//   cancelOffer  — OfferCancel (cancel existing offer)
//   ammDeposit   — AMMDeposit (add liquidity to AMM pool)
//   ammWithdraw  — AMMWithdraw (remove liquidity from AMM pool)
//
// Orderbook and AMM info queries are read-only (no tx needed).

import { and, db, eq, isNull, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import {
  type AssetAmount,
  buildAmmDeposit,
  buildAmmWithdraw,
  buildOfferCancel,
  buildOfferCreate,
} from '@railforge/xrpl-core';
import { logger } from '../logger.ts';

export class DexServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'not_managed'
      | 'enqueue_failed'
      | 'db_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'DexServiceError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveOwnedAccount(
  clientId: string,
  address: string,
): Promise<{ id: string; address: string } | null> {
  const rows = await db
    .select({ id: schema.accounts.id, address: schema.accounts.address })
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

/** Map API-level asset amount to the xrpl-core AssetAmount shape. */
function toAssetAmount(a: {
  drops?: string;
  currency?: string;
  issuer?: string;
  value?: string;
  mpt_issuance_id?: string;
}): AssetAmount {
  if (a.drops !== undefined) return { drops: a.drops };
  if (a.mpt_issuance_id && a.value) return { mptIssuanceId: a.mpt_issuance_id, value: a.value };
  if (a.currency && a.issuer && a.value) {
    return { currency: a.currency, issuer: a.issuer, value: a.value };
  }
  throw new DexServiceError('invalid_input', 'Invalid asset amount');
}

/** Map API-level asset currency to the xrpl-core AssetAmount shape (no value). */
function toAssetCurrency(a: {
  drops?: boolean | string;
  currency?: string;
  issuer?: string;
  mpt_issuance_id?: string;
}): AssetAmount {
  if (a.drops) return { drops: '0' };
  if (a.mpt_issuance_id) return { mptIssuanceId: a.mpt_issuance_id };
  if (a.currency && a.issuer) return { currency: a.currency, issuer: a.issuer };
  throw new DexServiceError('invalid_input', 'Invalid asset currency');
}

// ── Create Offer ────────────────────────────────────────────────────────────

export interface CreateOfferInput {
  clientId: string;
  account: string;
  takerGets: AssetAmount;
  takerPays: AssetAmount;
  expiration?: number;
  offerSequence?: number;
  flags?: number;
  domainId?: string;
  idempotencyKey?: string;
}

export async function createOffer(
  input: CreateOfferInput,
): Promise<{ tx_id: string; status: string }> {
  const log = logger.child({
    service: 'dex',
    op: 'createOffer',
    clientId: input.clientId,
  });

  const account = await resolveOwnedAccount(input.clientId, input.account);
  if (!account) throw new DexServiceError('not_managed', 'Account is not a managed account');

  const txJson = buildOfferCreate({
    account: input.account,
    takerGets: input.takerGets,
    takerPays: input.takerPays,
    expiration: input.expiration,
    offerSequence: input.offerSequence,
    flags: input.flags,
    domainId: input.domainId,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'OfferCreate',
      sourceAddress: input.account,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      requestBody: { op: 'createOffer', account: input.account },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new DexServiceError('db_conflict', 'transactions insert returned no row');

  try {
    await enqueueTxSubmit({ txId, sourceAddress: input.account, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new DexServiceError('enqueue_failed', 'Failed to enqueue offer creation');
  }

  log.info({ txId }, 'offer creation enqueued');
  return { tx_id: txId, status: 'queued' };
}

// ── Cancel Offer ────────────────────────────────────────────────────────────

export interface CancelOfferInput {
  clientId: string;
  account: string;
  offerSequence: number;
  idempotencyKey?: string;
}

export async function cancelOffer(
  input: CancelOfferInput,
): Promise<{ tx_id: string; status: string }> {
  const log = logger.child({
    service: 'dex',
    op: 'cancelOffer',
    clientId: input.clientId,
  });

  const account = await resolveOwnedAccount(input.clientId, input.account);
  if (!account) throw new DexServiceError('not_managed', 'Account is not a managed account');

  const txJson = buildOfferCancel({
    account: input.account,
    offerSequence: input.offerSequence,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'OfferCancel',
      sourceAddress: input.account,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      requestBody: {
        op: 'cancelOffer',
        account: input.account,
        offerSequence: input.offerSequence,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new DexServiceError('db_conflict', 'transactions insert returned no row');

  try {
    await enqueueTxSubmit({ txId, sourceAddress: input.account, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new DexServiceError('enqueue_failed', 'Failed to enqueue offer cancellation');
  }

  log.info({ txId }, 'offer cancellation enqueued');
  return { tx_id: txId, status: 'queued' };
}

// ── AMM Deposit ─────────────────────────────────────────────────────────────

export interface AmmDepositInput {
  clientId: string;
  account: string;
  asset: AssetAmount;
  asset2: AssetAmount;
  amount?: AssetAmount;
  amount2?: AssetAmount;
  ePrice?: AssetAmount;
  lpTokenOut?: { currency: string; issuer: string; value: string };
  flags?: number;
  idempotencyKey?: string;
}

export async function ammDeposit(
  input: AmmDepositInput,
): Promise<{ tx_id: string; status: string }> {
  const log = logger.child({
    service: 'dex',
    op: 'ammDeposit',
    clientId: input.clientId,
  });

  const account = await resolveOwnedAccount(input.clientId, input.account);
  if (!account) throw new DexServiceError('not_managed', 'Account is not a managed account');

  const txJson = buildAmmDeposit({
    account: input.account,
    asset: input.asset,
    asset2: input.asset2,
    amount: input.amount,
    amount2: input.amount2,
    ePrice: input.ePrice,
    lpTokenOut: input.lpTokenOut,
    flags: input.flags,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'AMMDeposit',
      sourceAddress: input.account,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      requestBody: { op: 'ammDeposit', account: input.account },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new DexServiceError('db_conflict', 'transactions insert returned no row');

  try {
    await enqueueTxSubmit({ txId, sourceAddress: input.account, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new DexServiceError('enqueue_failed', 'Failed to enqueue AMM deposit');
  }

  log.info({ txId }, 'AMM deposit enqueued');
  return { tx_id: txId, status: 'queued' };
}

// ── AMM Withdraw ────────────────────────────────────────────────────────────

export interface AmmWithdrawInput {
  clientId: string;
  account: string;
  asset: AssetAmount;
  asset2: AssetAmount;
  amount?: AssetAmount;
  amount2?: AssetAmount;
  ePrice?: AssetAmount;
  lpTokenIn?: { currency: string; issuer: string; value: string };
  flags?: number;
  idempotencyKey?: string;
}

export async function ammWithdraw(
  input: AmmWithdrawInput,
): Promise<{ tx_id: string; status: string }> {
  const log = logger.child({
    service: 'dex',
    op: 'ammWithdraw',
    clientId: input.clientId,
  });

  const account = await resolveOwnedAccount(input.clientId, input.account);
  if (!account) throw new DexServiceError('not_managed', 'Account is not a managed account');

  const txJson = buildAmmWithdraw({
    account: input.account,
    asset: input.asset,
    asset2: input.asset2,
    amount: input.amount,
    amount2: input.amount2,
    ePrice: input.ePrice,
    lpTokenIn: input.lpTokenIn,
    flags: input.flags,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'AMMWithdraw',
      sourceAddress: input.account,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      requestBody: { op: 'ammWithdraw', account: input.account },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new DexServiceError('db_conflict', 'transactions insert returned no row');

  try {
    await enqueueTxSubmit({ txId, sourceAddress: input.account, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new DexServiceError('enqueue_failed', 'Failed to enqueue AMM withdrawal');
  }

  log.info({ txId }, 'AMM withdrawal enqueued');
  return { tx_id: txId, status: 'queued' };
}

// Re-export helpers for route handler use
export { toAssetAmount, toAssetCurrency };
