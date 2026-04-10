// Persists indexer-derived state.
//
// Sprint 3 scope: ledger-level high-water mark only. The indexer tracks
// the last validated ledger_index so it knows where it left off on
// restart. Full transaction-level persistence (writing to the
// `transactions` / `credentials` / `tokens` tables from the ledger
// stream) is Sprint 4+.
//
// Storage: a single Redis key (`railforge:indexer:hwm`). Redis is already
// in the infra stack and survives process restarts. A Postgres table
// would also work but costs a migration for one integer — Redis is the
// pragmatic Sprint 3 choice. If the indexer ever needs durable WAL-level
// guarantees on the high-water mark, move to Postgres then.

import { logger } from './logger.ts';
import type { IndexedLedger } from './parser.ts';

const log = logger.child({ component: 'store' });

const HWM_KEY = 'railforge:indexer:hwm';

/**
 * Minimal Redis interface — just get/set a string. The indexer doesn't
 * need queues or pub/sub, so we accept any object with these two methods
 * rather than pulling in the full ioredis dependency directly. The entry
 * point injects a real ioredis instance.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

let store: KvStore | null = null;

/**
 * Initialize the store with a Redis (or Redis-like) client.
 * Must be called before `persistLedger` or `getHighWaterMark`.
 */
export function initStore(kv: KvStore): void {
  store = kv;
}

/**
 * Persist a validated ledger close event. For Sprint 3 this just bumps
 * the high-water mark in Redis. Future sprints will fan out to Postgres
 * tables (account balances, credential state, etc.).
 */
export async function persistLedger(ledger: IndexedLedger): Promise<void> {
  if (!store) {
    log.warn('store not initialized — skipping persist');
    return;
  }

  await store.set(HWM_KEY, String(ledger.ledgerIndex));
  log.debug(
    {
      ledgerIndex: ledger.ledgerIndex,
      txCount: ledger.txCount,
      closedAt: ledger.closedAt,
    },
    'ledger persisted',
  );
}

/**
 * Read the last persisted ledger index. Returns null if the indexer has
 * never run (fresh start or Redis was wiped).
 */
export async function getHighWaterMark(): Promise<number | null> {
  if (!store) return null;
  const raw = await store.get(HWM_KEY);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}
