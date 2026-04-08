// Tests for TxSequencer. Uses ioredis-mock so the test can run without a
// real Redis. The XRPL pool is replaced with a stub that returns a fixed
// Sequence from a fake account_info response.

import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XrplClientPool } from './client.ts';
import { SequenceLockTimeout, TxSequencer } from './sequencer.ts';

const ADDRESS = 'rTestAccount000000000000000000000000';

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

describe('TxSequencer', () => {
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

  it('returns the ledger Sequence on first call and increments cache', async () => {
    const first = await sequencer.getNextSequence(ADDRESS);
    expect(first).toBe(42);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    const cached = await redis.get(`railforge:seq:${ADDRESS}`);
    expect(cached).toBe('43');
  });

  it('uses the cached value on subsequent calls without re-querying rippled', async () => {
    const first = await sequencer.getNextSequence(ADDRESS);
    const second = await sequencer.getNextSequence(ADDRESS);
    const third = await sequencer.getNextSequence(ADDRESS);

    expect(first).toBe(42);
    expect(second).toBe(43);
    expect(third).toBe(44);
    // Only the first call should hit the ledger.
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidate() clears the cache so the next call re-fetches', async () => {
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

  it('serializes concurrent calls and returns distinct sequences', async () => {
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

  it('throws SequenceLockTimeout if the lock cannot be acquired', async () => {
    // Hold the lock manually so the sequencer can never grab it.
    await redis.set(`railforge:seq:lock:${ADDRESS}`, 'stuck', 'EX', 60);

    await expect(sequencer.getNextSequence(ADDRESS)).rejects.toThrow(SequenceLockTimeout);
  });

  it('throws if account_info returns no Sequence', async () => {
    requestSpy.mockResolvedValueOnce({ result: { account_data: {} } });

    await expect(sequencer.getNextSequence(ADDRESS)).rejects.toThrow(/no Sequence/);
  });
});
