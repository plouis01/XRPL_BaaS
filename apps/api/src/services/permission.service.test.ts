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
          return Promise.resolve(dbSelectResults.delegations);
        }
        if (table.__name === 'audit_log') {
          return Promise.resolve(dbSelectResults.auditLog);
        }
        return { limit: vi.fn(async () => []) };
      }),
    })),
  }));

  const update = vi.fn(() => ({
    set: vi.fn((vals: unknown) => ({
      where: vi.fn(async () => {
        dbUpdateCalls.push(vals);
        return [];
      }),
    })),
  }));

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ insert, select });
  });

  return {
    db: { insert, select, update, transaction },
    schema: {
      accounts: { __name: 'accounts' },
      transactions: { __name: 'transactions' },
      delegations: { __name: 'delegations' },
      auditLog: { __name: 'audit_log' },
    },
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
    like: vi.fn(),
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
  });

  // ── revoke ────────────────────────────────────────────────────────────

  describe('revokePermission', () => {
    it('enqueues a SignerListSet removal and soft-revokes delegation', async () => {
      dbSelectResults.delegations = [
        {
          id: 'deleg-1',
          delegateAddress: 'rDelegate',
          permissions: ['Payment'],
          status: 'active',
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
  });
});
