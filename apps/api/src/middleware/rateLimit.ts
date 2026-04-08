// Per-API-key rate limiting using a Redis sliding-window log.
//
// Algorithm:
//   key = railforge:rl:<apiKeyId>
//   1. ZREMRANGEBYSCORE key 0 (now - WINDOW_MS)   — drop expired entries
//   2. ZADD key now <unique-member>                — record this request
//   3. ZCARD key                                   — count remaining entries
//   4. EXPIRE key (WINDOW_MS / 1000)               — auto-cleanup
//   5. If count > limit → 429
//
// All four ops run in a single MULTI pipeline so the count is consistent.
// The per-key limit comes from auth middleware (api_keys.rate_limit).

import type { MiddlewareHandler } from "hono";
import { getRedis } from "../redis.ts";
import type { AppEnv } from "../types.ts";

const WINDOW_MS = 60_000; // 1 minute
const WINDOW_SECONDS = Math.ceil(WINDOW_MS / 1000);

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKeyId = c.get("apiKeyId");
  const limit = c.get("rateLimit");

  // If auth didn't run for some reason, fail closed.
  if (!apiKeyId || !limit) {
    return c.json({ error: "Rate limit context missing" }, 500);
  }

  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const key = `railforge:rl:${apiKeyId}`;
  // Use a unique member so concurrent requests at the same ms don't collide.
  const member = `${now}-${Math.random()}`;

  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.expire(key, WINDOW_SECONDS);
  const result = await pipeline.exec();

  if (!result) {
    // Pipeline rejected — fail open and let downstream handle it.
    await next();
    return;
  }

  // result is [[err, value], ...]. Index 2 is the ZCARD reply.
  const cardResult = result[2];
  const count =
    cardResult && typeof cardResult[1] === "number" ? cardResult[1] : 0;

  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
  c.header("X-RateLimit-Reset", String(Math.ceil((now + WINDOW_MS) / 1000)));

  if (count > limit) {
    return c.json(
      { error: "Rate limit exceeded", retry_after_seconds: WINDOW_SECONDS },
      429,
    );
  }

  await next();
  return;
};
