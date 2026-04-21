// Spend policy enforcement service (Sprint 7, PLAN.md §9.1 #15).
//
// Per-client transaction amount limits. Two dimensions:
//
//   1. Per-tx limit — reject any single tx whose XRP amount exceeds
//      `spend_policies.max_xrp_per_tx_drops`. Cheap: one DB read (cached),
//      no concurrency issues (pure comparison).
//
//   2. Daily rolling limit — reject if the sum of XRP amounts across all
//      non-failed transactions in the last 24 hours plus the proposed tx
//      exceeds `spend_policies.daily_xrp_limit_drops`.
//
// Clients without a spend_policies row are unlimited (backward-compat).
// A row with `is_active=false` is also treated as unlimited. NULL on a
// limit column means "no limit" for that dimension.
//
// REVIEW.md H-2 fix: the daily check used to run `SELECT SUM + INSERT`
// non-atomically. Two concurrent requests at 90%-of-limit both read the
// same SUM, both passed, both inserted — the client silently exceeded
// their limit. Fix: authoritative atomic counter in Redis, seeded from
// the DB SUM on cold start. A Lua script does the check-and-increment
// in a single round-trip so no two requests can both see a pre-increment
// snapshot.
//
// Tradeoffs of the Redis-first model:
//   - Failed txs over-count. A tx that enforceSpendPolicy accepted but
//     that later fails on-ledger stays in the counter (the counter only
//     increments; it never decrements). This is conservative — the
//     client's available budget shrinks slightly. Rectified when the
//     counter's 24h TTL rolls over and the next request reseeds from
//     the DB (which filters out `status='failed'`).
//   - Redis unavailable → fall back to the old DB-only path. Loses
//     TOCTOU protection in that mode but keeps the service running.
//
// Token amount limits (non-XRP) are deferred — they require an oracle
// or price feed to be meaningful.

import { db, eq, schema, sql } from '@railforge/db';
import { logger } from '../logger.ts';
import { getRedis } from '../redis.ts';

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

// 24h rolling window. Matches the SQL interval in getDailySpend().
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Atomic check-and-increment. Returns one of:
 *   1  — accepted, counter incremented
 *   0  — rejected (would exceed limit)
 *   -1 — counter missing, caller must seed from DB and retry
 *
 * Why a Lua script: a naive GET + compare + INCRBY has the exact TOCTOU
 * race we're fixing. Redis executes Lua atomically on the single thread,
 * so the GET and INCRBY can't interleave with another client.
 */
const CHECK_AND_INCREMENT_SCRIPT = `
  local key = KEYS[1]
  local amount = tonumber(ARGV[1])
  local limit = tonumber(ARGV[2])
  local ttl = tonumber(ARGV[3])
  local current = redis.call("GET", key)
  if current == false then
    return -1
  end
  local currentNum = tonumber(current)
  if currentNum + amount > limit then
    return 0
  end
  redis.call("INCRBY", key, amount)
  if redis.call("TTL", key) < 0 then
    redis.call("EXPIRE", key, ttl)
  end
  return 1
`;

/**
 * Seed the counter if-and-only-if missing. Returns 1 if this call
 * performed the seed, 0 if another caller beat us to it. Either way
 * the counter exists after the call.
 */
const SEED_IF_MISSING_SCRIPT = `
  local key = KEYS[1]
  local seedValue = ARGV[1]
  local ttl = tonumber(ARGV[2])
  if redis.call("EXISTS", key) == 0 then
    redis.call("SET", key, seedValue, "EX", ttl)
    return 1
  end
  return 0
`;

function dailyCounterKey(clientId: string): string {
  return `railforge:spendpolicy:daily:${clientId}`;
}

/**
 * Fetch the active spend policy for a client. Returns null if no policy
 * exists or the policy is inactive (both mean "unlimited").
 *
 * Results are cached in-process for CACHE_TTL_MS to avoid a DB round-trip
 * on every transaction.
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
 * 24 hours. Returns 0n if no rows match. Used for initial Redis
 * seeding AND as a fallback when Redis is unavailable.
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
 * Attempt the atomic check-and-increment via Redis. Returns true if the
 * daily limit was not exceeded (and the counter has been incremented),
 * false if it would be exceeded (and the counter is unchanged).
 *
 * Handles cold-start seeding: if the counter is missing, compute the
 * real current spend from the DB and SETNX it, then retry the check.
 *
 * Throws if Redis is unreachable — the caller catches and falls back
 * to the unprotected DB-only path.
 */
async function tryAtomicCheckAndIncrement(
  clientId: string,
  amount: bigint,
  limit: bigint,
): Promise<boolean> {
  const redis = getRedis();
  const key = dailyCounterKey(clientId);

  const args = [amount.toString(), limit.toString(), DAILY_WINDOW_SECONDS.toString()];

  // First attempt. Hot path: counter already exists, one round-trip.
  let rc = Number(await redis.eval(CHECK_AND_INCREMENT_SCRIPT, 1, key, ...args));

  if (rc === -1) {
    // Counter missing — seed from DB and retry. Seeding is idempotent
    // via SEED_IF_MISSING_SCRIPT (SET NX EX), so two concurrent cold-
    // start requests resolve to the same baseline.
    const seedValue = (await getDailySpend(clientId)).toString();
    await redis.eval(SEED_IF_MISSING_SCRIPT, 1, key, seedValue, DAILY_WINDOW_SECONDS.toString());
    rc = Number(await redis.eval(CHECK_AND_INCREMENT_SCRIPT, 1, key, ...args));
    // If still -1, something catastrophic happened (Redis evicted the
    // key between our SET and our GET). Surface it — the caller's
    // catch will fall back to DB-only.
    if (rc === -1) {
      throw new Error('spend policy: counter missing after seed');
    }
  }

  return rc === 1;
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
    const limit = policy.dailyXrpLimitDrops;

    // REVIEW.md H-2 fix: try the atomic Redis path first. Fall back to
    // the old DB-only path only when Redis throws (unreachable) — a
    // rejected-by-Redis response is authoritative.
    try {
      const accepted = await tryAtomicCheckAndIncrement(clientId, amount, limit);
      if (!accepted) {
        logger.warn(
          { clientId, amountDrops, limit: limit.toString() },
          'spend policy: daily XRP limit exceeded (atomic)',
        );
        throw new SpendPolicyError(
          'daily_limit_exceeded',
          `Transaction would push daily XRP spend over limit of ${limit.toString()} drops`,
        );
      }
      return;
    } catch (err) {
      if (err instanceof SpendPolicyError) throw err;
      // Redis unavailable — fall through to degraded DB-only path.
      // Note: no `X-Spend-Policy-Mode: degraded` header because this
      // service is called from the service layer, not middleware. Ops
      // should alert on Redis connectivity instead.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), clientId },
        'spend policy: atomic check unavailable, falling back to DB-only (race-prone)',
      );
    }

    // Degraded fallback: the original (non-atomic) DB SUM check. Keeps
    // the service running when Redis is down, but the TOCTOU race the
    // atomic path protects against re-opens in this mode.
    const dailySpend = await getDailySpend(clientId);
    if (dailySpend + amount > limit) {
      logger.warn(
        {
          clientId,
          amountDrops,
          dailySpend: dailySpend.toString(),
          limit: limit.toString(),
        },
        'spend policy: daily XRP limit exceeded (DB fallback)',
      );
      throw new SpendPolicyError(
        'daily_limit_exceeded',
        `Transaction would push daily XRP spend to ${(dailySpend + amount).toString()} drops, exceeding limit of ${limit.toString()} drops`,
      );
    }
  }
}

/** Clear the in-process policy cache. Exported for tests. */
export function clearPolicyCache(): void {
  policyCache.clear();
}

/**
 * Decrement the client's daily spend counter by `amountDrops`. Called by
 * the txConfirmer when a tx that enforceSpendPolicy accepted transitions
 * to a terminal `failed` state (either pre-submission or on-ledger), so
 * the client gets their budget back instead of the counter over-counting
 * for the rest of the 24h window.
 *
 * REVIEW.md MED-04: before this, the counter was append-only — a
 * malicious client deliberately spamming failing transactions (bad
 * destination, `tecNO_DST`, intentionally-malformed MPT issuance, etc.)
 * could pin the daily budget at zero against legit traffic until the
 * 24h window rolled over. Now each failure refunds the counter.
 *
 * Never throws — best-effort. Wrapped in try/catch because:
 *   - The counter may not exist (policy wasn't active at enforcement time)
 *   - Redis may be down (we already tolerate that in the enforcement path)
 *   - DECRBY may drive the counter below zero on a race (harmless — it
 *     just means the client has a tiny slack window on reseed).
 */
export async function refundSpendCounter(clientId: string, amountDrops: string): Promise<void> {
  if (!amountDrops || amountDrops === '0') return;
  const policy = await getPolicy(clientId).catch(() => null);
  if (!policy || policy.dailyXrpLimitDrops === null) return;

  let amount: bigint;
  try {
    amount = BigInt(amountDrops);
  } catch {
    return; // malformed — nothing to refund
  }
  if (amount <= 0n) return;

  try {
    const redis = getRedis();
    const key = dailyCounterKey(clientId);
    // DECRBY is a no-op if the key is missing (it creates the key at 0
    // then decrements, resulting in -amount — which is wrong). Guard
    // with EXISTS so we don't synthesize a negative counter that would
    // later pass every check.
    const exists = await redis.exists(key);
    if (exists === 0) return;
    await redis.decrby(key, amount.toString());
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        clientId,
        amountDrops,
      },
      'spend policy: refund decrement failed (best-effort)',
    );
  }
}
