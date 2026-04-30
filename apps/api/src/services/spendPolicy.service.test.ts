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
    schema: {
      spendPolicies: {
        clientId: 'clientId',
        agentId: 'agentId',
        maxXrpPerTxDrops: 'maxXrpPerTxDrops',
        dailyXrpLimitDrops: 'dailyXrpLimitDrops',
        isActive: 'isActive',
      },
      transactions: {
        clientId: 'clientId',
        agentId: 'agentId',
        createdAt: 'createdAt',
        status: 'status',
        amountDrops: 'amountDrops',
      },
    },
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
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

// ── Redis mock ─────────────────────────────────────────────────────────────
// REVIEW.md H-2: the service now uses Lua scripts for the atomic counter.
// We model eval() with a stateful fake keyed by which script was passed —
// enough to cover the three return codes (accept=1, reject=0, seed=-1).

const redisState = {
  counter: null as string | null,
  // If set, eval throws — exercises the Redis-down fallback path.
  shouldThrow: false,
};

vi.mock('../redis.ts', () => ({
  getRedis: () => ({
    eval: vi.fn(async (script: string, _keys: number, _key: string, ...args: string[]) => {
      if (redisState.shouldThrow) throw new Error('redis unreachable');
      const isCheckScript = script.includes('return -1');
      const isSeedScript = script.includes('SEED_IF_MISSING') || script.includes('EXISTS');

      if (isSeedScript && !isCheckScript) {
        // SEED_IF_MISSING script
        if (redisState.counter === null) {
          redisState.counter = args[0] ?? '0';
          return 1;
        }
        return 0;
      }

      // CHECK_AND_INCREMENT script
      if (redisState.counter === null) return -1;
      const amount = BigInt(args[0] ?? '0');
      const limit = BigInt(args[1] ?? '0');
      const current = BigInt(redisState.counter);
      if (current + amount > limit) return 0;
      redisState.counter = (current + amount).toString();
      return 1;
    }),
  }),
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
    redisState.counter = null;
    redisState.shouldThrow = false;
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
        agentId: null,
        maxXrpPerTxDrops: '1000000',
        dailyXrpLimitDrops: '10000000',
        isActive: false,
      },
    ];
    await expect(enforceSpendPolicy('client-1', '100000000')).resolves.toBeUndefined();
  });

  it('is a no-op when both limits are NULL (unlimited)', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: null,
        isActive: true,
      },
    ];
    await expect(enforceSpendPolicy('client-1', '100000000')).resolves.toBeUndefined();
  });

  it('throws per_tx_limit_exceeded when amount exceeds per-tx limit', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: '5000000',
        dailyXrpLimitDrops: null,
        isActive: true,
      },
    ];
    const err = await enforceSpendPolicy('client-1', '10000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as InstanceType<typeof SpendPolicyError>).code).toBe('per_tx_limit_exceeded');
  });

  it('allows a transaction exactly at the per-tx limit', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: '5000000',
        dailyXrpLimitDrops: null,
        isActive: true,
      },
    ];
    await expect(enforceSpendPolicy('client-1', '5000000')).resolves.toBeUndefined();
  });

  it('allows a transaction under the per-tx limit', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: '5000000',
        dailyXrpLimitDrops: null,
        isActive: true,
      },
    ];
    await expect(enforceSpendPolicy('client-1', '4999999')).resolves.toBeUndefined();
  });

  it('throws daily_limit_exceeded when cumulative spend would exceed daily limit', async () => {
    policySelectResult.current = [
      {
        agentId: null,
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
        agentId: null,
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
        agentId: null,
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

  // ── REVIEW.md H-2 — atomic Redis counter ─────────────────────────────────

  it('seeds the Redis counter from the DB on cold start', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '100000000',
        isActive: true,
      },
    ];
    // DB reports the client already spent 40M drops in the last 24h.
    dailySumResult.current = [{ total: '40000000' }];
    // Redis counter is missing — cold start.
    redisState.counter = null;

    // Request 10M drops: seed(40M) + amount(10M) = 50M ≤ limit(100M) → accept.
    await expect(enforceSpendPolicy('client-1', '10000000')).resolves.toBeUndefined();
    // Counter should now reflect 40M (seed) + 10M (this tx) = 50M.
    expect(redisState.counter).toBe('50000000');
  });

  it('atomic counter rejects when cumulative spend would exceed daily limit', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    // Redis already has 45M recorded (warm path — no DB seed).
    redisState.counter = '45000000';

    const err = await enforceSpendPolicy('client-1', '10000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as InstanceType<typeof SpendPolicyError>).code).toBe('daily_limit_exceeded');
    // Counter must be unchanged on rejection — no double-debit.
    expect(redisState.counter).toBe('45000000');
  });

  it('atomic counter prevents the concurrent-request race', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '100000000',
        isActive: true,
      },
    ];
    dailySumResult.current = [{ total: '0' }];
    redisState.counter = null;

    // Two concurrent requests at 60M each. Pre-fix, both would read SUM=0,
    // both would pass, cumulative spend would be 120M > 100M limit.
    // Post-fix, the second request sees the first's increment.
    const [r1, r2] = await Promise.allSettled([
      enforceSpendPolicy('client-1', '60000000'),
      enforceSpendPolicy('client-1', '60000000'),
    ]);

    // Exactly one must have been accepted and one rejected.
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    const rejected = [r1, r2].filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    // Counter reflects only the one that was accepted.
    expect(redisState.counter).toBe('60000000');
  });

  it('falls back to DB-only check when Redis is unreachable', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    dailySumResult.current = [{ total: '45000000' }];
    redisState.shouldThrow = true;

    // DB says 45M + proposed 10M = 55M > 50M limit → reject.
    const err = await enforceSpendPolicy('client-1', '10000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as InstanceType<typeof SpendPolicyError>).code).toBe('daily_limit_exceeded');
  });

  it('falls back to DB-only check and accepts when Redis down + under limit', async () => {
    policySelectResult.current = [
      {
        agentId: null,
        maxXrpPerTxDrops: null,
        dailyXrpLimitDrops: '50000000',
        isActive: true,
      },
    ];
    dailySumResult.current = [{ total: '10000000' }];
    redisState.shouldThrow = true;

    await expect(enforceSpendPolicy('client-1', '10000000')).resolves.toBeUndefined();
  });
});
