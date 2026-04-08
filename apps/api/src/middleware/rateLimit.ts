import type { MiddlewareHandler } from "hono";

// Per-API-key rate limiting using a Redis sliding window.
// TODO Sprint 1: implement against ioredis.
export const rateLimit: MiddlewareHandler = async (_c, next) => {
  await next();
};
