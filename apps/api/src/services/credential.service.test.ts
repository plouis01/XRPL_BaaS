// Unit tests for credential.service.ts (Sprint 5 — XLS-70 credentials).
//
// Strategy: same mock pattern as account.service.test.ts — mock @railforge/db
// with chainable query builder, mock @railforge/jobs for enqueueTxSubmit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
const dbInsertResults: Record<string, unknown[]> = {
  transactions: [{ id: 'tx-uuid-1' }],
  credentials: [{ id: 'cred-uuid-1' }],
  credential_issuers: [],
};
// Legacy single-bucket result. New code uses dbSelectResults (table-keyed)
// so acceptCredential can differentiate the accounts lookup from the
// credentials row-lock query. Both are supported for backward compat.
const dbSelectResult = { current: [] as unknown[] };
const dbSelectResults: Record<string, unknown[]> = {};
const dbUpdateCalls: Array<{ table: string; set: unknown }> = [];

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
      // Prefer table-keyed result when present; fall back to the legacy
      // single-bucket `dbSelectResult.current` for existing tests.
      const tableName = table.__name ?? '';
      const pick = () => dbSelectResults[tableName] ?? dbSelectResult.current;
      return {
        where: vi.fn(() => {
          // Chainable result: supports `.await`, `.limit()`, and
          // `.for('update').limit()` for TOCTOU locking queries.
          const result = Promise.resolve(pick());
          const r = result as unknown as Record<string, unknown>;
          r.limit = vi.fn(async () => pick());
          r.for = vi.fn(() => ({
            limit: vi.fn(async () => pick()),
          }));
          return result;
        }),
      };
    }),
  }));

  const update = vi.fn((table: { __name: string }) => ({
    set: vi.fn((values: unknown) => ({
      where: vi.fn(async () => {
        dbUpdateCalls.push({ table: table.__name, set: values });
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
      credentials: { __name: 'credentials' },
      credentialIssuers: { __name: 'credential_issuers' },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
    lte: vi.fn((col: unknown, val: unknown) => ({ lte: [col, val] })),
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

// ── xrpl-core mock ─────────────────────────────────────────────────────────

vi.mock('@railforge/xrpl-core', () => ({
  buildCredentialCreate: vi.fn(() => ({
    TransactionType: 'CredentialCreate',
  })),
  buildCredentialAccept: vi.fn(() => ({
    TransactionType: 'CredentialAccept',
  })),
  buildCredentialDelete: vi.fn(() => ({
    TransactionType: 'CredentialDelete',
  })),
}));

// ── logger mock ─────────────────────────────────────────────────────────────

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

let mod: typeof import('./credential.service.ts');

beforeEach(async () => {
  vi.resetModules();
  dbInsertCalls.length = 0;
  dbUpdateCalls.length = 0;
  enqueueCalls.length = 0;
  dbSelectResult.current = [];
  for (const k of Object.keys(dbSelectResults)) delete dbSelectResults[k];
  dbInsertResults.transactions = [{ id: 'tx-uuid-1' }];
  dbInsertResults.credentials = [{ id: 'cred-uuid-1' }];
  enqueueShouldThrow.err = null;
  mod = await import('./credential.service.ts');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('issueCredential', () => {
  it('happy path: inserts tx + credential, enqueues, returns view', async () => {
    // resolveOwnedAccount finds the issuer account
    dbSelectResult.current = [{ id: 'acct-1', address: 'rIssuerAddr' }];

    const result = await mod.issueCredential({
      clientId: 'client-1',
      issuerAddress: 'rIssuerAddr',
      subjectAddress: 'rSubjectAddr',
      credentialType: '4B5943',
    });

    expect(result.id).toBe('cred-uuid-1');
    expect(result.tx_id).toBe('tx-uuid-1');
    expect(result.status).toBe('pending');
    expect(result.credential_type).toBe('4B5943');
    expect(enqueueCalls).toHaveLength(1);
    expect(dbInsertCalls).toHaveLength(2);
    expect(dbInsertCalls[0]!.table).toBe('transactions');
    expect(dbInsertCalls[1]!.table).toBe('credentials');
  });

  it('throws not_managed if issuer is not a managed account', async () => {
    dbSelectResult.current = [];

    await expect(
      mod.issueCredential({
        clientId: 'client-1',
        issuerAddress: 'rUnknown',
        subjectAddress: 'rSubject',
        credentialType: '4B5943',
      }),
    ).rejects.toThrow('Issuer address is not a managed account');
  });

  it('throws enqueue_failed if Redis is down', async () => {
    dbSelectResult.current = [{ id: 'acct-1', address: 'rIssuer' }];
    enqueueShouldThrow.err = new Error('Redis connection refused');

    await expect(
      mod.issueCredential({
        clientId: 'client-1',
        issuerAddress: 'rIssuer',
        subjectAddress: 'rSubject',
        credentialType: '4B5943',
      }),
    ).rejects.toThrow('Failed to enqueue credential creation');
  });
});

describe('acceptCredential', () => {
  // Helpers for the two-phase select: accounts (resolveOwnedAccount) and
  // credentials (TOCTOU SELECT FOR UPDATE inside the transaction).
  const setSubjectAccount = (addr: string) => {
    dbSelectResults.accounts = [{ id: 'acct-1', address: addr }];
  };
  const setCredentialRow = (
    overrides: Partial<{
      id: string;
      issuerAddress: string;
      subjectAddress: string;
      credentialType: string;
      status: string;
    }> = {},
  ) => {
    dbSelectResults.credentials = [
      {
        id: 'cred-1',
        issuerAddress: 'rIssuer',
        subjectAddress: 'rSubject',
        credentialType: '4B5943',
        status: 'pending',
        ...overrides,
      },
    ];
  };

  it("happy path: locks row, inserts tx, transitions to 'accepting', enqueues", async () => {
    setSubjectAccount('rSubject');
    setCredentialRow();

    const result = await mod.acceptCredential({
      clientId: 'client-1',
      credentialId: 'cred-1',
      subjectAddress: 'rSubject',
    });

    expect(result.tx_id).toBe('tx-uuid-1');
    // tx row inserted inside the transaction
    const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
    expect(txInsert).toBeDefined();
    expect(txInsert?.values).toMatchObject({
      txType: 'CredentialAccept',
      sourceAddress: 'rSubject',
      status: 'queued',
    });
    // Status flipped to 'accepting' to close the TOCTOU window
    const credUpdate = dbUpdateCalls.find((c) => c.table === 'credentials');
    expect(credUpdate).toBeDefined();
    expect(credUpdate?.set).toMatchObject({ status: 'accepting' });
    // Enqueued exactly once
    expect(enqueueCalls).toHaveLength(1);
  });

  it('threads idempotencyKey into the tx row when provided', async () => {
    setSubjectAccount('rSubject');
    setCredentialRow();

    await mod.acceptCredential({
      clientId: 'client-1',
      credentialId: 'cred-1',
      subjectAddress: 'rSubject',
      idempotencyKey: 'key-abc-123',
    });

    const txInsert = dbInsertCalls.find((c) => c.table === 'transactions');
    expect(txInsert?.values).toMatchObject({ idempotencyKey: 'key-abc-123' });
  });

  it('throws not_managed when the subject is not a managed account', async () => {
    // accounts lookup returns empty — outside the transaction, so no row lock attempted
    dbSelectResults.accounts = [];
    setCredentialRow();

    await expect(
      mod.acceptCredential({
        clientId: 'client-1',
        credentialId: 'cred-1',
        subjectAddress: 'rUnknown',
      }),
    ).rejects.toThrow('Subject address is not a managed account');

    // No tx insert, no status transition, no enqueue
    expect(dbInsertCalls.find((c) => c.table === 'transactions')).toBeUndefined();
    expect(dbUpdateCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('throws not_found when the credential row does not exist', async () => {
    setSubjectAccount('rSubject');
    dbSelectResults.credentials = [];

    await expect(
      mod.acceptCredential({
        clientId: 'client-1',
        credentialId: 'nonexistent',
        subjectAddress: 'rSubject',
      }),
    ).rejects.toThrow('Credential not found');
    expect(dbUpdateCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("throws already_accepted when status is already 'accepted'", async () => {
    setSubjectAccount('rSubject');
    setCredentialRow({ status: 'accepted' });

    await expect(
      mod.acceptCredential({
        clientId: 'client-1',
        credentialId: 'cred-1',
        subjectAddress: 'rSubject',
      }),
    ).rejects.toThrow(/Credential is accepted, not pending/);
    expect(enqueueCalls).toHaveLength(0);
  });

  it("throws already_accepted when status is 'accepting' — TOCTOU second-runner", async () => {
    // Simulates a concurrent accept that already transitioned the row to
    // 'accepting' inside its own transaction; the losing call sees that
    // state once it acquires the row lock.
    setSubjectAccount('rSubject');
    setCredentialRow({ status: 'accepting' });

    await expect(
      mod.acceptCredential({
        clientId: 'client-1',
        credentialId: 'cred-1',
        subjectAddress: 'rSubject',
      }),
    ).rejects.toThrow(/Credential is accepting, not pending/);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('throws invalid_input when the subject address does not match the credential', async () => {
    // Subject passes the managed-account check (we look up rSubject), but
    // the credential row is bound to a different subject.
    setSubjectAccount('rSubject');
    setCredentialRow({ subjectAddress: 'rOtherSubject' });

    await expect(
      mod.acceptCredential({
        clientId: 'client-1',
        credentialId: 'cred-1',
        subjectAddress: 'rSubject',
      }),
    ).rejects.toThrow('subject_address does not match credential');
    expect(enqueueCalls).toHaveLength(0);
  });

  it('throws enqueue_failed when the queue is down after DB commit', async () => {
    setSubjectAccount('rSubject');
    setCredentialRow();
    enqueueShouldThrow.err = new Error('Redis connection refused');

    await expect(
      mod.acceptCredential({
        clientId: 'client-1',
        credentialId: 'cred-1',
        subjectAddress: 'rSubject',
      }),
    ).rejects.toThrow('Failed to enqueue credential acceptance');
    // Status transition already happened inside the committed transaction
    expect(dbUpdateCalls.find((c) => c.table === 'credentials')).toBeDefined();
  });
});

describe('getCredential', () => {
  it('returns null when credential not found', async () => {
    dbSelectResult.current = [];
    const result = await mod.getCredential('client-1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns a view when found', async () => {
    dbSelectResult.current = [
      {
        id: 'cred-1',
        issuerAddress: 'rIss',
        subjectAddress: 'rSub',
        credentialType: '4B5943',
        status: 'accepted',
        expiresAt: null,
        acceptedAt: new Date(),
        ledgerIndex: '123',
        metadata: {},
        createdAt: new Date(),
      },
    ];
    const result = await mod.getCredential('client-1', 'cred-1');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('accepted');
    expect(result!.issuer_address).toBe('rIss');
  });
});

describe('verifyCredential', () => {
  it('returns valid=false when no matching credential', async () => {
    dbSelectResult.current = [];
    const result = await mod.verifyCredential({
      clientId: 'c1',
      subjectAddress: 'rSub',
      issuerAddress: 'rIss',
      credentialType: '4B5943',
    });
    expect(result.valid).toBe(false);
    expect(result.credential).toBeNull();
  });

  it('returns valid=true for an accepted non-expired credential', async () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    dbSelectResult.current = [
      {
        id: 'cred-1',
        issuerAddress: 'rIss',
        subjectAddress: 'rSub',
        credentialType: '4B5943',
        status: 'accepted',
        expiresAt: future,
        acceptedAt: new Date(),
        ledgerIndex: '123',
        metadata: {},
        createdAt: new Date(),
      },
    ];
    const result = await mod.verifyCredential({
      clientId: 'c1',
      subjectAddress: 'rSub',
      issuerAddress: 'rIss',
      credentialType: '4B5943',
    });
    expect(result.valid).toBe(true);
  });

  it('returns valid=false for an expired credential', async () => {
    const past = new Date('2020-01-01');
    dbSelectResult.current = [
      {
        id: 'cred-1',
        issuerAddress: 'rIss',
        subjectAddress: 'rSub',
        credentialType: '4B5943',
        status: 'accepted',
        expiresAt: past,
        acceptedAt: new Date(),
        ledgerIndex: '123',
        metadata: {},
        createdAt: new Date(),
      },
    ];
    const result = await mod.verifyCredential({
      clientId: 'c1',
      subjectAddress: 'rSub',
      issuerAddress: 'rIss',
      credentialType: '4B5943',
    });
    expect(result.valid).toBe(false);
    expect(result.credential).not.toBeNull();
  });
});

describe('listIssuers', () => {
  it('returns empty array when no issuers exist', async () => {
    dbSelectResult.current = [];
    const result = await mod.listIssuers();
    expect(result).toEqual([]);
  });

  it('returns issuer data', async () => {
    dbSelectResult.current = [
      {
        id: 'iss-1',
        name: 'Sumsub',
        address: 'rSumsub',
        provider: 'sumsub',
        types: ['4B5943'],
      },
    ];
    const result = await mod.listIssuers();
    expect(result).toHaveLength(1);
    expect(result[0]!.provider).toBe('sumsub');
  });
});
