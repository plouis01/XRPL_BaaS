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
//    txConfirmer lands on validated — TODO in a later task.
//
// CROSS-TENANT CHECK: the issuer lookup is scoped by clientId. If a
// malicious client passes an issuer address belonging to another tenant,
// the lookup returns null and we 404. This matches the pattern in
// account.service.getAccount.

import { and, db, eq, isNull, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import { buildMptIssuanceCreate } from '@railforge/xrpl-core';
import { logger } from '../logger.ts';

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
    public readonly code: 'issuer_not_found' | 'trustline_not_supported_yet' | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'TokenServiceError';
  }
}

/**
 * Create a new token. MPT by default, trustline opt-in (Sprint 2 defers
 * the trustline path — throws trustline_not_supported_yet until the
 * TrustSet flow lands).
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

  // 2. Trustline path deferred. Document clearly.
  if (input.type === 'trustline') {
    throw new TokenServiceError(
      'trustline_not_supported_yet',
      'Trustline issuance is not yet implemented. Use type=mpt.',
    );
  }

  // 3. Build the XRPL tx via the canonical builder. Sequence / Fee /
  // LastLedgerSequence are filled by the txSubmitter worker.
  const mptTx = buildMptIssuanceCreate({
    account: issuer.address,
    transferFee: input.transferFee,
    // Flags — tfMPTCanTransfer so holders can move it; tfMPTCanEscrow.
    // Clawback/freeze are set via separate AccountSet paths in follow-ups.
    flags: 0x00000020 | 0x00000001, // tfMPTCanTransfer + tfMPTCanLock
    ...(input.maxSupply !== undefined ? { maximumAmount: input.maxSupply } : {}),
  });

  // 4. Insert the transactions row FIRST to get a stable txId.
  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'MPTokenIssuanceCreate',
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
    txJson: mptTx,
  });

  log.info({ txId, tokenId }, 'token create enqueued');

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
