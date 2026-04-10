// Credential service — XLS-70 on-chain credentials.
//
// RailForge is NEVER the credential issuer. The issuer_address must be
// either (a) a managed account belonging to the authenticated client, or
// (b) a registered marketplace issuer. This service handles the on-chain
// orchestration: CredentialCreate, CredentialAccept, CredentialDelete.
//
// Flow:
//   1. issue  — issuer creates credential for subject (CredentialCreate tx)
//   2. accept — subject accepts the credential (CredentialAccept tx)
//   3. revoke — issuer or subject deletes the credential (CredentialDelete tx)
//
// The credential row status mirrors the on-ledger lifecycle:
//   pending → accepted → (expired | revoked)

import { and, db, eq, isNull, lte, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import {
  buildCredentialAccept,
  buildCredentialCreate,
  buildCredentialDelete,
} from '@railforge/xrpl-core';
import { logger } from '../logger.ts';

export class CredentialServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'not_managed'
      | 'already_accepted'
      | 'enqueue_failed'
      | 'db_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialServiceError';
  }
}

export interface IssueCredentialInput {
  clientId: string;
  issuerAddress: string;
  subjectAddress: string;
  credentialType: string;
  expiration?: number;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface CredentialView {
  id: string;
  issuer_address: string;
  subject_address: string;
  credential_type: string;
  status: string;
  expires_at: Date | null;
  accepted_at: Date | null;
  ledger_index: string | null;
  metadata: unknown;
  created_at: Date | null;
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

function toView(row: {
  id: string;
  issuerAddress: string;
  subjectAddress: string;
  credentialType: string;
  status: string;
  expiresAt: Date | null;
  acceptedAt: Date | null;
  ledgerIndex: string | null;
  metadata: unknown;
  createdAt: Date | null;
}): CredentialView {
  return {
    id: row.id,
    issuer_address: row.issuerAddress,
    subject_address: row.subjectAddress,
    credential_type: row.credentialType,
    status: row.status,
    expires_at: row.expiresAt,
    accepted_at: row.acceptedAt,
    ledger_index: row.ledgerIndex,
    metadata: row.metadata,
    created_at: row.createdAt,
  };
}

// ── Issue ───────────────────────────────────────────────────────────────────

export async function issueCredential(
  input: IssueCredentialInput,
): Promise<CredentialView & { tx_id: string }> {
  const log = logger.child({
    service: 'credential',
    op: 'issue',
    clientId: input.clientId,
  });

  // Issuer must be a managed account belonging to this client.
  const issuerAccount = await resolveOwnedAccount(input.clientId, input.issuerAddress);
  if (!issuerAccount) {
    throw new CredentialServiceError('not_managed', 'Issuer address is not a managed account');
  }

  const txJson = buildCredentialCreate({
    account: input.issuerAddress,
    subject: input.subjectAddress,
    credentialType: input.credentialType,
    expiration: input.expiration,
    uri: input.uri,
  });

  let credentialId: string;
  let txId: string;
  try {
    const result = await db.transaction(async (tx) => {
      const txInserted = await tx
        .insert(schema.transactions)
        .values({
          clientId: input.clientId,
          txType: 'CredentialCreate',
          sourceAddress: input.issuerAddress,
          status: 'queued',
          requestBody: {
            op: 'issueCredential',
            issuer: input.issuerAddress,
            subject: input.subjectAddress,
            credentialType: input.credentialType,
          },
        })
        .returning({ id: schema.transactions.id });
      const txRow = txInserted[0];
      if (!txRow)
        throw new CredentialServiceError('db_conflict', 'transactions insert returned no row');

      const credInserted = await tx
        .insert(schema.credentials)
        .values({
          clientId: input.clientId,
          issuerAddress: input.issuerAddress,
          subjectAddress: input.subjectAddress,
          credentialType: input.credentialType.toUpperCase(),
          status: 'pending',
          expiresAt: input.expiration ? new Date(input.expiration * 1000) : null,
          metadata: input.metadata ?? {},
        })
        .returning({ id: schema.credentials.id });
      const credRow = credInserted[0];
      if (!credRow)
        throw new CredentialServiceError('db_conflict', 'credentials insert returned no row');

      return { credentialId: credRow.id, txId: txRow.id };
    });
    credentialId = result.credentialId;
    txId = result.txId;
  } catch (err) {
    if (err instanceof CredentialServiceError) throw err;
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new CredentialServiceError('db_conflict', 'Credential already exists (retry)');
    }
    throw err;
  }

  try {
    await enqueueTxSubmit({ txId, sourceAddress: input.issuerAddress, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed after DB commit');
    throw new CredentialServiceError('enqueue_failed', 'Failed to enqueue credential creation');
  }

  log.info({ credentialId, txId }, 'credential issuance enqueued');

  return {
    id: credentialId,
    issuer_address: input.issuerAddress,
    subject_address: input.subjectAddress,
    credential_type: input.credentialType.toUpperCase(),
    status: 'pending',
    expires_at: input.expiration ? new Date(input.expiration * 1000) : null,
    accepted_at: null,
    ledger_index: null,
    metadata: input.metadata ?? {},
    created_at: new Date(),
    tx_id: txId,
  };
}

// ── Accept ──────────────────────────────────────────────────────────────────

export interface AcceptCredentialInput {
  clientId: string;
  credentialId: string;
  subjectAddress: string;
}

export async function acceptCredential(input: AcceptCredentialInput): Promise<{ tx_id: string }> {
  const log = logger.child({
    service: 'credential',
    op: 'accept',
    clientId: input.clientId,
  });

  // Credential must exist and belong to this client.
  const rows = await db
    .select({
      id: schema.credentials.id,
      issuerAddress: schema.credentials.issuerAddress,
      subjectAddress: schema.credentials.subjectAddress,
      credentialType: schema.credentials.credentialType,
      status: schema.credentials.status,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.id, input.credentialId),
        eq(schema.credentials.clientId, input.clientId),
      ),
    )
    .limit(1);

  const cred = rows[0];
  if (!cred) throw new CredentialServiceError('not_found', 'Credential not found');
  if (cred.status !== 'pending') {
    throw new CredentialServiceError(
      'already_accepted',
      `Credential is ${cred.status}, not pending`,
    );
  }

  // Subject address from the request must match the credential's subject.
  if (cred.subjectAddress !== input.subjectAddress) {
    throw new CredentialServiceError('invalid_input', 'subject_address does not match credential');
  }

  // Subject must be a managed account.
  const subjectAccount = await resolveOwnedAccount(input.clientId, cred.subjectAddress);
  if (!subjectAccount) {
    throw new CredentialServiceError('not_managed', 'Subject address is not a managed account');
  }

  const txJson = buildCredentialAccept({
    account: cred.subjectAddress,
    issuer: cred.issuerAddress,
    credentialType: cred.credentialType,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'CredentialAccept',
      sourceAddress: cred.subjectAddress,
      status: 'queued',
      requestBody: {
        op: 'acceptCredential',
        credentialId: input.credentialId,
        subject: cred.subjectAddress,
        issuer: cred.issuerAddress,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  try {
    await enqueueTxSubmit({ txId, sourceAddress: cred.subjectAddress, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new CredentialServiceError('enqueue_failed', 'Failed to enqueue credential acceptance');
  }

  log.info({ credentialId: input.credentialId, txId }, 'credential acceptance enqueued');
  return { tx_id: txId };
}

// ── Revoke ──────────────────────────────────────────────────────────────────

export interface RevokeCredentialInput {
  clientId: string;
  credentialId: string;
}

export async function revokeCredential(input: RevokeCredentialInput): Promise<{ tx_id: string }> {
  const log = logger.child({
    service: 'credential',
    op: 'revoke',
    clientId: input.clientId,
  });

  const rows = await db
    .select({
      id: schema.credentials.id,
      issuerAddress: schema.credentials.issuerAddress,
      subjectAddress: schema.credentials.subjectAddress,
      credentialType: schema.credentials.credentialType,
      status: schema.credentials.status,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.id, input.credentialId),
        eq(schema.credentials.clientId, input.clientId),
      ),
    )
    .limit(1);

  const cred = rows[0];
  if (!cred) throw new CredentialServiceError('not_found', 'Credential not found');

  // The issuer deletes: Account=issuer, Subject=subject.
  // We default to issuer-initiated delete since the issuer is the managed account.
  const issuerAccount = await resolveOwnedAccount(input.clientId, cred.issuerAddress);
  const sourceAddress = issuerAccount ? cred.issuerAddress : cred.subjectAddress;

  // At least one of issuer/subject must be managed.
  if (!issuerAccount) {
    const subjectAccount = await resolveOwnedAccount(input.clientId, cred.subjectAddress);
    if (!subjectAccount) {
      throw new CredentialServiceError(
        'not_managed',
        'Neither issuer nor subject is a managed account',
      );
    }
  }

  const txJson = buildCredentialDelete({
    account: sourceAddress,
    credentialType: cred.credentialType,
    subject: sourceAddress === cred.issuerAddress ? cred.subjectAddress : undefined,
    issuer: sourceAddress === cred.subjectAddress ? cred.issuerAddress : undefined,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'CredentialDelete',
      sourceAddress,
      status: 'queued',
      requestBody: {
        op: 'revokeCredential',
        credentialId: input.credentialId,
        issuer: cred.issuerAddress,
        subject: cred.subjectAddress,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  try {
    await enqueueTxSubmit({ txId, sourceAddress, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new CredentialServiceError('enqueue_failed', 'Failed to enqueue credential deletion');
  }

  log.info({ credentialId: input.credentialId, txId }, 'credential revocation enqueued');
  return { tx_id: txId };
}

// ── Get ─────────────────────────────────────────────────────────────────────

export async function getCredential(
  clientId: string,
  credentialId: string,
): Promise<CredentialView | null> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      issuerAddress: schema.credentials.issuerAddress,
      subjectAddress: schema.credentials.subjectAddress,
      credentialType: schema.credentials.credentialType,
      status: schema.credentials.status,
      expiresAt: schema.credentials.expiresAt,
      acceptedAt: schema.credentials.acceptedAt,
      ledgerIndex: schema.credentials.ledgerIndex,
      metadata: schema.credentials.metadata,
      createdAt: schema.credentials.createdAt,
    })
    .from(schema.credentials)
    .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.clientId, clientId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return toView(row);
}

// ── Verify ──────────────────────────────────────────────────────────────────

export interface VerifyCredentialInput {
  clientId: string;
  subjectAddress: string;
  issuerAddress: string;
  credentialType: string;
}

export async function verifyCredential(
  input: VerifyCredentialInput,
): Promise<{ valid: boolean; credential: CredentialView | null }> {
  const now = new Date();
  const rows = await db
    .select({
      id: schema.credentials.id,
      issuerAddress: schema.credentials.issuerAddress,
      subjectAddress: schema.credentials.subjectAddress,
      credentialType: schema.credentials.credentialType,
      status: schema.credentials.status,
      expiresAt: schema.credentials.expiresAt,
      acceptedAt: schema.credentials.acceptedAt,
      ledgerIndex: schema.credentials.ledgerIndex,
      metadata: schema.credentials.metadata,
      createdAt: schema.credentials.createdAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.clientId, input.clientId),
        eq(schema.credentials.subjectAddress, input.subjectAddress),
        eq(schema.credentials.issuerAddress, input.issuerAddress),
        eq(schema.credentials.credentialType, input.credentialType.toUpperCase()),
        eq(schema.credentials.status, 'accepted'),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { valid: false, credential: null };

  // Check expiration.
  if (row.expiresAt && row.expiresAt <= now) {
    return { valid: false, credential: toView(row) };
  }

  return { valid: true, credential: toView(row) };
}

// ── List issuers ────────────────────────────────────────────────────────────

export interface IssuerView {
  id: string;
  name: string;
  address: string;
  provider: string;
  types: string[];
}

export async function listIssuers(): Promise<IssuerView[]> {
  const rows = await db
    .select({
      id: schema.credentialIssuers.id,
      name: schema.credentialIssuers.name,
      address: schema.credentialIssuers.address,
      provider: schema.credentialIssuers.provider,
      types: schema.credentialIssuers.types,
    })
    .from(schema.credentialIssuers)
    .where(eq(schema.credentialIssuers.isActive, true));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    provider: r.provider,
    types: r.types ?? [],
  }));
}

// ── List expiring credentials (for worker job) ─────────────────────────────

export async function findExpiringCredentials(horizonDate: Date): Promise<
  Array<{
    id: string;
    clientId: string;
    subjectAddress: string;
    issuerAddress: string;
    credentialType: string;
    expiresAt: Date;
  }>
> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      clientId: schema.credentials.clientId,
      subjectAddress: schema.credentials.subjectAddress,
      issuerAddress: schema.credentials.issuerAddress,
      credentialType: schema.credentials.credentialType,
      expiresAt: schema.credentials.expiresAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.status, 'accepted'),
        lte(schema.credentials.expiresAt, horizonDate),
      ),
    );

  return rows.filter((r): r is typeof r & { expiresAt: Date } => r.expiresAt !== null);
}
