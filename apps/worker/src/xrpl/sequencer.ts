// Distributed sequence-number coordinator. Prevents two workers from grabbing
// the same Sequence for one account when concurrent requests are submitted.
//
// Algorithm (PLAN.md §4.2, hardened per Sprint 1 security review):
//   1. Acquire a per-address Redis lock via SET NX EX with a fenced token.
//   2. Compute the next Sequence — using the cached value if available,
//      otherwise fetching from rippled (with a HARD timeout below the lock TTL).
//   3. Atomically write the incremented cache via a Lua script that ALSO
//      verifies we still own the lock token. This is the fence: if our lock
//      expired and another worker grabbed it, the cache write is silently
//      dropped — we never clobber another worker's state.
//   4. Release the lock via Lua compare-and-delete.
//
// Why the Lua fence matters (CRITICAL Sprint 1 finding):
//   Without it, the GET → compute → SET window is not atomic w.r.t. lock
//   ownership. If rippled stalls past LOCK_TTL_SECONDS, the lock auto-expires,
//   another worker grabs it and writes its own sequence, then the original
//   worker finishes and overwrites the new state with a stale value. Two
//   workers then sign with the same Sequence and the second tx is rejected
//   on-ledger (or worse, both succeed and one is replayed).
//
// CRITICAL: never bypass this. Direct client.submit() calls in
// route handlers will collide on the same Sequence under load.

import type { Redis } from "ioredis";
import type { XrplClientPool } from "./client.ts";

const LOCK_TTL_SECONDS = 5;
const CACHE_TTL_SECONDS = 30;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 40; // ~2s total wait

// Hard cap on the rippled account_info call. MUST be strictly less than
// LOCK_TTL_SECONDS so that any in-flight request is guaranteed to either
// finish or fail before the lock auto-expires. The fence below is the
// safety net for the case where this timeout is misconfigured or removed.
const LEDGER_FETCH_TIMEOUT_MS = 3_000;

export class SequenceLockTimeout extends Error {
  constructor(address: string) {
    super(`Timed out acquiring sequence lock for ${address}`);
    this.name = "SequenceLockTimeout";
  }
}

export class LedgerFetchTimeout extends Error {
  constructor(address: string) {
    super(`Timed out fetching account_info for ${address}`);
    this.name = "LedgerFetchTimeout";
  }
}

/**
 * Lua script that compares the current lock token before writing the new
 * cached sequence. Three return values:
 *   1 — wrote the new cache value (we still own the lock)
 *   0 — token mismatch (another worker took the lock); cache NOT written
 *  -1 — token mismatch AND cache key was missing (defensive — same handling)
 *
 * This is the FENCE that prevents stale-write races when the lock expires
 * mid-operation. See the file header for context.
 */
const FENCED_CACHE_WRITE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
    return 1
  else
    return 0
  end
`;

/**
 * Lua script for compare-and-delete on lock release. Atomic — only deletes
 * the key if it still holds our token.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export class TxSequencer {
  constructor(
    private redis: Redis,
    private xrplPool: XrplClientPool,
  ) {}

  /**
   * Returns the next Sequence number to use for `address` and atomically
   * advances the cached counter so the next caller gets seq+1.
   *
   * Throws {@link SequenceLockTimeout} if the lock can't be acquired within
   * the retry budget. Callers should map this to HTTP 429.
   *
   * Throws {@link LedgerFetchTimeout} if rippled doesn't respond in time —
   * lock is released, caller can retry.
   */
  async getNextSequence(address: string): Promise<number> {
    const lockKey = `railforge:seq:lock:${address}`;
    const cacheKey = `railforge:seq:${address}`;
    const lockToken = `${process.pid}-${Date.now()}-${Math.random()}`;

    // Acquire lock with bounded retry. Lock contention is expected under load
    // and should not throw immediately — but it must not loop forever.
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      const acquired = await this.redis.set(
        lockKey,
        lockToken,
        "EX",
        LOCK_TTL_SECONDS,
        "NX",
      );
      if (acquired === "OK") {
        try {
          return await this.computeAndAdvance(
            address,
            lockKey,
            cacheKey,
            lockToken,
          );
        } finally {
          await this.releaseLock(lockKey, lockToken);
        }
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }

    throw new SequenceLockTimeout(address);
  }

  /**
   * Drops the cached sequence for an address. Call this whenever a tx for
   * `address` fails with a sequence-related XRPL engine result (tefPAST_SEQ,
   * terPRE_SEQ, etc.) so the next call re-fetches from the ledger.
   */
  async invalidate(address: string): Promise<void> {
    await this.redis.del(`railforge:seq:${address}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // internals
  // ─────────────────────────────────────────────────────────────────────────

  private async computeAndAdvance(
    address: string,
    lockKey: string,
    cacheKey: string,
    lockToken: string,
  ): Promise<number> {
    const cached = await this.redis.get(cacheKey);
    let next: number;

    // Strict integer parse — refuse "42abc" / "NaN" / etc. The cached value
    // could only become invalid via Redis bitrot or a key collision, but if
    // it does, we silently fall back to a fresh ledger fetch rather than
    // poisoning every future caller.
    if (cached !== null && /^\d+$/.test(cached)) {
      next = Number.parseInt(cached, 10);
    } else {
      next = await this.fetchSequenceFromLedger(address);
    }

    // FENCED write: only updates the cache if we still hold the lock token.
    // If our lock expired during fetchSequenceFromLedger, this write is a
    // silent no-op and the worker that took over has the authoritative state.
    const wrote = (await this.redis.eval(
      FENCED_CACHE_WRITE_SCRIPT,
      2,
      lockKey,
      cacheKey,
      lockToken,
      String(next + 1),
      String(CACHE_TTL_SECONDS),
    )) as number;

    if (wrote !== 1) {
      // Lock was lost mid-operation — our `next` value is stale. The caller
      // should NOT use it. Throw and let the caller retry, which will re-
      // acquire the lock and read the now-correct cache.
      throw new SequenceLockTimeout(address);
    }

    return next;
  }

  private async fetchSequenceFromLedger(address: string): Promise<number> {
    const client = this.xrplPool.getClient();
    const requestPromise = client.request({
      command: "account_info",
      account: address,
      ledger_index: "current",
    });

    // Hard timeout at LEDGER_FETCH_TIMEOUT_MS — must be strictly less than
    // LOCK_TTL_SECONDS so the lock can never expire while we're stalled.
    const info = await Promise.race([
      requestPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new LedgerFetchTimeout(address)),
          LEDGER_FETCH_TIMEOUT_MS,
        ),
      ),
    ]);

    const seq = info.result.account_data.Sequence;
    if (typeof seq !== "number") {
      throw new Error(`account_info returned no Sequence for ${address}`);
    }
    return seq;
  }

  private async releaseLock(lockKey: string, lockToken: string): Promise<void> {
    // releaseLock runs in a finally — if it throws, it would mask the
    // original error from computeAndAdvance. Catch and swallow Redis errors
    // here (the lock will auto-expire via TTL anyway).
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
    } catch {
      // Best-effort release. The TTL guarantees the lock can't be stuck
      // forever even if Redis is temporarily unreachable.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
