// Shared Redis client. Single connection used by middleware (rate limit,
// idempotency cache) and queues. Created lazily so unit tests can construct
// the app without a live Redis.
//
// REVIEW.md M-5 fix: `lazyConnect: true` defers the TCP connection until
// the first command is issued, so getRedis() never throws at construction
// time. If Redis is unreachable, each middleware (ipRateLimit, rateLimit,
// idempotency, spendPolicy) already wraps Redis calls in try/catch and
// falls back to degraded behavior. The `retryStrategy` caps at 3 attempts
// with 500ms backoff so the client doesn't hang indefinitely if the server
// comes back mid-request.

import Redis from 'ioredis';
import { logger } from './logger.ts';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client !== null) {
    return client;
  }
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 500, 2000);
    },
  });
  // Swallow connection errors — middleware handles per-request failures.
  // Without this, ioredis emits an 'error' event that crashes the process
  // if there's no listener.
  client.on('error', (err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'redis connection error',
    );
  });
  return client;
}

/** Test/teardown helper. Resets the singleton so a fresh client can be created. */
export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
