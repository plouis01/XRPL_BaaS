// Worker entry point. Spawns BullMQ workers for transaction submission,
// confirmation polling, webhook delivery, credential expiry alerts, and
// reserve reclamation. See PLAN.md §4.3 pipeline.
//
// Shared singletons (Redis connection, XRPL pool, sequencer, signer) live
// in ./queues.ts. Each job module exports a start*Worker function that
// wires its BullMQ worker to the shared Redis. On SIGTERM/SIGINT we close
// everything gracefully so in-flight jobs finish before the process exits.

import { Redis } from 'ioredis';
import { startTxConfirmWorker } from './jobs/txConfirmer.ts';
import { startTxSubmitWorker } from './jobs/txSubmitter.ts';
import { logger } from './logger.ts';
import { disconnectWorker } from './queues.ts';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const workerRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const txSubmitWorker = startTxSubmitWorker(workerRedis);
const txConfirmWorker = startTxConfirmWorker(workerRedis);

logger.info(
  {
    queues: ['tx-submit', 'tx-confirm'],
    redis: redisUrl,
    network: process.env.XRPL_NETWORK ?? 'testnet',
  },
  'railforge-worker started',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'railforge-worker shutting down');
  await Promise.all([txSubmitWorker.close(), txConfirmWorker.close()]);
  await disconnectWorker();
  await workerRedis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
