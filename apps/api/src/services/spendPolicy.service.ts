// Spend policy enforcement service (Sprint 7, PLAN.md §9.1 #15).
//
// Per-client transaction amount limits. Two dimensions:
//
//   1. Per-tx limit  — reject any single tx whose XRP amount exceeds
//      `spend_policies.max_xrp_per_tx_drops`. Cheap: one DB read (cached).
//
//   2. Daily rolling limit — reject if the sum of XRP amounts across all
//      non-failed transactions in the last 24 hours plus the proposed tx
//      exceeds `spend_policies.daily_xrp_limit_drops`. Slightly more
//      expensive: one SUM query on `transactions.amount_drops`.
//
// Clients without a spend_policies row are unlimited (backward-compat).
// A row with `is_active=false` is also treated as unlimited. NULL on a
// limit column means "no limit" for that dimension.
//
// Token amount limits (non-XRP) are deferred — they require an oracle
// or price feed to be meaningful. Only XRP-denominated amounts are
// checked here. Services that carry XRP amounts populate
// `transactions.amount_drops` at insert time; the daily sum query
// reads that column.

import { db, eq, schema, sql } from '@railforge/db';
import { logger } from '../logger.ts';

export class SpendPolicyError extends Error {
  constructor(
    public readonly code: 'per_tx_limit_exceeded' | 'daily_limit_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'SpendPolicyError';
  }
}

interface CachedPolicy {
  maxXrpPerTxDrops: bigint | null;
  dailyXrpLimitDrops: bigint | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const policyCache = new Map<string, CachedPolicy>();

/**
 * Fetch the active spend policy for a client. Returns null if no policy
 * exists or the policy is inactive (both mean "unlimited").
 *
 * Results are cached in-process for CACHE_TTL_MS to avoid a DB round-trip
 * on every transaction. The cache is bounded by the number of distinct
 * clients hitting this process — at Sprint 7 scale that's <100.
 */
async function getPolicy(clientId: string): Promise<CachedPolicy | null> {
  const now = Date.now();
  const cached = policyCache.get(clientId);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const rows = await db
    .select({
      maxXrpPerTxDrops: schema.spendPolicies.maxXrpPerTxDrops,
      dailyXrpLimitDrops: schema.spendPolicies.dailyXrpLimitDrops,
      isActive: schema.spendPolicies.isActive,
    })
    .from(schema.spendPolicies)
    .where(eq(schema.spendPolicies.clientId, clientId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) {
    policyCache.set(clientId, {
      maxXrpPerTxDrops: null,
      dailyXrpLimitDrops: null,
      fetchedAt: now,
    });
    return null;
  }

  const policy: CachedPolicy = {
    maxXrpPerTxDrops: row.maxXrpPerTxDrops ? BigInt(row.maxXrpPerTxDrops) : null,
    dailyXrpLimitDrops: row.dailyXrpLimitDrops ? BigInt(row.dailyXrpLimitDrops) : null,
    fetchedAt: now,
  };
  policyCache.set(clientId, policy);
  return policy;
}

/**
 * Query the rolling 24-hour XRP spend for a client. Sums
 * `transactions.amount_drops` for non-failed rows created in the last
 * 24 hours. Returns 0n if no rows match.
 */
async function getDailySpend(clientId: string): Promise<bigint> {
  const result = await db
    .select({
      total: sql<string>`COALESCE(SUM(${schema.transactions.amountDrops}::bigint), 0)`,
    })
    .from(schema.transactions)
    .where(
      sql`${schema.transactions.clientId} = ${clientId}
        AND ${schema.transactions.createdAt} > now() - interval '24 hours'
        AND ${schema.transactions.status} != 'failed'
        AND ${schema.transactions.amountDrops} IS NOT NULL`,
    );
  const total = result[0]?.total;
  return total ? BigInt(total) : 0n;
}

/**
 * Enforce the client's spend policy for a proposed XRP transaction.
 *
 * @param clientId  The authenticated client.
 * @param amountDrops  The XRP amount (in drops) that this transaction
 *   will move. Pass the string value from the request body.
 *
 * @throws {SpendPolicyError} if the transaction would exceed a limit.
 *
 * No-op (returns immediately) when:
 *   - The client has no spend_policies row
 *   - The row exists but is_active=false
 *   - Both limit columns are NULL (no limits configured)
 */
export async function enforceSpendPolicy(clientId: string, amountDrops: string): Promise<void> {
  const policy = await getPolicy(clientId);
  if (!policy) return;
  if (policy.maxXrpPerTxDrops === null && policy.dailyXrpLimitDrops === null) return;

  const amount = BigInt(amountDrops);

  if (policy.maxXrpPerTxDrops !== null && amount > policy.maxXrpPerTxDrops) {
    logger.warn(
      { clientId, amountDrops, limit: policy.maxXrpPerTxDrops.toString() },
      'spend policy: per-tx XRP limit exceeded',
    );
    throw new SpendPolicyError(
      'per_tx_limit_exceeded',
      `Transaction amount ${amountDrops} drops exceeds per-transaction limit of ${policy.maxXrpPerTxDrops.toString()} drops`,
    );
  }

  if (policy.dailyXrpLimitDrops !== null) {
    const dailySpend = await getDailySpend(clientId);
    if (dailySpend + amount > policy.dailyXrpLimitDrops) {
      logger.warn(
        {
          clientId,
          amountDrops,
          dailySpend: dailySpend.toString(),
          limit: policy.dailyXrpLimitDrops.toString(),
        },
        'spend policy: daily XRP limit exceeded',
      );
      throw new SpendPolicyError(
        'daily_limit_exceeded',
        `Transaction would push daily XRP spend to ${(dailySpend + amount).toString()} drops, exceeding limit of ${policy.dailyXrpLimitDrops.toString()} drops`,
      );
    }
  }
}

/** Clear the in-process cache. Exported for tests. */
export function clearPolicyCache(): void {
  policyCache.clear();
}
