// Permission service — XLS-75 Permission Delegation.
//
// Status: XLS-75 V1.1 is PENDING. This service uses the multi-sign
// fallback: each "delegate" is added as a signer on the delegator's
// signer list. The permissions array is recorded in the `delegations`
// table for auditing, but the on-chain enforcement is signer-weight
// based (not granular per-tx-type) until V1.1 activates.
//
// When V1.1 activates, swap the SignerListSet tx for DelegateSet.
//
// Operations:
//   grant  — add delegate to signer list + record in DB
//   revoke — remove delegate from signer list + soft-delete in DB
//   list   — list all active delegations for a delegator
//   audit  — query audit_log for delegation-related changes

import { and, db, eq, isNull, schema } from '@railforge/db';
import { enqueueTxSubmit } from '@railforge/jobs';
import { buildSignerListSet } from '@railforge/xrpl-core';
import { logger } from '../logger.ts';

export class PermissionServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'not_managed'
      | 'enqueue_failed'
      | 'db_conflict'
      | 'already_exists',
    message: string,
  ) {
    super(message);
    this.name = 'PermissionServiceError';
  }
}

export interface DelegationView {
  id: string;
  delegator_address: string;
  delegate_address: string;
  permissions: string[];
  status: string;
  created_at: Date | null;
  revoked_at: Date | null;
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

async function getActiveDelegations(
  clientId: string,
  delegatorAddress: string,
): Promise<
  Array<{
    id: string;
    delegateAddress: string;
    permissions: string[];
    weight: number;
    status: string;
    createdAt: Date | null;
    revokedAt: Date | null;
  }>
> {
  return db
    .select({
      id: schema.delegations.id,
      delegateAddress: schema.delegations.delegateAddress,
      permissions: schema.delegations.permissions,
      weight: schema.delegations.weight,
      status: schema.delegations.status,
      createdAt: schema.delegations.createdAt,
      revokedAt: schema.delegations.revokedAt,
    })
    .from(schema.delegations)
    .where(
      and(
        eq(schema.delegations.clientId, clientId),
        eq(schema.delegations.delegatorAddress, delegatorAddress),
        eq(schema.delegations.status, 'active'),
      ),
    );
}

function toView(
  delegatorAddress: string,
  row: {
    id: string;
    delegateAddress: string;
    permissions: string[];
    status: string;
    createdAt: Date | null;
    revokedAt: Date | null;
  },
): DelegationView {
  return {
    id: row.id,
    delegator_address: delegatorAddress,
    delegate_address: row.delegateAddress,
    permissions: row.permissions ?? [],
    status: row.status,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  };
}

// ── Grant ──────────────────────────────────────────────────────────────────

export interface GrantPermissionInput {
  clientId: string;
  delegatorAddress: string;
  delegateAddress: string;
  permissions: string[];
  weight: number;
}

export async function grantPermission(
  input: GrantPermissionInput,
): Promise<DelegationView & { tx_id: string }> {
  const log = logger.child({
    service: 'permission',
    op: 'grant',
    clientId: input.clientId,
  });

  const delegatorAccount = await resolveOwnedAccount(input.clientId, input.delegatorAddress);
  if (!delegatorAccount) {
    throw new PermissionServiceError('not_managed', 'Delegator address is not a managed account');
  }

  // Check for existing active delegation to the same delegate.
  const existing = await getActiveDelegations(input.clientId, input.delegatorAddress);
  const alreadyDelegated = existing.find((d) => d.delegateAddress === input.delegateAddress);
  if (alreadyDelegated) {
    throw new PermissionServiceError(
      'already_exists',
      'Delegation already exists for this delegate — revoke first, then re-grant',
    );
  }

  // Build a new signer list that includes all existing delegates + the new one.
  const signerEntries = existing.map((d) => ({
    address: d.delegateAddress,
    weight: d.weight,
  }));
  signerEntries.push({ address: input.delegateAddress, weight: input.weight });

  // Quorum = 1 (any single signer can authorize). This is the pre-V1.1
  // fallback — coarser than granular permission delegation.
  const txJson = buildSignerListSet({
    account: input.delegatorAddress,
    signerQuorum: 1,
    signerEntries,
  });

  let delegationId: string;
  let txId: string;
  try {
    const result = await db.transaction(async (tx) => {
      const txInserted = await tx
        .insert(schema.transactions)
        .values({
          clientId: input.clientId,
          txType: 'SignerListSet',
          sourceAddress: input.delegatorAddress,
          status: 'queued',
          requestBody: {
            op: 'grantPermission',
            delegator: input.delegatorAddress,
            delegate: input.delegateAddress,
            permissions: input.permissions,
          },
        })
        .returning({ id: schema.transactions.id });
      const txRow = txInserted[0];
      if (!txRow) {
        throw new PermissionServiceError('db_conflict', 'transactions insert returned no row');
      }

      const delegInserted = await tx
        .insert(schema.delegations)
        .values({
          clientId: input.clientId,
          delegatorAddress: input.delegatorAddress,
          delegateAddress: input.delegateAddress,
          permissions: input.permissions,
          weight: input.weight,
          status: 'active',
        })
        .returning({ id: schema.delegations.id });
      const delegRow = delegInserted[0];
      if (!delegRow) {
        throw new PermissionServiceError('db_conflict', 'delegations insert returned no row');
      }

      return { delegationId: delegRow.id, txId: txRow.id };
    });
    delegationId = result.delegationId;
    txId = result.txId;
  } catch (err) {
    if (err instanceof PermissionServiceError) throw err;
    throw err;
  }

  try {
    await enqueueTxSubmit({
      txId,
      sourceAddress: input.delegatorAddress,
      txJson,
    });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new PermissionServiceError('enqueue_failed', 'Failed to enqueue permission grant');
  }

  log.info({ delegationId, txId }, 'permission grant enqueued');

  return {
    id: delegationId,
    delegator_address: input.delegatorAddress,
    delegate_address: input.delegateAddress,
    permissions: input.permissions,
    status: 'active',
    created_at: new Date(),
    revoked_at: null,
    tx_id: txId,
  };
}

// ── Revoke ─────────────────────────────────────────────────────────────────

export interface RevokePermissionInput {
  clientId: string;
  delegatorAddress: string;
  delegateAddress: string;
}

export async function revokePermission(input: RevokePermissionInput): Promise<{ tx_id: string }> {
  const log = logger.child({
    service: 'permission',
    op: 'revoke',
    clientId: input.clientId,
  });

  const delegatorAccount = await resolveOwnedAccount(input.clientId, input.delegatorAddress);
  if (!delegatorAccount) {
    throw new PermissionServiceError('not_managed', 'Delegator address is not a managed account');
  }

  const existing = await getActiveDelegations(input.clientId, input.delegatorAddress);
  const delegation = existing.find((d) => d.delegateAddress === input.delegateAddress);
  if (!delegation) {
    throw new PermissionServiceError('not_found', 'No active delegation found for this delegate');
  }

  // Rebuild the signer list without the revoked delegate.
  const remainingSigners = existing
    .filter((d) => d.delegateAddress !== input.delegateAddress)
    .map((d) => ({ address: d.delegateAddress, weight: d.weight }));

  // If no signers remain, quorum=0 + empty list deletes the signer list.
  const txJson = buildSignerListSet({
    account: input.delegatorAddress,
    signerQuorum: remainingSigners.length > 0 ? 1 : 0,
    signerEntries: remainingSigners,
  });

  const txInserted = await db
    .insert(schema.transactions)
    .values({
      clientId: input.clientId,
      txType: 'SignerListSet',
      sourceAddress: input.delegatorAddress,
      status: 'queued',
      requestBody: {
        op: 'revokePermission',
        delegator: input.delegatorAddress,
        delegate: input.delegateAddress,
      },
    })
    .returning({ id: schema.transactions.id });
  const txId = txInserted[0]?.id;
  if (!txId) throw new PermissionServiceError('db_conflict', 'transactions insert returned no row');

  // Soft-revoke the delegation.
  await db
    .update(schema.delegations)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(schema.delegations.id, delegation.id));

  try {
    await enqueueTxSubmit({
      txId,
      sourceAddress: input.delegatorAddress,
      txJson,
    });
  } catch (err) {
    log.error({ err }, 'enqueueTxSubmit failed');
    throw new PermissionServiceError('enqueue_failed', 'Failed to enqueue permission revocation');
  }

  log.info({ delegationId: delegation.id, txId }, 'permission revocation enqueued');
  return { tx_id: txId };
}

// ── List ───────────────────────────────────────────────────────────────────

export async function listDelegations(
  clientId: string,
  delegatorAddress: string,
): Promise<DelegationView[]> {
  const delegatorAccount = await resolveOwnedAccount(clientId, delegatorAddress);
  if (!delegatorAccount) {
    throw new PermissionServiceError('not_managed', 'Delegator address is not a managed account');
  }

  const rows = await getActiveDelegations(clientId, delegatorAddress);
  return rows.map((r) => toView(delegatorAddress, r));
}

// ── Audit ──────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  method: string;
  path: string;
  status_code: number;
  ip: string | null;
  created_at: Date | null;
}

export async function getDelegationAudit(
  clientId: string,
  delegatorAddress: string,
): Promise<AuditEntry[]> {
  // Return audit log entries related to permission operations for this delegator.
  const rows = await db
    .select({
      id: schema.auditLog.id,
      method: schema.auditLog.method,
      path: schema.auditLog.path,
      statusCode: schema.auditLog.statusCode,
      ip: schema.auditLog.ip,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.clientId, clientId));

  // Filter to permission-related paths for this delegator.
  return rows
    .filter((r) => r.path.includes('/permissions') && r.path.includes(delegatorAddress))
    .map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status_code: r.statusCode,
      ip: r.ip,
      created_at: r.createdAt,
    }));
}
