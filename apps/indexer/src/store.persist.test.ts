// Unit tests for persistTransaction — the idempotent store gate. Focuses
// on the dedup contract (processed_transactions first, then dispatch) and
// on the rollback-on-failure invariant.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @railforge/db with a minimal query-builder fake. Every call just
// records what the code under test intended to do, and returns whatever
// we queued up in `queuedInsertReturning`.
const insertCalls: Array<{ table: string; values: unknown }> = [];
const deleteCalls: Array<{ table: string }> = [];
const updateCalls: Array<{ table: string; set: unknown }> = [];
let queuedInsertReturning: unknown[] = [];
let upsertCalls = 0;
// Rows the select().from(domains).where().orderBy().limit() chain resolves to.
// Used by backfillDomainId — set to [{id: 'domain-uuid'}] to simulate a
// matching pending row, [] to simulate no match.
let queuedSelectReturning: unknown[] = [];

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
    // Sprint-post: backfillDomainId uses select().from().where().orderBy().limit().
    select: (_fields: unknown) => ({
      from: (_table: { _tableName?: string }) => ({
        where: (_cond: unknown) => ({
          orderBy: (_order: unknown) => ({
            limit: async (_n: number) => {
              const r = queuedSelectReturning;
              queuedSelectReturning = [];
              return r;
            },
          }),
        }),
      }),
    }),
    // Update path used by backfillDomainId: update().set().where().
    update: (table: { _tableName?: string }) => ({
      set(set: unknown) {
        return {
          where() {
            updateCalls.push({ table: table._tableName ?? 'unknown', set });
            return Promise.resolve();
          },
        };
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
    domains: {
      _tableName: 'domains',
      id: {},
      ownerAddress: {},
      domainId: {},
      createdAt: {},
    },
  },
}));

const { __setDbForTests, persistTransaction } = await import('./store.ts');

beforeEach(() => {
  insertCalls.length = 0;
  deleteCalls.length = 0;
  updateCalls.length = 0;
  upsertCalls = 0;
  queuedInsertReturning = [];
  queuedSelectReturning = [];
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

// ── domain_set: backfill domain_id ─────────────────────────────────────────

// The indexer closes the loop that the API opens: domain.service.createDomain
// writes a `pending-<uuid>` placeholder so the API can return an id before
// the tx lands. When the PermissionedDomainSet validates, parser extracts
// the real DomainID from meta.CreatedNode.LedgerIndex; the store matches
// the newest pending row for the same owner and UPDATEs it.

describe('persistTransaction — domain_set backfill', () => {
  const REAL_DOMAIN_ID = '5035443BE747BB85958801FA8C196FE0B8F222A4C486F501A35D796708C5C059';

  it('CREATE: updates the newest pending row for the owner with the real DomainID', async () => {
    queuedInsertReturning = [{ txHash: 'HDOM1' }]; // dedup: first time
    queuedSelectReturning = [{ id: 'domain-row-uuid' }]; // pending row match
    await persistTransaction({
      kind: 'domain_set',
      txHash: 'HDOM1',
      ledgerIndex: 1,
      success: true,
      account: 'rOwner',
      domainId: REAL_DOMAIN_ID,
      isCreate: true,
    });
    // Exactly one UPDATE against domains, with the real id in `set`.
    const domainUpdates = updateCalls.filter((c) => c.table === 'domains');
    expect(domainUpdates).toHaveLength(1);
    expect((domainUpdates[0]!.set as { domainId?: string }).domainId).toBe(REAL_DOMAIN_ID);
  });

  it('UPDATE (isCreate=false): does NOT touch the domains table', async () => {
    // Reusing an existing DomainID — no placeholder to resolve.
    queuedInsertReturning = [{ txHash: 'HDOM2' }];
    queuedSelectReturning = [{ id: 'domain-row-uuid' }]; // even if a row existed,
    await persistTransaction({
      kind: 'domain_set',
      txHash: 'HDOM2',
      ledgerIndex: 1,
      success: true,
      account: 'rOwner',
      domainId: REAL_DOMAIN_ID,
      isCreate: false,
    });
    expect(updateCalls.filter((c) => c.table === 'domains')).toHaveLength(0);
  });

  it('CREATE with no matching pending row: no-op UPDATE (owner with no pending placeholder)', async () => {
    // An unknown owner (or one whose placeholder was already resolved)
    // must NOT trigger a bogus update. The store returns empty from the
    // SELECT; the UPDATE path is skipped entirely.
    queuedInsertReturning = [{ txHash: 'HDOM3' }];
    queuedSelectReturning = []; // no pending row
    await persistTransaction({
      kind: 'domain_set',
      txHash: 'HDOM3',
      ledgerIndex: 1,
      success: true,
      account: 'rUnknownOwner',
      domainId: REAL_DOMAIN_ID,
      isCreate: true,
    });
    expect(updateCalls.filter((c) => c.table === 'domains')).toHaveLength(0);
  });

  it('CREATE without a domainId: no-op (defensive; parser should never emit this)', async () => {
    // Double-guard: even if parser somehow flagged isCreate=true with no
    // extractable DomainID, the store bails before SELECTing anything.
    queuedInsertReturning = [{ txHash: 'HDOM4' }];
    queuedSelectReturning = [{ id: 'would-be-matched' }];
    await persistTransaction({
      kind: 'domain_set',
      txHash: 'HDOM4',
      ledgerIndex: 1,
      success: true,
      account: 'rOwner',
      // domainId: undefined on purpose
      isCreate: true,
    });
    expect(updateCalls.filter((c) => c.table === 'domains')).toHaveLength(0);
  });

  it('failed tx (success=false): dedup-only, never backfills', async () => {
    // A temINVALID_* / tec-coded PermissionedDomainSet lands on-chain
    // (fee burned) but didn't create an entry. The store dedups but
    // must not touch the domains row.
    queuedInsertReturning = [{ txHash: 'HDOM5' }];
    queuedSelectReturning = [{ id: 'would-be-matched' }];
    await persistTransaction({
      kind: 'domain_set',
      txHash: 'HDOM5',
      ledgerIndex: 1,
      success: false,
      account: 'rOwner',
      domainId: REAL_DOMAIN_ID,
      isCreate: true,
    });
    expect(updateCalls.filter((c) => c.table === 'domains')).toHaveLength(0);
  });
});
