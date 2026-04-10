// Domain service — XLS-80 Permissioned Domains.
//
// A permissioned domain defines which credential types are required to
// participate. Up to 10 accepted credentials per domain (protocol limit).
//
// Operations:
//   create — PermissionedDomainSet (no DomainID → creates new)
//   update — PermissionedDomainSet (with DomainID → updates credentials list)
//   delete — PermissionedDomainDelete (soft-deletes locally + on-chain)
//   checkMembership — does the subject hold a qualifying credential?
//   listMembers — all subjects with qualifying credentials

import { and, db, eq, isNull, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import { buildPermissionedDomainDelete, buildPermissionedDomainSet } from '@railforge/xrpl-core';
import { logger } from '../logger.ts';

export class DomainServiceError extends Error {
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
    this.name = 'DomainServiceError';
  }
}

export interface AcceptedCredentialEntry {
  issuer: string;
  credential_type: string;
}

export interface DomainView {
  id: string;
  owner_address: string;
  domain_id: string;
  accepted_credentials: AcceptedCredentialEntry[];
  created_at: Date | null;
  updated_at: Date | null;
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

async function resolveOwnedDomain(
  clientId: string,
  domainDbId: string,
): Promise<{
  id: string;
  ownerAddress: string;
  domainId: string;
  acceptedCredentials: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: schema.domains.id,
      ownerAddress: schema.domains.ownerAddress,
      domainId: schema.domains.domainId,
      acceptedCredentials: schema.domains.acceptedCredentials,
      createdAt: schema.domains.createdAt,
      updatedAt: schema.domains.updatedAt,
    })
    .from(schema.domains)
    .where(
      and(
        eq(schema.domains.id, domainDbId),
        eq(schema.domains.clientId, clientId),
        isNull(schema.domains.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function toView(row: {
  id: string;
  ownerAddress: string;
  domainId: string;
  acceptedCredentials: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
}): DomainView {
  return {
    id: row.id,
    owner_address: row.ownerAddress,
    domain_id: row.domainId,
    accepted_credentials: (row.acceptedCredentials as AcceptedCredentialEntry[]) ?? [],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ── Get ─────────────────────────────────────────────────────────────────────

export async function getDomain(clientId: string, domainDbId: string): Promise<DomainView | null> {
  const row = await resolveOwnedDomain(clientId, domainDbId);
  if (!row) return null;
  return toView(row);
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateDomainInput {
  clientId: string;
  ownerAddress: string;
  acceptedCredentials: AcceptedCredentialEntry[];
}

export async function createDomain(
  input: CreateDomainInput,
): Promise<DomainView & { tx_id: string }> {
  const log = logger.child({
    service: 'domain',
    op: 'create',
    clientId: input.clientId,
  });

  const ownerAccount = await resolveOwnedAccount(input.clientId, input.ownerAddress);
  if (!ownerAccount) {
    throw new DomainServiceError('not_managed', 'Owner address is not a managed account');
  }

  // Normalize credential types to uppercase before storage so DB matches
  // on-chain state (builders also uppercase) and comparisons don't need
  // runtime toUpperCase() calls.
  const normalizedCreds = input.acceptedCredentials.map((c) => ({
    ...c,
    credential_type: c.credential_type.toUpperCase(),
  }));

  const txJson = buildPermissionedDomainSet({
    account: input.ownerAddress,
    acceptedCredentials: normalizedCreds.map((c) => ({
      issuer: c.issuer,
      credentialType: c.credential_type,
    })),
  });

  // We don't know the on-chain DomainID until the tx validates, so we use
  // a placeholder. The txConfirmer will update domain_id from the tx metadata.
  const placeholderDomainId = `pending-${crypto.randomUUID()}`;

  let domainDbId: string;
  let txId: string;
  try {
    const result = await db.transaction(async (tx) => {
      const txInserted = await tx
        .insert(schema.transactions)
        .values({
          clientId: input.clientId,
          txType: 'PermissionedDomainSet',
          sourceAddress: input.ownerAddress,
          status: 'queued',
          requestBody: {
            op: 'createDomain',
            owner: input.ownerAddress,
            credentialCount: input.acceptedCredentials.length,
          },
        })
        .returning({ id: schema.transactions.id });
      const txRow = txInserted[0];
      if (!txRow)
        throw new DomainServiceError('db_conflict', 'transactions insert returned no row');

      const domainInserted = await tx
        .insert(schema.domains)
        .values({
          clientId: input.clientId,
          ownerAddress: input.ownerAddress,
          domainId: placeholderDomainId,
          acceptedCredentials: normalizedCreds,
        })
        .returning({ id: schema.domains.id });
      const domainRow = domainInserted[0];
      if (!domainRow) throw new DomainServiceError('db_conflict', 'domains insert returned no row');

      return { domainDbId: domainRow.id, txId: txRow.id };
    });
    domainDbId = result.domainDbId;
    txId = result.txId;
  } catch (err) {
    if (err instanceof DomainServiceError) throw err;
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new DomainServiceError('db_conflict', 'Domain already exists (retry)');
    }
    throw err;
  }

  try {
    await enqueueTxSubmit({ txId, sourceAddress: input.ownerAddress, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed after DB commit');
    throw new DomainServiceError('enqueue_failed', 'Failed to enqueue domain creation');
  }

  log.info({ domainDbId, txId }, 'domain creation enqueued');

  return {
    id: domainDbId,
    owner_address: input.ownerAddress,
    domain_id: placeholderDomainId,
    accepted_credentials: normalizedCreds,
    created_at: new Date(),
    updated_at: new Date(),
    tx_id: txId,
  };
}

// ── Update ──────────────────────────────────────────────────────────────────

export interface UpdateDomainInput {
  clientId: string;
  domainDbId: string;
  acceptedCredentials: AcceptedCredentialEntry[];
}

export async function updateDomain(
  input: UpdateDomainInput,
): Promise<DomainView & { tx_id: string }> {
  const log = logger.child({
    service: 'domain',
    op: 'update',
    clientId: input.clientId,
  });

  const domain = await resolveOwnedDomain(input.clientId, input.domainDbId);
  if (!domain) throw new DomainServiceError('not_found', 'Domain not found');

  // Domain must have a real on-chain ID (not a pending placeholder).
  if (domain.domainId.startsWith('pending-')) {
    throw new DomainServiceError(
      'invalid_input',
      'Domain creation is still pending — wait for on-chain confirmation',
    );
  }

  const normalizedCreds = input.acceptedCredentials.map((c) => ({
    ...c,
    credential_type: c.credential_type.toUpperCase(),
  }));

  const txJson = buildPermissionedDomainSet({
    account: domain.ownerAddress,
    domainId: domain.domainId,
    acceptedCredentials: normalizedCreds.map((c) => ({
      issuer: c.issuer,
      credentialType: c.credential_type,
    })),
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'PermissionedDomainSet',
      sourceAddress: domain.ownerAddress,
      status: 'queued',
      requestBody: {
        op: 'updateDomain',
        domainId: domain.domainId,
        credentialCount: input.acceptedCredentials.length,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  // Update the local record optimistically.
  await db
    .update(schema.domains)
    .set({
      acceptedCredentials: normalizedCreds,
      updatedAt: new Date(),
    })
    .where(eq(schema.domains.id, input.domainDbId));

  try {
    await enqueueTxSubmit({ txId, sourceAddress: domain.ownerAddress, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new DomainServiceError('enqueue_failed', 'Failed to enqueue domain update');
  }

  log.info({ domainDbId: input.domainDbId, txId }, 'domain update enqueued');

  return {
    id: domain.id,
    owner_address: domain.ownerAddress,
    domain_id: domain.domainId,
    accepted_credentials: normalizedCreds,
    created_at: domain.createdAt,
    updated_at: new Date(),
    tx_id: txId,
  };
}

// ── Delete ──────────────────────────────────────────────────────────────────

export interface DeleteDomainInput {
  clientId: string;
  domainDbId: string;
}

export async function deleteDomain(input: DeleteDomainInput): Promise<{ tx_id: string }> {
  const log = logger.child({
    service: 'domain',
    op: 'delete',
    clientId: input.clientId,
  });

  const domain = await resolveOwnedDomain(input.clientId, input.domainDbId);
  if (!domain) throw new DomainServiceError('not_found', 'Domain not found');

  if (domain.domainId.startsWith('pending-')) {
    throw new DomainServiceError(
      'invalid_input',
      'Domain creation is still pending — cannot delete',
    );
  }

  const txJson = buildPermissionedDomainDelete({
    account: domain.ownerAddress,
    domainId: domain.domainId,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'PermissionedDomainDelete',
      sourceAddress: domain.ownerAddress,
      status: 'queued',
      requestBody: {
        op: 'deleteDomain',
        domainId: domain.domainId,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new Error('transactions insert returned no row');

  // Soft-delete locally. The txConfirmer will confirm once on-chain.
  await db
    .update(schema.domains)
    .set({ deletedAt: new Date() })
    .where(eq(schema.domains.id, input.domainDbId));

  try {
    await enqueueTxSubmit({ txId, sourceAddress: domain.ownerAddress, txJson });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new DomainServiceError('enqueue_failed', 'Failed to enqueue domain deletion');
  }

  log.info({ domainDbId: input.domainDbId, txId }, 'domain deletion enqueued');
  return { tx_id: txId };
}

// ── Check membership ────────────────────────────────────────────────────────

export interface CheckMembershipInput {
  clientId: string;
  domainDbId: string;
  subjectAddress: string;
}

export async function checkMembership(
  input: CheckMembershipInput,
): Promise<{ is_member: boolean; matching_credentials: string[] }> {
  const domain = await resolveOwnedDomain(input.clientId, input.domainDbId);
  if (!domain) throw new DomainServiceError('not_found', 'Domain not found');

  const accepted = (domain.acceptedCredentials as AcceptedCredentialEntry[]) ?? [];
  if (accepted.length === 0) {
    return { is_member: false, matching_credentials: [] };
  }

  // Query credentials for the subject, scoped to this client.
  const creds = await db
    .select({
      id: schema.credentials.id,
      issuerAddress: schema.credentials.issuerAddress,
      credentialType: schema.credentials.credentialType,
      status: schema.credentials.status,
      expiresAt: schema.credentials.expiresAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.clientId, input.clientId),
        eq(schema.credentials.subjectAddress, input.subjectAddress),
        eq(schema.credentials.status, 'accepted'),
      ),
    );

  const now = new Date();
  const matchingIds: string[] = [];

  for (const entry of accepted) {
    const match = creds.find(
      (c) =>
        c.issuerAddress === entry.issuer &&
        c.credentialType === entry.credential_type &&
        (!c.expiresAt || c.expiresAt > now),
    );
    if (match) matchingIds.push(match.id);
  }

  return {
    is_member: matchingIds.length > 0,
    matching_credentials: matchingIds,
  };
}

// ── List members ────────────────────────────────────────────────────────────

export async function listMembers(
  clientId: string,
  domainDbId: string,
): Promise<{
  members: Array<{ subject_address: string; credential_ids: string[] }>;
}> {
  const domain = await resolveOwnedDomain(clientId, domainDbId);
  if (!domain) throw new DomainServiceError('not_found', 'Domain not found');

  const accepted = (domain.acceptedCredentials as AcceptedCredentialEntry[]) ?? [];
  if (accepted.length === 0) return { members: [] };

  // Fetch accepted credentials scoped to this client.
  const creds = await db
    .select({
      id: schema.credentials.id,
      subjectAddress: schema.credentials.subjectAddress,
      issuerAddress: schema.credentials.issuerAddress,
      credentialType: schema.credentials.credentialType,
      expiresAt: schema.credentials.expiresAt,
    })
    .from(schema.credentials)
    .where(
      and(eq(schema.credentials.clientId, clientId), eq(schema.credentials.status, 'accepted')),
    );

  const now = new Date();
  const memberMap = new Map<string, string[]>();

  for (const cred of creds) {
    if (cred.expiresAt && cred.expiresAt <= now) continue;
    const matches = accepted.some(
      (a) => a.issuer === cred.issuerAddress && a.credential_type === cred.credentialType,
    );
    if (matches) {
      const existing = memberMap.get(cred.subjectAddress) ?? [];
      existing.push(cred.id);
      memberMap.set(cred.subjectAddress, existing);
    }
  }

  return {
    members: Array.from(memberMap.entries()).map(([subject_address, credential_ids]) => ({
      subject_address,
      credential_ids,
    })),
  };
}
