// Shared Redis client. Single connection used by middleware (rate limit,
// idempotency cache) and queues. Created lazily so unit tests can construct
// the app without a live Redis.

import Redis from "ioredis";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client !== null) {
    return client;
  }
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  client = new Redis(url, {
    // BullMQ requires this; no harm leaving it on for the API too.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
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
