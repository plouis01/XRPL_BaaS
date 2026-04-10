// Unit tests for domain.service.ts (Sprint 5 — XLS-80 permissioned domains).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
const dbInsertResults: Record<string, unknown[]> = {
  transactions: [{ id: 'tx-uuid-1' }],
  domains: [{ id: 'dom-uuid-1' }],
};
const dbSelectResult = { current: [] as unknown[] };
const dbUpdateCalls: Array<unknown> = [];

vi.mock('@railforge/db', () => {
  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        return dbInsertResults[table.__name] ?? [];
      }),
    })),
  }));

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => dbSelectResult.current),
      })),
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
      domains: { __name: 'domains' },
      credentials: { __name: 'credentials' },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

// ── jobs mock ───────────────────────────────────────────────────────────────

const enqueueShouldThrow = { err: null as unknown };
const enqueueCalls: Array<unknown> = [];

vi.mock('@railforge/jobs', () => ({
  enqueueTxSubmit: vi.fn(async (data: unknown) => {
    enqueueCalls.push(data);
    if (enqueueShouldThrow.err) {
      const err = enqueueShouldThrow.err;
      enqueueShouldThrow.err = null;
      throw err;
    }
  }),
}));

vi.mock('@railforge/xrpl-core', () => ({
  buildPermissionedDomainSet: vi.fn(() => ({
    TransactionType: 'PermissionedDomainSet',
  })),
  buildPermissionedDomainDelete: vi.fn(() => ({
    TransactionType: 'PermissionedDomainDelete',
  })),
}));

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

// ── Tests ───────────────────────────────────────────────────────────────────

let mod: typeof import('./domain.service.ts');

beforeEach(async () => {
  vi.resetModules();
  dbInsertCalls.length = 0;
  dbUpdateCalls.length = 0;
  enqueueCalls.length = 0;
  dbSelectResult.current = [];
  dbInsertResults.transactions = [{ id: 'tx-uuid-1' }];
  dbInsertResults.domains = [{ id: 'dom-uuid-1' }];
  enqueueShouldThrow.err = null;
  mod = await import('./domain.service.ts');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDomain', () => {
  it('happy path: inserts tx + domain, enqueues', async () => {
    dbSelectResult.current = [{ id: 'acct-1', address: 'rOwner' }];

    const result = await mod.createDomain({
      clientId: 'c1',
      ownerAddress: 'rOwner',
      acceptedCredentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
    });

    expect(result.id).toBe('dom-uuid-1');
    expect(result.tx_id).toBe('tx-uuid-1');
    expect(result.owner_address).toBe('rOwner');
    expect(result.accepted_credentials).toHaveLength(1);
    expect(enqueueCalls).toHaveLength(1);
  });

  it('throws not_managed if owner is not managed', async () => {
    dbSelectResult.current = [];

    await expect(
      mod.createDomain({
        clientId: 'c1',
        ownerAddress: 'rUnknown',
        acceptedCredentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
      }),
    ).rejects.toThrow('Owner address is not a managed account');
  });

  it('throws enqueue_failed on Redis failure', async () => {
    dbSelectResult.current = [{ id: 'acct-1', address: 'rOwner' }];
    enqueueShouldThrow.err = new Error('Redis down');

    await expect(
      mod.createDomain({
        clientId: 'c1',
        ownerAddress: 'rOwner',
        acceptedCredentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
      }),
    ).rejects.toThrow('Failed to enqueue domain creation');
  });
});

describe('getDomain', () => {
  it('returns null when domain not found', async () => {
    dbSelectResult.current = [];
    const result = await mod.getDomain('c1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns a view when found', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'ABCDEF',
        acceptedCredentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const result = await mod.getDomain('c1', 'dom-1');
    expect(result).not.toBeNull();
    expect(result!.domain_id).toBe('ABCDEF');
    expect(result!.accepted_credentials).toHaveLength(1);
  });
});

describe('updateDomain', () => {
  it('throws not_found when domain does not exist', async () => {
    dbSelectResult.current = [];
    await expect(
      mod.updateDomain({
        clientId: 'c1',
        domainDbId: 'missing',
        acceptedCredentials: [{ issuer: 'rI', credential_type: '4B5943' }],
      }),
    ).rejects.toThrow('Domain not found');
  });

  it('throws invalid_input when domain is still pending', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'pending-abc',
        acceptedCredentials: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    await expect(
      mod.updateDomain({
        clientId: 'c1',
        domainDbId: 'dom-1',
        acceptedCredentials: [{ issuer: 'rI', credential_type: '4B5943' }],
      }),
    ).rejects.toThrow('still pending');
  });
});

describe('deleteDomain', () => {
  it('throws not_found when domain does not exist', async () => {
    dbSelectResult.current = [];
    await expect(mod.deleteDomain({ clientId: 'c1', domainDbId: 'missing' })).rejects.toThrow(
      'Domain not found',
    );
  });

  it('throws invalid_input when domain is pending', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'pending-xyz',
        acceptedCredentials: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    await expect(mod.deleteDomain({ clientId: 'c1', domainDbId: 'dom-1' })).rejects.toThrow(
      'cannot delete',
    );
  });
});
