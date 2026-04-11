// Unit tests for the txConfirmer polling job.
//
// Coverage:
//   1. Happy path: tx validated → update row with ledger_index + tesSUCCESS
//   2. Validated with tec error → update row with failed status
//   3. Tx not found AND before lastLedger → throw for BullMQ retry
//   4. Tx not found AND past lastLedger → invalidate sequencer, mark failed
//   5. Sprint 3: validated payment for a treasury-funded account flips
//      accounts.is_funded=true and writes the reserve_balance from Amount

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxConfirmJobData } from '../queues.ts';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Track UPDATE calls per-table so the new accounts-flip path can be
// asserted independently from the transactions-row update.
const dbUpdateCalls: Array<{ table: string; set: unknown }> = [];
const dbSelectResult = {
  current: [{ sourceAddress: 'rSource00000000000000000000000000' }] as unknown[],
};
// What `accounts.update().set().where().returning()` should resolve to.
// Empty array = "no funding row matched" — the most common path because
// most txs aren't funding txs.
const accountUpdateReturning = { current: [] as unknown[] };
// Sprint 7: credential-accept state machine returning() — what the
// applyCredentialAcceptOutcome UPDATE returns. Empty = "already
// transitioned, noop"; non-empty = "we won the transition".
const credentialUpdateReturning = { current: [] as unknown[] };

// ── Sprint 3 webhook fan-out: extra mock state ──
//
// The fan-out path issues TWO additional DB calls:
//   1. SELECT … FROM webhook_endpoints INNER JOIN transactions WHERE …
//   2. INSERT INTO webhook_deliveries … RETURNING id, endpoint_id
//
// We track call order so the existing simple `select.from.where.limit`
// chain (used by the sequencer-invalidate path) and the new
// `select.from.innerJoin.where` chain don't trample each other.

// Subscribers returned by the JOIN select. Empty by default.
const subscribersResult = { current: [] as Array<{ endpointId: string }> };
// Rows the webhook_deliveries insert .returning() resolves to.
const deliveryInsertResult = {
  current: [] as Array<{ id: string; endpointId: string }>,
};
// Tracks how many times .insert was called and with what.
const dbInsertCalls: Array<{ table: string; values: unknown }> = [];
// queues mock spy — counts enqueueWebhookDelivery calls.
const enqueueWebhookDeliveryMock = vi.fn(async (_data: unknown) => {});

vi.mock('@railforge/db', () => {
  const update = vi.fn((table: { __name: string }) => ({
    set: vi.fn((payload: unknown) => {
      const where = vi.fn(() => {
        dbUpdateCalls.push({ table: table.__name, set: payload });
        // The accounts UPDATE chains a .returning() — tx UPDATE doesn't.
        // Sprint 7: credentials UPDATE also chains .returning(). Route
        // the returning() result by table so each call site can assert
        // its own expected shape without a shared buffer fight.
        return Object.assign(Promise.resolve(), {
          returning: vi.fn(async () => {
            if (table.__name === 'accounts') return accountUpdateReturning.current;
            if (table.__name === 'credentials') return credentialUpdateReturning.current;
            return [];
          }),
        });
      });
      return { where };
    }),
  }));
  // Select supports BOTH chains used by the worker:
  //   - sequencer-invalidate: select().from().where().limit()  → dbSelectResult
  //   - webhook fan-out:      select().from().innerJoin().where()  → subscribersResult
  // We expose `where` as a thenable AND as an object with `.limit`, so both
  // chains resolve with the right data.
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => dbSelectResult.current),
      })),
      innerJoin: vi.fn(() => ({
        where: vi.fn(async () => subscribersResult.current),
      })),
    })),
  }));
  // Insert supports the webhook_deliveries fan-out path: insert().values().returning().
  const insert = vi.fn((table: { __name: string }) => ({
    values: vi.fn((v: unknown) => ({
      returning: vi.fn(async () => {
        dbInsertCalls.push({ table: table.__name, values: v });
        return deliveryInsertResult.current;
      }),
    })),
  }));
  return {
    db: { update, select, insert },
    schema: {
      transactions: {
        __name: 'transactions',
        id: 'id',
        clientId: 'clientId',
        sourceAddress: 'sourceAddress',
      },
      accounts: {
        __name: 'accounts',
        id: 'id',
        fundingTxId: 'fundingTxId',
      },
      webhookEndpoints: {
        __name: 'webhook_endpoints',
        id: 'id',
        clientId: 'clientId',
        events: 'events',
        isActive: 'isActive',
      },
      webhookDeliveries: {
        __name: 'webhook_deliveries',
        id: 'id',
        endpointId: 'endpointId',
      },
      credentials: {
        __name: 'credentials',
        id: 'id',
        status: 'status',
      },
      domains: {
        __name: 'domains',
        id: 'id',
        acceptedCredentials: 'acceptedCredentials',
        pendingAcceptedCredentials: 'pendingAcceptedCredentials',
        pendingDeletion: 'pendingDeletion',
        deletedAt: 'deletedAt',
        updatedAt: 'updatedAt',
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    sql: Object.assign(
      // Tag function form: sql`...` — return a marker the WHERE doesn't care about.
      (..._args: unknown[]) => ({ __sql: true }),
      // Properties on `sql` we don't use here.
    ),
  };
});

const stubs = {
  sequencerInvalidate: vi.fn(),
  clientRequest: vi.fn(),
};

vi.mock('../queues.ts', () => ({
  TX_CONFIRM_QUEUE: 'railforge-tx-confirm',
  getXrplPool: async () => ({
    getClient: () => ({ request: stubs.clientRequest }),
  }),
  getSequencer: async () => ({
    invalidate: stubs.sequencerInvalidate,
  }),
  enqueueWebhookDelivery: enqueueWebhookDeliveryMock,
}));

const {
  applyCredentialAcceptOutcome,
  applyDomainMutationOutcome,
  extractMptIssuanceIdFromMeta,
  processTxConfirmJob,
  TxNotYetValidated,
} = await import('./txConfirmer.ts');

// ── Test helpers ────────────────────────────────────────────────────────────

function makeJob(data: TxConfirmJobData): Job<TxConfirmJobData> {
  return { data, id: 'job-1' } as unknown as Job<TxConfirmJobData>;
}

const BASE_JOB: TxConfirmJobData = {
  txId: 'tx-uuid-1',
  txHash: 'ABC123',
  lastLedger: 120,
};

describe('processTxConfirmJob', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    dbSelectResult.current = [{ sourceAddress: 'rSource00000000000000000000000000' }];
    accountUpdateReturning.current = [];
    credentialUpdateReturning.current = [];
    // Sprint 3 fan-out state.
    subscribersResult.current = [];
    deliveryInsertResult.current = [];
    dbInsertCalls.length = 0;
    enqueueWebhookDeliveryMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validated tesSUCCESS: updates row with ledger_index and validated status', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });

    await processTxConfirmJob(makeJob(BASE_JOB));

    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('validated');
    expect(update.resultCode).toBe('tesSUCCESS');
    expect(update.ledgerIndex).toBe(115);
    expect(update.confirmedAt).toBeInstanceOf(Date);
    expect(update.errorMessage).toBeUndefined();

    // Sequencer NOT touched on success.
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
  });

  it('validated with tec error: updates row with failed status and the result code', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' },
      },
    });

    await processTxConfirmJob(makeJob(BASE_JOB));

    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('tecUNFUNDED_PAYMENT');
    expect(update.errorMessage).toMatch(/tecUNFUNDED_PAYMENT/);
    expect(update.ledgerIndex).toBe(115);
  });

  it('tx found but not yet validated: throws TxNotYetValidated for BullMQ retry', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: false,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });

    await expect(processTxConfirmJob(makeJob(BASE_JOB))).rejects.toThrow(TxNotYetValidated);

    // No DB update — still propagating.
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('tx not found AND current ledger still below lastLedger: throws for retry', async () => {
    // First call = tx lookup throws txnNotFound. Second call = ledger_current.
    stubs.clientRequest
      .mockRejectedValueOnce(new Error('txnNotFound'))
      .mockResolvedValueOnce({ result: { ledger_current_index: 110 } });

    await expect(processTxConfirmJob(makeJob(BASE_JOB))).rejects.toThrow(TxNotYetValidated);

    expect(dbUpdateCalls).toHaveLength(0);
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
  });

  it('tx not found AND current ledger past lastLedger: marks LAST_LEDGER_EXPIRED and invalidates sequencer', async () => {
    stubs.clientRequest
      .mockRejectedValueOnce(new Error('txnNotFound'))
      .mockResolvedValueOnce({ result: { ledger_current_index: 125 } }); // > 120

    await processTxConfirmJob(makeJob(BASE_JOB));

    // DB row marked failed with LAST_LEDGER_EXPIRED.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('LAST_LEDGER_EXPIRED');
    expect(update.errorMessage).toMatch(/expired/i);

    // Sequencer invalidated — the unconsumed Sequence is still on-ledger.
    expect(stubs.sequencerInvalidate).toHaveBeenCalledWith('rSource00000000000000000000000000');
  });

  it('expired with missing row: does NOT throw when sourceAddress lookup returns empty', async () => {
    dbSelectResult.current = [];
    stubs.clientRequest
      .mockRejectedValueOnce(new Error('txnNotFound'))
      .mockResolvedValueOnce({ result: { ledger_current_index: 125 } });

    // Must not throw — the DB update still proceeds without the invalidate.
    await processTxConfirmJob(makeJob(BASE_JOB));

    expect(dbUpdateCalls).toHaveLength(1);
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
  });

  // ── Sprint 3: treasury-funded account flipping ───────────────────────────

  it('validated payment with funding_tx_id match: flips accounts.is_funded=true with reserve_balance from Amount', async () => {
    // The XRPL `tx` response puts Amount on result directly (next to meta).
    // For an XRP Payment the Amount is a string in drops.
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        Amount: '20000000',
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    // Simulate the indexed UPDATE finding one matching account row.
    accountUpdateReturning.current = [{ id: 'acct-uuid-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    // Two updates: tx row, then accounts row.
    expect(dbUpdateCalls).toHaveLength(2);
    expect(dbUpdateCalls[0]?.table).toBe('transactions');
    expect(dbUpdateCalls[1]?.table).toBe('accounts');

    const acctUpdate = dbUpdateCalls[1]!.set as Record<string, unknown>;
    expect(acctUpdate.isFunded).toBe(true);
    expect(acctUpdate.reserveBalance).toBe('20000000');
  });

  it('validated payment with NO funding_tx_id match: empty returning is silent (no log/error)', async () => {
    // Most txs aren't funding txs. We still issue the conditional UPDATE
    // but the WHERE matches nothing — Postgres handles it cheaply via the
    // funding_tx_id index. The empty returning array MUST NOT be surfaced
    // as an error or a misleading log line.
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        Amount: '1000',
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    accountUpdateReturning.current = [];

    await processTxConfirmJob(makeJob(BASE_JOB));

    // Both updates fire — but the accounts UPDATE returned 0 rows, so the
    // service must not crash and must not assert anything was funded.
    expect(dbUpdateCalls).toHaveLength(2);
    expect(dbUpdateCalls[0]?.table).toBe('transactions');
    expect(dbUpdateCalls[1]?.table).toBe('accounts');
  });

  it('validated tec error on a funding payment: does NOT flip is_funded', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        Amount: '20000000',
        meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' },
      },
    });
    accountUpdateReturning.current = [{ id: 'acct-uuid-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    // Only the tx row update — no accounts update because isSuccess=false.
    expect(dbUpdateCalls.filter((u) => u.table === 'accounts')).toHaveLength(0);
    expect(dbUpdateCalls.filter((u) => u.table === 'transactions')).toHaveLength(1);
  });

  it('validated payment with non-XRP Amount (issued currency): does NOT flip is_funded', async () => {
    // Issued-currency payments have Amount as an object, not a string. The
    // funding-payment path expects XRP — we defensively skip the flip.
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        Amount: { currency: 'USD', issuer: 'rIssuer', value: '10' },
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    accountUpdateReturning.current = [{ id: 'acct-uuid-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    expect(dbUpdateCalls.filter((u) => u.table === 'accounts')).toHaveLength(0);
    expect(dbUpdateCalls.filter((u) => u.table === 'transactions')).toHaveLength(1);
  });

  // ── Sprint 3 webhook fan-out ─────────────────────────────────────────────

  it('tesSUCCESS with N matching subscribers: inserts N delivery rows and enqueues N jobs', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    // Two subscribers for transaction.validated.
    subscribersResult.current = [{ endpointId: 'ep-1' }, { endpointId: 'ep-2' }];
    deliveryInsertResult.current = [
      { id: 'del-1', endpointId: 'ep-1' },
      { id: 'del-2', endpointId: 'ep-2' },
    ];

    await processTxConfirmJob(makeJob(BASE_JOB));

    // Single batched INSERT into webhook_deliveries with both rows.
    const deliveryInsert = dbInsertCalls.find((c) => c.table === 'webhook_deliveries');
    expect(deliveryInsert).toBeDefined();
    const values = deliveryInsert!.values as Array<Record<string, unknown>>;
    expect(values).toHaveLength(2);
    expect(values[0]?.eventType).toBe('transaction.validated');
    expect(values[0]?.endpointId).toBe('ep-1');
    expect(values[1]?.endpointId).toBe('ep-2');
    // Payload includes the standard envelope fields.
    const payload = values[0]?.payload as Record<string, unknown>;
    expect(payload.transaction_id).toBe('tx-uuid-1');
    expect(payload.tx_hash).toBe('ABC123');
    expect(payload.result_code).toBe('tesSUCCESS');
    expect(payload.status).toBe('validated');

    // Two enqueue calls, one per inserted row.
    expect(enqueueWebhookDeliveryMock).toHaveBeenCalledTimes(2);
    expect(enqueueWebhookDeliveryMock).toHaveBeenCalledWith({
      deliveryId: 'del-1',
      endpointId: 'ep-1',
    });
    expect(enqueueWebhookDeliveryMock).toHaveBeenCalledWith({
      deliveryId: 'del-2',
      endpointId: 'ep-2',
    });
  });

  it("validated tec error: fans out 'transaction.failed' (not 'transaction.validated')", async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' },
      },
    });
    subscribersResult.current = [{ endpointId: 'ep-1' }];
    deliveryInsertResult.current = [{ id: 'del-1', endpointId: 'ep-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    const deliveryInsert = dbInsertCalls.find((c) => c.table === 'webhook_deliveries');
    expect(deliveryInsert).toBeDefined();
    const values = deliveryInsert!.values as Array<Record<string, unknown>>;
    expect(values[0]?.eventType).toBe('transaction.failed');
    const payload = values[0]?.payload as Record<string, unknown>;
    expect(payload.result_code).toBe('tecUNFUNDED_PAYMENT');
    expect(payload.status).toBe('failed');
  });

  it('validated tx with NO matching subscribers: skips insert and enqueue entirely', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    subscribersResult.current = []; // no subscribers

    await processTxConfirmJob(makeJob(BASE_JOB));

    expect(dbInsertCalls.find((c) => c.table === 'webhook_deliveries')).toBeUndefined();
    expect(enqueueWebhookDeliveryMock).not.toHaveBeenCalled();
  });

  it('fan-out failure is non-fatal (tx update still happens, no throw)', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    // Make the insert throw — fan-out should swallow.
    subscribersResult.current = [{ endpointId: 'ep-1' }];
    enqueueWebhookDeliveryMock.mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    deliveryInsertResult.current = [{ id: 'del-1', endpointId: 'ep-1' }];

    // Must NOT throw — the tx is already validated, retrying the whole job
    // would re-fire successful deliveries.
    await expect(processTxConfirmJob(makeJob(BASE_JOB))).resolves.toBeUndefined();

    // The tx row update still happened.
    expect(dbUpdateCalls.filter((u) => u.table === 'transactions')).toHaveLength(1);
  });
});

// ── extractMptIssuanceIdFromMeta (Sprint 2 carry-over: mpt_issuance_id backfill) ──

describe('extractMptIssuanceIdFromMeta', () => {
  it('returns the id from a CreatedNode of type MPTokenIssuance (mpt_issuance_id field)', () => {
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              NewFields: {
                mpt_issuance_id: '00ABCDEF1234567890ABCDEF1234567890ABCDEF12345678',
              },
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBe(
      '00ABCDEF1234567890ABCDEF1234567890ABCDEF12345678',
    );
  });

  it('returns the id from MPTokenIssuanceID field as fallback', () => {
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              NewFields: { MPTokenIssuanceID: 'FFFFEEEE' },
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBe('FFFFEEEE');
  });

  it('returns the LedgerIndex of the created node when neither id field is present', () => {
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              LedgerIndex: '1234ABCD',
              NewFields: {},
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBe('1234ABCD');
  });

  it('ignores ModifiedNode entries (only CreatedNode counts)', () => {
    const result = {
      meta: {
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              FinalFields: { mpt_issuance_id: 'DECAFBAD' },
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBeNull();
  });

  it("ignores CreatedNode entries that aren't MPTokenIssuance", () => {
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'AccountRoot',
              NewFields: { mpt_issuance_id: 'WRONG' },
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBeNull();
  });

  it('returns null on missing meta or non-array AffectedNodes', () => {
    expect(extractMptIssuanceIdFromMeta({})).toBeNull();
    expect(extractMptIssuanceIdFromMeta({ meta: {} })).toBeNull();
    expect(extractMptIssuanceIdFromMeta({ meta: { AffectedNodes: 'not-array' } })).toBeNull();
  });
});

// ── Sprint 7: CredentialAccept state-machine partner ─────────────────────────
//
// acceptCredential transitions the credentials row to 'accepting' inside
// the same DB transaction that enqueues the CredentialAccept tx. txConfirmer
// must flip the row out of 'accepting' once rippled validates (or expires)
// that tx: success → 'accepted' (+ acceptedAt), any failure → 'pending'.
// Coverage below exercises the helper directly AND drives it through
// processTxConfirmJob on all three terminal paths.

const silentLog = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  // biome-ignore lint/suspicious/noExplicitAny: silent logger stand-in
} as any;

describe('applyCredentialAcceptOutcome (unit)', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    dbSelectResult.current = [];
    credentialUpdateReturning.current = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-CredentialAccept tx: no credentials UPDATE', async () => {
    dbSelectResult.current = [{ txType: 'Payment', requestBody: { foo: 'bar' } }];
    await applyCredentialAcceptOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'credentials')).toHaveLength(0);
  });

  it('missing tx row: no credentials UPDATE', async () => {
    dbSelectResult.current = [];
    await applyCredentialAcceptOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'credentials')).toHaveLength(0);
  });

  it('CredentialAccept with missing credentialId in requestBody: no credentials UPDATE', async () => {
    dbSelectResult.current = [
      { txType: 'CredentialAccept', requestBody: { op: 'acceptCredential' } },
    ];
    await applyCredentialAcceptOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'credentials')).toHaveLength(0);
  });

  it("success path: sets status='accepted' and acceptedAt", async () => {
    dbSelectResult.current = [
      {
        txType: 'CredentialAccept',
        requestBody: { credentialId: 'cred-1' },
      },
    ];
    credentialUpdateReturning.current = [{ id: 'cred-1' }];

    await applyCredentialAcceptOutcome('tx-uuid-1', true, silentLog);

    const credUpdate = dbUpdateCalls.find((u) => u.table === 'credentials');
    expect(credUpdate).toBeDefined();
    const set = credUpdate!.set as Record<string, unknown>;
    expect(set.status).toBe('accepted');
    expect(set.acceptedAt).toBeInstanceOf(Date);
  });

  it("failure path: sets status='pending' (no acceptedAt)", async () => {
    dbSelectResult.current = [
      {
        txType: 'CredentialAccept',
        requestBody: { credentialId: 'cred-1' },
      },
    ];
    credentialUpdateReturning.current = [{ id: 'cred-1' }];

    await applyCredentialAcceptOutcome('tx-uuid-1', false, silentLog);

    const credUpdate = dbUpdateCalls.find((u) => u.table === 'credentials');
    expect(credUpdate).toBeDefined();
    const set = credUpdate!.set as Record<string, unknown>;
    expect(set.status).toBe('pending');
    expect(set.acceptedAt).toBeUndefined();
  });

  it('already transitioned (returning=[]): noop, does not throw', async () => {
    dbSelectResult.current = [
      {
        txType: 'CredentialAccept',
        requestBody: { credentialId: 'cred-1' },
      },
    ];
    credentialUpdateReturning.current = [];

    // The UPDATE still fires — the idempotency guard is the WHERE clause
    // that returns zero rows. Helper must not throw.
    await expect(
      applyCredentialAcceptOutcome('tx-uuid-1', true, silentLog),
    ).resolves.toBeUndefined();

    // UPDATE was attempted exactly once even though it was a noop.
    expect(dbUpdateCalls.filter((u) => u.table === 'credentials')).toHaveLength(1);
  });
});

describe('processTxConfirmJob: CredentialAccept integration', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    accountUpdateReturning.current = [];
    credentialUpdateReturning.current = [];
    subscribersResult.current = [];
    deliveryInsertResult.current = [];
    dbInsertCalls.length = 0;
    enqueueWebhookDeliveryMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validated tesSUCCESS CredentialAccept: flips credential to accepted', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    dbSelectResult.current = [
      {
        txType: 'CredentialAccept',
        requestBody: { credentialId: 'cred-1' },
      },
    ];
    credentialUpdateReturning.current = [{ id: 'cred-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    const credUpdate = dbUpdateCalls.find((u) => u.table === 'credentials');
    expect(credUpdate).toBeDefined();
    expect((credUpdate!.set as Record<string, unknown>).status).toBe('accepted');
  });

  it('validated tec error CredentialAccept: flips credential back to pending', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tecNO_PERMISSION' },
      },
    });
    dbSelectResult.current = [
      {
        txType: 'CredentialAccept',
        requestBody: { credentialId: 'cred-1' },
      },
    ];
    credentialUpdateReturning.current = [{ id: 'cred-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    const credUpdate = dbUpdateCalls.find((u) => u.table === 'credentials');
    expect(credUpdate).toBeDefined();
    expect((credUpdate!.set as Record<string, unknown>).status).toBe('pending');
  });

  it('expired CredentialAccept: flips credential back to pending', async () => {
    // First call = tx lookup throws; second call = ledger_current past lastLedger.
    stubs.clientRequest
      .mockRejectedValueOnce(new Error('txnNotFound'))
      .mockResolvedValueOnce({ result: { ledger_current_index: 125 } });

    // Shared mock data: the expired branch's sourceAddress SELECT and the
    // helper's txType/requestBody SELECT both read from dbSelectResult. A
    // single row with all fields satisfies both without per-chain routing.
    dbSelectResult.current = [
      {
        sourceAddress: 'rSource00000000000000000000000000',
        txType: 'CredentialAccept',
        requestBody: { credentialId: 'cred-1' },
      },
    ];
    credentialUpdateReturning.current = [{ id: 'cred-1' }];

    await processTxConfirmJob(makeJob(BASE_JOB));

    // Tx row marked failed AND credential row reverted to 'pending'.
    expect(dbUpdateCalls.filter((u) => u.table === 'transactions')).toHaveLength(1);
    const credUpdate = dbUpdateCalls.find((u) => u.table === 'credentials');
    expect(credUpdate).toBeDefined();
    expect((credUpdate!.set as Record<string, unknown>).status).toBe('pending');
  });
});

// ── Sprint 7 #22: optimistic-domain-mutation rollback ────────────────────────
//
// updateDomain/deleteDomain stage mutations in pending_* columns instead of
// touching the committed state. applyDomainMutationOutcome commits the
// staging on tesSUCCESS and drops it on any failure/expiry so the DB row
// never diverges from the ledger.

describe('applyDomainMutationOutcome (unit)', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    dbSelectResult.current = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-domain tx type: no domains UPDATE', async () => {
    dbSelectResult.current = [{ txType: 'Payment', requestBody: { foo: 'bar' } }];
    await applyDomainMutationOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'domains')).toHaveLength(0);
  });

  it('missing tx row: no domains UPDATE', async () => {
    dbSelectResult.current = [];
    await applyDomainMutationOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'domains')).toHaveLength(0);
  });

  it('createDomain op: no domains UPDATE (create path is not staged)', async () => {
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainSet',
        requestBody: { op: 'createDomain', domainDbId: 'dom-1' },
      },
    ];
    await applyDomainMutationOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'domains')).toHaveLength(0);
  });

  it('missing domainDbId in requestBody: no domains UPDATE', async () => {
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainSet',
        requestBody: { op: 'updateDomain' /* domainDbId missing */ },
      },
    ];
    await applyDomainMutationOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'domains')).toHaveLength(0);
  });

  it('updateDomain success: commits pendingAcceptedCredentials → acceptedCredentials and clears staging', async () => {
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainSet',
        requestBody: { op: 'updateDomain', domainDbId: 'dom-1' },
      },
    ];
    await applyDomainMutationOutcome('tx-uuid-1', true, silentLog);

    const update = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(update).toBeDefined();
    const set = update!.set as Record<string, unknown>;
    // Staging is cleared.
    expect(set.pendingAcceptedCredentials).toBeNull();
    // acceptedCredentials is set to an expression (sql-marker in the mock);
    // what matters is that the field is written in the same UPDATE.
    expect('acceptedCredentials' in set).toBe(true);
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('updateDomain failure: drops staging (acceptedCredentials untouched)', async () => {
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainSet',
        requestBody: { op: 'updateDomain', domainDbId: 'dom-1' },
      },
    ];
    await applyDomainMutationOutcome('tx-uuid-1', false, silentLog);

    const update = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(update).toBeDefined();
    const set = update!.set as Record<string, unknown>;
    expect(set.pendingAcceptedCredentials).toBeNull();
    // Failure path must NOT touch committed state.
    expect('acceptedCredentials' in set).toBe(false);
    expect('updatedAt' in set).toBe(false);
  });

  it('deleteDomain success: stamps deletedAt and clears pendingDeletion', async () => {
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainDelete',
        requestBody: { op: 'deleteDomain', domainDbId: 'dom-1' },
      },
    ];
    await applyDomainMutationOutcome('tx-uuid-1', true, silentLog);

    const update = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(update).toBeDefined();
    const set = update!.set as Record<string, unknown>;
    expect(set.deletedAt).toBeInstanceOf(Date);
    expect(set.pendingDeletion).toBe(false);
  });

  it('deleteDomain failure: clears pendingDeletion but does NOT stamp deletedAt', async () => {
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainDelete',
        requestBody: { op: 'deleteDomain', domainDbId: 'dom-1' },
      },
    ];
    await applyDomainMutationOutcome('tx-uuid-1', false, silentLog);

    const update = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(update).toBeDefined();
    const set = update!.set as Record<string, unknown>;
    expect(set.pendingDeletion).toBe(false);
    expect('deletedAt' in set).toBe(false);
  });
});

describe('processTxConfirmJob: domain mutation integration', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    accountUpdateReturning.current = [];
    credentialUpdateReturning.current = [];
    subscribersResult.current = [];
    deliveryInsertResult.current = [];
    dbInsertCalls.length = 0;
    enqueueWebhookDeliveryMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validated updateDomain: commits the stage via the domains UPDATE', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tesSUCCESS' },
      },
    });
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainSet',
        requestBody: { op: 'updateDomain', domainDbId: 'dom-1' },
      },
    ];

    await processTxConfirmJob(makeJob(BASE_JOB));

    const domainUpdate = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(domainUpdate).toBeDefined();
    const set = domainUpdate!.set as Record<string, unknown>;
    expect(set.pendingAcceptedCredentials).toBeNull();
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('validated tec error updateDomain: drops the stage (no commit)', async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: 'tecNO_PERMISSION' },
      },
    });
    dbSelectResult.current = [
      {
        txType: 'PermissionedDomainSet',
        requestBody: { op: 'updateDomain', domainDbId: 'dom-1' },
      },
    ];

    await processTxConfirmJob(makeJob(BASE_JOB));

    const domainUpdate = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(domainUpdate).toBeDefined();
    const set = domainUpdate!.set as Record<string, unknown>;
    expect(set.pendingAcceptedCredentials).toBeNull();
    expect('acceptedCredentials' in set).toBe(false);
  });

  it('expired deleteDomain: drops pendingDeletion (no deletedAt)', async () => {
    stubs.clientRequest
      .mockRejectedValueOnce(new Error('txnNotFound'))
      .mockResolvedValueOnce({ result: { ledger_current_index: 125 } });

    // Shared row: sourceAddress for the expired-branch SELECT + domain
    // fields for the helper's SELECT.
    dbSelectResult.current = [
      {
        sourceAddress: 'rSource00000000000000000000000000',
        txType: 'PermissionedDomainDelete',
        requestBody: { op: 'deleteDomain', domainDbId: 'dom-1' },
      },
    ];

    await processTxConfirmJob(makeJob(BASE_JOB));

    const domainUpdate = dbUpdateCalls.find((u) => u.table === 'domains');
    expect(domainUpdate).toBeDefined();
    const set = domainUpdate!.set as Record<string, unknown>;
    expect(set.pendingDeletion).toBe(false);
    expect('deletedAt' in set).toBe(false);
  });
});
