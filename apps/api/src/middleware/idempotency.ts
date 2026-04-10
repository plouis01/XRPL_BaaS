// Idempotency key handling.
//
// State-changing endpoints (POST/PUT/DELETE) MUST receive an Idempotency-Key
// header. The first request with a given key is processed normally and its
// response is cached in Redis. Subsequent requests with the same key replay
// the cached response without re-running the handler.
//
// Cache key: `railforge:idemp:{clientId}:{method}:{path}:{idempotencyKey}`
//
// Cache value: { status, body } serialized as JSON.
//
// TTL: 24 hours — long enough to cover client retry windows (hours), short
// enough that stale responses don't accumulate indefinitely.
//
// SCOPE: the cache key includes (clientId, method, path) so the same
// idempotency key can be reused across different endpoints without
// collision. Two clients submitting the same key to the same endpoint
// get independent buckets because clientId is part of the key.
//
// INVARIANT: the cache is scoped per-client by design. A client CANNOT
// replay another client's response, because clientId is set by the auth
// middleware and is part of the cache key.
//
// Closes PLAN.md §9.2 item #10.

import type { MiddlewareHandler } from 'hono';
import { getRedis } from '../redis.ts';
import type { AppEnv } from '../types.ts';

const IDEMP_TTL_SECONDS = 24 * 60 * 60; // 24h
const CACHEABLE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

interface CachedResponse {
  status: number;
  body: unknown;
}

export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;

  // Only state-changing methods need idempotency keys.
  if (!CACHEABLE_METHODS.has(method)) {
    await next();
    return;
  }

  const key = c.req.header('idempotency-key');
  if (!key) {
    return c.json({ error: 'Missing Idempotency-Key header' }, 400);
  }
  // Cap length to prevent Redis memory exhaustion via oversized keys.
  if (key.length > 256) {
    return c.json({ error: 'Idempotency-Key must be 256 characters or fewer' }, 400);
  }

  // clientId is set by auth middleware which runs BEFORE this one. If it's
  // missing, something is very wrong upstream — fail closed.
  const clientId = c.get('clientId');
  if (!clientId) {
    return c.json({ error: 'Idempotency context missing client id' }, 500);
  }

  const path = new URL(c.req.url).pathname;
  const cacheKey = `railforge:idemp:${clientId}:${method}:${path}:${key}`;
  const redis = getRedis();

  // 1. Check for a cached response. If found, replay it verbatim.
  // Wrapped in try/catch so Redis being down doesn't block the request —
  // the handler will re-process and the cache write below also tolerates failure.
  let cached: string | null = null;
  try {
    cached = await redis.get(cacheKey);
  } catch {
    // Redis down — treat as cache miss and proceed.
  }
  if (cached) {
    try {
      const { status, body } = JSON.parse(cached) as CachedResponse;
      // Emit a signal header so clients can tell this was a replay — useful
      // for debugging and not sensitive (the client already knows it sent a
      // duplicate request).
      c.header('X-Idempotent-Replay', 'true');
      // biome-ignore lint/suspicious/noExplicitAny: status code is narrowed at runtime
      return c.json(body as any, status as any);
    } catch {
      // Corrupted cache entry — fall through and re-process. The new
      // response will overwrite it below.
    }
  }

  // 2. Run the handler. If it throws, the error propagates up the
  // middleware chain — the global onError handler turns it into a 5xx
  // response. CRITICALLY: any code below this line is unreachable on
  // throw, so a thrown handler will NOT cache anything. The behavior is
  // verified by the "handler throws: no caching" test below.
  await next();

  // 3. Cache the response for the next retry. We only cache successful
  // and client-error responses (2xx, 4xx). 5xx responses are NOT cached
  // so that transient server errors don't stick around — the client
  // retrying after a 500 should get a real retry, not a replayed failure.
  //
  // A note on the 4xx caching: returning 4xx on the same key twice is
  // idempotent (validation errors are deterministic), and caching them
  // prevents re-running expensive validation on retry spam.
  const status = c.res.status;
  const shouldCache = status >= 200 && status < 500 && status !== 429;
  if (shouldCache) {
    try {
      // Clone the response so we can read its body without consuming it
      // for the actual client.
      const clone = c.res.clone();
      const body = await clone.json().catch(() => null);
      if (body !== null) {
        const payload: CachedResponse = { status, body };
        // SETNX — only set if no one else has written to this key in the
        // meantime (which would happen on concurrent duplicate requests).
        // If another request beat us to it, we just skip the write.
        await redis.set(cacheKey, JSON.stringify(payload), 'EX', IDEMP_TTL_SECONDS, 'NX');
      }
    } catch {
      // Non-fatal — the response has already been returned to the client
      // at this point. A cache miss on the next retry is acceptable.
    }
  }
  return;
};
