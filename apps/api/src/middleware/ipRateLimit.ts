// Pre-auth IP rate limiter. Mounted BEFORE the auth middleware on /v1/* so
// that anonymous (failed-auth) traffic is bounded.
//
// Why this exists (CRITICAL security finding from sprint-1 review):
//   The per-API-key rate limiter (rateLimit.ts) keys on `apiKeyId` from the
//   Hono context — which is only set AFTER auth succeeds. That means any
//   request with a missing or invalid X-API-Key bypasses rate limiting
//   entirely. An attacker could brute-force key candidates at line rate.
//
//   This middleware closes that gap by limiting BEFORE auth runs, keyed on
//   the source IP. Genuine clients almost never hit this ceiling — it's
//   intentionally generous (300 req/min default). Attackers spraying
//   candidate keys hit it within seconds.
//
// IP source:
//   1. CF-Connecting-IP (Cloudflare)
//   2. X-Forwarded-For (first hop, trusted proxies only)
//   3. Hono's c.req.raw socket address fallback
//
// Algorithm: same Redis sliding window as rateLimit.ts, but with a different
// key namespace (`railforge:ip:` vs `railforge:rl:`) so the two don't collide.

import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import { getRedis } from '../redis.ts';
import type { AppEnv } from '../types.ts';
import { memoryRateLimiter } from './memoryRateLimit.ts';
import { getClientIp } from './trustedProxy.ts';

const WINDOW_MS = 60_000; // 1 minute
const WINDOW_SECONDS = Math.ceil(WINDOW_MS / 1000);
const DEFAULT_IP_LIMIT = 300; // requests/minute per source IP, pre-auth

export const ipRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  // REVIEW.md M-1: IP extraction respects the TRUSTED_PROXY_IPS allowlist.
  // See trustedProxy.ts for the full reasoning. Without that env var set,
  // behavior is unchanged.
  const ip = getClientIp(c);
  const limit = Number(process.env.IP_RATE_LIMIT ?? DEFAULT_IP_LIMIT);

  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const key = `railforge:ip:${ip}`;
  const member = `${now}-${Math.random()}`;

  let count = -1;
  let degraded = false;
  try {
    const pipeline = redis.multi();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.expire(key, WINDOW_SECONDS);
    const result = await pipeline.exec();

    if (!result) {
      degraded = true;
    } else {
      const cardResult = result[2];
      count = cardResult && typeof cardResult[1] === 'number' ? cardResult[1] : 0;
    }
  } catch (err) {
    // Sprint 7 (#16): Redis unreachable. The pre-auth limiter is the only
    // thing standing between anonymous traffic and the auth lookup — we
    // can't fail open. Fall through to the in-process sliding window.
    logger.warn({ err, key }, 'ipRateLimit redis error — using in-memory fallback');
    degraded = true;
  }

  if (degraded) {
    count = memoryRateLimiter.hit(key, WINDOW_MS, now);
  }

  // Don't expose the per-IP budget in headers — that just tells attackers
  // the threshold. Only emit a Retry-After on rejection.
  if (count > limit) {
    c.header('Retry-After', String(WINDOW_SECONDS));
    return c.json({ error: 'Too many requests', retry_after_seconds: WINDOW_SECONDS }, 429);
  }

  await next();
  return;
};
