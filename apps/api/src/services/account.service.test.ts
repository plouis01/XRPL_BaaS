// Unit tests for account.service.ts (Sprint 3 — treasury-funded creation).
//
// Strategy:
//   - Mock @railforge/db with a chainable query builder + a fake transaction
//     callback that runs the inner block against the same insert/select stubs.
//   - Mock @railforge/jobs to control enqueueTxSubmit success/failure.
//   - Real xrpl.js Wallet — we just verify the service doesn't leak the seed.
//
// What changed from Sprint 2: the faucet-mocked tests are gone. The new
// flow is wallet → DB transaction (insert tx + insert account) → enqueue
// → return view with is_funded=false and a funding_tx_id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────
//
// Drizzle's transaction callback runs against a `tx` object with the same
// insert/select API as `db`. We model that by having `db.transaction(cb)`
// invoke `cb(db)` synchronously — the inner code uses the same stubs.

const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
const dbInsertResults = {
  transactions: [{ id: 'tx-uuid-1' }] as unknown[],
  accounts: [{ id: 'acct-uuid-1' }] as unknown[],
};
const dbSelectResult = { current: [] as unknown[] };
// Per-table thrown error. Set to a Postgres-shaped error to simulate 23505.
const dbInsertShouldThrow = { table: '' as string, err: null as unknown };

vi.mock('@railforge/db', () => {
  // Build a chained insert mock keyed by which table object was passed.
  // We can't introspect the Drizzle table object reliably, so we use a
  // sentinel string in the schema mock below.
  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        if (dbInsertShouldThrow.table === table.__name && dbInsertShouldThrow.err) {
          const err = dbInsertShouldThrow.err;
          dbInsertShouldThrow.err = null;
          dbInsertShouldThrow.table = '';
          throw err;
        }
        return dbInsertResults[table.__name as 'transactions' | 'accounts'];
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

  // Drizzle's db.transaction(cb) — we just call cb with the same db object
  // so the inner inserts hit the same stubs. Real Drizzle wraps in BEGIN/
  // COMMIT but for unit tests the wrapper is transparent.
  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ insert, select });
  });

  return {
    db: { insert, select, transaction },
    schema: {
      accounts: { __name: 'accounts' },
      transactions: { __name: 'transactions' },
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

// Import AFTER mocks.
const { createAccount, getAccount, AccountServiceError } = await import('./account.service.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createAccount (treasury flow)', () => {
  beforeEach(() => {
    dbInsertCalls.length = 0;
    enqueueCalls.length = 0;
    dbInsertResults.transactions = [{ id: 'tx-uuid-1' }];
    dbInsertResults.accounts = [{ id: 'acct-uuid-1' }];
    dbInsertShouldThrow.table = '';
    dbInsertShouldThrow.err = null;
    enqueueShouldThrow.err = null;
    process.env.TREASURY_ADDRESS = 'rTreasury000000000000000000000000';
  });

  afterEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is the only way to actually unset
    delete process.env.TREASURY_ADDRESS;
  });

  it('happy path: inserts tx + account, enqueues, returns is_funded=false with funding_tx_id', async () => {
    const result = await createAccount({
      clientId: 'client-1',
      label: 'test-wallet',
    });

    // Response shape checks.
    expect(result.id).toBe('acct-uuid-1');
    expect(result.address).toMatch(/^r/);
    expect(result.isFunded).toBe(false);
    expect(result.reserveBalance).toBe('0');
    expect(result.fundingTxId).toBe('tx-uuid-1');
    expect(result.label).toBe('test-wallet');
    expect(result.custodyMode).toBe('semi');

    // CRITICAL: no seed material in the response.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/seed/i);
    expect(serialized).not.toMatch(/master_key_ref/i);
    expect(serialized).not.toMatch(/^s[a-zA-Z1-9]{28}/);

    // DB writes happened in the right order: tx row first, then account.
    expect(dbInsertCalls).toHaveLength(2);
    expect(dbInsertCalls[0]?.table).toBe('transactions');
    expect(dbInsertCalls[1]?.table).toBe('accounts');

    // tx row was queued from treasury, type Payment, with funding metadata.
    const txValues = dbInsertCalls[0]!.values as Record<string, unknown>;
    expect(txValues.clientId).toBe('client-1');
    expect(txValues.txType).toBe('Payment');
    expect(txValues.sourceAddress).toBe('rTreasury000000000000000000000000');
    expect(txValues.status).toBe('queued');
    const reqBody = txValues.requestBody as Record<string, unknown>;
    expect(reqBody.purpose).toBe('account_funding');
    expect(reqBody.destination).toBe(result.address);
    expect(reqBody.amountDrops).toBe('20000000');

    // account row carries the seed in master_key_ref AND links the tx via
    // funding_tx_id.
    const acctValues = dbInsertCalls[1]!.values as Record<string, unknown>;
    expect(acctValues.clientId).toBe('client-1');
    expect(acctValues.address).toBe(result.address);
    expect(acctValues.isFunded).toBe(false);
    expect(acctValues.reserveBalance).toBe('0');
    expect(acctValues.fundingTxId).toBe('tx-uuid-1');
    expect(acctValues.masterKeyRef).toMatch(/^s[a-zA-Z1-9]{28}/);

    // Enqueue happened with treasury as source and the built Payment.
    expect(enqueueCalls).toHaveLength(1);
    const job = enqueueCalls[0] as Record<string, unknown>;
    expect(job.txId).toBe('tx-uuid-1');
    expect(job.sourceAddress).toBe('rTreasury000000000000000000000000');
    const txJson = job.txJson as Record<string, unknown>;
    expect(txJson.TransactionType).toBe('Payment');
    expect(txJson.Account).toBe('rTreasury000000000000000000000000');
    expect(txJson.Destination).toBe(result.address);
    expect(txJson.Amount).toBe('20000000');
  });

  it('defaults custody_mode to "semi" when not provided', async () => {
    const result = await createAccount({ clientId: 'client-1' });
    expect(result.custodyMode).toBe('semi');
  });

  it('throws treasury_not_configured when TREASURY_ADDRESS is unset', async () => {
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to "undefined"; delete is the only way to actually unset
    delete process.env.TREASURY_ADDRESS;

    const err = await createAccount({ clientId: 'client-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe('treasury_not_configured');

    // No DB inserts and no enqueue if treasury isn't configured.
    expect(dbInsertCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('throws db_conflict on Postgres unique-violation (23505) inside the transaction', async () => {
    dbInsertShouldThrow.table = 'accounts';
    dbInsertShouldThrow.err = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });

    const err = await createAccount({ clientId: 'client-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe('db_conflict');

    // Enqueue must NOT happen if the DB write didn't commit.
    expect(enqueueCalls).toHaveLength(0);
  });

  it('rethrows non-unique DB errors unchanged (global error handler deals with them)', async () => {
    dbInsertShouldThrow.table = 'transactions';
    dbInsertShouldThrow.err = new Error('connection lost');

    const err = await createAccount({ clientId: 'client-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AccountServiceError);
    expect((err as Error).message).toBe('connection lost');
    expect(enqueueCalls).toHaveLength(0);
  });

  it('throws enqueue_failed when enqueueTxSubmit rejects (DB rows are orphaned)', async () => {
    enqueueShouldThrow.err = new Error('Redis down');

    const err = await createAccount({ clientId: 'client-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountServiceError);
    expect((err as InstanceType<typeof AccountServiceError>).code).toBe('enqueue_failed');

    // The DB writes DID happen — the orphan is intentional and the
    // recovery path is "client retries with a new idempotency key".
    expect(dbInsertCalls).toHaveLength(2);
  });
});

describe('getAccount', () => {
  beforeEach(() => {
    dbSelectResult.current = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no row matches (not-found OR wrong client)', async () => {
    dbSelectResult.current = [];
    const result = await getAccount('client-1', 'rAddress');
    expect(result).toBeNull();
  });

  it('scopes the SELECT by clientId (cross-tenant isolation, structural)', async () => {
    // The mock doesn't actually filter — it just returns whatever's in
    // dbSelectResult.current. To prove cross-tenant isolation we instead
    // verify the WHERE clause passes both the clientId AND the address
    // through to drizzle's eq() at query-build time. If a future refactor
    // drops the clientId predicate, this test fails before any real query
    // runs.
    const { eq: eqMock } = (await import('@railforge/db')) as unknown as {
      eq: ReturnType<typeof vi.fn>;
    };
    eqMock.mockClear();
    dbSelectResult.current = [];

    await getAccount('client-1', 'rAddress');

    // eq should have been called with both clientId and address. We accept
    // any order — drizzle does too.
    const calls = eqMock.mock.calls;
    const clientIdCall = calls.find((args: unknown[]) => args[1] === 'client-1');
    const addressCall = calls.find((args: unknown[]) => args[1] === 'rAddress');
    expect(clientIdCall, 'WHERE missing clientId predicate').toBeDefined();
    expect(addressCall, 'WHERE missing address predicate').toBeDefined();
  });

  it('returns the account view when the row exists and belongs to the client', async () => {
    dbSelectResult.current = [
      {
        id: 'acct-1',
        address: 'rKnown000000000000000000000000000',
        regularKey: null,
        custodyMode: 'semi',
        label: 'my-wallet',
        isFunded: true,
        reserveBalance: '20000000',
        fundingTxId: 'tx-uuid-1',
        createdAt: new Date('2026-04-09T12:00:00Z'),
      },
    ];

    const result = await getAccount('client-1', 'rKnown000000000000000000000000000');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('acct-1');
    expect(result?.address).toBe('rKnown000000000000000000000000000');
    expect(result?.isFunded).toBe(true);
    expect(result?.reserveBalance).toBe('20000000');
    expect(result?.fundingTxId).toBe('tx-uuid-1');
  });

  it('never exposes master_key_ref in the view (redaction contract)', async () => {
    dbSelectResult.current = [
      {
        id: 'acct-1',
        address: 'rX',
        regularKey: null,
        custodyMode: 'semi',
        label: null,
        isFunded: true,
        reserveBalance: '20000000',
        fundingTxId: null,
        createdAt: new Date(),
        masterKeyRef: 'sLEAKED',
      },
    ];

    const result = await getAccount('client-1', 'rX');
    const json = JSON.stringify(result);
    expect(json).not.toContain('LEAKED');
    expect(json).not.toMatch(/master_key/i);
  });

  it('coerces isFunded=null from the DB to false in the view', async () => {
    dbSelectResult.current = [
      {
        id: 'acct-1',
        address: 'rX',
        regularKey: null,
        custodyMode: 'semi',
        label: null,
        isFunded: null,
        reserveBalance: null,
        fundingTxId: null,
        createdAt: null,
      },
    ];

    const result = await getAccount('client-1', 'rX');
    expect(result?.isFunded).toBe(false);
    expect(result?.reserveBalance).toBe('0');
    expect(result?.fundingTxId).toBeNull();
  });
});
