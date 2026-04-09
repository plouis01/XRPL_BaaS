// Tests for TxSequencer. Uses ioredis-mock so the test can run without a
// real Redis. The XRPL pool is replaced with a stub that returns a fixed
// Sequence from a fake account_info response.

import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XrplClientPool } from "./client.ts";
import { SequenceLockTimeout, TxSequencer } from "./sequencer.ts";

const ADDRESS = "rTestAccount000000000000000000000000";

function makeStubPool(initialSequence: number): {
  pool: XrplClientPool;
  requestSpy: ReturnType<typeof vi.fn>;
} {
  const requestSpy = vi.fn().mockResolvedValue({
    result: { account_data: { Sequence: initialSequence } },
  });
  const pool = {
    getClient: () => ({ request: requestSpy }),
  } as unknown as XrplClientPool;
  return { pool, requestSpy };
}

describe("TxSequencer", () => {
  // ioredis-mock satisfies the ioredis Redis interface at runtime; the cast
  // to Redis here is the only place test machinery touches production types.
  let redis: InstanceType<typeof RedisMock>;
  let pool: XrplClientPool;
  let requestSpy: ReturnType<typeof vi.fn>;
  let sequencer: TxSequencer;

  beforeEach(async () => {
    redis = new RedisMock();
    // ioredis-mock shares an in-process server across instances. Flush so each
    // test starts from a clean slate (no leftover lock or cached sequence).
    await redis.flushall();
    const stub = makeStubPool(42);
    pool = stub.pool;
    requestSpy = stub.requestSpy;
    sequencer = new TxSequencer(redis as unknown as Redis, pool);
  });

  afterEach(async () => {
    await redis.quit();
    vi.clearAllMocks();
  });

  it("returns the ledger Sequence on first call and increments cache", async () => {
    const first = await sequencer.getNextSequence(ADDRESS);
    expect(first).toBe(42);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    const cached = await redis.get(`railforge:seq:${ADDRESS}`);
    expect(cached).toBe("43");
  });

  it("uses the cached value on subsequent calls without re-querying rippled", async () => {
    const first = await sequencer.getNextSequence(ADDRESS);
    const second = await sequencer.getNextSequence(ADDRESS);
    const third = await sequencer.getNextSequence(ADDRESS);

    expect(first).toBe(42);
    expect(second).toBe(43);
    expect(third).toBe(44);
    // Only the first call should hit the ledger.
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidate() clears the cache so the next call re-fetches", async () => {
    await sequencer.getNextSequence(ADDRESS);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    await sequencer.invalidate(ADDRESS);
    const cached = await redis.get(`railforge:seq:${ADDRESS}`);
    expect(cached).toBeNull();

    // Next call should re-query.
    const next = await sequencer.getNextSequence(ADDRESS);
    expect(next).toBe(42);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent calls and returns distinct sequences", async () => {
    const results = await Promise.all([
      sequencer.getNextSequence(ADDRESS),
      sequencer.getNextSequence(ADDRESS),
      sequencer.getNextSequence(ADDRESS),
      sequencer.getNextSequence(ADDRESS),
    ]);

    // All four results must be unique consecutive integers — no two callers
    // got the same Sequence.
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual([42, 43, 44, 45]);
  });

  it("throws SequenceLockTimeout if the lock cannot be acquired", async () => {
    // Hold the lock manually so the sequencer can never grab it.
    await redis.set(`railforge:seq:lock:${ADDRESS}`, "stuck", "EX", 60);

    await expect(sequencer.getNextSequence(ADDRESS)).rejects.toThrow(
      SequenceLockTimeout,
    );
  });

  it("throws if account_info returns no Sequence", async () => {
    requestSpy.mockResolvedValueOnce({ result: { account_data: {} } });

    await expect(sequencer.getNextSequence(ADDRESS)).rejects.toThrow(
      /no Sequence/,
    );
  });

  it("aborts and preserves the foreign lock when our token is no longer the owner (fenced cache write)", async () => {
    // CRITICAL safety property of the Lua FENCED_CACHE_WRITE_SCRIPT.
    //
    // Scenario: worker A acquires the lock and starts fetching a sequence
    // from rippled. The fetch stalls past LOCK_TTL_SECONDS, the lock
    // auto-expires, worker B acquires it and writes its own token. Worker A
    // finally finishes the fetch and attempts to write the cache.
    //
    // CORRECT behavior (post-fence):
    //   1. The fenced cache write checks GET lockKey == ARGV[1] and returns 0
    //      because worker B's token is now there.
    //   2. computeAndAdvance throws SequenceLockTimeout — worker A's stale
    //      `next` value is NEVER returned to the caller.
    //   3. releaseLock runs in the finally and does NOT delete worker B's
    //      lock (token mismatch in compare-and-delete).
    //
    // Without the fence, worker A would clobber the cache with stale state
    // and two workers would sign with the same Sequence on-ledger.
    const lockKey = `railforge:seq:lock:${ADDRESS}`;
    const otherWorkerToken = "other-worker-stole-this";

    // Slow down account_info so worker A is "still in computeAndAdvance" when
    // we overwrite the lock from underneath it.
    let resolveSlowRequest!: () => void;
    requestSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlowRequest = () =>
            resolve({ result: { account_data: { Sequence: 100 } } });
        }),
    );

    const seqPromise = sequencer.getNextSequence(ADDRESS);

    // Wait for the sequencer to acquire its lock (poll the redis state).
    let acquired = false;
    for (let i = 0; i < 50; i++) {
      const v = await redis.get(lockKey);
      if (v && v !== otherWorkerToken) {
        acquired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(acquired).toBe(true);

    // Simulate the lock expiring and another worker grabbing it.
    await redis.set(lockKey, otherWorkerToken);

    // Now let worker A's slow request resolve. The fence in computeAndAdvance
    // must reject the cache write and surface SequenceLockTimeout to the
    // caller — worker A's stale Sequence MUST NOT be returned.
    resolveSlowRequest();
    await expect(seqPromise).rejects.toThrow(SequenceLockTimeout);

    // And the lock value must STILL be worker B's token — releaseLock's
    // compare-and-delete refused to delete the foreign lock.
    const finalValue = await redis.get(lockKey);
    expect(finalValue).toBe(otherWorkerToken);

    // And the cache MUST NOT contain worker A's stale increment.
    const cached = await redis.get(`railforge:seq:${ADDRESS}`);
    expect(cached).toBeNull();
  });

  it("releaseLock DOES delete the lock when the token matches (happy path)", async () => {
    // Sanity check the other branch of the Lua script: when the token DOES
    // match, the lock is freed so the next caller can proceed.
    const lockKey = `railforge:seq:lock:${ADDRESS}`;

    await sequencer.getNextSequence(ADDRESS);

    // After the call returns, the lock should be cleared.
    const value = await redis.get(lockKey);
    expect(value).toBeNull();
  });
});
