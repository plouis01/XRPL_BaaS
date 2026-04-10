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
const dbSelectResult = { current: [] as unknown[] };

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
      where: vi.fn(() => {
        // Return a thenable that also has .limit() — covers both
        // queries that chain .limit() and those that await .where() directly.
        const result = Promise.resolve(dbSelectResult.current);
        (result as unknown as Record<string, unknown>).limit = vi.fn(
          async () => dbSelectResult.current,
        );
        return result;
      }),
    })),
  }));

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ insert, select });
  });

  return {
    db: { insert, select, transaction },
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
  enqueueCalls.length = 0;
  dbSelectResult.current = [];
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
