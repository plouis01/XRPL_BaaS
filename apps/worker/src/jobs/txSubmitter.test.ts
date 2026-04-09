// Unit tests for the txSubmitter job.
//
// Strategy:
//   - Mock @railforge/db so we don't need a live Postgres.
//   - Mock ../queues.ts to inject stub pool/sequencer/signer/queue.
//   - Drive the exported processTxSubmitJob() directly with a fake BullMQ Job.
//
// Coverage (the 5 most important behaviors):
//   1. Happy path: sequence fetched → LastLedgerSequence set → signed →
//      submitted → DB updated → confirmation enqueued
//   2. Signer has no key → row marked failed, sequencer NOT touched
//   3. tesSUCCESS → isSequenceError NOT triggered
//   4. tefPAST_SEQ → sequencer.invalidate() called, row marked failed
//   5. Network error → sequencer.invalidate() called, error rethrown for retry

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxSubmitJobData } from '../queues.ts';

// ── Mocks ───────────────────────────────────────────────────────────────────

// DB mock — chain ends in .where() which records the update payload.
const dbUpdateCalls: Array<{ table: unknown; set: unknown; where: unknown }> = [];
vi.mock('@railforge/db', () => {
  const update = vi.fn((table: unknown) => ({
    set: vi.fn((payload: unknown) => ({
      where: vi.fn((cond: unknown) => {
        dbUpdateCalls.push({ table, set: payload, where: cond });
        return Promise.resolve();
      }),
    })),
  }));
  return {
    db: { update },
    schema: { transactions: { id: 'id' } },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  };
});

// queues.ts mock — we inject controllable stubs for pool/sequencer/signer/
// and a confirm-queue spy.
const stubs = {
  sequencerNext: vi.fn(),
  sequencerInvalidate: vi.fn(),
  signerHasKey: vi.fn(),
  signerSign: vi.fn(),
  clientRequest: vi.fn(),
  confirmQueueAdd: vi.fn(),
};

vi.mock('../queues.ts', () => ({
  TX_SUBMIT_QUEUE: 'railforge:tx-submit',
  getSequencer: async () => ({
    getNextSequence: stubs.sequencerNext,
    invalidate: stubs.sequencerInvalidate,
  }),
  getSigner: () => ({
    hasKey: stubs.signerHasKey,
    sign: stubs.signerSign,
  }),
  getXrplPool: async () => ({
    getClient: () => ({ request: stubs.clientRequest }),
  }),
  getTxConfirmQueue: () => ({
    add: stubs.confirmQueueAdd,
  }),
}));

// Import AFTER the mocks are registered.
const { processTxSubmitJob } = await import('./txSubmitter.ts');

// ── Test helpers ────────────────────────────────────────────────────────────

function makeJob(data: TxSubmitJobData): Job<TxSubmitJobData> {
  return { data, id: 'job-1' } as unknown as Job<TxSubmitJobData>;
}

function baseJobData(): TxSubmitJobData {
  return {
    txId: 'tx-uuid-1',
    sourceAddress: 'rSource00000000000000000000000000',
    txJson: {
      TransactionType: 'Payment',
      Account: 'rSource00000000000000000000000000',
      Destination: 'rDest0000000000000000000000000000',
      Amount: '1000000',
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('processTxSubmitJob', () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    // Default stub behavior — each test overrides as needed.
    stubs.sequencerNext.mockResolvedValue(42);
    stubs.sequencerInvalidate.mockResolvedValue(undefined);
    stubs.signerHasKey.mockResolvedValue(true);
    stubs.signerSign.mockResolvedValue({
      tx_blob: 'DEADBEEF',
      hash: 'ABC123',
    });
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') {
        return { result: { ledger_current_index: 100 } };
      }
      if (req.command === 'submit') {
        return { result: { engine_result: 'tesSUCCESS' } };
      }
      throw new Error(`unexpected command ${req.command}`);
    });
    stubs.confirmQueueAdd.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: fetches sequence, signs, submits, updates DB, enqueues confirmation', async () => {
    await processTxSubmitJob(makeJob(baseJobData()));

    // Sequencer consulted exactly once.
    expect(stubs.sequencerNext).toHaveBeenCalledWith('rSource00000000000000000000000000');
    expect(stubs.sequencerNext).toHaveBeenCalledTimes(1);

    // Sequencer NOT invalidated on success.
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();

    // Signer called with Sequence/LastLedgerSequence/Fee filled in.
    expect(stubs.signerSign).toHaveBeenCalledTimes(1);
    const signArgs = stubs.signerSign.mock.calls[0]!;
    expect(signArgs[0]).toBe('rSource00000000000000000000000000');
    const signedTx = signArgs[1];
    expect(signedTx.Sequence).toBe(42);
    expect(signedTx.LastLedgerSequence).toBe(120); // 100 + LAST_LEDGER_OFFSET(20)
    expect(signedTx.Fee).toBe('12'); // DEFAULT_FEE_DROPS

    // Submit called with the signed blob.
    const submitCall = stubs.clientRequest.mock.calls.find((c) => c[0].command === 'submit');
    expect(submitCall?.[0]).toEqual({ command: 'submit', tx_blob: 'DEADBEEF' });

    // DB updated with submitted status + hash + blob.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('submitted');
    expect(update.txHash).toBe('ABC123');
    expect(update.txBlob).toBe('DEADBEEF');
    expect(update.resultCode).toBe('tesSUCCESS');
    expect(update.feeDrops).toBe('12');
    expect(update.submittedAt).toBeInstanceOf(Date);
    expect(update.errorMessage).toBeUndefined();

    // Confirmation enqueued with the correct horizon.
    expect(stubs.confirmQueueAdd).toHaveBeenCalledTimes(1);
    const confirmArgs = stubs.confirmQueueAdd.mock.calls[0]!;
    expect(confirmArgs[0]).toBe('confirm');
    expect(confirmArgs[1]).toEqual({
      txId: 'tx-uuid-1',
      txHash: 'ABC123',
      lastLedger: 120,
    });
  });

  it('signer missing key: marks failed pre-submit, does NOT touch sequencer', async () => {
    stubs.signerHasKey.mockResolvedValue(false);

    await processTxSubmitJob(makeJob(baseJobData()));

    // Sequencer was never asked — critical: a mis-enqueued job must not
    // consume a Sequence number.
    expect(stubs.sequencerNext).not.toHaveBeenCalled();
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
    expect(stubs.signerSign).not.toHaveBeenCalled();
    expect(stubs.clientRequest).not.toHaveBeenCalled();

    // DB updated with failed status and a generic error code.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('SIGNER_NO_KEY');
  });

  it('tefPAST_SEQ: invalidates sequencer and marks failed', async () => {
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') return { result: { ledger_current_index: 100 } };
      if (req.command === 'submit') return { result: { engine_result: 'tefPAST_SEQ' } };
      throw new Error('unexpected');
    });

    await processTxSubmitJob(makeJob(baseJobData()));

    // Sequencer invalidated — closes PLAN.md §9.2 #3.
    expect(stubs.sequencerInvalidate).toHaveBeenCalledWith('rSource00000000000000000000000000');
    expect(stubs.sequencerInvalidate).toHaveBeenCalledTimes(1);

    // DB row marked failed with the engine result code.
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('tefPAST_SEQ');
    expect(update.errorMessage).toMatch(/tefPAST_SEQ/);

    // Confirmation NOT enqueued (tx never accepted).
    expect(stubs.confirmQueueAdd).not.toHaveBeenCalled();
  });

  it('terPRE_SEQ: also invalidates sequencer (sequence gap)', async () => {
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') return { result: { ledger_current_index: 100 } };
      if (req.command === 'submit') return { result: { engine_result: 'terPRE_SEQ' } };
      throw new Error('unexpected');
    });

    await processTxSubmitJob(makeJob(baseJobData()));

    expect(stubs.sequencerInvalidate).toHaveBeenCalledTimes(1);
  });

  it('non-sequence tec error: marks failed but does NOT invalidate sequencer', async () => {
    // tecUNFUNDED_PAYMENT is a tx failure but NOT a sequence problem —
    // the sequence was consumed, cache is correct, no invalidation needed.
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') return { result: { ledger_current_index: 100 } };
      if (req.command === 'submit') return { result: { engine_result: 'tecUNFUNDED_PAYMENT' } };
      throw new Error('unexpected');
    });

    await processTxSubmitJob(makeJob(baseJobData()));

    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('tecUNFUNDED_PAYMENT');
  });

  it('network failure during submit: invalidates sequencer and rethrows for BullMQ retry', async () => {
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') return { result: { ledger_current_index: 100 } };
      if (req.command === 'submit') throw new Error('ECONNREFUSED');
      throw new Error('unexpected');
    });

    await expect(processTxSubmitJob(makeJob(baseJobData()))).rejects.toThrow(/ECONNREFUSED/);

    // Sequencer invalidated because we don't know if rippled consumed the seq.
    expect(stubs.sequencerInvalidate).toHaveBeenCalledTimes(1);

    // DB row marked failed with NETWORK_ERROR.
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('NETWORK_ERROR');
  });

  // Note: the "signed tx_blob never appears in logs" invariant is enforced
  // by the @railforge/logger REDACT_PATHS (tested in packages/logger/src/
  // index.test.ts). We deliberately do NOT spy on the logger here because
  // (a) it's redundant with those tests and (b) any future change that
  // imports a secret into a log line will be caught by the redact test suite.
});
