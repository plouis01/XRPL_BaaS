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
//   2. Signer has no key (and no DB ref) → row marked failed, sequencer NOT touched
//   3. tesSUCCESS → isSequenceError NOT triggered
//   4. tefPAST_SEQ → sequencer.invalidate() called, row marked failed
//   5. Network error → sequencer.invalidate() called, error rethrown for retry
//   6. Cold-start lazy-load: signer hasKey=false but DB has master_key_ref →
//      loadKey is called and the job continues
//   7. ledger_current failure → sequencer.invalidate() called + retry

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxSubmitJobData } from '../queues.ts';

// ── Mocks ───────────────────────────────────────────────────────────────────

// DB mock — chain ends in .where() which records the update payload. The
// select() chain is for the cold-start seed lookup added in task 50.
//
// REVIEW.md HIGH-08: the double-submit guard adds a `.where(...).returning()`
// chain that the old mock didn't support. The first UPDATE (status='queued'
// → 'submitting') uses returning(); all later UPDATEs use the thenable path.
// `claimShouldReturn` controls whether the claim is simulated as won (array
// of one) or lost (empty array — another worker already claimed).
const dbUpdateCalls: Array<{ table: unknown; set: unknown; where: unknown }> = [];
const dbSelectResult = {
  current: [] as Array<{ masterKeyRef: string }>,
};
const claimShouldReturn = {
  current: [{ id: 'tx-uuid-1', txHash: null }] as Array<{
    id: string;
    txHash: string | null;
  }>,
};
let updateCallCount = 0;
vi.mock('@railforge/db', () => {
  const update = vi.fn((table: unknown) => ({
    set: vi.fn((payload: unknown) => ({
      where: vi.fn((cond: unknown) => {
        updateCallCount += 1;
        const call = updateCallCount;
        // First update in each job invocation is the HIGH-08 claim (status
        // 'queued' → 'submitting'). We do NOT push it into dbUpdateCalls
        // so the existing tests — which expect the status/hash payload at
        // index 0 — keep working. The claim is observed via updateCallCount.
        const isClaim =
          call === 1 &&
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { status?: string }).status === 'submitting';
        if (!isClaim) dbUpdateCalls.push({ table, set: payload, where: cond });
        const asPromise = Promise.resolve();
        return Object.assign(asPromise, {
          returning: vi.fn(async () =>
            isClaim ? claimShouldReturn.current : [{ id: 'tx-uuid-1' }],
          ),
        });
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
  return {
    db: { update, select },
    schema: {
      transactions: { id: 'id', status: 'status', txHash: 'txHash' },
      accounts: { address: 'address', masterKeyRef: 'masterKeyRef' },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  };
});

// queues.ts mock — we inject controllable stubs for pool/sequencer/signer/
// and a confirm-queue spy.
const stubs = {
  sequencerNext: vi.fn(),
  sequencerInvalidate: vi.fn(),
  signerHasKey: vi.fn(),
  signerLoadKey: vi.fn(),
  signerSign: vi.fn(),
  clientRequest: vi.fn(),
  confirmQueueAdd: vi.fn(),
};

vi.mock('../queues.ts', () => ({
  TX_SUBMIT_QUEUE: 'railforge-tx-submit',
  getSequencer: async () => ({
    getNextSequence: stubs.sequencerNext,
    invalidate: stubs.sequencerInvalidate,
  }),
  getSigner: () => ({
    hasKey: stubs.signerHasKey,
    loadKey: stubs.signerLoadKey,
    sign: stubs.signerSign,
  }),
  getXrplPool: async () => ({
    getClient: () => ({ request: stubs.clientRequest }),
  }),
  getTxConfirmQueue: () => ({
    add: stubs.confirmQueueAdd,
  }),
}));

// Confirmer hooks are imported by txSubmitter for the submit-reject
// branch (closes the temMALFORMED gap where agent rows would otherwise
// stay stuck in 'pending' / 'pending_revocation=true'). Mock them so
// tests assert call patterns without spinning up the full confirmer
// module (which imports xrpl + ioredis at load time).
const applyAgentGrantOutcomeMock = vi.fn();
const applyDelegationRevocationOutcomeMock = vi.fn();
vi.mock('./txConfirmer.ts', () => ({
  applyAgentGrantOutcome: (...args: unknown[]) => applyAgentGrantOutcomeMock(...args),
  applyDelegationRevocationOutcome: (...args: unknown[]) =>
    applyDelegationRevocationOutcomeMock(...args),
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
    dbSelectResult.current = [];
    updateCallCount = 0;
    claimShouldReturn.current = [{ id: 'tx-uuid-1', txHash: null }];
    // Default stub behavior — each test overrides as needed.
    stubs.sequencerNext.mockResolvedValue(42);
    stubs.sequencerInvalidate.mockResolvedValue(undefined);
    stubs.signerHasKey.mockResolvedValue(true);
    stubs.signerLoadKey.mockResolvedValue(undefined);
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
    applyAgentGrantOutcomeMock.mockReset().mockResolvedValue(undefined);
    applyDelegationRevocationOutcomeMock.mockReset().mockResolvedValue(undefined);
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

    // DB updated with submitted status + hash. The signed blob is
    // INTENTIONALLY not persisted — the hash alone is enough to look up
    // the tx on-ledger and the blob is signature material we don't keep.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('submitted');
    expect(update.txHash).toBe('ABC123');
    expect(update.txBlob).toBeUndefined();
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

  it('signer missing key AND no master_key_ref in DB: marks failed pre-submit, does NOT touch sequencer', async () => {
    stubs.signerHasKey.mockResolvedValue(false);
    dbSelectResult.current = []; // no row in accounts for this address

    await processTxSubmitJob(makeJob(baseJobData()));

    // Sequencer was never asked — critical: a mis-enqueued job must not
    // consume a Sequence number.
    expect(stubs.sequencerNext).not.toHaveBeenCalled();
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
    expect(stubs.signerLoadKey).not.toHaveBeenCalled();
    expect(stubs.signerSign).not.toHaveBeenCalled();
    expect(stubs.clientRequest).not.toHaveBeenCalled();

    // DB updated with failed status and a generic error code.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('SIGNER_NO_KEY');
  });

  it('cold-start lazy load: signer hasKey=false but DB has master_key_ref → loadKey called and pipeline continues', async () => {
    // Simulate a worker process that just booted: the in-memory signer
    // has no wallets, but the DB has the seed from when the API created
    // the account. Without task 50's fix, every first submission for an
    // address would fail with SIGNER_NO_KEY — the bug that motivated this
    // test.
    let loaded = false;
    stubs.signerHasKey.mockImplementation(async () => loaded);
    stubs.signerLoadKey.mockImplementation(async () => {
      loaded = true;
    });
    dbSelectResult.current = [{ masterKeyRef: 'sFAKE_SEED_PLACEHOLDER' }];

    await processTxSubmitJob(makeJob(baseJobData()));

    // loadKey was called with the address + the persisted ref.
    expect(stubs.signerLoadKey).toHaveBeenCalledWith(
      'rSource00000000000000000000000000',
      'sFAKE_SEED_PLACEHOLDER',
    );

    // Pipeline proceeded all the way to sign + submit + DB update.
    expect(stubs.signerSign).toHaveBeenCalledTimes(1);
    expect(stubs.confirmQueueAdd).toHaveBeenCalledTimes(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('submitted');
  });

  it('loadKey throws but signer still has no key: marks failed without consuming sequence', async () => {
    stubs.signerHasKey.mockResolvedValue(false);
    stubs.signerLoadKey.mockRejectedValue(
      new Error('master_key_ref does not derive to the requested address'),
    );
    dbSelectResult.current = [{ masterKeyRef: 'sCORRUPTED' }];

    await processTxSubmitJob(makeJob(baseJobData()));

    // loadKey was attempted, but failed.
    expect(stubs.signerLoadKey).toHaveBeenCalledTimes(1);
    // Sequence cache untouched.
    expect(stubs.sequencerNext).not.toHaveBeenCalled();
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
    // Row marked failed.
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

  it('getNextSequence failure: marks tx failed before BullMQ retry (no stuck submitting row)', async () => {
    // The previous code let getNextSequence throws propagate without
    // markFailed — leaving status='submitting' forever. The claim-once
    // gate then refused to re-claim on retry, stranding the row.
    // Regression guard for the fix in txSubmitter.ts that wraps the
    // sequencer call in markFailed.
    stubs.sequencerNext.mockRejectedValue(new Error('SequenceLockTimeout'));

    await expect(processTxSubmitJob(makeJob(baseJobData()))).rejects.toThrow(/SequenceLockTimeout/);

    // Sequence cache wasn't advanced (the throw happened mid-fetch).
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();

    // ledger_current was never reached — submit path never started.
    const ledgerCall = stubs.clientRequest.mock.calls.find(
      (c) => c[0].command === 'ledger_current',
    );
    expect(ledgerCall).toBeUndefined();

    // DB row marked failed with SEQUENCER_ERROR so retries no-op cleanly.
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('SEQUENCER_ERROR');
  });

  it('ledger_current failure: invalidates sequencer (rolls back consumed seq) and rethrows', async () => {
    // ledger_current is fetched AFTER getNextSequence, so a failure here
    // means the cache has been advanced but no tx will be sent. Without
    // task 54's fix the cache would stay advanced and the next submission
    // for this address would fail with terPRE_SEQ.
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') throw new Error('ECONNREFUSED');
      throw new Error(`unexpected command ${req.command}`);
    });

    await expect(processTxSubmitJob(makeJob(baseJobData()))).rejects.toThrow(/ECONNREFUSED/);

    // Sequencer was consulted (the cache advanced), then invalidated.
    expect(stubs.sequencerNext).toHaveBeenCalledTimes(1);
    expect(stubs.sequencerInvalidate).toHaveBeenCalledTimes(1);

    // Sign was never reached.
    expect(stubs.signerSign).not.toHaveBeenCalled();

    // DB row marked failed with NETWORK_ERROR.
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('NETWORK_ERROR');
  });

  it('sign failure: invalidates sequencer (rolls back consumed seq) and rethrows', async () => {
    // sign() is called AFTER getNextSequence + ledger_current, so a sign
    // failure also means the cache has been advanced but no tx will be sent.
    stubs.signerSign.mockRejectedValue(new Error('invalid_tx'));

    await expect(processTxSubmitJob(makeJob(baseJobData()))).rejects.toThrow(/invalid_tx/);

    expect(stubs.sequencerNext).toHaveBeenCalledTimes(1);
    expect(stubs.sequencerInvalidate).toHaveBeenCalledTimes(1);

    // submit was never reached.
    const submitCall = stubs.clientRequest.mock.calls.find((c) => c[0].command === 'submit');
    expect(submitCall).toBeUndefined();

    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('SIGN_FAILED');
  });

  it('terQUEUED is NOT a sequence error: cache stays warm', async () => {
    // terQUEUED means rippled accepted the tx into its own queue for a
    // future ledger — Sequence is correct, no invalidation needed. Task 55.
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') return { result: { ledger_current_index: 100 } };
      if (req.command === 'submit') return { result: { engine_result: 'terQUEUED' } };
      throw new Error('unexpected');
    });

    await processTxSubmitJob(makeJob(baseJobData()));

    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
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

  it('HIGH-08 double-submit guard: skips when row is not in queued state', async () => {
    // Simulate a retry after a successful submit — the conditional UPDATE
    // returns zero rows because status is no longer 'queued'.
    claimShouldReturn.current = [];

    await processTxSubmitJob(makeJob(baseJobData()));

    // Only the claim UPDATE happened (not recorded in dbUpdateCalls); no
    // downstream work.
    expect(updateCallCount).toBe(1);
    expect(dbUpdateCalls).toHaveLength(0);
    expect(stubs.sequencerNext).not.toHaveBeenCalled();
    expect(stubs.signerSign).not.toHaveBeenCalled();
    expect(stubs.clientRequest).not.toHaveBeenCalled();
    expect(stubs.confirmQueueAdd).not.toHaveBeenCalled();
  });

  // Note: the "signed tx_blob never appears in logs" invariant is enforced
  // by the @railforge/logger REDACT_PATHS (tested in packages/logger/src/
  // index.test.ts). We deliberately do NOT spy on the logger here because
  // (a) it's redundant with those tests and (b) any future change that
  // imports a secret into a log line will be caught by the redact test suite.

  it("submit-rejected (temMALFORMED): fires agent-state hooks so revocation/grant rows aren't stuck", async () => {
    // Closes the gap where applyDelegationRevocationOutcome only ran from
    // txConfirmer's validated-outcome branch. A tem* / tef* / tel*
    // rejection at submit time terminates the tx without ever reaching
    // the confirmer — leaving the agent's `pending_revocation=true` (or
    // `status='pending'` for grants) forever. The submitter now calls
    // both hooks with isSuccess=false on every non-tesSUCCESS engine
    // result; the hooks self-filter on requestBody.op so calling both
    // is safe.
    stubs.clientRequest.mockImplementation(async (req: { command: string }) => {
      if (req.command === 'ledger_current') return { result: { ledger_current_index: 100 } };
      if (req.command === 'submit') return { result: { engine_result: 'temMALFORMED' } };
      throw new Error('unexpected');
    });

    await processTxSubmitJob(makeJob(baseJobData()));

    // Tx was marked failed (pre-existing behavior, captured at index 0).
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe('failed');
    expect(update.resultCode).toBe('temMALFORMED');

    // Both agent-state hooks fired with isSuccess=false. These no-op
    // when the tx isn't a SignerListSet for an agent flow, so the
    // submitter calls both unconditionally.
    expect(applyAgentGrantOutcomeMock).toHaveBeenCalledTimes(1);
    expect(applyAgentGrantOutcomeMock).toHaveBeenCalledWith('tx-uuid-1', false, expect.anything());
    expect(applyDelegationRevocationOutcomeMock).toHaveBeenCalledTimes(1);
    expect(applyDelegationRevocationOutcomeMock).toHaveBeenCalledWith(
      'tx-uuid-1',
      false,
      expect.anything(),
    );

    // Confirmation polling is NOT enqueued for a rejected tx (it would
    // never validate, so the confirmer would just expire it).
    expect(stubs.confirmQueueAdd).not.toHaveBeenCalled();
  });

  it('submit-success: does NOT fire agent-state hooks (confirmer owns the validated outcome)', async () => {
    // The success path leaves the agent in 'pending' / 'pending_revocation'
    // intentionally — txConfirmer fires the hooks once the tx validates
    // on-ledger. Firing them here would race with the confirmer.
    await processTxSubmitJob(makeJob(baseJobData()));

    expect(applyAgentGrantOutcomeMock).not.toHaveBeenCalled();
    expect(applyDelegationRevocationOutcomeMock).not.toHaveBeenCalled();
    expect(stubs.confirmQueueAdd).toHaveBeenCalledTimes(1);
  });
});
