// Unit tests for orphanReconciler.ts (Sprint 7, PLAN.md §9.2 G-1).
//
// The reconciler scans for stale `transactions.status='queued'` rows
// past a grace window, marks them as failed (result_code='ORPHANED'),
// and soft-deletes any unfunded `accounts` row whose fundingTxId
// matches. We mock @railforge/db to drive each branch deterministically.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────
//
// We model the bits of the Drizzle query builder we use in the
// reconciler:
//   - select().from(table).where(...).limit(N) → returns staleSelectResults
//   - update(table).set(...).where(...).returning(...) → returns either
//     transactionsClaimReturning or accountsDeleteReturning depending on
//     which table the call targeted (matched via the pgTable mock object).
//
// Per-call state is stashed in module-level arrays so tests can assert
// on what got read/written without spinning up Postgres.

const staleSelectResults = { current: [] as Array<Record<string, unknown>> };

// Each entry in this queue feeds the next claim UPDATE on transactions.
// Tests push the rows that should be returned (claim wins) or empty
// arrays (claim lost a race).
const transactionsClaimQueue: Array<Array<{ id: string }>> = [];

// Same shape for accounts soft-delete UPDATE.
const accountsDeleteQueue: Array<Array<{ id: string }>> = [];

// Same shape for the pending-agent sweep UPDATE.
const agentsClaimQueue: Array<Array<{ id: string; agentAddress: string }>> = [];

// Records every UPDATE so tests can assert on what the reconciler did.
interface RecordedUpdate {
  table: string;
  set: Record<string, unknown>;
}
const recordedUpdates: RecordedUpdate[] = [];

// FIFO queue of select results. The reconciler now does two distinct
// transactions selects per sweep: the original 'queued' scan, then the
// 'submitting' scan added for stranded-rows recovery. Tests push one or
// both result sets; an empty fallback covers the second call when the
// test only cares about the first. The counter lives at module scope so
// beforeEach can reset it between tests.
const submittingSelectResults: Array<Array<Record<string, unknown>>> = [];
const selectCallCount = { current: 0 };

vi.mock('@railforge/db', () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          selectCallCount.current += 1;
          // First call per sweep = the 'queued' scan (existing behavior).
          // Second call = the 'submitting' scan (new, defaults to []).
          if (selectCallCount.current === 1) return staleSelectResults.current;
          return submittingSelectResults.shift() ?? [];
        }),
      })),
    })),
  }));

  const update = vi.fn((table: { __name: string }) => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          recordedUpdates.push({ table: table.__name, set: values });
          if (table.__name === 'transactions') {
            return transactionsClaimQueue.shift() ?? [];
          }
          if (table.__name === 'accounts') {
            return accountsDeleteQueue.shift() ?? [];
          }
          if (table.__name === 'agents') {
            return agentsClaimQueue.shift() ?? [];
          }
          return [];
        }),
      })),
    })),
  }));

  return {
    db: { select, update },
    eq: vi.fn(),
    and: vi.fn((...args: unknown[]) => ({ and: args })),
    lt: vi.fn(),
    like: vi.fn(),
    isNull: vi.fn(),
    schema: {
      transactions: {
        __name: 'transactions',
        id: 'transactions.id',
        status: 'transactions.status',
        createdAt: 'transactions.createdAt',
        txType: 'transactions.txType',
        sourceAddress: 'transactions.sourceAddress',
      },
      accounts: {
        __name: 'accounts',
        fundingTxId: 'accounts.fundingTxId',
        isFunded: 'accounts.isFunded',
      },
      agents: {
        __name: 'agents',
        id: 'agents.id',
        status: 'agents.status',
        delegationId: 'agents.delegationId',
        createdAt: 'agents.createdAt',
        agentAddress: 'agents.agentAddress',
      },
    },
  };
});

vi.mock('../logger.ts', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ── Test setup ──────────────────────────────────────────────────────────────

let processOrphanReconcileSweep: typeof import('./orphanReconciler.ts').processOrphanReconcileSweep;

beforeEach(async () => {
  vi.resetModules();
  staleSelectResults.current = [];
  submittingSelectResults.length = 0;
  selectCallCount.current = 0;
  transactionsClaimQueue.length = 0;
  accountsDeleteQueue.length = 0;
  agentsClaimQueue.length = 0;
  recordedUpdates.length = 0;
  const mod = await import('./orphanReconciler.ts');
  processOrphanReconcileSweep = mod.processOrphanReconcileSweep;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('processOrphanReconcileSweep', () => {
  it('returns zero counts when no stale transactions are found', async () => {
    staleSelectResults.current = [];

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 0,
      accountsSoftDeleted: 0,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });
    // HIGH-09: the HSM pre-funding sweep runs unconditionally at the end.
    // With no matching rows it still records one accounts UPDATE.
    expect(recordedUpdates).toHaveLength(2);
    expect(recordedUpdates[0]?.table).toBe('accounts');
  });

  it('marks a single orphan failed and soft-deletes the linked account', async () => {
    staleSelectResults.current = [{ id: 'tx-1', txType: 'Payment', sourceAddress: 'rTreasury' }];
    transactionsClaimQueue.push([{ id: 'tx-1' }]);
    accountsDeleteQueue.push([{ id: 'acct-1' }]);

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 1,
      accountsSoftDeleted: 1,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });

    // Three updates: transactions (mark failed), accounts (soft-delete),
    // and the HIGH-09 HSM pre-funding sweep (another accounts UPDATE).
    expect(recordedUpdates).toHaveLength(4);
    expect(recordedUpdates[0]?.table).toBe('transactions');
    expect(recordedUpdates[0]?.set).toMatchObject({
      status: 'failed',
      resultCode: 'ORPHANED',
    });
    expect(recordedUpdates[0]?.set.errorMessage).toMatch(/never enqueued/i);
    expect(recordedUpdates[0]?.set.submittedAt).toBeInstanceOf(Date);

    expect(recordedUpdates[1]?.table).toBe('accounts');
    expect(recordedUpdates[1]?.set).toHaveProperty('deletedAt');
    expect(recordedUpdates[1]?.set.deletedAt).toBeInstanceOf(Date);
  });

  it('marks an orphan failed without soft-deleting when no account is linked', async () => {
    // E.g. an orphaned token-issuance tx, where there's no `accounts.fundingTxId == tx.id`.
    staleSelectResults.current = [
      { id: 'tx-2', txType: 'MPTokenIssuanceCreate', sourceAddress: 'rIssuer' },
    ];
    transactionsClaimQueue.push([{ id: 'tx-2' }]);
    accountsDeleteQueue.push([]); // No linked accounts row.

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 1,
      accountsSoftDeleted: 0,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });
    // Both per-orphan UPDATEs + the HIGH-09 HSM pre-funding sweep = 3.
    expect(recordedUpdates).toHaveLength(4);
    expect(recordedUpdates[1]?.table).toBe('accounts');
  });

  it('skips a row when the claim UPDATE returns zero (concurrent sweep won the race)', async () => {
    staleSelectResults.current = [
      { id: 'tx-3', txType: 'Payment', sourceAddress: 'rA' },
      { id: 'tx-4', txType: 'Payment', sourceAddress: 'rB' },
    ];
    // First row: claim lost race, returns []. Second row: claim wins.
    transactionsClaimQueue.push([], [{ id: 'tx-4' }]);
    // Only the second orphan triggers an accounts soft-delete.
    accountsDeleteQueue.push([{ id: 'acct-4' }]);

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 1,
      accountsSoftDeleted: 1,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });
    // Updates recorded: tx-3 claim attempt (returned []), tx-4 claim
    // (returned id), accounts soft-delete (returned id), + the HIGH-09
    // HSM pre-funding sweep at the end.
    const tableSequence = recordedUpdates.map((u) => u.table);
    expect(tableSequence).toEqual([
      'transactions',
      'transactions',
      'accounts',
      'accounts', // HIGH-09 HSM pre-funding sweep
      'agents', // pending-agent sweep
    ]);
  });

  it('processes multiple orphans in a single sweep', async () => {
    staleSelectResults.current = [
      { id: 'tx-a', txType: 'Payment', sourceAddress: 'rA' },
      { id: 'tx-b', txType: 'Payment', sourceAddress: 'rB' },
      { id: 'tx-c', txType: 'OfferCreate', sourceAddress: 'rC' },
    ];
    transactionsClaimQueue.push([{ id: 'tx-a' }], [{ id: 'tx-b' }], [{ id: 'tx-c' }]);
    accountsDeleteQueue.push([{ id: 'acct-a' }], [{ id: 'acct-b' }], []); // tx-c has no account

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 3,
      accountsSoftDeleted: 2,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });
    // 3 transactions UPDATEs + 3 per-orphan accounts UPDATEs + 1 HSM
    // pre-funding sweep at the end.
    expect(recordedUpdates).toHaveLength(8);
  });

  it('honors the gracePeriodMs override (smoke check that the parameter wires through)', async () => {
    staleSelectResults.current = [];
    // Custom grace period — the underlying SELECT mock doesn't actually
    // filter, but we want to make sure the override is accepted and the
    // sweep doesn't throw.
    const result = await processOrphanReconcileSweep(60_000);
    expect(result).toEqual({
      orphanedCount: 0,
      accountsSoftDeleted: 0,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });
  });

  it('HIGH-09: soft-deletes pending-<uuid> accounts that never got a funding tx', async () => {
    // The HSM sweep soft-deletes accounts whose address starts with
    // 'pending-' and have NULL fundingTxId — these are rows where
    // generateInHsm failed permanently and the tx-based sweep can't
    // reach them (no fundingTxId to match on).
    staleSelectResults.current = [];
    // Queue one row for the HSM-sweep UPDATE (index 0 since no earlier
    // per-orphan updates precede it in this test).
    accountsDeleteQueue.push([{ id: 'acct-hsm-orphan-1' }]);

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 0,
      accountsSoftDeleted: 0,
      hsmOrphansSoftDeleted: 1,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 0,
    });
    expect(recordedUpdates).toHaveLength(2);
    expect(recordedUpdates[0]?.table).toBe('accounts');
    expect(recordedUpdates[0]?.set).toHaveProperty('deletedAt');
  });

  it('marks a stranded-submitting tx failed past the submitting grace window', async () => {
    // Closes the gap left by HIGH-08's claim-once gate: a tx claimed
    // (queued → submitting) but never submitted is stranded forever
    // because BullMQ retries refuse to re-claim non-'queued' rows. The
    // sweep finds it past SUBMITTING_GRACE_PERIOD_MS and marks it
    // failed so a fresh idempotency-keyed retry can take over.
    staleSelectResults.current = []; // No 'queued' orphans.
    submittingSelectResults.push([
      { id: 'tx-stranded', txType: 'SignerListSet', sourceAddress: 'rParent' },
    ]);
    transactionsClaimQueue.push([{ id: 'tx-stranded' }]);

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 0,
      accountsSoftDeleted: 0,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 1,
      pendingAgentsOrphanedCount: 0,
    });
    // The HSM accounts UPDATE always runs unconditionally + the
    // stranded-submitting transactions UPDATE = 2 total.
    expect(recordedUpdates).toHaveLength(3);
    const txUpdate = recordedUpdates.find((u) => u.table === 'transactions');
    expect(txUpdate?.set).toMatchObject({
      status: 'failed',
      resultCode: 'STRANDED_SUBMITTING',
    });
    expect(txUpdate?.set.errorMessage).toMatch(/never reached rippled/i);
  });

  it('skips a stranded-submitting row when the claim returns zero (concurrent sweep won)', async () => {
    staleSelectResults.current = [];
    submittingSelectResults.push([{ id: 'tx-stranded', txType: 'Payment', sourceAddress: 'rA' }]);
    transactionsClaimQueue.push([]); // Lost the claim race.

    const result = await processOrphanReconcileSweep();

    expect(result.submittingOrphanedCount).toBe(0);
    // One transactions UPDATE (the claim attempt that returned []) +
    // the unconditional HSM accounts UPDATE + the unconditional
    // pending-agents UPDATE.
    expect(recordedUpdates).toHaveLength(3);
  });

  it('marks pending agents with no delegation_id as failed', async () => {
    // provisionAgent commits the agent row outside grantPermission's
    // transaction. If grantPermission throws, the agent row is left
    // with status='pending', delegation_id=NULL, and no on-ledger work
    // queued. The sweep finds these past PENDING_AGENT_GRACE_PERIOD_MS
    // and marks them failed so the dashboard surfaces the terminal
    // state instead of a forever-pending row.
    staleSelectResults.current = [];
    agentsClaimQueue.push([
      { id: 'agent-orphan-1', agentAddress: 'rOrphanAgent' },
      { id: 'agent-orphan-2', agentAddress: 'rOrphanAgent2' },
    ]);

    const result = await processOrphanReconcileSweep();

    expect(result).toEqual({
      orphanedCount: 0,
      accountsSoftDeleted: 0,
      hsmOrphansSoftDeleted: 0,
      submittingOrphanedCount: 0,
      pendingAgentsOrphanedCount: 2,
    });
    // Sweep order: HSM accounts UPDATE, then agents UPDATE.
    const agentsUpdate = recordedUpdates.find((u) => u.table === 'agents');
    expect(agentsUpdate?.set).toMatchObject({ status: 'failed' });
    expect(agentsUpdate?.set.revokedAt).toBeInstanceOf(Date);
  });
});
