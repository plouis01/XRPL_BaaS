// Shared Redis client for API middleware (ipRateLimit, rateLimit,
// idempotency, spendPolicy). NOT used by BullMQ — that lives in
// `packages/jobs/src/index.ts` with a separate connection because
// BullMQ requires `maxRetriesPerRequest: null` for blocking polls,
// which is incompatible with the fast-fail posture we want here.
//
// Created lazily so unit tests can construct the app without a live
// Redis. Each middleware wraps Redis calls in try/catch and falls
// back to degraded behavior when an op fails — so the priority here
// is "fail fast and let the middleware fall back" rather than "retry
// forever and hang the request."
//
// Resilience knobs (post-incident hardening):
//
//   - `commandTimeout: 3000` is the load-bearing fix. Without it, a
//     half-open TCP connection (NAT/middlebox dropped the flow without
//     FIN/RST, Upstash node restart, etc.) leaves in-flight commands
//     hanging forever. The API process keeps accepting requests, all
//     the middleware Redis calls hang, and Bun never writes a response
//     — Fly's edge proxy logs `connection closed before message
//     completed` and the dashboard sees an infinite loading spinner.
//     3s × maxRetriesPerRequest=1 = ~6s worst-case per Redis op, which
//     trips the middleware's try/catch and degrades cleanly.
//
//   - `enableOfflineQueue: false` makes commands fail synchronously
//     when the connection is down rather than queueing. Pairs with the
//     middleware's per-request try/catch — failing fast is what we want.
//
//   - `keepAlive: 30000` tells the kernel to send a TCP keepalive
//     probe every 30s. A dead connection surfaces as a real error
//     within a minute or two instead of silently hanging.
//
//   - `reconnectOnError` widens the auto-reconnect trigger to include
//     network-level disconnect patterns (EPIPE, ECONNRESET, ETIMEDOUT)
//     in addition to ioredis's defaults. ioredis still reconnects in
//     the background; this just makes more failure modes trip it.
//
//   - `maxRetriesPerRequest: 1` — one retry per command, then give up.
//     The default is 20, which is wildly too high for a request-path
//     middleware connection.
//
//   - `retryStrategy` caps the reconnect backoff at 2s so we don't
//     stay disconnected forever after a transient blip.

import Redis from 'ioredis';
import { logger } from './logger.ts';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client !== null) {
    return client;
  }
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  client = new Redis(url, {
    commandTimeout: 3000,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    lazyConnect: true,
    keepAlive: 30000,
    maxRetriesPerRequest: 1,
    reconnectOnError(err: Error) {
      const msg = err.message ?? '';
      return /READONLY|CLUSTERDOWN|EPIPE|ECONNRESET|ETIMEDOUT|broken pipe/i.test(msg);
    },
    retryStrategy(times) {
      if (times > 5) return null;
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
