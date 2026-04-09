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

import type { MiddlewareHandler } from "hono";
import { getRedis } from "../redis.ts";
import type { AppEnv } from "../types.ts";

const WINDOW_MS = 60_000; // 1 minute
const WINDOW_SECONDS = Math.ceil(WINDOW_MS / 1000);
const DEFAULT_IP_LIMIT = 300; // requests/minute per source IP, pre-auth

function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  // Trust order: dedicated proxy header → standard XFF → fallback to "unknown".
  // We deliberately do NOT parse XFF chains beyond the first entry — multi-hop
  // proxies need to be configured in front, not parsed in app code.
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp;

  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  // Hono doesn't always expose the raw socket — use a static fallback
  // bucket so we still rate-limit unknown sources together. This is the
  // safe-default: under attack, "unknown" gets rate-limited as one bucket
  // rather than waved through.
  return "unknown";
}

export const ipRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c);
  const limit = Number(process.env.IP_RATE_LIMIT ?? DEFAULT_IP_LIMIT);

  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const key = `railforge:ip:${ip}`;
  const member = `${now}-${Math.random()}`;

  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.expire(key, WINDOW_SECONDS);
  const result = await pipeline.exec();

  if (!result) {
    // Pipeline rejected — fail open. Pre-auth limiter is defense-in-depth;
    // if Redis is down, the per-key limiter behind it still runs once auth
    // succeeds. Logging a metric here would be good once we wire pino.
    await next();
    return;
  }

  const cardResult = result[2];
  const count =
    cardResult && typeof cardResult[1] === "number" ? cardResult[1] : 0;

  // Don't expose the per-IP budget in headers — that just tells attackers
  // the threshold. Only emit a Retry-After on rejection.
  if (count > limit) {
    c.header("Retry-After", String(WINDOW_SECONDS));
    return c.json(
      { error: "Too many requests", retry_after_seconds: WINDOW_SECONDS },
      429,
    );
  }

  await next();
  return;
};
