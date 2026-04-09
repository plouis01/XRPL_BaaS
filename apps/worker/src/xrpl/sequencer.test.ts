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

  it("releaseLock does NOT delete a lock owned by another worker (token mismatch)", async () => {
    // This is the core safety property of the Lua compare-and-delete script.
    // Scenario: worker A's getNextSequence stalls past LOCK_TTL_SECONDS, the
    // lock auto-expires, worker B grabs the lock and writes its own token.
    // When worker A finally finishes and tries to release, it must NOT delete
    // worker B's lock — otherwise a third worker could grab it concurrently
    // with worker B, causing a Sequence collision.
    //
    // We exercise this by:
    //   1. Letting worker A acquire the lock normally.
    //   2. Forcing the lock value to a different token (simulating B took over).
    //   3. Letting worker A's getNextSequence finish (try/finally → release).
    //   4. Verifying the lock value is STILL worker B's token, not deleted.
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

    // Now let worker A's slow request resolve. Its finally block calls
    // releaseLock, which must NOT delete otherWorkerToken.
    resolveSlowRequest();
    await seqPromise;

    const finalValue = await redis.get(lockKey);
    expect(finalValue).toBe(otherWorkerToken);
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
