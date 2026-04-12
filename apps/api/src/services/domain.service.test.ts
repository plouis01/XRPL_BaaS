// Unit tests for domain.service.ts (Sprint 5 — XLS-80 permissioned domains).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
const dbInsertResults: Record<string, unknown[]> = {
  transactions: [{ id: 'tx-uuid-1' }],
  domains: [{ id: 'dom-uuid-1' }],
};
const dbSelectResult = { current: [] as unknown[] };
// Table-keyed results so queries that scan different tables (e.g.
// listMembers: domains lookup → credentials scan) can be isolated.
const dbSelectResults: Record<string, unknown[]> = {};
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
    from: vi.fn((table: { __name?: string } = {}) => {
      const tableName = table.__name ?? '';
      const pick = () => dbSelectResults[tableName] ?? dbSelectResult.current;
      return {
        where: vi.fn(() => {
          // Fluent chain that supports both simple `.limit()` and
          // the full `.groupBy().orderBy().limit().offset()` used
          // by listMembers after the SQL-push refactor.
          const data = pick();
          // biome-ignore lint/suspicious/noExplicitAny: self-referencing fluent mock
          const awaitable: any = Object.assign(Promise.resolve(data), {
            limit: vi.fn(() => awaitable),
            offset: vi.fn(async () => data),
            groupBy: vi.fn(() => awaitable),
            orderBy: vi.fn(() => awaitable),
          });
          return awaitable;
        }),
      };
    }),
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
    or: vi.fn((...args: unknown[]) => ({ or: args })),
    gt: vi.fn((col: unknown, val: unknown) => ({ gt: [col, val] })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
    asc: vi.fn((col: unknown) => ({ asc: col })),
    sql: vi.fn((...args: unknown[]) => args),
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
  for (const k of Object.keys(dbSelectResults)) delete dbSelectResults[k];
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
        pendingAcceptedCredentials: null,
        pendingDeletion: false,
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

  // #22 fix: staging behavior.

  it('stages new credentials in pendingAcceptedCredentials instead of mutating committed column', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcdef1234567890',
        acceptedCredentials: [{ issuer: 'rOld', credential_type: '4F4C44' }],
        pendingAcceptedCredentials: null,
        pendingDeletion: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await mod.updateDomain({
      clientId: 'c1',
      domainDbId: 'dom-1',
      acceptedCredentials: [{ issuer: 'rNew', credential_type: '4E4557' }],
    });

    // The UPDATE payload must stage, not commit.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0] as Record<string, unknown>;
    expect(update.pendingAcceptedCredentials).toEqual([
      { issuer: 'rNew', credential_type: '4E4557' },
    ]);
    // Must NOT touch the committed column.
    expect(update.acceptedCredentials).toBeUndefined();
  });

  it('rejects updateDomain when a prior update is still staged', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcdef1234567890',
        acceptedCredentials: [{ issuer: 'rOld', credential_type: '4F4C44' }],
        pendingAcceptedCredentials: [{ issuer: 'rMid', credential_type: '4D4944' }],
        pendingDeletion: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await expect(
      mod.updateDomain({
        clientId: 'c1',
        domainDbId: 'dom-1',
        acceptedCredentials: [{ issuer: 'rNew', credential_type: '4E4557' }],
      }),
    ).rejects.toThrow('pending mutation');
  });

  it('rejects updateDomain when a delete is already staged', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcdef1234567890',
        acceptedCredentials: [],
        pendingAcceptedCredentials: null,
        pendingDeletion: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await expect(
      mod.updateDomain({
        clientId: 'c1',
        domainDbId: 'dom-1',
        acceptedCredentials: [{ issuer: 'rNew', credential_type: '4E4557' }],
      }),
    ).rejects.toThrow('pending mutation');
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
        pendingAcceptedCredentials: null,
        pendingDeletion: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    await expect(mod.deleteDomain({ clientId: 'c1', domainDbId: 'dom-1' })).rejects.toThrow(
      'cannot delete',
    );
  });

  // #22 fix: staging behavior.

  it('stages deletion in pendingDeletion instead of stamping deletedAt', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcdef1234567890',
        acceptedCredentials: [{ issuer: 'rIss', credential_type: '4B5943' }],
        pendingAcceptedCredentials: null,
        pendingDeletion: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await mod.deleteDomain({ clientId: 'c1', domainDbId: 'dom-1' });

    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0] as Record<string, unknown>;
    expect(update.pendingDeletion).toBe(true);
    // Must NOT stamp deletedAt eagerly — that happens only after on-chain
    // confirmation in txConfirmer.applyDomainMutationOutcome.
    expect(update.deletedAt).toBeUndefined();
  });

  it('rejects deleteDomain when a prior update is still staged', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcdef1234567890',
        acceptedCredentials: [],
        pendingAcceptedCredentials: [{ issuer: 'rMid', credential_type: '4D4944' }],
        pendingDeletion: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await expect(mod.deleteDomain({ clientId: 'c1', domainDbId: 'dom-1' })).rejects.toThrow(
      'pending mutation',
    );
  });

  it('rejects deleteDomain when a prior delete is already staged', async () => {
    dbSelectResult.current = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcdef1234567890',
        acceptedCredentials: [],
        pendingAcceptedCredentials: null,
        pendingDeletion: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await expect(mod.deleteDomain({ clientId: 'c1', domainDbId: 'dom-1' })).rejects.toThrow(
      'pending mutation',
    );
  });
});

describe('listMembers', () => {
  // Helper: seed a domain with a given accepted credentials list.
  const seedDomain = (accepted: Array<{ issuer: string; credential_type: string }>) => {
    dbSelectResults.domains = [
      {
        id: 'dom-1',
        ownerAddress: 'rOwner',
        domainId: 'abcd1234',
        acceptedCredentials: accepted,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  };

  it('throws not_found when the domain does not exist', async () => {
    dbSelectResults.domains = [];
    await expect(mod.listMembers('c1', 'missing-id')).rejects.toThrow('Domain not found');
  });

  it('returns empty members when the domain has no accepted credentials', async () => {
    seedDomain([]);
    const result = await mod.listMembers('c1', 'dom-1');
    expect(result.members).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('returns pre-grouped credentials from SQL', async () => {
    seedDomain([{ issuer: 'rIss', credential_type: '4B5943' }]);
    // SQL returns already-grouped rows via array_agg.
    dbSelectResults.credentials = [
      { subjectAddress: 'rAlice', credentialIds: ['cred-1', 'cred-2'] },
    ];
    const result = await mod.listMembers('c1', 'dom-1');
    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.subject_address).toBe('rAlice');
    expect(result.members[0]!.credential_ids).toEqual(['cred-1', 'cred-2']);
    expect(result.has_more).toBe(false);
  });

  it('returns members in SQL-sorted order', async () => {
    seedDomain([{ issuer: 'rIss', credential_type: '4B5943' }]);
    // SQL ORDER BY subject_address ASC returns sorted rows.
    dbSelectResults.credentials = [
      { subjectAddress: 'rAlice', credentialIds: ['cred-alice'] },
      { subjectAddress: 'rBob', credentialIds: ['cred-bob'] },
      { subjectAddress: 'rCharlie', credentialIds: ['cred-charlie'] },
    ];
    const result = await mod.listMembers('c1', 'dom-1');
    expect(result.members.map((m) => m.subject_address)).toEqual(['rAlice', 'rBob', 'rCharlie']);
  });

  it('detects has_more via the limit+1 row trick', async () => {
    seedDomain([{ issuer: 'rIss', credential_type: '4B5943' }]);
    // SQL returns limit+1 rows when there are more results.
    // With limit=2, the query fetches 3 rows.
    dbSelectResults.credentials = [
      { subjectAddress: 'rA', credentialIds: ['c1'] },
      { subjectAddress: 'rB', credentialIds: ['c2'] },
      { subjectAddress: 'rC', credentialIds: ['c3'] },
    ];
    const result = await mod.listMembers('c1', 'dom-1', {
      limit: 2,
      offset: 0,
    });
    expect(result.members).toHaveLength(2);
    expect(result.members.map((m) => m.subject_address)).toEqual(['rA', 'rB']);
    expect(result.has_more).toBe(true);
  });

  it('sets has_more=false when SQL returns <= limit rows', async () => {
    seedDomain([{ issuer: 'rIss', credential_type: '4B5943' }]);
    dbSelectResults.credentials = [{ subjectAddress: 'rA', credentialIds: ['c1'] }];
    const result = await mod.listMembers('c1', 'dom-1', {
      limit: 2,
      offset: 0,
    });
    expect(result.members).toHaveLength(1);
    expect(result.has_more).toBe(false);
  });

  it('clamps the limit to the 1..1000 bound', async () => {
    seedDomain([{ issuer: 'rIss', credential_type: '4B5943' }]);
    dbSelectResults.credentials = [
      { subjectAddress: 'rA', credentialIds: ['c1'] },
      { subjectAddress: 'rB', credentialIds: ['c2'] },
    ];
    // limit=0 clamps up to 1 → service fetches limit+1=2 rows, returns 1.
    const tiny = await mod.listMembers('c1', 'dom-1', { limit: 0 });
    expect(tiny.members).toHaveLength(1);
    expect(tiny.has_more).toBe(true);
    // limit=9999 clamps down to 1000 (still returns all 2 since count < 1000)
    const huge = await mod.listMembers('c1', 'dom-1', { limit: 9999 });
    expect(huge.members).toHaveLength(2);
    expect(huge.has_more).toBe(false);
  });
});
