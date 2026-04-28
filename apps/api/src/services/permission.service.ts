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

import { and, db, eq, isNull, like, schema } from '@railforge/db';
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
  /**
   * Optional signer-list quorum. REVIEW.md MED-05: previously hardcoded to 1
   * (any single delegate can authorize). That's the right default for a
   * single-delegate setup, but a tenant granting two delegates expecting
   * 2-of-2 coordination was silently getting either-one-solo-signs. The
   * caller now picks — clamped to [1, totalWeight] so "can't ever sign"
   * (quorum > sum) and "zero quorum" are both rejected at the service layer.
   */
  quorum?: number;
  idempotencyKey?: string;
  /**
   * REVIEW D3: when set, the freshly-inserted delegation's id is written
   * back to `agents.delegation_id` for this agent UUID inside the SAME
   * transaction that inserts the delegation row. Without this, the caller
   * had to issue a separate UPDATE after `grantPermission` returned — and
   * if that bare UPDATE failed, the agents row was orphaned with
   * delegation_id=NULL. The downstream effect was that
   * `applyDelegationRevocationOutcome` (which matches agents by
   * delegation_id) could never finalize the row, so a revoke would strip
   * on-ledger authority while leaving status='active' in the API forever.
   * The agents table is in `apps/api/src/services` orbit but the schema
   * is shared, so it's safe to write here. Only `provisionAgent` passes
   * this; standalone permission grants leave it undefined.
   */
  agentId?: string;
}

export async function grantPermission(
  input: GrantPermissionInput,
): Promise<DelegationView & { tx_id: string }> {
  const log = logger.child({
    service: 'permission',
    op: 'grant',
    clientId: input.clientId,
  });

  if (input.delegatorAddress === input.delegateAddress) {
    throw new PermissionServiceError('invalid_input', 'Cannot delegate to self');
  }

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

  // REVIEW.md MED-05: quorum is caller-selected with a safe default of 1
  // (preserves the pre-fix behavior for single-delegate setups). Reject
  // quorum > sum(weights) — the signer list would be unusable (no subset
  // of signers could ever authorize a tx). Reject quorum < 1 — XRPL itself
  // refuses a zero-quorum SignerListSet, but catching here gives a clearer
  // 400 than a tefEXCEPTION on submit.
  const totalWeight = signerEntries.reduce((sum, s) => sum + s.weight, 0);
  const signerQuorum = input.quorum ?? 1;
  if (signerQuorum < 1) {
    throw new PermissionServiceError('invalid_input', 'quorum must be at least 1');
  }
  if (signerQuorum > totalWeight) {
    throw new PermissionServiceError(
      'invalid_input',
      `quorum (${signerQuorum}) exceeds total signer weight (${totalWeight})`,
    );
  }

  const txJson = buildSignerListSet({
    account: input.delegatorAddress,
    signerQuorum,
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
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
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

      // REVIEW D3: atomic agents.delegation_id back-fill. The agents row
      // is scoped by clientId so this UPDATE can never link an agent
      // owned by another tenant. WHERE id=agentId AND clientId=clientId
      // matches at most one row; an empty result rolls the whole tx back
      // via the throw below so the delegations row is never committed
      // without its agents linkage. Replaces the bare post-tx UPDATE
      // that previously ran in agent.service.ts:provisionAgent — that
      // path could leave agents.delegation_id NULL on transient DB
      // failure, breaking applyDelegationRevocationOutcome's join.
      if (input.agentId) {
        const linked = await tx
          .update(schema.agents)
          .set({ delegationId: delegRow.id })
          .where(
            and(eq(schema.agents.id, input.agentId), eq(schema.agents.clientId, input.clientId)),
          )
          .returning({ id: schema.agents.id });
        if (linked.length === 0) {
          throw new PermissionServiceError(
            'db_conflict',
            'Failed to link delegation to agent (agent missing or cross-tenant)',
          );
        }
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
  idempotencyKey?: string;
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

  // REVIEW.md C-1 fix: wrap the delegation lookup, signer-list rebuild,
  // transactions insert, and staging UPDATE in a single db.transaction
  // with SELECT FOR UPDATE on the delegation row. The prior implementation
  // flipped status='revoked' before the on-chain tx even submitted, so a
  // failed SignerListSet would leave the DB saying "revoked" while the
  // delegate still held signing authority on-ledger.
  //
  // Staging contract (mirrors the #22 domain pattern):
  //   - This fn sets `pendingRevocation=true` (NOT status='revoked').
  //   - Rejects if pendingRevocation is already true — one revoke in flight
  //     at a time per delegation.
  //   - txConfirmer.applyDelegationRevocationOutcome() commits on tesSUCCESS
  //     (status='revoked', revokedAt=now, pendingRevocation=false) or
  //     clears the flag on failure/expiry (leaves status='active').
  let txId: string;
  let txJson: ReturnType<typeof buildSignerListSet>;
  try {
    const result = await db.transaction(async (tx) => {
      const lockedRows = await tx
        .select({
          id: schema.delegations.id,
          delegateAddress: schema.delegations.delegateAddress,
          permissions: schema.delegations.permissions,
          weight: schema.delegations.weight,
          status: schema.delegations.status,
          pendingRevocation: schema.delegations.pendingRevocation,
        })
        .from(schema.delegations)
        .where(
          and(
            eq(schema.delegations.clientId, input.clientId),
            eq(schema.delegations.delegatorAddress, input.delegatorAddress),
            eq(schema.delegations.delegateAddress, input.delegateAddress),
            eq(schema.delegations.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);

      const delegation = lockedRows[0];
      if (!delegation) {
        throw new PermissionServiceError(
          'not_found',
          'No active delegation found for this delegate',
        );
      }
      if (delegation.pendingRevocation) {
        throw new PermissionServiceError(
          'invalid_input',
          'Delegation has a pending revocation — wait for on-chain confirmation',
        );
      }

      // Load siblings for signer-list rebuild. Siblings stay active even
      // when the target is being revoked, so we query with the same
      // helper; we just exclude the target in the map below.
      const siblings = await getActiveDelegations(input.clientId, input.delegatorAddress);
      const remainingSigners = siblings
        .filter((d) => d.delegateAddress !== input.delegateAddress)
        .map((d) => ({ address: d.delegateAddress, weight: d.weight }));

      // If no signers remain, quorum=0 + empty list deletes the signer list.
      const builtTxJson = buildSignerListSet({
        account: input.delegatorAddress,
        signerQuorum: remainingSigners.length > 0 ? 1 : 0,
        signerEntries: remainingSigners,
      });

      const txInserted = await tx
        .insert(schema.transactions)
        .values({
          clientId: input.clientId,
          txType: 'SignerListSet',
          sourceAddress: input.delegatorAddress,
          status: 'queued',
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          requestBody: {
            op: 'revokePermission',
            delegationId: delegation.id,
            delegator: input.delegatorAddress,
            delegate: input.delegateAddress,
          },
        })
        .returning({ id: schema.transactions.id });
      const txRow = txInserted[0];
      if (!txRow) {
        throw new PermissionServiceError('db_conflict', 'transactions insert returned no row');
      }

      // Stage the revocation. Guarded by status='active' + pendingRevocation=false
      // so a race between this and the FOR UPDATE-released rollback can't
      // double-stage.
      await tx
        .update(schema.delegations)
        .set({ pendingRevocation: true })
        .where(eq(schema.delegations.id, delegation.id));

      return {
        txId: txRow.id,
        txJson: builtTxJson,
        delegationId: delegation.id,
      };
    });
    txId = result.txId;
    txJson = result.txJson;
  } catch (err) {
    if (err instanceof PermissionServiceError) throw err;
    // UNIQUE(client_id, idempotency_key) collision — same idempotency-key
    // replay. Surface as db_conflict (409), mirroring acceptCredential.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new PermissionServiceError('db_conflict', 'Duplicate idempotency key (retry)');
    }
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
    throw new PermissionServiceError('enqueue_failed', 'Failed to enqueue permission revocation');
  }

  log.info({ txId }, 'permission revocation enqueued');
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

/**
 * REVIEW.md M-6: escape LIKE metacharacters (`%` and `_`) in any string
 * interpolated into a LIKE pattern so `%` becomes a literal percent and
 * `_` becomes a literal underscore rather than wildcards. The backslash
 * itself is escaped first so we don't accidentally turn a trailing `\`
 * into an escape for the quote character.
 *
 * In this specific caller, `delegatorAddress` is already constrained by
 * the XRPL r-address regex (`^r[1-9A-HJ-NP-Za-km-z]{24,34}$`), which
 * excludes both metacharacters — so the concrete exploit path is closed
 * at the validator. This escape is defense-in-depth against future
 * callers reusing the helper with user-supplied strings.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export async function getDelegationAudit(
  clientId: string,
  delegatorAddress: string,
): Promise<AuditEntry[]> {
  // Return audit log entries related to permission operations for this delegator.
  // Push both filters into SQL to avoid loading the full audit_log table.
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
    .where(
      and(
        eq(schema.auditLog.clientId, clientId),
        like(schema.auditLog.path, '%/permissions%'),
        like(schema.auditLog.path, `%${escapeLikePattern(delegatorAddress)}%`),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    status_code: r.statusCode,
    ip: r.ip,
    created_at: r.createdAt,
  }));
}
