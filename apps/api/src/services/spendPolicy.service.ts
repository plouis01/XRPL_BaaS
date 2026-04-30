// Spend policy enforcement service.
//
// USD-denominated transaction amount limits (migration 0019). The caller
// converts the proposed tx amount to USD cents BEFORE calling
// enforceSpendPolicy — this keeps oracle access concentrated in the
// surfaces that need it (payment.service for XRP/RLUSD) instead of
// every check.
//
// Two dimensions:
//
//   1. Per-tx limit — reject when amount > spend_policies.max_per_tx_usd_cents.
//      Cheap: one DB read (cached), no concurrency issues.
//
//   2. Daily rolling limit — atomic Redis counter in cents, seeded from the
//      DB SUM on cold start (REVIEW.md H-2). The seed converts historical
//      `transactions.amount_drops` × current XRP/USD rate ÷ 1_000_000;
//      RLUSD txs (no drops column) are missed by the seed, so an agent
//      could in principle get a slightly larger budget after a Redis
//      flush — acceptable trade-off for now since flushes are rare.
//
// Clients without a spend_policies row are unlimited (backward-compat).
// A row with `is_active=false` is also treated as unlimited. NULL on a
// limit column means "no limit" for that dimension.
//
// REVIEW.md H-2 fix: a naive `SELECT SUM + INSERT` was non-atomic. Two
// concurrent requests at 90%-of-limit both read the same SUM, both
// passed, both inserted — the client silently exceeded their limit.
// Fix: authoritative atomic counter in Redis. A Lua script does the
// check-and-increment in a single round-trip so no two requests can
// both see a pre-increment snapshot.
//
// Tradeoffs of the Redis-first model:
//   - Failed txs over-count. The counter only ever INCRs from the
//     enforcement path; refundSpendCounter on terminal `failed` rolls
//     the over-count back. The 24h TTL roll-over also reseeds from DB.
//   - Redis unavailable → fall back to the DB-only path. Loses TOCTOU
//     protection in that mode but keeps the service running.
//
// Asset coverage:
//   - XRP    → drops × XRP/USD rate ÷ 1_000_000 = cents (priceOracle.service)
//   - RLUSD  → value × 100 = cents (1:1 peg, no oracle)
//   - other IOU / MPT → out of scope; bounded by enforceTokenOpCount
//                       (a per-day op-count ceiling, not amount-based).

import { and, db, eq, isNull, schema, sql } from '@railforge/db';
import { logger } from '../logger.ts';
import { getRedis } from '../redis.ts';
import { getXrpUsdRateCents } from './priceOracle.service.ts';

/**
 * Resolution scope for a spend-policy lookup. 'agent' = a per-agent
 * override row was found (spend_policies.agent_id = agentId). 'client' =
 * fell through to the tenant-wide default (agent_id IS NULL). 'unlimited'
 * = no row of either kind, no caps applied.
 *
 * Counters (Redis keys) match the scope of the policy that resolved.
 */
export type PolicyScope = 'agent' | 'client' | 'unlimited';

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
  scope: PolicyScope;
  maxPerTxUsdCents: bigint | null;
  dailyLimitUsdCents: bigint | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
// Cache key composes both client and agent so a per-agent resolution and
// the same client's tenant-wide resolution don't collide.
const policyCache = new Map<string, CachedPolicy>();

function policyCacheKey(clientId: string, agentId: string | null): string {
  return agentId ? `${clientId}|${agentId}` : `${clientId}|*`;
}

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

// Redis key for the daily-spend counter. The agentId-null branch keeps
// the original (pre-agent) key shape so live counters survive the
// per-agent migration without resetting all tenants' budgets at deploy.
function dailyCounterKey(clientId: string, agentId: string | null): string {
  return agentId
    ? `railforge:spendpolicy:daily:${clientId}:agent:${agentId}`
    : `railforge:spendpolicy:daily:${clientId}`;
}

/**
 * Drop the in-process policy cache for one (client, agent) scope. Called
 * after a dashboard write so the next enforceSpendPolicy on this node
 * re-reads the row. Pass agentId=null to invalidate the tenant-wide
 * default. Other API nodes still serve the stale cap for up to
 * CACHE_TTL_MS — acceptable for an admin-set policy.
 *
 * NOTE: when an agent override is created or removed, callers must
 * invalidate BOTH the agent scope AND the client scope on the same node,
 * since enforcement may have cached the now-incorrect resolution.
 */
export function invalidateSpendPolicyCache(clientId: string, agentId: string | null = null): void {
  policyCache.delete(policyCacheKey(clientId, agentId));
}

/**
 * Read-only view of the client's current 24h XRP spend counter (in drops).
 * Returns "0" when no counter has been initialized yet (no XRP spend in
 * the window) and "0" on a Redis fault — callers that surface this to the
 * UI should treat it as a best-effort metric, not a billing source.
 */
export async function getDailySpendUsage(
  clientId: string,
  agentId: string | null = null,
): Promise<string> {
  try {
    const redis = getRedis();
    const raw = await redis.get(dailyCounterKey(clientId, agentId));
    if (!raw) return '0';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return '0';
    return raw;
  } catch (err) {
    logger.warn(
      { err, clientId, agentId },
      'spend policy: failed to read daily counter, reporting 0',
    );
    return '0';
  }
}

/**
 * Resolve the active spend policy for a (client, agent) pair.
 *
 * Resolution order:
 *   1. If agentId is set and a row exists with `(client_id=X, agent_id=Y)`
 *      and is_active, return it with scope='agent'.
 *   2. Else if a row exists with `(client_id=X, agent_id IS NULL)` and
 *      is_active, return it with scope='client'.
 *   3. Else scope='unlimited'.
 *
 * Caps that are NULL in the resolved row mean "no limit" for that axis.
 * Cached in-process per (client, agent) pair to avoid DB round-trips on
 * every tx; an `unlimited` resolution is also cached so cold-start
 * traffic for a client without a policy doesn't hammer the DB.
 */
export async function resolvePolicy(
  clientId: string,
  agentId: string | null = null,
): Promise<CachedPolicy> {
  const now = Date.now();
  const cacheKey = policyCacheKey(clientId, agentId);
  const cached = policyCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  // Single query that pulls BOTH the agent override (if any) AND the
  // client default in one round-trip. PostgreSQL planner: this is an
  // index range scan on (client_id, agent_id) plus a bounded fetch.
  const rows = await db
    .select({
      agentId: schema.spendPolicies.agentId,
      maxPerTxUsdCents: schema.spendPolicies.maxPerTxUsdCents,
      dailyLimitUsdCents: schema.spendPolicies.dailyLimitUsdCents,
      isActive: schema.spendPolicies.isActive,
    })
    .from(schema.spendPolicies)
    .where(
      agentId
        ? and(
            eq(schema.spendPolicies.clientId, clientId),
            // Either the agent's row OR the tenant default; the JS layer
            // picks the agent one first when both are returned.
            sql`(${schema.spendPolicies.agentId} = ${agentId} OR ${schema.spendPolicies.agentId} IS NULL)`,
          )
        : and(eq(schema.spendPolicies.clientId, clientId), isNull(schema.spendPolicies.agentId)),
    )
    // UNIQUE(client_id, agent_id) bounds this to at most 2 rows; the
    // explicit limit defends against runaway queries on a corrupted
    // index AND keeps the test mock disambiguating on `.limit()`.
    .limit(2);

  // Prefer an agent-scoped active row; fall back to client-scoped.
  const agentRow = agentId ? rows.find((r) => r.agentId === agentId && r.isActive) : null;
  const clientRow = rows.find((r) => r.agentId === null && r.isActive);
  const winner = agentRow ?? clientRow;
  const scope: PolicyScope = agentRow ? 'agent' : clientRow ? 'client' : 'unlimited';

  const policy: CachedPolicy = {
    scope,
    maxPerTxUsdCents: winner?.maxPerTxUsdCents ? BigInt(winner.maxPerTxUsdCents) : null,
    dailyLimitUsdCents: winner?.dailyLimitUsdCents ? BigInt(winner.dailyLimitUsdCents) : null,
    fetchedAt: now,
  };
  policyCache.set(cacheKey, policy);
  return policy;
}

/**
 * Query the rolling 24-hour XRP spend for the given (client, agent) scope.
 * Sums `transactions.amount_drops` for non-failed rows created in the last
 * 24 hours. Returns 0n if no rows match. Used for initial Redis seeding
 * AND as a fallback when Redis is unavailable.
 *
 * Scope filter:
 *   - agentId set     → `agent_id = Y` (per-agent counter seed)
 *   - agentId is null → `agent_id IS NULL` (client-counter seed: only
 *                       non-agent-key txs land in this bucket)
 *
 * Caveat: when an agent INHERITS the client policy (no per-agent row),
 * its txs hit the client counter at runtime but carry `agent_id != NULL`
 * in the DB. On client-counter cold-start they're missed by this seed
 * (the seed under-counts), so the client gets a slightly more generous
 * budget for the first window. Self-corrects when the next reseed sees
 * the matured rows or — more typically — never matters because the
 * counter is set the moment the first tx of the window comes in.
 */
async function getDailySpend(clientId: string, agentId: string | null): Promise<bigint> {
  const result = await db
    .select({
      total: sql<string>`COALESCE(SUM(${schema.transactions.amountDrops}::bigint), 0)`,
    })
    .from(schema.transactions)
    .where(
      agentId
        ? sql`${schema.transactions.clientId} = ${clientId}
            AND ${schema.transactions.agentId} = ${agentId}
            AND ${schema.transactions.createdAt} > now() - interval '24 hours'
            AND ${schema.transactions.status} != 'failed'
            AND ${schema.transactions.amountDrops} IS NOT NULL`
        : sql`${schema.transactions.clientId} = ${clientId}
            AND ${schema.transactions.agentId} IS NULL
            AND ${schema.transactions.createdAt} > now() - interval '24 hours'
            AND ${schema.transactions.status} != 'failed'
            AND ${schema.transactions.amountDrops} IS NOT NULL`,
    );
  const totalDrops = result[0]?.total ? BigInt(result[0].total) : 0n;
  if (totalDrops === 0n) return 0n;
  // Convert historical drops to USD cents at the CURRENT rate. Inaccurate
  // for windows that span large rate movements, but the seed only matters
  // on cold-start (counter missing) — the live check-and-increment path
  // uses the live rate per tx. RLUSD historical txs are missed entirely
  // (no drops column), so the seed under-counts when an agent has been
  // moving RLUSD; documented in the file header.
  const rate = await getXrpUsdRateCents();
  return (totalDrops * BigInt(rate.cents)) / 1_000_000n;
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
  agentId: string | null,
  amount: bigint,
  limit: bigint,
): Promise<boolean> {
  const redis = getRedis();
  const key = dailyCounterKey(clientId, agentId);

  const args = [amount.toString(), limit.toString(), DAILY_WINDOW_SECONDS.toString()];

  // First attempt. Hot path: counter already exists, one round-trip.
  let rc = Number(await redis.eval(CHECK_AND_INCREMENT_SCRIPT, 1, key, ...args));

  if (rc === -1) {
    // Counter missing — seed from DB and retry. Seeding is idempotent
    // via SEED_IF_MISSING_SCRIPT (SET NX EX), so two concurrent cold-
    // start requests resolve to the same baseline.
    const seedValue = (await getDailySpend(clientId, agentId)).toString();
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
 * Enforce the resolved spend policy for a proposed transaction.
 *
 * @param clientId  The authenticated client.
 * @param amountUsdCents  The transaction amount in USD cents. Caller is
 *   responsible for converting from the source asset:
 *     - XRP   → priceOracle.dropsToUsdCents(drops)
 *     - RLUSD → priceOracle.rlusdValueToUsdCents(value)
 *   Other IOU/MPT amounts can't be converted without a per-asset oracle;
 *   those callers route to enforceTokenOpCount instead.
 * @param agentId  When the calling key is agent-bound, the agent's UUID.
 *   Resolution prefers a per-agent row; otherwise falls back to the
 *   tenant-wide row. The Redis counter matches the resolved scope.
 *
 * @throws {SpendPolicyError} if the transaction would exceed a limit.
 *
 * No-op (returns immediately) when:
 *   - No row exists for either scope
 *   - The resolved row is_active=false
 *   - Both limit columns are NULL (no limits configured)
 */
export async function enforceSpendPolicy(
  clientId: string,
  amountUsdCents: bigint,
  agentId: string | null = null,
): Promise<void> {
  const policy = await resolvePolicy(clientId, agentId);
  if (policy.scope === 'unlimited') return;
  if (policy.maxPerTxUsdCents === null && policy.dailyLimitUsdCents === null) return;

  // Counter scope follows policy scope — an agent override uses the
  // agent counter, an inherited (client-scoped) policy uses the
  // shared tenant counter.
  const counterAgentId = policy.scope === 'agent' ? agentId : null;
  const amount = amountUsdCents;

  if (policy.maxPerTxUsdCents !== null && amount > policy.maxPerTxUsdCents) {
    logger.warn(
      {
        clientId,
        agentId,
        scope: policy.scope,
        amountUsdCents: amount.toString(),
        limit: policy.maxPerTxUsdCents.toString(),
      },
      'spend policy: per-tx USD limit exceeded',
    );
    throw new SpendPolicyError(
      'per_tx_limit_exceeded',
      `Transaction amount ${amount.toString()} cents exceeds per-transaction limit of ${policy.maxPerTxUsdCents.toString()} cents`,
    );
  }

  if (policy.dailyLimitUsdCents !== null) {
    const limit = policy.dailyLimitUsdCents;

    // REVIEW.md H-2 fix: try the atomic Redis path first. Fall back to
    // the old DB-only path only when Redis throws (unreachable) — a
    // rejected-by-Redis response is authoritative.
    try {
      const accepted = await tryAtomicCheckAndIncrement(clientId, counterAgentId, amount, limit);
      if (!accepted) {
        logger.warn(
          {
            clientId,
            agentId,
            scope: policy.scope,
            amountUsdCents: amount.toString(),
            limit: limit.toString(),
          },
          'spend policy: daily USD limit exceeded (atomic)',
        );
        throw new SpendPolicyError(
          'daily_limit_exceeded',
          `Transaction would push daily USD spend over limit of ${limit.toString()} cents`,
        );
      }
      return;
    } catch (err) {
      if (err instanceof SpendPolicyError) throw err;
      // Redis unavailable — fall through to degraded DB-only path.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          clientId,
          agentId,
        },
        'spend policy: atomic check unavailable, falling back to DB-only (race-prone)',
      );
    }

    // Degraded fallback: the original (non-atomic) DB SUM check. Keeps
    // the service running when Redis is down, but the TOCTOU race the
    // atomic path protects against re-opens in this mode.
    const dailySpend = await getDailySpend(clientId, counterAgentId);
    if (dailySpend + amount > limit) {
      logger.warn(
        {
          clientId,
          agentId,
          scope: policy.scope,
          amountUsdCents: amount.toString(),
          dailySpend: dailySpend.toString(),
          limit: limit.toString(),
        },
        'spend policy: daily USD limit exceeded (DB fallback)',
      );
      throw new SpendPolicyError(
        'daily_limit_exceeded',
        `Transaction would push daily USD spend to ${(dailySpend + amount).toString()} cents, exceeding limit of ${limit.toString()} cents`,
      );
    }
  }
}

/** Clear the in-process policy cache. Exported for tests. */
export function clearPolicyCache(): void {
  policyCache.clear();
}

// ── REVIEW.md MED-03 — per-day count limit for non-XRP ops ────────────────
//
// enforceSpendPolicy (above) only covers XRP-denominated txs because the
// amount it checks against is `amountDrops`. That leaves MPT / issued-
// currency / token-transfer / DEX-offer / AMM-deposit paths uncapped —
// a stolen key could drain those balances unchecked until manually
// revoked. Until we wire an oracle / price feed to do asset-denominated
// limits properly, we apply a nominal per-day COUNT ceiling as defense-
// in-depth.
//
// The limit is aggressive enough to catch abuse (bulk-draining scripts
// typically burst thousands of ops / minute) but lenient enough to not
// bite normal workloads. Configurable via TOKEN_OPS_DAILY_LIMIT env var.
//
// Redis-first with DB-free state: we just INCR a counter and let it
// expire at 24h. No seeding needed — a missing key means "fresh day,
// start at 0". Fails OPEN on Redis unavailability (same rationale as
// the XRP atomic path's DB fallback) so a Redis outage doesn't hard-
// block the API; the underlying revocation + key-age mitigations
// already bound the blast radius.

const TOKEN_OPS_DAILY_LIMIT_DEFAULT = 5000;

function getTokenOpsLimit(): number {
  const raw = process.env.TOKEN_OPS_DAILY_LIMIT;
  if (!raw) return TOKEN_OPS_DAILY_LIMIT_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return TOKEN_OPS_DAILY_LIMIT_DEFAULT;
  return n;
}

// Token-op counter key. Like dailyCounterKey, the agentId-null branch
// preserves the pre-agent shape so live counters survive deploy.
function tokenOpsKey(clientId: string, agentId: string | null): string {
  return agentId
    ? `railforge:spendpolicy:tokenops:${clientId}:agent:${agentId}`
    : `railforge:spendpolicy:tokenops:${clientId}`;
}

/**
 * Atomic INCR + EXPIRE for the token-op counter. REVIEW.md MED-16: the
 * prior implementation ran `INCR` and `EXPIRE` as two separate round-trips
 * gated by a JS `if (count === 1)` check. If the process crashed, the
 * connection dropped, or the EXPIRE call threw between them, the counter
 * persisted without a TTL forever — the client's daily quota never
 * reset, and the first time they burst past the limit they were locked
 * out until an operator manually `DEL`'d the key.
 *
 * Fix: a single Lua script does INCR followed by an EXPIRE guarded on
 * `TTL < 0` (i.e. unset). Redis guarantees Lua scripts run atomically on
 * the single event-loop thread, so no partial state is observable and no
 * crash between the two operations is possible. The `TTL < 0` branch also
 * rescues a pre-fix key that got stuck without a TTL — the next request
 * from that client re-arms the expiry.
 */
const TOKEN_OP_INCR_SCRIPT = `
  local cnt = redis.call("INCR", KEYS[1])
  if cnt == 1 or redis.call("TTL", KEYS[1]) < 0 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end
  return cnt
`;

/**
 * Enforce a daily count ceiling on non-XRP state-changing ops
 * (token transfer, MPT payment, issued-currency payment, DEX offer,
 * AMM deposit/withdraw). Throws SpendPolicyError('daily_limit_exceeded')
 * when the ceiling is crossed. Best-effort: silently no-ops on Redis
 * failure so a cache outage doesn't hard-block the API surface.
 *
 * Counter scope follows the resolved spend policy: an agent with its
 * own policy row gets a per-agent counter; an agent inheriting the
 * client default shares the tenant counter. Resolution is reused from
 * resolvePolicy so a single (client, agent) tuple has consistent
 * scope across XRP and non-XRP enforcement.
 */
export async function enforceTokenOpCount(
  clientId: string,
  agentId: string | null = null,
): Promise<void> {
  const limit = getTokenOpsLimit();
  // Agent's resolved scope decides which counter to bump. resolvePolicy
  // is cached so this is one map hit on the hot path.
  const policy = await resolvePolicy(clientId, agentId);
  const counterAgentId = policy.scope === 'agent' ? agentId : null;
  let count: number;
  try {
    const redis = getRedis();
    const key = tokenOpsKey(clientId, counterAgentId);
    count = Number(await redis.eval(TOKEN_OP_INCR_SCRIPT, 1, key, DAILY_WINDOW_SECONDS.toString()));
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        clientId,
        agentId,
      },
      'spend policy: token-op counter unavailable, failing open',
    );
    return;
  }
  if (count > limit) {
    logger.warn(
      { clientId, agentId, scope: policy.scope, count, limit },
      'spend policy: daily token-op count exceeded',
    );
    throw new SpendPolicyError('daily_limit_exceeded', `Daily token-op limit of ${limit} exceeded`);
  }
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
export async function refundSpendCounter(
  clientId: string,
  amountUsdCents: bigint,
  agentId: string | null = null,
): Promise<void> {
  if (amountUsdCents <= 0n) return;
  const policy = await resolvePolicy(clientId, agentId).catch(() => null);
  if (!policy || policy.scope === 'unlimited') return;
  if (policy.dailyLimitUsdCents === null) return;

  // Refund hits the same counter that enforcement incremented — agent
  // counter when policy resolved per-agent, client counter when inherited.
  const counterAgentId = policy.scope === 'agent' ? agentId : null;

  try {
    const redis = getRedis();
    const key = dailyCounterKey(clientId, counterAgentId);
    // DECRBY is a no-op if the key is missing (it creates the key at 0
    // then decrements, resulting in -amount — which is wrong). Guard
    // with EXISTS so we don't synthesize a negative counter that would
    // later pass every check.
    const exists = await redis.exists(key);
    if (exists === 0) return;
    await redis.decrby(key, amountUsdCents.toString());
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        clientId,
        agentId,
        amountUsdCents: amountUsdCents.toString(),
      },
      'spend policy: refund decrement failed (best-effort)',
    );
  }
}
