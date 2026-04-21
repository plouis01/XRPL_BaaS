// Unit tests for fanOutExternalTxEvent.
//
// Verifies the core invariants:
//   - Internal txs (hash exists in transactions) are skipped
//   - Non-managed addresses produce zero enqueues
//   - Each matching (client, endpoint) pair produces one delivery
//   - The event-kind → webhook-type mapping is correct

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stateful fake db driven per test.
interface FakeState {
  ownTxRows: unknown[];
  accountRows: Array<{ clientId: string; address: string }>;
  endpointRows: Array<{ id: string; clientId: string; events: string[] }>;
  insertedDeliveries: Array<{
    endpointId: string;
    eventType: string;
    payload: unknown;
  }>;
  nextDeliveryId: number;
}

const state: FakeState = {
  ownTxRows: [],
  accountRows: [],
  endpointRows: [],
  insertedDeliveries: [],
  nextDeliveryId: 0,
};

const enqueueCalls: Array<{ deliveryId: string; endpointId: string }> = [];

vi.mock('@railforge/db', () => {
  const SELECT_TABLES: Record<string, () => unknown[]> = {
    transactions: () => state.ownTxRows,
    accounts: () => state.accountRows,
    webhook_endpoints: () => state.endpointRows,
  };
  return {
    db: {
      select: () => ({
        from: (table: { __tableName: string }) => ({
          where: () => {
            const rows = SELECT_TABLES[table.__tableName]?.() ?? [];
            // `where()` is itself thenable — the accounts/endpoint queries
            // don't chain `.limit()`. The transactions "own tx" gate does.
            const p = Promise.resolve(rows);
            return Object.assign(p, {
              limit: (_n: number) => Promise.resolve(rows),
            });
          },
        }),
      }),
      insert: (table: { __tableName: string }) => ({
        values(v: Record<string, unknown>) {
          return {
            returning: () => {
              if (table.__tableName === 'webhook_deliveries') {
                state.nextDeliveryId += 1;
                const id = `d${state.nextDeliveryId}`;
                state.insertedDeliveries.push({
                  endpointId: v.endpointId as string,
                  eventType: v.eventType as string,
                  payload: v.payload,
                });
                return Promise.resolve([{ id }]);
              }
              return Promise.resolve([]);
            },
          };
        },
      }),
    },
    eq: vi.fn(() => ({ __predicate: 'eq' })),
    inArray: vi.fn(() => ({ __predicate: 'inArray' })),
    schema: {
      transactions: { __tableName: 'transactions', id: {}, txHash: {} },
      accounts: { __tableName: 'accounts', clientId: {}, address: {} },
      webhookEndpoints: {
        __tableName: 'webhook_endpoints',
        id: {},
        clientId: {},
        events: {},
      },
      webhookDeliveries: { __tableName: 'webhook_deliveries' },
    },
  };
});

// `from()` in our fake uses `table.__tableName` to look up the right
// select result. We must use identical table-name strings in both the
// schema object and the SELECT_TABLES map above. accounts / endpoints
// use snake_case to match Postgres table names.
vi.mock('@railforge/jobs', () => ({
  enqueueWebhookDelivery: (data: {
    deliveryId: string;
    endpointId: string;
  }) => {
    enqueueCalls.push(data);
    return Promise.resolve();
  },
  // REVIEW.md MED-14: webhookFanout imports this const to build the
  // indexer-side skip gate. Mirror the real shape here so the test mock
  // doesn't crash on module load.
  TX_CONFIRMER_EVENT_TYPES: ['transaction.validated', 'transaction.failed'] as const,
}));

const { fanOutExternalTxEvent } = await import('./webhookFanout.ts');

beforeEach(() => {
  state.ownTxRows = [];
  state.accountRows = [];
  state.endpointRows = [];
  state.insertedDeliveries = [];
  state.nextDeliveryId = 0;
  enqueueCalls.length = 0;
});

describe('fanOutExternalTxEvent', () => {
  it('skips internal txs for transaction.validated (txConfirmer handles it)', async () => {
    state.ownTxRows = [{ id: 't1' }];
    state.accountRows = [{ clientId: 'c1', address: 'rDest' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['transaction.validated'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'payment',
      txHash: 'H1',
      ledgerIndex: 1,
      success: true,
      account: 'rSrc',
      destination: 'rDest',
      amount: '1000000',
    });
    expect(enqueued).toBe(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  it('FIRES credential.issued for internal txs — txConfirmer does NOT handle credential.*', async () => {
    // Same tx hash exists in `transactions` (internal), but credential.issued
    // is indexer-only so it must still fire.
    state.ownTxRows = [{ id: 't1' }];
    state.accountRows = [{ clientId: 'c1', address: 'rSubject' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['credential.issued'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'credential_create',
      txHash: 'H-internal-cred',
      ledgerIndex: 1,
      success: true,
      issuer: 'rIssuer',
      subject: 'rSubject',
      credentialType: 'KYC',
    });
    expect(enqueued).toBe(1);
    expect(state.insertedDeliveries[0]?.eventType).toBe('credential.issued');
  });

  it('FIRES domain.deleted for internal domain-delete tx', async () => {
    state.ownTxRows = [{ id: 't1' }];
    state.accountRows = [{ clientId: 'c1', address: 'rOwner' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['domain.deleted'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'domain_delete',
      txHash: 'H-internal-dom',
      ledgerIndex: 1,
      success: true,
      account: 'rOwner',
      domainId: 'D1',
    });
    expect(enqueued).toBe(1);
  });

  it('returns 0 when no managed account matches', async () => {
    state.accountRows = [];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'payment',
      txHash: 'H2',
      ledgerIndex: 1,
      success: true,
      account: 'rSrc',
      destination: 'rOther',
      amount: '1',
    });
    expect(enqueued).toBe(0);
  });

  it('enqueues transaction.validated for incoming external payment', async () => {
    state.accountRows = [{ clientId: 'c1', address: 'rDest' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['transaction.validated'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'payment',
      txHash: 'H3',
      ledgerIndex: 1,
      success: true,
      account: 'rSrc',
      destination: 'rDest',
      amount: '9',
    });
    expect(enqueued).toBe(1);
    expect(enqueueCalls).toEqual([{ deliveryId: 'd1', endpointId: 'e1' }]);
    expect(state.insertedDeliveries[0]?.eventType).toBe('transaction.validated');
    const payload = state.insertedDeliveries[0]?.payload as {
      event: string;
      tx_hash: string;
    };
    expect(payload.event).toBe('transaction.validated');
    expect(payload.tx_hash).toBe('H3');
  });

  it('skips failed payments', async () => {
    state.accountRows = [{ clientId: 'c1', address: 'rDest' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['transaction.validated'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'payment',
      txHash: 'H4',
      ledgerIndex: 1,
      success: false,
      account: 'rSrc',
      destination: 'rDest',
      amount: '1',
    });
    expect(enqueued).toBe(0);
  });

  it('fires credential.issued for external CredentialCreate on managed subject', async () => {
    state.accountRows = [{ clientId: 'c1', address: 'rSubject' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['credential.issued'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'credential_create',
      txHash: 'H5',
      ledgerIndex: 1,
      success: true,
      issuer: 'rIssuer',
      subject: 'rSubject',
      credentialType: 'KYC',
    });
    expect(enqueued).toBe(1);
    expect(state.insertedDeliveries[0]?.eventType).toBe('credential.issued');
  });

  it('dedupes by clientId when multiple managed addresses match', async () => {
    state.accountRows = [
      { clientId: 'c1', address: 'rA' },
      { clientId: 'c1', address: 'rB' }, // same client, two addresses
    ];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['domain.updated'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'domain_set',
      txHash: 'H6',
      ledgerIndex: 1,
      success: true,
      account: 'rA',
    });
    // One endpoint, one event → one delivery. No per-address duplication.
    expect(enqueued).toBe(1);
  });

  it('does not fire for offer_create (no matching webhook type)', async () => {
    state.accountRows = [{ clientId: 'c1', address: 'rMaker' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['transaction.validated'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'offer_create',
      txHash: 'H7',
      ledgerIndex: 1,
      success: true,
      account: 'rMaker',
      sequence: 1,
      takerPays: '1',
      takerGets: '1',
    });
    expect(enqueued).toBe(0);
  });

  it('filters endpoints that did NOT subscribe to the event type', async () => {
    state.accountRows = [{ clientId: 'c1', address: 'rDest' }];
    state.endpointRows = [{ id: 'e1', clientId: 'c1', events: ['credential.issued'] }];
    const enqueued = await fanOutExternalTxEvent({
      kind: 'payment',
      txHash: 'H8',
      ledgerIndex: 1,
      success: true,
      account: 'rSrc',
      destination: 'rDest',
      amount: '1',
    });
    // Endpoint subscribed to credential.issued only — no match for transaction.validated.
    expect(enqueued).toBe(0);
  });
});
