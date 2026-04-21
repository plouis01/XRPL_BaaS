// REVIEW.md MED-09: dedicated rate limit for DEX read routes.
//
// `GET /v1/dex/orderbook/:base/:counter` and `GET /v1/dex/amm/:asset1/:asset2`
// proxy arbitrary issuer queries to rippled. The general per-key rateLimit
// (default 300 req/min) is tuned for write traffic; the read routes can be
// used by a free-tier key to scrape XRPL through our bandwidth + rippled
// pool. This middleware applies a tighter per-key budget scoped to the DEX
// read surface — 30 req/min is ~2x a typical "load 5 books" refresh and
// still generous for real dashboards.
//
// Key naming is deliberately distinct from rateLimit's (`railforge:rl:<id>`)
// so the two counters don't collide. Middleware order: applied INSIDE the
// DEX router, so it runs AFTER the global rateLimit — a burst that exceeds
// the tighter DEX cap is already counted against the global window too.
//
// On Redis unavailability we fail OPEN on the read routes (the cost of a
// false negative is low — worst case is the general rateLimit still caps
// total traffic, and the outage path already has alerting via rateLimit's
// memoryRateLimiter fallback).

import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import { getRedis } from '../redis.ts';
import type { AppEnv } from '../types.ts';

const WINDOW_MS = 60_000;
const WINDOW_SECONDS = Math.ceil(WINDOW_MS / 1000);
const LIMIT = 30;

export const dexReadRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKeyId = c.get('apiKeyId');
  if (!apiKeyId) {
    return c.json({ error: 'Rate limit context missing' }, 500);
  }

  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const key = `railforge:rl:dex-read:${apiKeyId}`;
  const member = `${now}-${Math.random()}`;

  try {
    const pipeline = redis.multi();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.expire(key, WINDOW_SECONDS);
    const results = await pipeline.exec();
    const count = results ? Number((results[2]?.[1] as number) ?? 0) : 0;
    if (count > LIMIT) {
      c.header('X-DexRead-RateLimit-Limit', String(LIMIT));
      c.header('X-DexRead-RateLimit-Remaining', '0');
      return c.json(
        {
          error: 'DEX read rate limit exceeded',
          limit: LIMIT,
          window_seconds: WINDOW_SECONDS,
        },
        429,
      );
    }
    c.header('X-DexRead-RateLimit-Limit', String(LIMIT));
    c.header('X-DexRead-RateLimit-Remaining', String(Math.max(0, LIMIT - count)));
  } catch (err) {
    // Read-route fail-open: the outer rateLimit already caps total traffic.
    logger.warn({ err }, 'DEX read rate limit unavailable — allowing request');
  }

  await next();
  return;
};
