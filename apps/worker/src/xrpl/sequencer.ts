// Distributed sequence-number coordinator. Prevents two workers from grabbing
// the same Sequence for one account when concurrent requests are submitted.
//
// Algorithm (PLAN.md §4.2):
//   1. Acquire a per-address Redis lock (SET NX EX) so only one worker is
//      computing a sequence for this address at a time.
//   2. Look up the cached `seq:<address>` value. If absent, fetch the current
//      Sequence from rippled via account_info.
//   3. Increment the cache by 1 and return the pre-increment value.
//   4. Release the lock.
//
// CRITICAL (CLAUDE.md): never bypass this. Direct client.submit() calls in
// route handlers will collide on the same Sequence under load.

import type { Redis } from 'ioredis';
import type { XrplClientPool } from './client.ts';

const LOCK_TTL_SECONDS = 5;
const CACHE_TTL_SECONDS = 30;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 40; // ~2s total wait

export class SequenceLockTimeout extends Error {
  constructor(address: string) {
    super(`Timed out acquiring sequence lock for ${address}`);
    this.name = 'SequenceLockTimeout';
  }
}

export class TxSequencer {
  constructor(
    private redis: Redis,
    private xrplPool: XrplClientPool,
  ) {}

  /**
   * Returns the next Sequence number to use for `address` and atomically
   * advances the cached counter so the next caller gets seq+1.
   */
  async getNextSequence(address: string): Promise<number> {
    const lockKey = `railforge:seq:lock:${address}`;
    const cacheKey = `railforge:seq:${address}`;
    const lockToken = `${process.pid}-${Date.now()}-${Math.random()}`;

    // Acquire lock with bounded retry. Lock contention is expected under load
    // and should not throw immediately — but it must not loop forever.
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      const acquired = await this.redis.set(lockKey, lockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
      if (acquired === 'OK') {
        try {
          return await this.computeAndAdvance(address, cacheKey);
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
   * `address` fails (so the cache doesn't drift) or after a long idle period.
   */
  async invalidate(address: string): Promise<void> {
    await this.redis.del(`railforge:seq:${address}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // internals
  // ─────────────────────────────────────────────────────────────────────────

  private async computeAndAdvance(address: string, cacheKey: string): Promise<number> {
    const cached = await this.redis.get(cacheKey);
    let next: number;

    if (cached !== null) {
      next = Number.parseInt(cached, 10);
      if (!Number.isFinite(next)) {
        // Defensive: cache poisoned somehow. Fetch fresh.
        next = await this.fetchSequenceFromLedger(address);
      }
    } else {
      next = await this.fetchSequenceFromLedger(address);
    }

    await this.redis.set(cacheKey, String(next + 1), 'EX', CACHE_TTL_SECONDS);
    return next;
  }

  private async fetchSequenceFromLedger(address: string): Promise<number> {
    const client = this.xrplPool.getClient();
    const info = await client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'current',
    });
    const seq = info.result.account_data.Sequence;
    if (typeof seq !== 'number') {
      throw new Error(`account_info returned no Sequence for ${address}`);
    }
    return seq;
  }

  /**
   * Release the lock only if we still own it (token match). Avoids the case
   * where this worker stalled past LOCK_TTL_SECONDS, the lock expired, another
   * worker grabbed it, and we'd otherwise delete that worker's lock.
   */
  private async releaseLock(lockKey: string, lockToken: string): Promise<void> {
    // Lua compare-and-delete. Using eval keeps the check + delete atomic.
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, lockKey, lockToken);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
