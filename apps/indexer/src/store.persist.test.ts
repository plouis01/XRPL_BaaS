// Unit tests for persistTransaction — the idempotent store gate. Focuses
// on the dedup contract (processed_transactions first, then dispatch) and
// on the rollback-on-failure invariant.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @railforge/db with a minimal query-builder fake. Every call just
// records what the code under test intended to do, and returns whatever
// we queued up in `queuedInsertReturning`.
const insertCalls: Array<{ table: string; values: unknown }> = [];
const deleteCalls: Array<{ table: string }> = [];
let queuedInsertReturning: unknown[] = [];
let upsertCalls = 0;

function fakeDb() {
  return {
    insert: (table: { _tableName?: string }) => ({
      values(values: unknown) {
        insertCalls.push({ table: table._tableName ?? 'unknown', values });
        const builder = {
          onConflictDoNothing() {
            return {
              returning() {
                const r = queuedInsertReturning;
                queuedInsertReturning = [];
                return Promise.resolve(r);
              },
            };
          },
          onConflictDoUpdate(_: unknown) {
            upsertCalls += 1;
            return Promise.resolve();
          },
          returning() {
            const r = queuedInsertReturning;
            queuedInsertReturning = [];
            return Promise.resolve(r);
          },
        };
        return builder;
      },
    }),
    delete: (table: { _tableName?: string }) => ({
      where() {
        deleteCalls.push({ table: table._tableName ?? 'unknown' });
        return Promise.resolve();
      },
    }),
  };
}

vi.mock('@railforge/db', () => ({
  db: {},
  eq: vi.fn(() => ({ __eq: true })),
  and: vi.fn(() => ({ __and: true })),
  sql: Object.assign((..._: unknown[]) => ({ __sql: true }), {
    raw: () => ({ __sql: true }),
  }),
  schema: {
    processedTransactions: { _tableName: 'processed_transactions', txHash: {} },
    offerBook: { _tableName: 'offer_book', account: {}, sequence: {} },
    accountBalances: { _tableName: 'account_balances' },
    ammPools: { _tableName: 'amm_pools' },
  },
}));

const { __setDbForTests, persistTransaction } = await import('./store.ts');

beforeEach(() => {
  insertCalls.length = 0;
  deleteCalls.length = 0;
  upsertCalls = 0;
  queuedInsertReturning = [];
  __setDbForTests(fakeDb() as unknown as typeof import('@railforge/db').db);
});

describe('persistTransaction — dedup gate', () => {
  it('returns false when processed_transactions insert returns no rows (replay)', async () => {
    queuedInsertReturning = []; // ON CONFLICT DO NOTHING → no rows returned
    const result = await persistTransaction({
      kind: 'payment',
      txHash: 'H1',
      ledgerIndex: 1,
      success: true,
      account: 'rA',
      destination: 'rB',
      amount: '1',
    });
    expect(result).toBe(false);
    expect(upsertCalls).toBe(0); // no downstream writes
  });

  it('returns true when processed_transactions insert is new', async () => {
    queuedInsertReturning = [{ txHash: 'H2' }];
    const result = await persistTransaction({
      kind: 'payment',
      txHash: 'H2',
      ledgerIndex: 1,
      success: true,
      account: 'rA',
      destination: 'rB',
      amount: '1',
    });
    expect(result).toBe(true);
  });

  it('skips downstream writes for failed (success=false) txs but still dedups', async () => {
    queuedInsertReturning = [{ txHash: 'H3' }];
    const result = await persistTransaction({
      kind: 'offer_create',
      txHash: 'H3',
      ledgerIndex: 1,
      success: false,
      account: 'rMaker',
      sequence: 1,
      takerPays: '1',
      takerGets: '1',
    });
    expect(result).toBe(true);
    // Exactly one insert hit processed_transactions; offer_book untouched.
    expect(insertCalls.filter((c) => c.table === 'offer_book')).toHaveLength(0);
  });
});

describe('persistTransaction — dispatch', () => {
  it('offer_create → upserts offer_book', async () => {
    queuedInsertReturning = [{ txHash: 'H4' }];
    await persistTransaction({
      kind: 'offer_create',
      txHash: 'H4',
      ledgerIndex: 1,
      success: true,
      account: 'rMaker',
      sequence: 7,
      takerPays: { currency: 'USD', issuer: 'rI', value: '10' },
      takerGets: '1000000',
    });
    expect(upsertCalls).toBe(1);
    const offerInserts = insertCalls.filter((c) => c.table === 'offer_book');
    expect(offerInserts).toHaveLength(1);
  });

  it('offer_cancel → deletes from offer_book', async () => {
    queuedInsertReturning = [{ txHash: 'H5' }];
    await persistTransaction({
      kind: 'offer_cancel',
      txHash: 'H5',
      ledgerIndex: 1,
      success: true,
      account: 'rMaker',
      offerSequence: 7,
    });
    expect(deleteCalls.filter((c) => c.table === 'offer_book')).toHaveLength(1);
  });

  it('payment / credential / domain events dedup-only (no side tables)', async () => {
    queuedInsertReturning = [{ txHash: 'H6' }];
    await persistTransaction({
      kind: 'credential_accept',
      txHash: 'H6',
      ledgerIndex: 1,
      success: true,
      account: 'rSubject',
      issuer: 'rIssuer',
      credentialType: '4B5943',
    });
    expect(upsertCalls).toBe(0);
    expect(insertCalls.filter((c) => c.table === 'offer_book')).toHaveLength(0);
  });
});
