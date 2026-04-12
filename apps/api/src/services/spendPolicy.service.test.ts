// Unit tests for spendPolicy.service.ts (Sprint 7, PLAN.md §9.1 #15).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const policySelectResult = { current: [] as unknown[] };
const dailySumResult = { current: [{ total: '0' }] as unknown[] };

vi.mock('@railforge/db', () => {
  // getPolicy: db.select().from().where().limit() → policySelectResult
  // getDailySpend: db.select().from().where() → dailySumResult (no .limit)
  //
  // The mock returns an object from .where() that is BOTH a thenable
  // (resolves to dailySumResult) and has a .limit() method (resolves
  // to policySelectResult). This lets both call patterns work.
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const thenableWithLimit = Object.assign(Promise.resolve(dailySumResult.current), {
          limit: vi.fn(async () => policySelectResult.current),
        });
        return thenableWithLimit;
      }),
    })),
  }));

  return {
    db: { select },
    eq: vi.fn(),
    schema: {
      spendPolicies: {
        clientId: 'clientId',
        maxXrpPerTxDrops: 'maxXrpPerTxDrops',
        dailyXrpLimitDrops: 'dailyXrpLimitDrops',
        isActive: 'isActive',
      },
      transactions: {
        clientId: 'clientId',
        createdAt: 'createdAt',
        status: 'status',
        amountDrops: 'amountDrops',
      },
    },
    sql: vi.fn((...args: unknown[]) => args),
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
    warn: vi.fn(),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { SpendPolicyError, enforceSpendPolicy, clearPolicyCache } = await import(
  './spendPolicy.service.ts'
);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('enforceSpendPolicy', () => {
  beforeEach(() => {
    policySelectResult.current = [];
    dailySumResult.current = [{ total: '0' }];
    clearPolicyCache();
    vi.clearAllMocks();
  });

  it('is a no-op when no spend policy exists for the client', async () => {
    policySelectResult.current = [];
    await expect(enforceSpendPolicy('client-1', '100000000')).resolves.toBeUndefined();
  });

  it('is a no-op when the policy exists but is inactive', async () => {
    policySelectResult.current = [
      {
        maxXrpPerTxDrops: '1000000',
        dailyXrpLimitDrops: '10000000',
        isActive: false,
      },
    ];
    await expect(enforceSpendPolicy('client-1', '100000000')).resolves.toBeUndefined();
  });

  it('is a no-op when both limits are NULL (unlimited)', async () => {
    policySelectResult.current = [
      { maxXrpPerTxDrops: null, dailyXrpLimitDrops: null, isActive: true },
    ];
    await expect(enforceSpendPolicy('client-1', '100000000')).resolves.toBeUndefined();
  });

  it('throws per_tx_limit_exceeded when amount exceeds per-tx limit', async () => {
    policySelectResult.current = [
      { maxXrpPerTxDrops: '5000000', dailyXrpLimitDrops: null, isActive: true },
    ];
    const err = await enforceSpendPolicy('client-1', '10000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as InstanceType<typeof SpendPolicyError>).code).toBe('per_tx_limit_exceeded');
  });

  it('allows a transaction exactly at the per-tx limit', async () => {
    policySelectResult.current = [
      { maxXrpPerTxDrops: '5000000', dailyXrpLimitDrops: null, isActive: true },
    ];
    await expect(enforceSpendPolicy('client-1', '5000000')).resolves.toBeUndefined();
  });

  it('allows a transaction under the per-tx limit', async () => {
    policySelectResult.current = [
      { maxXrpPerTxDrops: '5000000', dailyXrpLimitDrops: null, isActive: true },
    ];
    await expect(enforceSpendPolicy('client-1', '4999999')).resolves.toBeUndefined();
  });

  it('throws daily_limit_exceeded when cumulative spend would exceed daily limit', async () => {
    policySelectResult.current = [
      {
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    dailySumResult.current = [{ total: '45000000' }];

    const err = await enforceSpendPolicy('client-1', '10000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as InstanceType<typeof SpendPolicyError>).code).toBe('daily_limit_exceeded');
  });

  it('allows when cumulative spend plus tx is exactly at the daily limit', async () => {
    policySelectResult.current = [
      {
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    dailySumResult.current = [{ total: '40000000' }];

    await expect(enforceSpendPolicy('client-1', '10000000')).resolves.toBeUndefined();
  });

  it('checks both per-tx AND daily limits (per-tx fires first)', async () => {
    policySelectResult.current = [
      {
        maxXrpPerTxDrops: '5000000',
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    dailySumResult.current = [{ total: '0' }];

    // Amount exceeds per-tx limit but is under daily limit.
    const err = await enforceSpendPolicy('client-1', '10000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as InstanceType<typeof SpendPolicyError>).code).toBe('per_tx_limit_exceeded');
  });
});
