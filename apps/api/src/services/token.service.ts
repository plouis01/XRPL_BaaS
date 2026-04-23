// Token service — issue, transfer, freeze, clawback.
//
// Sprint 2 scope: token creation (MPT default + trustline opt-in).
// The full surface (transfer, freeze, clawback) is queued for the same
// sprint but this file ships the core create path first so the other
// operations can follow the same pattern.
//
// Architecture:
//
// 1. Validate that the `issuer` address belongs to the authenticated client.
//    No cross-tenant issuance — a client can only issue from an account
//    it owns.
//
// 2. Insert a transactions row in 'queued' state. This gives us a stable
//    txId we can pass to the worker via the job payload.
//
// 3. Build the XRPL tx via @railforge/xrpl-core builders.
//
// 4. Enqueue a TxSubmitJob via @railforge/jobs. The worker pipeline
//    (txSubmitter → txConfirmer) fills in Sequence/Fee/LastLedgerSequence,
//    signs, submits, and updates the transactions row to 'submitted'
//    and then 'validated'.
//
// 5. On validation (done in txConfirmer), a follow-up step writes the
//    tokens table row with the on-chain mpt_issuance_id. For Sprint 2 we
//    write the tokens row EAGERLY during create() so clients see the
//    token ID immediately; the mpt_issuance_id is backfilled when the
//    txConfirmer validates the tx (see txConfirmer.ts backfillMptIssuanceId).
//
// CROSS-TENANT CHECK: the issuer lookup is scoped by clientId. If a
// malicious client passes an issuer address belonging to another tenant,
// the lookup returns null and we 404. This matches the pattern in
// account.service.getAccount.

import { and, db, eq, isNull, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import {
  buildIssuedCurrencyClawback,
  buildIssuedCurrencyPayment,
  buildMptClawback,
  buildMptIssuanceCreate,
  buildMptIssuanceSet,
  buildMptPayment,
  buildTrustSet,
} from '@railforge/xrpl-core';
import { logger } from '../logger.ts';
import { enforceTokenOpCount } from './spendPolicy.service.ts';

export interface CreateTokenInput {
  clientId: string;
  issuer: string;
  type: 'mpt' | 'trustline';
  currencyCode: string;
  transferFee: number;
  clawback: boolean;
  freezeEnabled: boolean;
  maxSupply?: string;
  metadata?: Record<string, unknown>;
  /**
   * Trust line opt-in only: the holding limit. Required when type='trustline',
   * ignored otherwise. The validator should reject the request if missing,
   * but the service double-checks since validators can drift.
   */
  trustlineLimit?: string;
  /** REVIEW.md HIGH-04: thread into transactions.idempotency_key. */
  idempotencyKey?: string;
}

export interface TokenView {
  id: string;
  clientId: string;
  issuerAccountId: string;
  issuerAddress: string;
  tokenType: string;
  currencyCode: string;
  mptIssuanceId: string | null;
  transferFee: number;
  clawback: boolean;
  freezeEnabled: boolean;
  maxSupply: string | null;
  status: 'queued' | 'submitted' | 'validated' | 'failed';
  txId: string;
  createdAt: Date | null;
}

export class TokenServiceError extends Error {
  constructor(
    public readonly code:
      | 'issuer_not_found'
      | 'token_not_found'
      | 'token_not_ready'
      | 'trustline_missing_limit'
      | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'TokenServiceError';
  }
}

/**
 * Create a new token. MPT by default, trustline opt-in via explicit
 * `type: "trustline"` (requires trustlineLimit).
 *
 * @throws {TokenServiceError} on issuer lookup failure or unsupported type
 */
export async function createToken(input: CreateTokenInput): Promise<TokenView> {
  const log = logger.child({
    service: 'token',
    op: 'create',
    clientId: input.clientId,
    issuer: input.issuer,
  });

  // 1. Look up the issuer account scoped to the client. This is the
  // cross-tenant boundary — the lookup returns null if the address
  // belongs to another tenant, and we surface the same 'issuer_not_found'
  // code for both cases (no enumeration oracle).
  const issuerRows = await db
    .select({
      id: schema.accounts.id,
      address: schema.accounts.address,
      isFunded: schema.accounts.isFunded,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.clientId, input.clientId),
        eq(schema.accounts.address, input.issuer),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .limit(1);

  const issuer = issuerRows[0];
  if (!issuer) {
    throw new TokenServiceError('issuer_not_found', 'Issuer account not found for this client');
  }
  if (!issuer.isFunded) {
    // An unfunded issuer can't submit any transaction — surface this
    // clearly rather than letting the submit fail with tecNO_DST or similar.
    throw new TokenServiceError('issuer_not_found', 'Issuer account is not yet funded');
  }

  // 2. Build the XRPL tx via the canonical builder. Sequence / Fee /
  // LastLedgerSequence are filled by the txSubmitter worker.
  //
  // Trust line opt-in (Sprint 3): when type='trustline' the service
  // builds a TrustSet from the issuer to itself with the requested limit.
  // The currencyCode is the on-ledger currency identifier. The requested
  // `trustlineLimit` is required and the validator enforces it; we
  // double-check here in case the validator schema drifts.
  let txJson: ReturnType<typeof buildMptIssuanceCreate> | ReturnType<typeof buildTrustSet>;
  let txType: 'MPTokenIssuanceCreate' | 'TrustSet';
  if (input.type === 'trustline') {
    if (!input.trustlineLimit) {
      throw new TokenServiceError(
        'trustline_missing_limit',
        'Trust line tokens require a trustline_limit',
      );
    }
    txJson = buildTrustSet({
      account: issuer.address,
      currency: input.currencyCode,
      // For an issuer self-issuing a trust-line token, the issuer field
      // on the limit IS the issuer's own address. Holders later create
      // their own TrustSet pointing at this issuer.
      issuer: issuer.address,
      limit: input.trustlineLimit,
    });
    txType = 'TrustSet';
  } else {
    // MPTokenIssuanceCreate flag values (xrpl.js v4.6 MPTokenIssuanceCreateFlags):
    //   tfMPTCanLock      = 0x00000002  — enables freeze via MPTokenIssuanceSet
    //   tfMPTRequireAuth  = 0x00000004
    //   tfMPTCanEscrow    = 0x00000008
    //   tfMPTCanTrade     = 0x00000010
    //   tfMPTCanTransfer  = 0x00000020  — required for holder-to-holder transfers
    //   tfMPTCanClawback  = 0x00000040  — enables issuer clawback
    //
    // Prior bug: this mask used 0x01 for "CanLock" (wrong: 0x01 is tfMPTLock
    // on MPTokenIssuanceSet, not a valid Create flag). rippled rejected with
    // temINVALID_FLAG. The fix threads the `clawback` / `freeze_enabled`
    // service inputs to the correct flags instead of hard-coding a mask.
    let flagMask = 0x00000020; // tfMPTCanTransfer — always on
    if (input.freezeEnabled) flagMask |= 0x00000002; // tfMPTCanLock
    if (input.clawback) flagMask |= 0x00000040; // tfMPTCanClawback
    txJson = buildMptIssuanceCreate({
      account: issuer.address,
      transferFee: input.transferFee,
      flags: flagMask,
      ...(input.maxSupply !== undefined ? { maximumAmount: input.maxSupply } : {}),
    });
    txType = 'MPTokenIssuanceCreate';
  }

  // 3. Insert the transactions row FIRST to get a stable txId.
  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType,
      sourceAddress: issuer.address,
      status: 'queued',
      requestBody: {
        op: 'createToken',
        issuer: input.issuer,
        type: input.type,
        currencyCode: input.currencyCode,
        transferFee: input.transferFee,
        clawback: input.clawback,
        freezeEnabled: input.freezeEnabled,
        maxSupply: input.maxSupply ?? null,
        trustlineLimit: input.trustlineLimit ?? null,
      },
    })
    .returning({ id: schema.transactions.id });

  const txId = txInserted[0]?.id;
  if (!txId) {
    throw new Error('transactions insert returned no row');
  }

  // 5. Insert the tokens row now. mpt_issuance_id stays null until the
  // txConfirmer backfills it on validation.
  const tokenInserted = await db
    .insert(schema.tokens)
    .values({
      clientId: input.clientId,
      issuerAccount: issuer.id,
      tokenType: input.type,
      currencyCode: input.currencyCode,
      mptIssuanceId: null,
      transferFee: input.transferFee,
      clawback: input.clawback,
      freezeEnabled: input.freezeEnabled,
      maxSupply: input.maxSupply ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: schema.tokens.id });

  const tokenId = tokenInserted[0]?.id;
  if (!tokenId) {
    throw new Error('tokens insert returned no row');
  }

  // 6. Enqueue the submit job. The worker reads the seed from
  // accounts.master_key_ref to sign for this source address.
  await enqueueTxSubmit({
    txId,
    sourceAddress: issuer.address,
    txJson,
  });

  log.info({ txId, tokenId, txType }, 'token create enqueued');

  return {
    id: tokenId,
    clientId: input.clientId,
    issuerAccountId: issuer.id,
    issuerAddress: issuer.address,
    tokenType: input.type,
    currencyCode: input.currencyCode,
    mptIssuanceId: null,
    transferFee: input.transferFee,
    clawback: input.clawback,
    freezeEnabled: input.freezeEnabled,
    maxSupply: input.maxSupply ?? null,
    status: 'queued',
    txId,
    createdAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Token operations: transfer / freeze / clawback
//
// Shared shape: each op (a) looks up the token + its issuer scoped to the
// client, (b) verifies the token is ready (mpt_issuance_id present for MPT
// ops), (c) builds the right tx via xrpl-core, (d) inserts a transactions
// row, (e) enqueues. The pattern mirrors createToken().
//
// CROSS-TENANT CHECK: every lookup is scoped by clientId. The two-step
// SELECT (token by id+client → issuer account) prevents leaking the
// existence of tokens that belong to other tenants.
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedToken {
  tokenId: string;
  tokenType: string;
  currencyCode: string;
  mptIssuanceId: string | null;
  issuerAccountId: string;
  issuerAddress: string;
}

/**
 * Look up a token + its issuer account, scoped to the client. Returns
 * `null` if the token doesn't exist OR belongs to another tenant — both
 * cases are indistinguishable from the caller's perspective.
 *
 * Single JOIN over (tokens, accounts) — Postgres uses the tokens.id PK
 * and the FK index on issuer_account, so this is two index lookups.
 */
async function resolveToken(clientId: string, tokenId: string): Promise<ResolvedToken | null> {
  const rows = await db
    .select({
      tokenId: schema.tokens.id,
      tokenType: schema.tokens.tokenType,
      currencyCode: schema.tokens.currencyCode,
      mptIssuanceId: schema.tokens.mptIssuanceId,
      issuerAccountId: schema.tokens.issuerAccount,
      issuerAddress: schema.accounts.address,
    })
    .from(schema.tokens)
    .innerJoin(schema.accounts, eq(schema.tokens.issuerAccount, schema.accounts.id))
    .where(and(eq(schema.tokens.id, tokenId), eq(schema.tokens.clientId, clientId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface TransferTokenInput {
  clientId: string;
  tokenId: string;
  destination: string;
  amount: string;
  destinationTag?: number;
  idempotencyKey?: string;
}

/**
 * Transfer token value from the issuer to a destination. For MPT tokens
 * the issuance must already be validated on-ledger (mpt_issuance_id is
 * non-null) — we can't reference an MPT that doesn't exist yet.
 *
 * For trust-line tokens, "transfer" is just a Payment with the issued-
 * currency Amount shape. The issuer can always transfer; it's the holder
 * receiving side that needs the trust line set up.
 *
 * @throws {TokenServiceError} on token_not_found or token_not_ready
 */
export async function transferToken(input: TransferTokenInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'token',
    op: 'transfer',
    clientId: input.clientId,
    tokenId: input.tokenId,
  });

  const token = await resolveToken(input.clientId, input.tokenId);
  if (!token) {
    throw new TokenServiceError('token_not_found', 'Token not found');
  }

  // REVIEW.md MED-03: token transfers move asset value the drops-based
  // enforceSpendPolicy doesn't cover. Apply the nominal per-day op-count
  // ceiling as defense-in-depth.
  await enforceTokenOpCount(input.clientId);

  let txJson: ReturnType<typeof buildMptPayment> | ReturnType<typeof buildIssuedCurrencyPayment>;
  if (token.tokenType === 'mpt') {
    if (!token.mptIssuanceId) {
      // MPT issuance hasn't been validated yet — we don't have an
      // mpt_issuance_id to reference. The client must wait for the
      // create tx to land. The txConfirmer backfills this column on
      // tesSUCCESS (PLAN.md §6 Sprint 3 carry-over).
      throw new TokenServiceError(
        'token_not_ready',
        'Token issuance has not yet validated on-ledger',
      );
    }
    txJson = buildMptPayment({
      account: token.issuerAddress,
      destination: input.destination,
      mptIssuanceId: token.mptIssuanceId,
      value: input.amount,
      ...(input.destinationTag !== undefined ? { destinationTag: input.destinationTag } : {}),
    });
  } else {
    // Trust-line token — issued-currency Payment shape.
    txJson = buildIssuedCurrencyPayment({
      account: token.issuerAddress,
      destination: input.destination,
      currency: token.currencyCode,
      issuer: token.issuerAddress,
      value: input.amount,
      ...(input.destinationTag !== undefined ? { destinationTag: input.destinationTag } : {}),
    });
  }

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType: 'Payment',
      sourceAddress: token.issuerAddress,
      status: 'queued',
      requestBody: {
        op: 'transferToken',
        tokenId: input.tokenId,
        destination: input.destination,
        amount: input.amount,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: token.issuerAddress, txJson });
  log.info({ txId }, 'token transfer enqueued');
  return { txId };
}

export interface FreezeTokenInput {
  clientId: string;
  tokenId: string;
  /** Holder to freeze. Omit to freeze the entire issuance. */
  holder?: string;
  /** True to unfreeze (tfMPTUnlock), false (default) to freeze (tfMPTLock). */
  unfreeze?: boolean;
  idempotencyKey?: string;
}

/**
 * Freeze (or unfreeze) an MPT token. Trust-line freeze is a different
 * code path (TrustSet with tfSetFreeze flag) and is deferred to a later
 * sprint — for now we reject trust-line tokens with invalid_input.
 */
export async function freezeToken(input: FreezeTokenInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'token',
    op: 'freeze',
    clientId: input.clientId,
    tokenId: input.tokenId,
  });

  const token = await resolveToken(input.clientId, input.tokenId);
  if (!token) {
    throw new TokenServiceError('token_not_found', 'Token not found');
  }
  if (token.tokenType !== 'mpt') {
    throw new TokenServiceError(
      'invalid_input',
      'freeze is only supported for MPT tokens in this version',
    );
  }
  if (!token.mptIssuanceId) {
    throw new TokenServiceError(
      'token_not_ready',
      'Token issuance has not yet validated on-ledger',
    );
  }

  // REVIEW.md MED-03: freeze/unfreeze is a privileged admin op; defense-
  // in-depth ceiling against a stolen-key op-spam attack.
  await enforceTokenOpCount(input.clientId);

  const txJson = buildMptIssuanceSet({
    account: token.issuerAddress,
    mptIssuanceId: token.mptIssuanceId,
    action: input.unfreeze ? 'unlock' : 'lock',
    ...(input.holder !== undefined ? { holder: input.holder } : {}),
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType: 'MPTokenIssuanceSet',
      sourceAddress: token.issuerAddress,
      status: 'queued',
      requestBody: {
        op: 'freezeToken',
        tokenId: input.tokenId,
        holder: input.holder ?? null,
        unfreeze: input.unfreeze ?? false,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: token.issuerAddress, txJson });
  log.info({ txId, action: input.unfreeze ? 'unlock' : 'lock' }, 'token freeze enqueued');
  return { txId };
}

export interface ClawbackTokenInput {
  clientId: string;
  tokenId: string;
  holder: string;
  amount: string;
  idempotencyKey?: string;
}

/**
 * Claw back tokens from a holder. Per the XRPL Clawback spec the
 * issuer is implicit — it's the Account submitting the tx. We use
 * the right amount shape (MPT vs issued currency) based on tokenType.
 */
export async function clawbackToken(input: ClawbackTokenInput): Promise<{ txId: string }> {
  const log = logger.child({
    service: 'token',
    op: 'clawback',
    clientId: input.clientId,
    tokenId: input.tokenId,
  });

  const token = await resolveToken(input.clientId, input.tokenId);
  if (!token) {
    throw new TokenServiceError('token_not_found', 'Token not found');
  }

  // REVIEW.md MED-03: clawback is a privileged admin op that moves asset
  // value; enforceSpendPolicy wouldn't cover it. Apply the op-count ceiling.
  await enforceTokenOpCount(input.clientId);

  let txJson: ReturnType<typeof buildMptClawback> | ReturnType<typeof buildIssuedCurrencyClawback>;
  if (token.tokenType === 'mpt') {
    if (!token.mptIssuanceId) {
      throw new TokenServiceError(
        'token_not_ready',
        'Token issuance has not yet validated on-ledger',
      );
    }
    txJson = buildMptClawback({
      account: token.issuerAddress,
      mptIssuanceId: token.mptIssuanceId,
      holder: input.holder,
      value: input.amount,
    });
  } else {
    txJson = buildIssuedCurrencyClawback({
      account: token.issuerAddress,
      currency: token.currencyCode,
      holder: input.holder,
      value: input.amount,
    });
  }

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      txType: 'Clawback',
      sourceAddress: token.issuerAddress,
      status: 'queued',
      requestBody: {
        op: 'clawbackToken',
        tokenId: input.tokenId,
        holder: input.holder,
        amount: input.amount,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  await enqueueTxSubmit({ txId, sourceAddress: token.issuerAddress, txJson });
  log.info({ txId }, 'token clawback enqueued');
  return { txId };
}
