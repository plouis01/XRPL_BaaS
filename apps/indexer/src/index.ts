// Indexer entry. Subscribes to XRPL validated ledgers via WebSocket,
// parses close events + per-tx payloads into normalized records, and
// persists state so the indexer knows where it left off on restart.
// See PLAN.md §5.3.
//
// Pipeline per ledger:
//   1. ledgerClosed         → parseLedgerClose → persistLedger (Redis hwm)
//   2. ledger expand fetch  → parseTransaction per tx → persistTransaction
//                              (Postgres dedup + UPSERTs)

import { Redis } from 'ioredis';
import { logger } from './logger.ts';
import { parseLedgerClose, parseTransaction } from './parser.ts';
import { getHighWaterMark, initStore, persistLedger, persistTransaction } from './store.ts';
import { LedgerSubscriber } from './subscriber.ts';
import { fanOutExternalTxEvent } from './webhookFanout.ts';

const wsUrl = process.env.XRPL_WS_URL ?? 'wss://s.altnet.rippletest.net:51233';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Redis for the high-water mark. Separate from the BullMQ Redis in the
// worker — the indexer is a standalone process with its own lifecycle.
const redis = new Redis(redisUrl);

initStore(redis);

const hwm = await getHighWaterMark();
logger.info({ highWaterMark: hwm ?? 'none (fresh start)' }, 'indexer state loaded');

const subscriber = new LedgerSubscriber(wsUrl, {
  onLedgerClose: async (event) => {
    const indexed = parseLedgerClose(event);
    if (indexed) {
      await persistLedger(indexed);
    }
  },
  onTransaction: async (raw) => {
    const txEvent = parseTransaction(raw);
    if (!txEvent) return;
    let firstSeen = false;
    try {
      firstSeen = await persistTransaction(txEvent);
    } catch (err) {
      // Persist errors are logged inside the store and rolled back via
      // the dedup-row rollback. Swallow here so one bad tx doesn't kill
      // the subscription loop — the next replay will retry.
      logger.error({ err, txHash: txEvent.txHash }, 'persistTransaction failed');
      return;
    }
    if (!firstSeen) return;
    // Webhook fan-out for EXTERNAL txs involving managed accounts. Runs
    // only on first observation (the `firstSeen` gate skips replays) and
    // is best-effort — a failure here must not roll back the dedup row,
    // otherwise a retry would duplicate the side-table writes.
    // Internal txs (ours) are skipped inside fanOutExternalTxEvent via a
    // `transactions.tx_hash` lookup so txConfirmer stays the sole source
    // for those events.
    try {
      await fanOutExternalTxEvent(txEvent);
    } catch (err) {
      logger.error({ err, txHash: txEvent.txHash }, 'external webhook fan-out failed');
    }
  },
});

await subscriber.start();

// REVIEW.md LOW-09: log only the Redis host, never the full URL. A prod
// `redis://:<password>@host:port` landed here verbatim would leak the
// password into every startup log line. `new URL(...).host` keeps the
// identifying bit (which Redis, which port) without the credentials.
let redisHost: string;
try {
  redisHost = new URL(redisUrl).host;
} catch {
  redisHost = '<unparseable>';
}

logger.info(
  {
    wsUrl,
    redisHost,
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
