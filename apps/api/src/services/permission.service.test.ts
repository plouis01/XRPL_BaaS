// Unit tests for permission.service.ts (Sprint 6 — XLS-75 multi-sign fallback).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
const dbSelectResults: {
  accounts: unknown[];
  delegations: unknown[];
  auditLog: unknown[];
} = {
  accounts: [],
  delegations: [],
  auditLog: [],
};
const dbUpdateCalls: Array<unknown> = [];
const likeSpy = vi.fn();

// REVIEW D3: when grantPermission is called with `agentId`, it issues
// `UPDATE agents SET delegation_id = ... WHERE ... RETURNING { id }`
// inside the same tx. The mock controls what that returning clause
// resolves to: a non-empty list means "row matched and was linked"; an
// empty list triggers the cross-tenant guard which rolls the tx back.
let agentLinkReturning: Array<{ id: string }> = [{ id: 'agent-1' }];

vi.mock('@railforge/db', () => {
  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        if (table.__name === 'transactions') return [{ id: 'tx-uuid-1' }];
        if (table.__name === 'delegations') return [{ id: 'deleg-uuid-1' }];
        return [];
      }),
    })),
  }));

  const select = vi.fn(() => ({
    from: vi.fn((table: { __name: string }) => ({
      where: vi.fn(() => {
        if (table.__name === 'accounts') {
          return { limit: vi.fn(async () => dbSelectResults.accounts) };
        }
        if (table.__name === 'delegations') {
          // Support both plain `.where(...)` (listDelegations / siblings
          // query) AND `.where(...).for('update').limit(1)` (revokePermission
          // FOR UPDATE lock) in the same builder.
          const awaitable = Object.assign(Promise.resolve(dbSelectResults.delegations), {
            // biome-ignore lint/suspicious/noExplicitAny: self-referencing fluent mock
            for: vi.fn((_mode: string): any => ({
              limit: vi.fn(async () => dbSelectResults.delegations),
            })),
          });
          return awaitable;
        }
        if (table.__name === 'audit_log') {
          return Promise.resolve(dbSelectResults.auditLog);
        }
        return { limit: vi.fn(async () => []) };
      }),
    })),
  }));

  // The where(...) leaf supports two shapes:
  //   1. `await update().set().where()`               → resolves to []
  //   2. `await update().set().where().returning()`   → resolves to
  //      `agentLinkReturning` (REVIEW D3)
  // Pre-fix tests (revokePermission staging UPDATE) use shape (1); the new
  // grantPermission(agentId) path uses shape (2). One thenable that also
  // exposes .returning() satisfies both.
  const update = vi.fn(() => ({
    set: vi.fn((vals: unknown) => ({
      where: vi.fn(() => {
        dbUpdateCalls.push(vals);
        const p = Promise.resolve([]);
        return Object.assign(p, {
          returning: vi.fn(async () => agentLinkReturning),
        });
      }),
    })),
  }));

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ insert, select, update });
  });

  return {
    db: { insert, select, update, transaction },
    schema: {
      accounts: { __name: 'accounts' },
      transactions: { __name: 'transactions' },
      delegations: { __name: 'delegations' },
      auditLog: { __name: 'audit_log' },
      // REVIEW D3: grantPermission(agentId) issues an UPDATE on agents
      // inside its tx. The mock only needs the table marker + the columns
      // referenced in the WHERE/RETURNING clauses; the eq/and helpers are
      // already vi.fn stubs.
      agents: { __name: 'agents', id: {}, clientId: {} },
    },
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
    like: likeSpy,
  };
});

vi.mock('@railforge/jobs', () => ({
  enqueueTxSubmit: vi.fn(async () => {}),
}));

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { grantPermission, revokePermission, listDelegations, getDelegationAudit } = await import(
  './permission.service.ts'
);

describe('PermissionService', () => {
  beforeEach(() => {
    dbInsertCalls.length = 0;
    dbUpdateCalls.length = 0;
    // REVIEW D3: default the agents-link UPDATE returning to a single row
    // (the happy path). Tests that exercise the cross-tenant / missing-
    // agent rollback override this to [].
    agentLinkReturning = [{ id: 'agent-1' }];
    dbSelectResults.accounts = [{ id: 'acct-1', address: 'rDelegator' }];
    dbSelectResults.delegations = [];
    dbSelectResults.auditLog = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── grant ─────────────────────────────────────────────────────────────

  describe('grantPermission', () => {
    it('enqueues a SignerListSet tx and inserts delegation', async () => {
      const result = await grantPermission({
        clientId: 'client-1',
        delegatorAddress: 'rDelegator',
        delegateAddress: 'rDelegate',
        permissions: ['Payment', 'TrustSet'],
        weight: 1,
      });
      expect(result.tx_id).toBe('tx-uuid-1');
      expect(result.id).toBe('deleg-uuid-1');
      expect(result.status).toBe('active');
      expect(result.permissions).toEqual(['Payment', 'TrustSet']);
      const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
      expect(txInsert?.values).toMatchObject({ txType: 'SignerListSet' });
    });

    it('throws not_managed for unknown delegator', async () => {
      dbSelectResults.accounts = [];
      await expect(
        grantPermission({
          clientId: 'client-1',
          delegatorAddress: 'rUnknown',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          weight: 1,
        }),
      ).rejects.toThrow(/not a managed account/);
    });

    it('throws invalid_input for self-delegation', async () => {
      await expect(
        grantPermission({
          clientId: 'client-1',
          delegatorAddress: 'rDelegator',
          delegateAddress: 'rDelegator',
          permissions: ['Payment'],
          weight: 1,
        }),
      ).rejects.toThrow(/Cannot delegate to self/);
    });

    it('throws already_exists for duplicate delegation', async () => {
      dbSelectResults.delegations = [
        {
          id: 'existing-1',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          status: 'active',
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
      await expect(
        grantPermission({
          clientId: 'client-1',
          delegatorAddress: 'rDelegator',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          weight: 1,
        }),
      ).rejects.toThrow(/already exists/);
    });

    // REVIEW D3: agentId is the linkage knob the agent launcher uses.
    // Without these, the `delegation_id` back-fill on agents could end
    // up running outside the grant transaction (the bug we just closed)
    // or could silently link a cross-tenant agent.

    it('REVIEW D3: writes agents.delegation_id inside the grant transaction when agentId is provided', async () => {
      const result = await grantPermission({
        clientId: 'client-1',
        delegatorAddress: 'rDelegator',
        delegateAddress: 'rDelegate',
        permissions: ['Payment'],
        weight: 1,
        agentId: 'agent-1',
      });
      expect(result.id).toBe('deleg-uuid-1');
      // The UPDATE was issued as part of the grant tx — the mock pushes
      // every set() vals into dbUpdateCalls. Find the agents-link write.
      const agentLink = dbUpdateCalls.find(
        (u) => (u as { delegationId?: string }).delegationId === 'deleg-uuid-1',
      );
      expect(agentLink).toBeDefined();
    });

    it('REVIEW D3: standalone grant (no agentId) does NOT touch agents', async () => {
      await grantPermission({
        clientId: 'client-1',
        delegatorAddress: 'rDelegator',
        delegateAddress: 'rDelegate',
        permissions: ['Payment'],
        weight: 1,
      });
      // No update at all is the strongest assertion — non-agent grants
      // must never read or write the agents table.
      expect(dbUpdateCalls).toHaveLength(0);
    });

    it('REVIEW D3: rolls the grant back when the agent UUID is missing or cross-tenant', async () => {
      // Force the agents-link UPDATE to match zero rows (simulates an
      // agent UUID that doesn't exist for this clientId — the cross-tenant
      // guard in permission.service.ts must surface as db_conflict and
      // roll the whole tx back so no orphan delegation is committed.
      agentLinkReturning = [];
      await expect(
        grantPermission({
          clientId: 'client-1',
          delegatorAddress: 'rDelegator',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          weight: 1,
          agentId: 'agent-bogus',
        }),
      ).rejects.toThrow(/Failed to link delegation to agent/);
    });
  });

  // ── revoke ────────────────────────────────────────────────────────────

  describe('revokePermission', () => {
    it('stages pending_revocation=true instead of status=revoked (REVIEW.md C-1)', async () => {
      dbSelectResults.delegations = [
        {
          id: 'deleg-1',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          weight: 1,
          status: 'active',
          pendingRevocation: false,
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
      const result = await revokePermission({
        clientId: 'client-1',
        delegatorAddress: 'rDelegator',
        delegateAddress: 'rDelegate',
      });
      expect(result.tx_id).toBe('tx-uuid-1');
      expect(dbUpdateCalls.length).toBe(1);
      // CRITICAL: must stage pendingRevocation, NOT flip status to 'revoked'.
      // A failed on-chain tx with status='revoked' would leave the DB
      // claiming revoked while the delegate still held signing authority.
      expect(dbUpdateCalls[0]).toEqual({ pendingRevocation: true });
    });

    it('threads delegationId into requestBody for the txConfirmer hook', async () => {
      dbSelectResults.delegations = [
        {
          id: 'deleg-abc',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          weight: 1,
          status: 'active',
          pendingRevocation: false,
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
      await revokePermission({
        clientId: 'client-1',
        delegatorAddress: 'rDelegator',
        delegateAddress: 'rDelegate',
      });
      const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
      const body = (txInsert?.values as { requestBody: Record<string, unknown> })?.requestBody;
      expect(body?.op).toBe('revokePermission');
      expect(body?.delegationId).toBe('deleg-abc');
    });

    it('rejects when delegation already has pendingRevocation=true', async () => {
      dbSelectResults.delegations = [
        {
          id: 'deleg-1',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          weight: 1,
          status: 'active',
          pendingRevocation: true,
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
      await expect(
        revokePermission({
          clientId: 'client-1',
          delegatorAddress: 'rDelegator',
          delegateAddress: 'rDelegate',
        }),
      ).rejects.toThrow(/pending revocation/);
    });

    it('throws not_found when delegation does not exist', async () => {
      dbSelectResults.delegations = [];
      await expect(
        revokePermission({
          clientId: 'client-1',
          delegatorAddress: 'rDelegator',
          delegateAddress: 'rNobody',
        }),
      ).rejects.toThrow(/No active delegation/);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe('listDelegations', () => {
    it('returns active delegations', async () => {
      dbSelectResults.delegations = [
        {
          id: 'deleg-1',
          delegateAddress: 'rDel1',
          permissions: ['Payment'],
          status: 'active',
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
      const result = await listDelegations('client-1', 'rDelegator');
      expect(result).toHaveLength(1);
      expect(result[0]!.delegate_address).toBe('rDel1');
    });
  });

  // ── audit ─────────────────────────────────────────────────────────────

  describe('getDelegationAudit', () => {
    it('returns audit entries mapped from DB rows', async () => {
      // Filtering now happens in SQL (LIKE clauses). The mock simulates
      // the DB returning only matching rows.
      dbSelectResults.auditLog = [
        {
          id: 'audit-2',
          method: 'DELETE',
          path: '/v1/permissions/rDelegator/rDelegate',
          statusCode: 202,
          ip: '127.0.0.1',
          createdAt: new Date(),
        },
      ];
      const result = await getDelegationAudit('client-1', 'rDelegator');
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toContain('rDelegator');
      expect(result[0]!.status_code).toBe(202);
    });

    // REVIEW.md M-6: LIKE pattern interpolation must escape `%` and `_`.
    // The XRPL address regex at the validator layer already blocks these,
    // but escaping is defense-in-depth against future callers.
    it('escapes LIKE metacharacters in the delegatorAddress pattern (REVIEW.md M-6)', async () => {
      likeSpy.mockClear();
      dbSelectResults.auditLog = [];
      // Pass a raw string containing both metacharacters — bypassing
      // the route-level regex. The service MUST still escape them
      // before interpolation.
      await getDelegationAudit('client-1', 'r%Admin_X');

      // The audit helper calls like() twice: once for '%/permissions%'
      // (a static pattern) and once for the delegator pattern. Find
      // the delegator call by the 'Admin'-containing argument.
      const delegatorCall = likeSpy.mock.calls.find(
        (args) => typeof args[1] === 'string' && args[1].includes('Admin'),
      );
      expect(delegatorCall).toBeDefined();
      const pattern = delegatorCall?.[1] as string;
      // Both metacharacters in the input should be backslash-escaped.
      // Outer `%` wrappers stay bare — they're the wildcards we DO want.
      expect(pattern).toBe('%r\\%Admin\\_X%');
    });
  });
});
