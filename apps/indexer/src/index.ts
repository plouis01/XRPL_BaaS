// Indexer entry. Subscribes to XRPL validated ledgers via WebSocket,
// parses close events into normalized records, and persists state so the
// indexer knows where it left off on restart. See PLAN.md §5.3.
//
// Sprint 3 scope: ledger-level subscription + high-water mark tracking.
// Sprint 4+ adds per-transaction parsing + Postgres persistence for
// complex queries ("all credentials issued by account X", etc.).

import { Redis } from 'ioredis';
import { logger } from './logger.ts';
import { parseLedgerClose } from './parser.ts';
import { getHighWaterMark, initStore, persistLedger } from './store.ts';
import { LedgerSubscriber } from './subscriber.ts';

const wsUrl = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Redis for the high-water mark. Separate from the BullMQ Redis in the
// worker — the indexer is a standalone process with its own lifecycle.
const redis = new Redis(redisUrl);

initStore(redis);

// Log the high-water mark on startup so operators can see where the
// indexer will resume from.
const hwm = await getHighWaterMark();
logger.info({ highWaterMark: hwm ?? 'none (fresh start)' }, 'indexer state loaded');

// The handler pipeline: parse → persist. Each validated ledger close
// flows through this chain. Errors in persistLedger are logged inside
// the store module and do not propagate — the subscriber keeps running.
const subscriber = new LedgerSubscriber(wsUrl, async (event) => {
  const indexed = parseLedgerClose(event);
  if (indexed) {
    await persistLedger(indexed);
  }
});

await subscriber.start();

logger.info(
  {
    wsUrl,
    redis: redisUrl,
    network: process.env.XRPL_NETWORK ?? 'testnet',
  },
  'railforge-indexer started',
);

// Graceful shutdown — close the WebSocket + Redis cleanly.
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'railforge-indexer shutting down');
  await subscriber.stop();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
