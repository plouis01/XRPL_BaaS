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
//
// Sprint 7 (#17) — TOCTOU fix:
// Before this fix, two concurrent requests with the same idempotency key
// both saw an empty cache in step 1, both ran the handler, and both
// returned responses. The DB constraint `UNIQUE(client_id, idempotency_key)`
// on the transactions table caught double-submitted txs, but any other
// state-changing op (webhook endpoint CRUD, credential accept, etc.)
// could execute twice. We now acquire a Redis `SET NX` lock between the
// cache-hit check and the handler run so only one of N concurrent
// duplicates progresses; the others get a 409 Conflict immediately.

import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import { getRedis } from '../redis.ts';
import type { AppEnv } from '../types.ts';

const IDEMP_TTL_SECONDS = 24 * 60 * 60; // 24h
// Upper bound on handler runtime. If a handler legitimately takes longer
// than this, the lock expires and a concurrent request can proceed — the
// lock is primarily crash-recovery safety, not a hard SLA. 60s is well
// above p99 for any endpoint we currently expose.
const IDEMP_LOCK_TTL_SECONDS = 60;
const CACHEABLE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * REVIEW.md H-3 fix: compare-and-delete on lock release. Atomically
 * deletes the lock key ONLY if it still holds the token this request
 * wrote. Prevents the following race:
 *
 *   1. Request A acquires the lock with TTL=60s but the handler takes
 *      >60s (e.g. a slow downstream HTTP call).
 *   2. Lock expires. Request B with the same key acquires a fresh lock.
 *   3. Request A finishes and issues `DEL lockKey` — this would delete
 *      B's lock, opening the door for a third concurrent request.
 *
 * The CAS script reads the current value, compares to our token, and
 * only deletes on a match. Mirrors the sequencer's lock-release pattern.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

interface CachedResponse {
  status: number;
  body: unknown;
}

/**
 * Collapse URL-shape variance so the idempotency cache key is stable across
 * requests that Hono treats as the same route. Collapses runs of `/` and
 * strips a trailing slash unless the path IS `/`.
 *
 * REVIEW.md LOW-17: previously also lowercased the pathname. That was
 * wrong for XRPL classic addresses in path params — base58 is CASE
 * SENSITIVE, so `rHb9CJAWyB4` and `rhb9cjawyb4` are different accounts.
 * A single client reusing one idempotency key across two requests whose
 * only difference was case in an address param would silently replay the
 * first response for the second — subtle footgun, even though the
 * clientId in the cache key still bounds cross-tenant leakage. Keep
 * the slash-shape normalizations (harmless) and drop the case fold.
 */
function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/+/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
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

  // REVIEW.md MED-11: normalize the URL pathname before hashing into the
  // cache key. The raw pathname treated `/accounts/foo`, `/accounts/foo/`,
  // `/accounts/FOO`, and `/accounts//foo` as four distinct idempotency
  // buckets — all of which Hono routes to the same handler, so a caller
  // that varied those characters on retry silently defeated dedup. We
  // can't use `c.req.routePath` here because this middleware runs before
  // route dispatch (routePath returns the middleware's `*` pattern at this
  // point, not the final route). Normalize manually: lowercase, collapse
  // runs of `/`, strip the trailing slash unless the path is exactly `/`.
  const path = normalizePath(new URL(c.req.url).pathname);
  const cacheKey = `railforge:idemp:${clientId}:${method}:${path}:${key}`;
  // The lock key sits in a sibling namespace so it never collides with the
  // cached response at the same key. It's short-lived (IDEMP_LOCK_TTL_SECONDS)
  // vs the 24h cache TTL, and its only job is to block concurrent duplicates.
  const lockKey = `railforge:idemp:lock:${clientId}:${method}:${path}:${key}`;
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

  // 2. Acquire a short-lived Redis lock before running the handler.
  // SET NX EX: only succeeds if the key doesn't exist. If another request
  // with the same (clientId, method, path, key) is in flight, we lose the
  // race and return 409 — Stripe-style "concurrent request" error. The
  // client's retry should either hit the cache (if the first finished) or
  // re-attempt the lock (if the first is still running).
  //
  // If Redis is unreachable, skip the lock entirely and fall through to
  // the handler. We lose TOCTOU protection in that mode but it's the same
  // degraded behavior the DB UNIQUE constraint was already compensating
  // for pre-fix — no regression, just no improvement.
  // REVIEW.md H-3 fix: use a per-request unique token as the lock value
  // so the CAS-release script can tell if this request still owns the
  // lock. A fixed sentinel ('1') would let a stale DEL kill another
  // request's lock after TTL expiry.
  const lockToken = randomUUID();
  let holdingLock = false;
  try {
    const acquired = await redis.set(lockKey, lockToken, 'EX', IDEMP_LOCK_TTL_SECONDS, 'NX');
    if (acquired === 'OK') {
      holdingLock = true;
    } else {
      // Another request is processing this exact (client, method, path,
      // key) tuple right now. Return 409 so the client can retry — by
      // then the first request will have either cached its response
      // (→ replay on next attempt) or released the lock (→ acquire now).
      return c.json(
        {
          error: 'Idempotent request already in progress',
          retry_after_seconds: 1,
        },
        409,
      );
    }
  } catch (err) {
    // Redis unreachable on the lock check. Log and proceed without the
    // lock — we cannot enforce TOCTOU protection without Redis, but we
    // must not block the whole API because of it.
    logger.warn({ err, lockKey }, 'idempotency lock unavailable — proceeding without lock');
  }

  // 3. Run the handler. If it throws, the error propagates up the
  // middleware chain — the global onError handler turns it into a 5xx
  // response. CRITICALLY: we MUST release the lock on both success and
  // throw, so the handler call is wrapped in try/finally. A thrown
  // handler is still unreachable for the caching block below, so a
  // thrown handler will NOT cache anything (verified by the existing
  // "handler throws: no caching" test).
  try {
    await next();
  } catch (err) {
    if (holdingLock) {
      try {
        // CAS release: only deletes if the lock still holds OUR token.
        // If TTL expired and another request acquired the lock, this is
        // a no-op (script returns 0) rather than killing their lock.
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
      } catch {
        // Non-fatal — the lock will expire via its TTL.
      }
    }
    throw err;
  }

  // 4. Cache the response for the next retry. We only cache 2xx responses.
  //
  // REVIEW.md MED-12: previous implementation cached 4xx (incl. 401/403)
  // for 24h. That pinned the client at a failure status even after the
  // underlying condition was fixed, and — worse — let an attacker poison a
  // victim's replay attempt by deliberately triggering a 401 once. 4xx
  // bodies are also frequently auth / envGuard responses that have nothing
  // to do with the handler's logic, so caching them served no correctness
  // purpose. 5xx were already excluded (transient server errors).
  const status = c.res.status;
  // REVIEW B1: routes whose response carries credentials (e.g. POST
  // /v1/agents returns the delegate seed exactly once) opt out of body
  // caching by setting `c.set('skipIdempotencyCache', true)` in the
  // handler. The lock + 409-on-concurrent-duplicate behavior still
  // applies; only the 24 h Redis copy of the response body is suppressed.
  const skipCache = c.get('skipIdempotencyCache') === true;
  const shouldCache = status >= 200 && status < 300 && !skipCache;
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

  // 5. Release the lock via CAS (see RELEASE_LOCK_SCRIPT comment). Runs
  // on both 2xx/4xx/5xx success paths. Best effort — if eval fails, the
  // lock expires via its TTL.
  if (holdingLock) {
    try {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
    } catch {
      // Non-fatal.
    }
  }
  return;
};
