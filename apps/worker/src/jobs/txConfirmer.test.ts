// Unit tests for the txConfirmer polling job.
//
// Coverage (the 4 behaviors that actually matter for correctness):
//   1. Happy path: tx validated → update row with ledger_index + tesSUCCESS
//   2. Validated with tec error → update row with failed status
//   3. Tx not found AND before lastLedger → throw for BullMQ retry
//   4. Tx not found AND past lastLedger → invalidate sequencer, mark failed

import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TxConfirmJobData } from "../queues.ts";

// ── Mocks ───────────────────────────────────────────────────────────────────

const dbUpdateCalls: Array<{ set: unknown }> = [];
const dbSelectResult = {
  current: [{ sourceAddress: "rSource00000000000000000000000000" }],
};

vi.mock("@railforge/db", () => {
  const update = vi.fn(() => ({
    set: vi.fn((payload: unknown) => ({
      where: vi.fn(() => {
        dbUpdateCalls.push({ set: payload });
        return Promise.resolve();
      }),
    })),
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
        id: "id",
        sourceAddress: "sourceAddress",
      },
    },
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  };
});

const stubs = {
  sequencerInvalidate: vi.fn(),
  clientRequest: vi.fn(),
};

vi.mock("../queues.ts", () => ({
  TX_CONFIRM_QUEUE: "railforge:tx-confirm",
  getXrplPool: async () => ({
    getClient: () => ({ request: stubs.clientRequest }),
  }),
  getSequencer: async () => ({
    invalidate: stubs.sequencerInvalidate,
  }),
}));

const { processTxConfirmJob, TxNotYetValidated } =
  await import("./txConfirmer.ts");

// ── Test helpers ────────────────────────────────────────────────────────────

function makeJob(data: TxConfirmJobData): Job<TxConfirmJobData> {
  return { data, id: "job-1" } as unknown as Job<TxConfirmJobData>;
}

const BASE_JOB: TxConfirmJobData = {
  txId: "tx-uuid-1",
  txHash: "ABC123",
  lastLedger: 120,
};

describe("processTxConfirmJob", () => {
  beforeEach(() => {
    dbUpdateCalls.length = 0;
    dbSelectResult.current = [
      { sourceAddress: "rSource00000000000000000000000000" },
    ];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("validated tesSUCCESS: updates row with ledger_index and validated status", async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: "tesSUCCESS" },
      },
    });

    await processTxConfirmJob(makeJob(BASE_JOB));

    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe("validated");
    expect(update.resultCode).toBe("tesSUCCESS");
    expect(update.ledgerIndex).toBe(115);
    expect(update.confirmedAt).toBeInstanceOf(Date);
    expect(update.errorMessage).toBeUndefined();

    // Sequencer NOT touched on success.
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
  });

  it("validated with tec error: updates row with failed status and the result code", async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: true,
        ledger_index: 115,
        meta: { TransactionResult: "tecUNFUNDED_PAYMENT" },
      },
    });

    await processTxConfirmJob(makeJob(BASE_JOB));

    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe("failed");
    expect(update.resultCode).toBe("tecUNFUNDED_PAYMENT");
    expect(update.errorMessage).toMatch(/tecUNFUNDED_PAYMENT/);
    expect(update.ledgerIndex).toBe(115);
  });

  it("tx found but not yet validated: throws TxNotYetValidated for BullMQ retry", async () => {
    stubs.clientRequest.mockResolvedValueOnce({
      result: {
        validated: false,
        meta: { TransactionResult: "tesSUCCESS" },
      },
    });

    await expect(processTxConfirmJob(makeJob(BASE_JOB))).rejects.toThrow(
      TxNotYetValidated,
    );

    // No DB update — still propagating.
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it("tx not found AND current ledger still below lastLedger: throws for retry", async () => {
    // First call = tx lookup throws txnNotFound. Second call = ledger_current.
    stubs.clientRequest
      .mockRejectedValueOnce(new Error("txnNotFound"))
      .mockResolvedValueOnce({ result: { ledger_current_index: 110 } });

    await expect(processTxConfirmJob(makeJob(BASE_JOB))).rejects.toThrow(
      TxNotYetValidated,
    );

    expect(dbUpdateCalls).toHaveLength(0);
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
  });

  it("tx not found AND current ledger past lastLedger: marks LAST_LEDGER_EXPIRED and invalidates sequencer", async () => {
    stubs.clientRequest
      .mockRejectedValueOnce(new Error("txnNotFound"))
      .mockResolvedValueOnce({ result: { ledger_current_index: 125 } }); // > 120

    await processTxConfirmJob(makeJob(BASE_JOB));

    // DB row marked failed with LAST_LEDGER_EXPIRED.
    expect(dbUpdateCalls).toHaveLength(1);
    const update = dbUpdateCalls[0]!.set as Record<string, unknown>;
    expect(update.status).toBe("failed");
    expect(update.resultCode).toBe("LAST_LEDGER_EXPIRED");
    expect(update.errorMessage).toMatch(/expired/i);

    // Sequencer invalidated — the unconsumed Sequence is still on-ledger.
    expect(stubs.sequencerInvalidate).toHaveBeenCalledWith(
      "rSource00000000000000000000000000",
    );
  });

  it("expired with missing row: does NOT throw when sourceAddress lookup returns empty", async () => {
    dbSelectResult.current = [];
    stubs.clientRequest
      .mockRejectedValueOnce(new Error("txnNotFound"))
      .mockResolvedValueOnce({ result: { ledger_current_index: 125 } });

    // Must not throw — the DB update still proceeds without the invalidate.
    await processTxConfirmJob(makeJob(BASE_JOB));

    expect(dbUpdateCalls).toHaveLength(1);
    expect(stubs.sequencerInvalidate).not.toHaveBeenCalled();
  });
});
