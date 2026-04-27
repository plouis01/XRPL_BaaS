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
// VISION.md agent launcher: applyAgentGrantOutcome's UPDATE returns the
// matched agents row(s). Empty = no pending agents row for this grant
// (standalone delegation), non-empty = "we won the transition".
const agentsUpdateReturning = { current: [] as unknown[] };
// VISION.md agent launcher revocation: applyDelegationRevocationOutcome's
// delegations UPDATE returning. Non-empty = the delegation transition
// succeeded; the helper then proceeds to the agents-row mirror update.
const delegationsUpdateReturning = { current: [] as unknown[] };

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
            if (table.__name === 'agents') return agentsUpdateReturning.current;
            if (table.__name === 'delegations') return delegationsUpdateReturning.current;
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
      agents: {
        __name: 'agents',
        id: 'id',
        agentAddress: 'agentAddress',
        status: 'status',
        delegationId: 'delegationId',
        pendingRevocation: 'pendingRevocation',
      },
      delegations: {
        __name: 'delegations',
        id: 'id',
        pendingRevocation: 'pendingRevocation',
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
  applyAgentGrantOutcome,
  applyCredentialAcceptOutcome,
  applyDelegationRevocationOutcome,
  applyDomainMutationOutcome,
  extractFundingAmount,
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

  it('REVIEW.md LOW-06: returns null when LedgerIndex is the ONLY signal (no Sequence/Issuer either)', () => {
    // Pre-LOW-06 this fell through to LedgerIndex as a last-ditch fallback.
    // That was wrong: LedgerIndex is the 256-bit ledger entry hash, NOT
    // the 192-bit MPT issuance id. A write under that value would poison
    // tokens.mpt_issuance_id and every later lookup by id would miss.
    // Fail closed so the operator sees the rippled version mismatch.
    //
    // (Subsequent update: the helper now ALSO derives the id from
    // Sequence+Issuer when those are present — see the derivation test
    // below. This test keeps the LOW-06 guard by withholding them.)
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
    expect(extractMptIssuanceIdFromMeta(result)).toBeNull();
  });

  it('derives the id from Sequence + Issuer when neither mpt_issuance_id nor MPTokenIssuanceID is present', () => {
    // Current rippled (+ xrpl.js v4.6 api v2) doesn't include the id in
    // CreatedNode.NewFields. The helper falls back to deriving it from
    // the spec: 4 bytes Sequence (big-endian) + 20 bytes decoded Issuer
    // AccountID. Cross-checked against live testnet account_objects.
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              LedgerIndex: 'DD8FAFA379A40CCAD7B05C09EBDD784F69A5A59654F6999FAF11060537E594AD',
              NewFields: {
                Flags: 98,
                Issuer: 'rs37MdXJEcn8k4BtzeT2sevgm6LaRAua8S',
                Sequence: 16777881,
              },
            },
          },
        ],
      },
    };
    // Sequence 16777881 = 0x01000299; decoded Issuer AccountID hex
    // confirmed against rippled's account_objects response for this addr.
    expect(extractMptIssuanceIdFromMeta(result)).toBe(
      '010002991759FFA931B36B53EB53C7E748A79AD62AE8E103',
    );
  });

  it('prefers a meta-provided mpt_issuance_id over the Sequence+Issuer derivation', () => {
    // If a future rippled version DOES populate mpt_issuance_id, trust
    // that directly — don't derive. The derivation is a fallback, not a
    // shadow verification path.
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              NewFields: {
                mpt_issuance_id: 'DEADBEEF',
                Issuer: 'rs37MdXJEcn8k4BtzeT2sevgm6LaRAua8S',
                Sequence: 16777881,
              },
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBe('DEADBEEF');
  });

  it('fails closed on an invalid Issuer address (no partial poison)', () => {
    // decodeAccountID throws on malformed r-addresses. The helper must
    // swallow and return null so tokens.mpt_issuance_id never receives a
    // garbage value.
    const result = {
      meta: {
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'MPTokenIssuance',
              NewFields: {
                Issuer: 'not-a-real-xrpl-address',
                Sequence: 12345,
              },
            },
          },
        ],
      },
    };
    expect(extractMptIssuanceIdFromMeta(result)).toBeNull();
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

// ── extractFundingAmount (rippled API v1/v2 shape handling) ────────────────

// Funds the is_funded flip in the confirmer. The actual bug this guards
// against: xrpl.js v4.6 defaults to api_version=2, which hides the Payment
// amount under tx_json.DeliverMax (the field was also renamed from Amount).
// Before the fix, confirmer read result.Amount only and always got undefined
// — every account stayed is_funded=false forever.

describe('extractFundingAmount (API v1/v2 shape parser)', () => {
  it("prefers meta.delivered_amount — it's the AUTHORITATIVE delivered amount (covers partial payments)", () => {
    const result = {
      meta: { delivered_amount: '20000000', TransactionResult: 'tesSUCCESS' },
      tx_json: { DeliverMax: '25000000', Amount: '30000000' },
      Amount: '35000000',
    };
    expect(extractFundingAmount(result)).toBe('20000000');
  });

  it('falls back to tx_json.DeliverMax for API v2 when delivered_amount is absent', () => {
    // This is the canonical v2-default shape for `tx`. Pre-fix, the
    // confirmer read result.Amount (undefined in v2) and skipped the flip.
    const result = {
      meta: { TransactionResult: 'tesSUCCESS' },
      tx_json: { DeliverMax: '10000000' },
    };
    expect(extractFundingAmount(result)).toBe('10000000');
  });

  it('falls back to tx_json.Amount when DeliverMax is missing (some tx types still use Amount)', () => {
    const result = {
      meta: { TransactionResult: 'tesSUCCESS' },
      tx_json: { Amount: '5000000' },
    };
    expect(extractFundingAmount(result)).toBe('5000000');
  });

  it('falls back to result.Amount for API v1 inline shape', () => {
    // api_version=1 or api_version omitted on older rippled versions:
    // tx fields live at the top of result, no tx_json wrapper.
    const result = {
      meta: { TransactionResult: 'tesSUCCESS' },
      Amount: '1000000',
    };
    expect(extractFundingAmount(result)).toBe('1000000');
  });

  it("returns null when the delivered amount is an issued-currency object (can't fund)", () => {
    // Funding payments are XRP only. If an MPT or IOU somehow lands here
    // we must NOT write the object into the reserve_balance text column.
    const result = {
      meta: {
        delivered_amount: {
          currency: 'USD',
          issuer: 'rIss0000000000000000000000000000',
          value: '10',
        },
      },
    };
    expect(extractFundingAmount(result)).toBeNull();
  });

  it('returns null when the delivered amount is an MPT object', () => {
    const result = {
      meta: { delivered_amount: { mpt_issuance_id: 'DEADBEEF', value: '42' } },
    };
    expect(extractFundingAmount(result)).toBeNull();
  });

  it('returns null on empty / non-object input', () => {
    expect(extractFundingAmount(null)).toBeNull();
    expect(extractFundingAmount(undefined)).toBeNull();
    expect(extractFundingAmount({})).toBeNull();
    expect(extractFundingAmount({ meta: null })).toBeNull();
  });
});

// VISION.md agent launcher: applyAgentGrantOutcome finalizes the agents.status
// flip on validation of the SignerListSet grant tx enqueued by provisionAgent.
// The contract it must honor:
//   - Only SignerListSet + requestBody.op='grantPermission' is touched; any
//     other tx type or op string is a no-op.
//   - Success flips status='active' only on rows currently status='pending'
//     (idempotent against replays).
//   - Failure flips status='failed' on pending rows so operators can see
//     they need review, rather than silently stuck at 'pending'.
//   - If no agents row matches (standalone grantPermission call without an
//     agent vault), the helper returns without throwing.
describe('applyAgentGrantOutcome (unit)', () => {
  const silentLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: test Logger stub
  } as any;

  beforeEach(() => {
    dbUpdateCalls.length = 0;
    dbSelectResult.current = [];
    agentsUpdateReturning.current = [];
    // Webhook fan-out state — reset so a prior test's subscribers /
    // deliveries don't leak into the next one. Without this, the new
    // 'agent.activated' / 'agent.failed' tests see stale insert rows.
    dbInsertCalls.length = 0;
    subscribersResult.current = [];
    deliveryInsertResult.current = [];
    enqueueWebhookDeliveryMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-SignerListSet tx: no agents UPDATE', async () => {
    dbSelectResult.current = [{ txType: 'Payment', requestBody: { op: 'sendPayment' } }];
    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(0);
  });

  it('missing tx row: no agents UPDATE', async () => {
    dbSelectResult.current = [];
    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(0);
  });

  it("SignerListSet with op='revokePermission' (revoke helper's domain): no agents UPDATE", async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'revokePermission', delegationId: 'deleg-1' },
      },
    ];
    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(0);
  });

  it('grantPermission with missing delegate in requestBody: no agents UPDATE', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission' },
      },
    ];
    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(0);
  });

  it("success path: flips agents.status='active'", async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT000000000' },
      },
    ];
    agentsUpdateReturning.current = [{ id: 'agent-1' }];

    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);

    const agentUpdate = dbUpdateCalls.find((u) => u.table === 'agents');
    expect(agentUpdate).toBeDefined();
    const set = agentUpdate?.set as Record<string, unknown>;
    expect(set?.status).toBe('active');
  });

  it("failure path: flips agents.status='failed' (visible for operator review)", async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT000000000' },
      },
    ];
    agentsUpdateReturning.current = [{ id: 'agent-1' }];

    await applyAgentGrantOutcome('tx-uuid-1', false, silentLog);

    const agentUpdate = dbUpdateCalls.find((u) => u.table === 'agents');
    expect(agentUpdate).toBeDefined();
    const set = agentUpdate?.set as Record<string, unknown>;
    expect(set?.status).toBe('failed');
  });

  it('no matching agents row (standalone delegation): UPDATE fires but noop, does not throw', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT000000000' },
      },
    ];
    agentsUpdateReturning.current = [];

    await expect(applyAgentGrantOutcome('tx-uuid-1', true, silentLog)).resolves.toBeUndefined();

    // UPDATE was attempted; idempotency guard (WHERE status='pending') returned zero rows.
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(1);
  });

  // Webhook fan-out (agent.activated / agent.failed). VISION.md follow-up
  // step #3: clients shouldn't have to poll GET /v1/agents/:id to see the
  // pending → active flip. The fan-out reuses the same SignerListSet tx
  // for client-id resolution (transactions → webhook_endpoints join).

  it("success path: fans out 'agent.activated' to subscribers with the agent payload", async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT000000000' },
      },
    ];
    agentsUpdateReturning.current = [{ id: 'agent-1' }];
    subscribersResult.current = [{ endpointId: 'ep-1' }, { endpointId: 'ep-2' }];
    deliveryInsertResult.current = [
      { id: 'del-1', endpointId: 'ep-1' },
      { id: 'del-2', endpointId: 'ep-2' },
    ];

    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);

    const deliveryInsert = dbInsertCalls.find((c) => c.table === 'webhook_deliveries');
    expect(deliveryInsert).toBeDefined();
    const values = deliveryInsert!.values as Array<Record<string, unknown>>;
    expect(values).toHaveLength(2);
    expect(values[0]?.eventType).toBe('agent.activated');
    const payload = values[0]?.payload as Record<string, unknown>;
    expect(payload.agent_id).toBe('agent-1');
    expect(payload.agent_address).toBe('rAGENT000000000');
    expect(payload.status).toBe('active');
    // CRITICAL: the payload must NEVER include the seed. The seed lives
    // only in accounts.master_key_ref after provisioning.
    expect('agent_seed' in payload).toBe(false);

    expect(enqueueWebhookDeliveryMock).toHaveBeenCalledTimes(2);
  });

  it("failure path: fans out 'agent.failed' (not 'agent.activated') with the right payload", async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT000000000' },
      },
    ];
    agentsUpdateReturning.current = [{ id: 'agent-1' }];
    subscribersResult.current = [{ endpointId: 'ep-1' }];
    deliveryInsertResult.current = [{ id: 'del-1', endpointId: 'ep-1' }];

    await applyAgentGrantOutcome('tx-uuid-1', false, silentLog);

    const deliveryInsert = dbInsertCalls.find((c) => c.table === 'webhook_deliveries');
    expect(deliveryInsert).toBeDefined();
    const values = deliveryInsert!.values as Array<Record<string, unknown>>;
    expect(values[0]?.eventType).toBe('agent.failed');
    const payload = values[0]?.payload as Record<string, unknown>;
    expect(payload.status).toBe('failed');
  });

  it('no subscribers: agent UPDATE still happens, fan-out is a no-op', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT000000000' },
      },
    ];
    agentsUpdateReturning.current = [{ id: 'agent-1' }];
    subscribersResult.current = []; // no one subscribed

    await applyAgentGrantOutcome('tx-uuid-1', true, silentLog);

    // Agent flip happened.
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(1);
    // No deliveries inserted, no enqueue.
    expect(dbInsertCalls.find((c) => c.table === 'webhook_deliveries')).toBeUndefined();
    expect(enqueueWebhookDeliveryMock).not.toHaveBeenCalled();
  });
});

// VISION.md agent launcher revocation: applyDelegationRevocationOutcome
// is the partner of revokePermission's staging. Beyond the existing
// delegation-row commit (covered above by integration with
// processTxConfirmJob), it now also mirrors the transition onto the
// paired agents row and fires `agent.revoked` on tesSUCCESS.
describe('applyDelegationRevocationOutcome — agent mirror (unit)', () => {
  const silentLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: test Logger stub
  } as any;

  beforeEach(() => {
    dbUpdateCalls.length = 0;
    dbInsertCalls.length = 0;
    dbSelectResult.current = [];
    delegationsUpdateReturning.current = [];
    agentsUpdateReturning.current = [];
    subscribersResult.current = [];
    deliveryInsertResult.current = [];
    enqueueWebhookDeliveryMock.mockClear();
  });

  it('non-revokePermission tx: no agents UPDATE', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'grantPermission', delegate: 'rAGENT' },
      },
    ];
    await applyDelegationRevocationOutcome('tx-uuid-1', true, silentLog);
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(0);
  });

  it('delegation already transitioned: no agents UPDATE, no fan-out', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'revokePermission', delegationId: 'deleg-1' },
      },
    ];
    delegationsUpdateReturning.current = []; // delegation idempotency guard returns 0 rows

    await applyDelegationRevocationOutcome('tx-uuid-1', true, silentLog);

    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(0);
    expect(enqueueWebhookDeliveryMock).not.toHaveBeenCalled();
  });

  it('standalone delegation (no paired agent): delegation flips, agent UPDATE no-op, no fan-out', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'revokePermission', delegationId: 'deleg-1' },
      },
    ];
    delegationsUpdateReturning.current = [{ id: 'deleg-1' }];
    agentsUpdateReturning.current = []; // no agent row paired with this delegation

    await applyDelegationRevocationOutcome('tx-uuid-1', true, silentLog);

    // Both UPDATEs were attempted (delegation + agents) but only the
    // delegation one matched — so no webhook fan-out.
    expect(dbUpdateCalls.filter((u) => u.table === 'agents')).toHaveLength(1);
    expect(enqueueWebhookDeliveryMock).not.toHaveBeenCalled();
  });

  it("success path with paired agent: flips agent + fans out 'agent.revoked'", async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'revokePermission', delegationId: 'deleg-1' },
      },
    ];
    delegationsUpdateReturning.current = [{ id: 'deleg-1' }];
    agentsUpdateReturning.current = [
      { id: 'agent-1', agentAddress: 'rAGENT00000000000000000000000' },
    ];
    subscribersResult.current = [{ endpointId: 'ep-1' }];
    deliveryInsertResult.current = [{ id: 'del-1', endpointId: 'ep-1' }];

    await applyDelegationRevocationOutcome('tx-uuid-1', true, silentLog);

    // Agent row was flipped to revoked.
    const agentUpdate = dbUpdateCalls.find((u) => u.table === 'agents');
    expect(agentUpdate).toBeDefined();
    const set = agentUpdate?.set as Record<string, unknown>;
    expect(set?.status).toBe('revoked');
    expect(set?.pendingRevocation).toBe(false);

    // Webhook fan-out fired with the right event type and payload.
    const deliveryInsert = dbInsertCalls.find((c) => c.table === 'webhook_deliveries');
    expect(deliveryInsert).toBeDefined();
    const values = deliveryInsert!.values as Array<Record<string, unknown>>;
    expect(values[0]?.eventType).toBe('agent.revoked');
    const payload = values[0]?.payload as Record<string, unknown>;
    expect(payload.agent_id).toBe('agent-1');
    expect(payload.status).toBe('revoked');
    expect(enqueueWebhookDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('failure path: clears agents.pendingRevocation, does NOT fan out a webhook', async () => {
    dbSelectResult.current = [
      {
        txType: 'SignerListSet',
        requestBody: { op: 'revokePermission', delegationId: 'deleg-1' },
      },
    ];
    delegationsUpdateReturning.current = [{ id: 'deleg-1' }];
    agentsUpdateReturning.current = [
      { id: 'agent-1', agentAddress: 'rAGENT00000000000000000000000' },
    ];

    await applyDelegationRevocationOutcome('tx-uuid-1', false, silentLog);

    const agentUpdate = dbUpdateCalls.find((u) => u.table === 'agents');
    const set = agentUpdate?.set as Record<string, unknown>;
    // status is left as-is ('active'); pendingRevocation cleared.
    expect(set?.pendingRevocation).toBe(false);
    expect(set?.status).toBeUndefined();

    // No webhook on failed revocation — the agent's effective state
    // didn't change, so there's nothing terminal to notify about.
    expect(dbInsertCalls.find((c) => c.table === 'webhook_deliveries')).toBeUndefined();
    expect(enqueueWebhookDeliveryMock).not.toHaveBeenCalled();
  });
});
