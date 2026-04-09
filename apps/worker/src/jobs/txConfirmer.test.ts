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
  current: [{ sourceAddress: 'rSource00000000000000000000000000' }],
};
// What `accounts.update().set().where().returning()` should resolve to.
// Empty array = "no funding row matched" — the most common path because
// most txs aren't funding txs.
const accountUpdateReturning = { current: [] as unknown[] };

vi.mock('@railforge/db', () => {
  const update = vi.fn((table: { __name: string }) => ({
    set: vi.fn((payload: unknown) => {
      const where = vi.fn(() => {
        dbUpdateCalls.push({ table: table.__name, set: payload });
        // The accounts UPDATE chains a .returning() — tx UPDATE doesn't.
        // We expose returning() on the same object so both call patterns
        // work without branching.
        return Object.assign(Promise.resolve(), {
          returning: vi.fn(async () => accountUpdateReturning.current),
        });
      });
      return { where };
    }),
  }));
  // Select for the sequencer-invalidate path (lookup sourceAddress by txId).
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => dbSelectResult.current),
      })),
    })),
  }));
  return {
    db: { update, select },
    schema: {
      transactions: {
        __name: 'transactions',
        id: 'id',
        sourceAddress: 'sourceAddress',
      },
      accounts: {
        __name: 'accounts',
        id: 'id',
        fundingTxId: 'fundingTxId',
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
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
}));

const { processTxConfirmJob, TxNotYetValidated } = await import('./txConfirmer.ts');

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
});
