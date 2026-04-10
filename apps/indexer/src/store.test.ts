// Unit tests for store.ts — uses a fake KvStore (no real Redis).
//
// Coverage:
//   1. persistLedger writes the ledger index to the KV store
//   2. getHighWaterMark reads back what was written
//   3. getHighWaterMark returns null on fresh state
//   4. persistLedger is a no-op when store not initialized

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHighWaterMark, initStore, persistLedger } from './store.ts';
import type { KvStore } from './store.ts';

function makeFakeKv(): KvStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

describe('store', () => {
  let kv: ReturnType<typeof makeFakeKv>;

  beforeEach(() => {
    kv = makeFakeKv();
    initStore(kv);
  });

  it('persistLedger writes the ledger index to the HWM key', async () => {
    await persistLedger({
      ledgerIndex: 12345,
      ledgerHash: 'AABB',
      closedAt: '2025-01-01T00:00:00.000Z',
      txCount: 10,
    });

    expect(kv.set).toHaveBeenCalledTimes(1);
    expect(kv.data.get('railforge:indexer:hwm')).toBe('12345');
  });

  it('getHighWaterMark reads back the persisted value', async () => {
    await persistLedger({
      ledgerIndex: 99999,
      ledgerHash: 'CCDD',
      closedAt: '2025-06-01T00:00:00.000Z',
      txCount: 5,
    });

    const hwm = await getHighWaterMark();
    expect(hwm).toBe(99999);
  });

  it('getHighWaterMark returns null on fresh state (no writes)', async () => {
    const hwm = await getHighWaterMark();
    expect(hwm).toBeNull();
  });

  it('subsequent writes update the HWM (monotonically increasing)', async () => {
    await persistLedger({
      ledgerIndex: 100,
      ledgerHash: 'A',
      closedAt: '2025-01-01T00:00:00.000Z',
      txCount: 1,
    });
    await persistLedger({
      ledgerIndex: 200,
      ledgerHash: 'B',
      closedAt: '2025-01-01T00:00:01.000Z',
      txCount: 2,
    });

    const hwm = await getHighWaterMark();
    expect(hwm).toBe(200);
  });
});
